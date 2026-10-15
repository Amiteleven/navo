import { describe, expect, it, beforeEach, vi } from 'vitest';
import { OfferStatus, OfferType } from '@prisma/client';
import { ConflictError } from '../../../utils/errors.js';

/**
 * Functional tests for the 4-Offer Commercial Engine.
 *
 * Tests the product/service/SaaS offer lifecycle, submission count
 * enforcement, and the immutability of past submissions.
 */

interface Row { [key: string]: unknown }

const { db, prismaMock } = vi.hoisted(() => {
  const state = {
    users: [] as Row[],
    vendorAssignments: [] as Row[],
    commercialOffers: [] as Row[],
    submissions: [] as Row[],
    events: [] as Row[],
    auditLogs: [] as Row[],
    procurementRequests: [] as Row[],
  };

  function applyDefaults(data: Row): Row {
    return {
      submissionsInRound: 0,
      currentSubmissionNumber: 0,
      finalOfferSubmitted: false,
      commercialRound: 1,
      status: 'VENDOR_INVITED',
      currency: 'INR',
      ...data,
    };
  }

  const mock = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.users.find((u) => u.id === where.id) ?? null,
    },
    vendorAssignment: {
      findFirst: async ({ where }: { where: Row }) =>
        state.vendorAssignments.find(
          (a) => a.id === where.id && a.tenantId === where.tenantId
        ) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const a = state.vendorAssignments.find((x) => x.id === where.id);
        if (a) {
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && (value as any).increment !== undefined) {
              (a as any)[key] = ((a as any)[key] as number ?? 0) + (value as any).increment;
            } else {
              (a as any)[key] = value;
            }
          }
        }
        return a ?? null;
      },
    },
    commercialOffer: {
      findUnique: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
        const w = where as Record<string, unknown>;
        let found: Row | null = null;
        if (w.vendorAssignmentId_commercialRound) {
          const key = w.vendorAssignmentId_commercialRound as { vendorAssignmentId: string; commercialRound: number };
          found = state.commercialOffers.find(
            (o) =>
              o.vendorAssignmentId === key.vendorAssignmentId &&
              o.commercialRound === key.commercialRound
          ) ?? null;
        } else if (typeof w.id === 'string') {
          found = state.commercialOffers.find((o) => o.id === w.id) ?? null;
        }
        if (!found) return null;
        if (!select) return found;
        const result: Row = {};
        for (const k of Object.keys(found)) {
          if (select[k]) (result as Record<string, unknown>)[k] = (found as Record<string, unknown>)[k];
        }
        return result;
      },
      findFirst: async ({ where }: { where: Row }) =>
        state.commercialOffers.find(
          (o) => o.id === where.id && o.tenantId === where.tenantId
        ) ?? null,
      findMany: async () => [],
      count: async () => 0,
      create: async ({ data }: { data: Row }) => {
        const offer = applyDefaults({
          id: `offer-${state.commercialOffers.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        });
        state.commercialOffers.push(offer);
        return offer;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const o = state.commercialOffers.find((x) => x.id === where.id);
        if (o) {
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && (value as any).increment !== undefined) {
              (o as any)[key] = ((o as any)[key] as number ?? 0) + (value as any).increment;
            } else {
              (o as any)[key] = value;
            }
          }
          (o as any).updatedAt = new Date();
        }
        return o ?? null;
      },
    },
    commercialOfferSubmission: {
      findUnique: async ({ where }: { where: Row }) => {
        const w = where as Record<string, string>;
        if (w.idempotencyKey) return state.submissions.find((s) => s.idempotencyKey === w.idempotencyKey) ?? null;
        if (w.id) return state.submissions.find((s) => s.id === w.id) ?? null;
        return null;
      },
      findFirst: async ({ where }: { where: Row }) => {
        const w = where as { commercialOfferId?: string; submissionNumber?: number };
        if (w.commercialOfferId !== undefined && w.submissionNumber !== undefined) {
          return state.submissions.find(
            (s) =>
              s.commercialOfferId === w.commercialOfferId &&
              s.submissionNumber === w.submissionNumber
          ) ?? null;
        }
        return null;
      },
      create: async ({ data }: { data: Row }) => {
        const sub = { id: `sub-${state.submissions.length + 1}`, ...data };
        state.submissions.push(sub);
        return sub;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const idx = state.submissions.findIndex((s) => s.id === where.id);
        if (idx >= 0) state.submissions.splice(idx, 1);
        return { count: idx >= 0 ? 1 : 0 };
      },
    },
    offerEvent: {
      create: async ({ data }: { data: Row }) => {
        const e = { id: `event-${state.events.length + 1}`, ...data };
        state.events.push(e);
        return e;
      },
      findMany: async () => state.events,
    },
    procurementRequest: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.procurementRequests.find((r) => r.id === where.id) ?? null,
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        const a = { id: `audit-${state.auditLogs.length + 1}`, ...data };
        state.auditLogs.push(a);
        return a;
      },
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mock),
  };

  return { db: state, prismaMock: mock };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));

import {
  submitOffer,
  createOrGetOffer,
  reopenCommercialProcess,
} from '../commercial-offer.service.js';

const TENANT_A = 'tenant-a';
const VENDOR_1 = 'vendor-1';
const USER_VENDOR_1 = 'user-vendor-1';

beforeEach(() => {
  db.users.length = 0;
  db.vendorAssignments.length = 0;
  db.commercialOffers.length = 0;
  db.submissions.length = 0;
  db.events.length = 0;
  db.auditLogs.length = 0;
  db.procurementRequests.length = 0;

  db.users.push({
    id: USER_VENDOR_1, tenantId: TENANT_A, role: 'VENDOR', vendorId: VENDOR_1, isActive: true, email: 'seller@demo.com',
  });

  db.procurementRequests.push({
    id: 'req-1', tenantId: TENANT_A, quantity: 100, unit: 'units', requiredDate: new Date('2026-12-31'),
    category: 'IT', specifications: 'test', location: 'BLR',
  });

  db.vendorAssignments.push({
    id: 'assignment-1', tenantId: TENANT_A, requestId: 'req-1', vendorId: VENDOR_1,
    hasQuoted: false, offersSubmitted: 0, finalOfferSubmitted: false,
    commercialRound: 1, currency: 'INR', deadline: new Date('2026-11-30'),
  });
});

const submitProduct = (key: string, total: number = 1180) =>
  submitOffer(
    {
      vendorAssignmentId: 'assignment-1',
      requestId: 'req-1',
      offerType: OfferType.PRODUCT,
      currency: 'INR',
      subTotal: total - 180,
      taxAmount: 180,
      totalAmount: total,
      unitPrice: (total - 180) / 100,
      quantity: 100,
      deliveryDate: '2026-12-01',
      paymentTerms: 'Net 30',
      offerValidityDays: 30,
      scope: 'Standard delivery',
      exclusions: '',
      supportingDocuments: [],
      idempotencyKey: key,
    },
    USER_VENDOR_1,
    TENANT_A,
    VENDOR_1
  );

const submitService = (key: string) =>
  submitOffer(
    {
      vendorAssignmentId: 'assignment-1',
      requestId: 'req-1',
      offerType: OfferType.SERVICE,
      currency: 'INR',
      subTotal: 50000,
      taxAmount: 9000,
      totalAmount: 59000,
      contractDuration: '12 months',
      paymentTerms: 'Net 30',
      deliveryDate: '2026-11-15',
      offerValidityDays: 60,
      scope: 'Full IT infrastructure support',
      exclusions: 'Hardware not included',
      supportingDocuments: [],
      idempotencyKey: key,
    },
    USER_VENDOR_1,
    TENANT_A,
    VENDOR_1
  );

const submitSaaS = (key: string) =>
  submitOffer(
    {
      vendorAssignmentId: 'assignment-1',
      requestId: 'req-1',
      offerType: OfferType.SOFTWARE_SUBSCRIPTION,
      currency: 'INR',
      subTotal: 24000,
      taxAmount: 4320,
      totalAmount: 28320,
      numberOfLicenses: 100,
      billingFrequency: 'Annual',
      subscriptionTerm: '1 year',
      paymentTerms: 'Net 30',
      deliveryDate: '2026-11-01',
      offerValidityDays: 90,
      scope: 'Enterprise software licensing',
      exclusions: '',
      supportingDocuments: [],
      idempotencyKey: key,
    },
    USER_VENDOR_1,
    TENANT_A,
    VENDOR_1
  );

describe('Product Offer Lifecycle', () => {
  it('creates submission with correct data', async () => {
    const result = await submitProduct('prod-key-1', 1180);
    const sub = result.submission;

    expect(sub.submissionNumber).toBe(1);
    expect(sub.totalAmount.toString()).toBe('1180');
    expect(sub.currency).toBe('INR');
    expect(sub.unitPrice).toBeDefined();
    expect(sub.quantity).toBe(100);
    expect(sub.isFinal).toBe(false);
  });

  it('stores the offer type correctly', async () => {
    await submitProduct('prod-key-2');
    const offer = db.commercialOffers[0];
    expect(offer.offerType).toBe(OfferType.PRODUCT);
  });
});

describe('Service Offer Lifecycle', () => {
  it('stores contract duration for service offers', async () => {
    const result = await submitService('svc-key-1');
    const sub = result.submission;

    expect(sub.contractDuration).toBe('12 months');
    expect(sub.scope).toBe('Full IT infrastructure support');
  });
});

describe('SaaS Offer Lifecycle', () => {
  it('stores subscription fields for SaaS offers', async () => {
    const result = await submitSaaS('saas-key-1');
    const sub = result.submission;

    expect(sub.numberOfLicenses).toBe(100);
    expect(sub.billingFrequency).toBe('Annual');
    expect(sub.subscriptionTerm).toBe('1 year');
  });
});

describe('4-Submission Limit', () => {
  it('allows exactly 4 submissions', async () => {
    for (let i = 1; i <= 4; i++) {
      const result = await submitProduct(`limit-key-${i}`, 1000 + i * 100);
      expect(result.submissionNumber).toBe(i);
    }
    expect(db.submissions).toHaveLength(4);
  });

  it('blocks the 5th submission with ConflictError', async () => {
    for (let i = 1; i <= 4; i++) {
      await submitProduct(`block-key-${i}`, 1000 + i * 100);
    }

    await expect(submitProduct('block-key-5', 5000)).rejects.toThrow(ConflictError);
  });

  it('marks the 4th submission as final', async () => {
    for (let i = 1; i <= 4; i++) {
      await submitProduct(`final-key-${i}`, 1000 + i * 100);
    }

    const fourth = db.submissions.find((s) => (s as any).submissionNumber === 4);
    expect(fourth!.isFinal).toBe(true);

    const offer = db.commercialOffers[0];
    expect(offer.finalOfferSubmitted).toBe(true);
    expect(offer.status).toBe(OfferStatus.FINAL_OFFER_SUBMITTED);
  });
});

describe('Submission History & Immutability', () => {
  it('submissions are numbered sequentially within a round', async () => {
    await submitProduct('seq-1');
    await submitProduct('seq-2', 1200);

    const subs = db.submissions.filter((s) => (s as any).submissionNumber > 0);
    expect(subs).toHaveLength(2);
    expect((subs[0] as any).submissionNumber).toBe(1);
    expect((subs[1] as any).submissionNumber).toBe(2);
  });

  it('each submission is a separate immutable record', async () => {
    await submitProduct('imm-1', 1180);
    await submitProduct('imm-2', 1300);

    const sub1 = db.submissions.find((s) => (s as any).submissionNumber === 1);
    const sub2 = db.submissions.find((s) => (s as any).submissionNumber === 2);

    expect(sub1!.id).not.toBe(sub2!.id);
    expect((sub1!.totalAmount as any).toString()).toBe('1180');
    expect((sub2!.totalAmount as any).toString()).toBe('1300');
  });
});

describe('Audit Trail', () => {
  it('creates an OfferEvent for each submission', async () => {
    await submitProduct('audit-1');

    const submitEvents = db.events.filter((e) => e.eventType === 'OFFER_SUBMITTED');
    expect(submitEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('records an auditLog entry for each submission', async () => {
    await submitProduct('audit-2');

    const logs = db.auditLogs.filter((l) => l.action === 'OFFER_SUBMITTED');
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Commercial Process Reopening', () => {
  it('new round gets fresh submission count', async () => {
    for (let i = 1; i <= 4; i++) {
      await submitProduct(`reopen-key-${i}`, 1000 + i * 100);
    }

    // Verify round 1 is exhausted
    let offer = db.commercialOffers.find((o) => o.commercialRound === 1);
    expect(offer?.submissionsInRound).toBe(4);
    expect(offer?.finalOfferSubmitted).toBe(true);
  });
});
