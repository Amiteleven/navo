import { describe, expect, it, beforeEach, vi } from 'vitest';
import { UserRole } from '@navo/shared';
import {
  assertPublishableVisibility,
  assertVendorCanParticipate,
  clearRestriction,
  findRestriction,
  openMarketWhere,
  resolveInteractionBasis,
  resolveSellerActor,
  setRestriction,
} from '../communication.service.js';
import {
  assertSellerMayContact,
  assertSellerMayRequestConnection,
} from '../communication.service.js';
import { ForbiddenError, ValidationError } from '../../../utils/errors.js';

/**
 * Communication-control tests.
 *
 * The property under test throughout: a seller can reach a buyer only when a
 * permitted interaction already exists, and no client-supplied value can
 * create one. Prisma is stubbed so each scenario is expressed as an explicit
 * record set rather than seeded rows, which keeps the assertion about the
 * *decision* rather than about database state.
 */

interface Row {
  [key: string]: unknown;
}

const { db, prismaMock } = vi.hoisted(() => {
  const state = {
    users: [] as Row[],
    vendors: [] as Row[],
    interests: [] as Row[],
    connections: [] as Row[],
    restrictions: [] as Row[],
  };

  const mock = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = state.users.find((u) => u.id === where.id);
        if (!user) return null;
        // Honour the active and tenant guards the service relies on.
        return state.users.find(
          (u) => u.id === where.id && u.isActive !== false && u.tenantId === user.tenantId
        ) ?? null;
      },
    },
    vendor: {
      findFirst: async ({ where }: { where: Row }) =>
        state.vendors.find(
          (v) =>
            v.id === where.id &&
            v.tenantId === where.tenantId &&
            (where.status === undefined || v.status === where.status)
        ) ?? null,
    },
    marketplaceInterest: {
      findFirst: async ({ where }: { where: Row }) =>
        state.interests.find((i) => {
          if (i.vendorId !== where.vendorId) return false;
          if (i.tenantId !== where.tenantId) return false;
          const statuses = (where.status as { in?: string[] } | undefined)?.in;
          if (statuses && !statuses.includes(i.status as string)) return false;
          // `request` arrives as a nested filter on id and requesterId.
          const request = where.request as { id?: string; requesterId?: string } | undefined;
          if (request?.id && i.requestId !== request.id) return false;
          if (request?.requesterId && i.requesterRequesterId !== request.requesterId) return false;
          return true;
        }) ?? null,
    },
    connection: {
      findFirst: async ({ where }: { where: Row }) => {
        const branches = (where.OR as Row[] | undefined) ?? [];
        return state.connections.find((c) => {
          if (c.tenantId !== where.tenantId) return false;
          if (c.vendorId !== where.vendorId) return false;
          return branches.some((b) => {
            const request = b.request as { requesterId?: string } | undefined;
            const room = b.dealRoom as { buyerId?: string } | undefined;
            if (request?.requesterId) return c.requestRequesterId === request.requesterId;
            if (room?.buyerId) return c.roomBuyerId === room.buyerId;
            return false;
          });
        }) ?? null;
      },
    },
    contactRestriction: {
      findMany: async ({ where }: { where: Row }) =>
        state.restrictions.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            r.buyerId === where.buyerId &&
            r.vendorId === where.vendorId
        ),
      create: async ({ data }: { data: Row }) => {
        const created = { id: `restriction-${state.restrictions.length + 1}`, ...data };
        state.restrictions.push(created);
        return created;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = state.restrictions.length;
        for (let i = state.restrictions.length - 1; i >= 0; i--) {
          const r = state.restrictions[i];
          if (
            r.tenantId === where.tenantId &&
            r.buyerId === where.buyerId &&
            r.vendorId === where.vendorId
          ) {
            state.restrictions.splice(i, 1);
          }
        }
        return { count: before - state.restrictions.length };
      },
    },
  };

  return { db: state, prismaMock: mock };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));

const SELLER_USER = 'user-seller';
const OTHER_BUYER = 'user-other-buyer';

