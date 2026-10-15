import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ForbiddenError } from '../../../utils/errors.js';
import { assessNegotiationWorthiness } from '../negotiation.service.js';

interface Row { [key: string]: unknown }

const TENANT = 'tenant-a';
const BUYER = 'buyer-1';
const VENDOR_USER = 'vendor-user-1';
const VENDOR_1 = 'vendor-1';
const REQUESTER = 'requester-1';
const ROOM = 'room-1';

const { db, prismaMock } = vi.hoisted(() => {
  const state = {
    rooms: [] as Row[],
    completedDeals: 0,
  };

  const mock = {
    dealRoom: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.rooms.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null,
    },
    deal: {
      count: async () => state.completedDeals,
    },
  };

  return { db: state, prismaMock: mock };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));

describe('Negotiation worthiness assessment', () => {
  beforeEach(() => {
    db.rooms.length = 0;
    db.completedDeals = 0;
  });

  const seedRoom = (options: { budget: number; unitPrice: number | null }): Row & { offers: Row[] } => {
    const requiredDate = new Date(Date.now() + 30 * 86400000);
    const room: Row & { offers: Row[] } = {
      id: ROOM,
      tenantId: TENANT,
      buyerId: BUYER,
      vendorId: VENDOR_1,
      status: 'ACTIVE',
      request: {
        id: 'req-1',
        title: 'Laptops',
        item: 'Laptop',
        quantity: 10,
        estimatedBudget: options.budget,
        requiredDate,
        categoryId: null,
        department: null,
        costCenter: null,
        requesterId: REQUESTER,
      },
      offers: [],
      messages: [],
      vendor: { id: VENDOR_1, name: 'Vendor One' },
      buyer: { id: BUYER, firstName: 'Buyer', lastName: 'One', email: 'b@example.com' },
      connection: null,
      deal: null,
    };
    if (options.unitPrice !== null) {
      room.offers = [
        {
          id: 'offer-1',
          dealRoomId: ROOM,
          submittedById: VENDOR_USER,
          submittedByRole: 'VENDOR',
          unitPrice: options.unitPrice,
          quantity: 10,
          gst: 0,
          freightAmount: 0,
          installationAmount: 0,
          otherCharges: 0,
          warrantyMonths: 12,
          deliveryTimelineDays: 7,
          paymentTerms: 'Net 30',
          status: 'ACTIVE',
        },
      ];
    }
    db.rooms.push(room);
    return room;
  };

  it('flags an over-budget offer as OVER_BUDGET', async () => {
    seedRoom({ budget: 90000, unitPrice: 10000 });
    const result = await assessNegotiationWorthiness(ROOM, TENANT, BUYER);

    expect(result.recommendation).toBe('OVER_BUDGET');
    expect(result.factors.budgetFit.offerTotal).toBe(100000);
    expect(result.factors.budgetFit.savingsAmount).toBe(-10000);
  });

  it('recommends ACCEPT_AS_IS when savings are strong', async () => {
    seedRoom({ budget: 100000, unitPrice: 8000 });
    const result = await assessNegotiationWorthiness(ROOM, TENANT, BUYER);

    expect(result.recommendation).toBe('ACCEPT_AS_IS');
    expect(result.factors.budgetFit.savingsPercent).toBeCloseTo(20, 1);
    // Strong budget fit dominates the weighted score.
    expect(result.worthinessScore).toBeGreaterThanOrEqual(70);
  });

  it('recommends NEGOTIATE when savings are thin', async () => {
    seedRoom({ budget: 100000, unitPrice: 9500 });
    const result = await assessNegotiationWorthiness(ROOM, TENANT, BUYER);

    expect(result.recommendation).toBe('NEGOTIATE');
    expect(result.factors.budgetFit.savingsPercent).toBeCloseTo(5, 1);
  });

  it('recommends NEGOTIATE when no offer exists yet', async () => {
    seedRoom({ budget: 100000, unitPrice: null });
    const result = await assessNegotiationWorthiness(ROOM, TENANT, BUYER);

    expect(result.recommendation).toBe('NEGOTIATE');
    expect(result.factors.budgetFit.score).toBe(30);
    expect(result.factors.competitiveLeverage.activeOffers).toBe(0);
  });

  it('only the buyer can assess the room', async () => {
    seedRoom({ budget: 100000, unitPrice: 9000 });
    await expect(
      assessNegotiationWorthiness(ROOM, TENANT, VENDOR_USER)
    ).rejects.toThrow(ForbiddenError);
  });

  it('scores delivery fit against the required date', async () => {
    seedRoom({ budget: 100000, unitPrice: 9000 });
    const result = await assessNegotiationWorthiness(ROOM, TENANT, BUYER);

    // 7-day timeline against a 30-day window leaves ample slack.
    expect(result.factors.deliveryFit.deliveryTimelineDays).toBe(7);
    expect(result.factors.deliveryFit.daysRemaining).toBeGreaterThanOrEqual(29);
    expect(result.factors.deliveryFit.score).toBeGreaterThan(80);
  });

  it('weights vendor track record from completed deals', async () => {
    seedRoom({ budget: 100000, unitPrice: 9000 });
    db.completedDeals = 6;
    const withHistory = await assessNegotiationWorthiness(ROOM, TENANT, BUYER);

    expect(withHistory.factors.vendorTrackRecord.completedDeals).toBe(6);
    expect(withHistory.factors.vendorTrackRecord.score).toBe(90);
  });

  it('more concurrent offers increase competitive leverage', async () => {
    const room = seedRoom({ budget: 100000, unitPrice: 9000 });
    room.offers.push({
      id: 'offer-2',
      dealRoomId: ROOM,
      submittedById: VENDOR_USER,
      submittedByRole: 'VENDOR',
      unitPrice: 9100,
      quantity: 10,
      gst: 0,
      freightAmount: 0,
      installationAmount: 0,
      otherCharges: 0,
      warrantyMonths: 6,
      deliveryTimelineDays: 14,
      paymentTerms: 'Net 60',
      status: 'ACTIVE',
    });

    const result = await assessNegotiationWorthiness(ROOM, TENANT, BUYER);
    expect(result.factors.competitiveLeverage.activeOffers).toBe(2);
    expect(result.factors.competitiveLeverage.score).toBe(65);
  });
});