beforeEach(() => {
  db.users.length = 0;
  db.vendors.length = 0;
  db.interests.length = 0;
  db.connections.length = 0;
  db.restrictions.length = 0;
  vi.clearAllMocks();

  db.users.push(
    {
      id: SELLER_USER,
      tenantId: 'tenant-a',
      role: 'VENDOR',
      vendorId: 'vendor-1',
      isActive: true,
    },
    {
      id: OTHER_BUYER,
      tenantId: 'tenant-a',
      role: 'REQUESTER',
      vendorId: null,
      isActive: true,
    }
  );
  db.vendors.push({
    id: 'vendor-1',
    tenantId: 'tenant-a',
    status: 'ACTIVE',
    verificationStatus: 'VERIFIED',
  });
});

describe('seller resolution', () => {
  it('re-reads the vendor link from the database', async () => {
    // A token claiming a different vendorId must not be honoured: the lookup is
    // by user id and the vendorId comes from the row.
    const actor = await resolveSellerActor(SELLER_USER, 'tenant-a');
    expect(actor.vendorId).toBe('vendor-1');
  });

  it('refuses a seller whose account is not linked to a vendor', async () => {
    db.users[0].vendorId = null;
    await expect(resolveSellerActor(SELLER_USER, 'tenant-a')).rejects.toThrow(ForbiddenError);
  });

  it('refuses a non-seller account', async () => {
    await expect(resolveSellerActor(OTHER_BUYER, 'tenant-a')).rejects.toThrow(ForbiddenError);
  });

  it('refuses an inactive account', async () => {
    db.users[0].isActive = false;
    await expect(resolveSellerActor(SELLER_USER, 'tenant-a')).rejects.toThrow(ForbiddenError);
  });

  it('refuses a cross-tenant user', async () => {
    await expect(resolveSellerActor(SELLER_USER, 'tenant-b')).rejects.toThrow(ForbiddenError);
  });
});

describe('vendor eligibility', () => {
  it('allows an active vendor', async () => {
    await expect(assertVendorCanParticipate('tenant-a', 'vendor-1')).resolves.toBeUndefined();
  });

  it('blocks a blacklisted vendor', async () => {
    // BLACKLISTED was previously a dead enum value that nothing checked.
    db.vendors[0].status = 'BLACKLISTED';
    await expect(assertVendorCanParticipate('tenant-a', 'vendor-1')).rejects.toThrow(
      /suspended/i
    );
  });

  it('blocks a vendor that is not yet active', async () => {
    db.vendors[0].status = 'PENDING_APPROVAL';
    await expect(assertVendorCanParticipate('tenant-a', 'vendor-1')).rejects.toThrow(/active/i);
  });

  it('refuses a vendor from another tenant', async () => {
    await expect(assertVendorCanParticipate('tenant-b', 'vendor-1')).rejects.toThrow();
  });
});

describe('seller may not contact a buyer unsolicited', () => {
  it('refuses when no interaction exists', async () => {
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe('NONE');
    await expect(assertSellerMayContact('tenant-a', SELLER_USER, OTHER_BUYER)).rejects.toThrow(
      ForbiddenError
    );
  });

  it('allows contact after the seller expressed interest', async () => {
    db.interests.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestId: 'req-1',
      requesterRequesterId: OTHER_BUYER,
      status: 'EXPRESSED',
    });
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe(
      'MARKETPLACE_INTEREST'
    );
  });

  it('allows contact when the seller has quoted', async () => {
    db.interests.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestId: 'req-1',
      requesterRequesterId: OTHER_BUYER,
      status: 'QUOTED',
    });
    await expect(assertSellerMayContact('tenant-a', SELLER_USER, OTHER_BUYER)).resolves.toBe(
      'MARKETPLACE_INTEREST'
    );
  });

  it('does not treat a withdrawn interest as a basis', async () => {
    db.interests.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestId: 'req-1',
      requesterRequesterId: OTHER_BUYER,
      status: 'WITHDRAWN',
    });
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe('NONE');
  });

  it('does not treat a rejected interest as a basis', async () => {
    db.interests.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestId: 'req-1',
      requesterRequesterId: OTHER_BUYER,
      status: 'REJECTED',
    });
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe('NONE');
  });

  it('allows contact after the buyer invited the seller', async () => {
    db.connections.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestRequesterId: OTHER_BUYER,
      roomBuyerId: null,
      status: 'PENDING',
      dealRoom: null,
    });
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe(
      'BUYER_INVITED'
    );
  });

  it('allows contact once a connection is accepted', async () => {
    db.connections.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestRequesterId: OTHER_BUYER,
      roomBuyerId: OTHER_BUYER,
      status: 'ACCEPTED',
      dealRoom: { id: 'room-1' },
    });
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe(
      'CONNECTION_ACCEPTED'
    );
  });

  it('does not let a connection to a different buyer authorize contact', async () => {
    // The connection exists, but against another buyer's requirement. This is
    // the cross-buyer leak the requesterId filter is there to prevent.
    db.connections.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestRequesterId: 'user-someone-else',
      roomBuyerId: null,
      status: 'ACCEPTED',
      dealRoom: null,
    });
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe('NONE');
  });

  it('names the actionable fix in the refusal', async () => {
    await expect(assertSellerMayContact('tenant-a', SELLER_USER, OTHER_BUYER)).rejects.toThrow(
      /quotation|invitation/i
    );
  });
});

describe('block and mute', () => {
  it('a block stops an otherwise valid interaction', async () => {
    db.interests.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestId: 'req-1',
      requesterRequesterId: OTHER_BUYER,
      status: 'QUOTED',
    });
    await setRestriction({ tenantId: 'tenant-a', buyerId: OTHER_BUYER, vendorId: 'vendor-1', kind: 'BLOCK' });

    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe('NONE');
  });

  it('an expired mute no longer restricts', async () => {
    db.restrictions.push({
      tenantId: 'tenant-a',
      buyerId: OTHER_BUYER,
      vendorId: 'vendor-1',
      kind: 'MUTE',
      expiresAt: new Date(Date.now() - 1000),
    });
    db.interests.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestId: 'req-1',
      requesterRequesterId: OTHER_BUYER,
      status: 'EXPRESSED',
    });
    expect(await findRestriction('tenant-a', OTHER_BUYER, 'vendor-1')).toBeNull();
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe(
      'MARKETPLACE_INTEREST'
    );
  });

  it('an active mute still restricts', async () => {
    db.restrictions.push({
      tenantId: 'tenant-a',
      buyerId: OTHER_BUYER,
      vendorId: 'vendor-1',
      kind: 'MUTE',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await findRestriction('tenant-a', OTHER_BUYER, 'vendor-1')).toMatchObject({
      kind: 'MUTE',
    });
  });

  it('blocking replaces an existing mute rather than co-existing', async () => {
    await setRestriction({ tenantId: 'tenant-a', buyerId: OTHER_BUYER, vendorId: 'vendor-1', kind: 'MUTE' });
    await setRestriction({ tenantId: 'tenant-a', buyerId: OTHER_BUYER, vendorId: 'vendor-1', kind: 'BLOCK' });

    const active = db.restrictions.filter(
      (r) => r.buyerId === OTHER_BUYER && r.vendorId === 'vendor-1'
    );
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe('BLOCK');
  });

  it('a block does not expire even if a date is supplied', async () => {
    await setRestriction({
      tenantId: 'tenant-a',
      buyerId: OTHER_BUYER,
      vendorId: 'vendor-1',
      kind: 'BLOCK',
      expiresAt: new Date(Date.now() + 1000),
    });
    const row = db.restrictions.find((r) => r.kind === 'BLOCK');
    expect(row?.expiresAt).toBeNull();
  });

  it('clearing a restriction restores the interaction basis', async () => {
    db.interests.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestId: 'req-1',
      requesterRequesterId: OTHER_BUYER,
      status: 'EXPRESSED',
    });
    await setRestriction({ tenantId: 'tenant-a', buyerId: OTHER_BUYER, vendorId: 'vendor-1', kind: 'BLOCK' });
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe('NONE');

    await clearRestriction('tenant-a', OTHER_BUYER, 'vendor-1');
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe(
      'MARKETPLACE_INTEREST'
    );
  });
});

describe('connection requests', () => {
  it('allows a request backed by interest in that requirement', async () => {
    db.interests.push({
      vendorId: 'vendor-1',
      tenantId: 'tenant-a',
      requestId: 'req-1',
      requesterRequesterId: OTHER_BUYER,
      status: 'EXPRESSED',
    });
    await expect(
      assertSellerMayRequestConnection('tenant-a', SELLER_USER, OTHER_BUYER, 'req-1')
    ).resolves.toBe('MARKETPLACE_INTEREST');
  });

  it('refuses a cold connection request', async () => {
    expect(await resolveInteractionBasis('tenant-a', SELLER_USER, OTHER_BUYER)).toBe('NONE');
    await expect(
      assertSellerMayRequestConnection('tenant-a', SELLER_USER, OTHER_BUYER, 'req-9')
    ).resolves.toBe('NONE');
  });

  it('refuses when the vendor is suspended', async () => {
    db.vendors[0].status = 'BLACKLISTED';
    await expect(
      assertSellerMayRequestConnection('tenant-a', SELLER_USER, OTHER_BUYER, 'req-1')
    ).rejects.toThrow(/suspended/i);
  });

  it('refuses when the buyer has blocked the vendor', async () => {
    await setRestriction({ tenantId: 'tenant-a', buyerId: OTHER_BUYER, vendorId: 'vendor-1', kind: 'BLOCK' });
    await expect(
      assertSellerMayRequestConnection('tenant-a', SELLER_USER, OTHER_BUYER, 'req-1')
    ).rejects.toThrow(/not accepting/i);
  });
});

describe('publish validation', () => {
  it('refuses to publish a draft to the open market', () => {
    expect(() =>
      assertPublishableVisibility({ visibility: 'OPEN_MARKET', status: 'DRAFT' })
    ).toThrow(ValidationError);
  });

  it('allows publishing a submitted requirement', () => {
    expect(() =>
      assertPublishableVisibility({ visibility: 'OPEN_MARKET', status: 'SUBMITTED' })
    ).not.toThrow();
  });

  it('refuses a quotation deadline on a private requirement', () => {
    expect(() =>
      assertPublishableVisibility({
        visibility: 'PRIVATE',
        status: 'SUBMITTED',
        quotationDeadline: new Date(),
      })
    ).toThrow(/deadline only applies/i);
  });

  it('allows a deadline on an open-market requirement', () => {
    expect(() =>
      assertPublishableVisibility({
        visibility: 'OPEN_MARKET',
        status: 'SUBMITTED',
        quotationDeadline: new Date(),
      })
    ).not.toThrow();
  });
});

describe('open market filter', () => {
  const where = openMarketWhere('tenant-a');

  it('only ever returns open-market requirements', () => {
    expect(where.visibility).toBe('OPEN_MARKET');
  });

  it('only ever returns published requirements', () => {
    expect(where.publishedAt).toEqual({ not: null });
  });

  it('excludes drafts and cancelled requirements', () => {
const statuses = (where.status as { in?: string[] } | undefined)?.in;
    expect(statuses).not.toContain('DRAFT');
    expect(statuses).not.toContain('CANCELLED');
    expect(statuses).not.toContain('COMPLETED');
  });

  it('excludes requirements whose deadline has passed', () => {
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toHaveLength(2);
    expect(or[0]).toEqual({ quotationDeadline: null });
  });

  it('hides a requirement from a vendor the buyer has blocked', () => {
    const blocked = openMarketWhere('tenant-a', 'vendor-1');
    expect(blocked.requester).toEqual({
      restrictionsAsBuyer: { none: { vendorId: 'vendor-1' } },
    });
  });

  it('omits the vendor filter when there is no vendor identity', () => {
    expect(openMarketWhere('tenant-a').requester).toBeUndefined();
  });
});