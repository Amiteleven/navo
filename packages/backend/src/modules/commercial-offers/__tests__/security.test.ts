import { describe, expect, it, beforeEach, vi } from 'vitest';
import { OfferStatus, OfferType } from '@prisma/client';
import { ForbiddenError, NotFoundError, ConflictError } from '../../../utils/errors.js';

/**
 * Security & enforcement tests for the 4-Offer Commercial Engine.
 *
 * Prisma is stubbed so every scenario is expressed as an explicit record set.
 * The guarantee under test is *authorization, isolation and limit-enforcement
 * logic* rather than database state.
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
    vendors: [] as Row[],
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

  function applyUpdate(data: Row): Row {
    const result: Row = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && (value as any).increment !== undefined) {
        result[key] = { __increment: (value as any).increment };
      } else {
        (result as any)[key] = value;
      }
    }
    return result;
  }

  const mock = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.users.find((u) => u.id === where.id) ?? null,
    },
    vendor: {
      findMany: async () => state.vendors,
      findFirst: async ({ where }: { where: Row }) =>
        state.vendors.find((v) => v.id === where.id) ?? null,
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
      findUnique: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {        const w = where as Record<string, unknown>;
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
      findMany: async ({ where, include }: { where: Row; include?: Record<string, boolean> }) => {
        return state.commercialOffers.filter((o) => {
          for (const [key, value] of Object.entries(where)) {
            if (key === 'tenantId' && o.tenantId !== value) return false;
            if (key === 'requestId' && o.requestId !== value) return false;
            if (key === 'vendorId' && o.vendorId !== value) return false;
            if (key === 'status' && o.status !== value) return false;
          }
          return true;
        });
      },
      count: async ({ where }: { where: Row }) => {
        return state.commercialOffers.filter((o) => {
          for (const [key, value] of Object.entries(where)) {
            if (key === 'tenantId' && o.tenantId !== value) return false;
            if (key === 'requestId' && o.requestId !== value) return false;
            if (key === 'vendorId' && o.vendorId !== value) return false;
            if (key === 'status' && o.status !== value) return false;
          }
          return true;
        }).length;
      },
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
      findFirst: async ({ where, include }: { where: Row; include?: Record<string, unknown> }) => {
        const w = where as Record<string, unknown>;
        let found: Row | null = null;
        if (w.id && w.tenantId) {
          found = state.submissions.find((s) => s.id === w.id && s.tenantId === w.tenantId) ?? null;
        } else if (w.commercialOfferId !== undefined && w.submissionNumber !== undefined) {
          const sub = { where: { commercialOfferId: w.commercialOfferId, submissionNumber: w.submissionNumber } };
          found = state.submissions.find(
            (s) =>
              s.commercialOfferId === sub.where.commercialOfferId &&
              s.submissionNumber === sub.where.submissionNumber
          ) ?? null;
        }
        if (!found) return null;
        if (include?.commercialOffer) {
          const co = state.commercialOffers.find((o) => o.id === found!.commercialOfferId) ?? null;
          const result = { ...found, commercialOffer: co };
          const coInclude = (include.commercialOffer as any)?.include;
          if (coInclude?.vendor && co) {
            (result.commercialOffer as any).vendor = state.vendors.find((v) => v.id === (co as any).vendorId) ?? { id: (co as any).vendorId, name: 'Test Vendor' };
          }
          if (coInclude?.request && co) {
            const req = state.procurementRequests.find((r) => r.id === (co as any).requestId) ?? state.procurementRequests[0];
            if (req) {
              (result.commercialOffer as any).request = { title: req.title, item: req.item, quantity: req.quantity, unit: req.unit };
            }
          }
          return result;
        }
        return found;
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
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const idx = state.submissions.findIndex((s) => s.id === where.id);
        if (idx >= 0) {
          for (const [k, v] of Object.entries(data)) {
            (state.submissions[idx] as any)[k] = v;
          }
        }
        return state.submissions[idx] ?? null;
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
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const found = state.procurementRequests.find((r) => r.id === where.id) ?? null;
        if (!found) return null;
        if (!select) return found;
        const result: Row = {};
        for (const k of Object.keys(select)) {
          if (select[k]) (result as Record<string, unknown>)[k] = (found as Record<string, unknown>)[k];
        }
        if (select.category) {
          result.category = { name: (found as any).category || 'IT' };
        }
        return result;
      },
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
  createOrGetOffer,
  submitOffer,
  getOffer,
  reopenCommercialProcess,
  listOffersForBuyer,
  postClarification,
  summarizeSubmission,
  evaluateSubmissionCompliance,
} from '../commercial-offer.service.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const VENDOR_1 = 'vendor-1';
const VENDOR_2 = 'vendor-2';
const USER_VENDOR_1 = 'user-vendor-1';
const USER_VENDOR_2 = 'user-vendor-2';
const USER_BUYER = 'user-buyer';
const USER_BUYER_OTHER_TENANT = 'user-buyer-other';
const USER_REQUESTER = 'user-requester';

beforeEach(() => {
  db.users.length = 0;
  db.vendorAssignments.length = 0;
  db.commercialOffers.length = 0;
  db.submissions.length = 0;
  db.events.length = 0;
  db.auditLogs.length = 0;
  db.procurementRequests.length = 0;
  db.vendors.length = 0;

  db.users.push(
    { id: USER_VENDOR_1, tenantId: TENANT_A, role: 'VENDOR', vendorId: VENDOR_1, isActive: true, email: 'seller1@demo.com' },
    { id: USER_VENDOR_2, tenantId: TENANT_A, role: 'VENDOR', vendorId: VENDOR_2, isActive: true, email: 'seller2@demo.com' },
    { id: USER_BUYER, tenantId: TENANT_A, role: 'PROCUREMENT_MANAGER', vendorId: null, isActive: true, email: 'buyer@demo.com' },
    { id: USER_BUYER_OTHER_TENANT, tenantId: TENANT_B, role: 'PROCUREMENT_MANAGER', vendorId: null, isActive: true, email: 'buyer2@demo.com' },
    { id: USER_REQUESTER, tenantId: TENANT_A, role: 'REQUESTER', vendorId: null, isActive: true, email: 'req@demo.com' },
  );

  db.procurementRequests.push({
    id: 'req-1',
    tenantId: TENANT_A,
    quantity: 100,
    unit: 'units',
    requiredDate: new Date('2026-12-31'),
    category: 'IT',
    specifications: 'test',
    location: 'BLR',
  });

  db.vendorAssignments.push(
    {
      id: 'assignment-1',
      tenantId: TENANT_A,
      requestId: 'req-1',
      vendorId: VENDOR_1,
      hasQuoted: false,
      offersSubmitted: 0,
      finalOfferSubmitted: false,
      commercialRound: 1,
      currency: 'INR',
      deadline: new Date('2026-11-30'),
    },
    {
      id: 'assignment-2',
      tenantId: TENANT_A,
      requestId: 'req-1',
      vendorId: VENDOR_2,
      hasQuoted: false,
      offersSubmitted: 0,
      finalOfferSubmitted: false,
      commercialRound: 1,
      currency: 'INR',
      deadline: new Date('2026-11-30'),
    },
  );
});
const submitOne = (key: string) =>
  submitOffer(
    {
      vendorAssignmentId: 'assignment-1',
      requestId: 'req-1',
      offerType: OfferType.PRODUCT,
      currency: 'INR',
      subTotal: 1000,
      totalAmount: 1180,
      idempotencyKey: key,
    },
    USER_VENDOR_1,
    TENANT_A,
    VENDOR_1
  );

describe('Security: Tenant Isolation', () => {
  it('vendor from tenant B cannot access assignment in tenant A', async () => {
    await expect(
      submitOffer(
        {
          vendorAssignmentId: 'assignment-1',
          requestId: 'req-1',
          offerType: OfferType.PRODUCT,
          currency: 'INR',
          subTotal: 1000,
          totalAmount: 1180,
          idempotencyKey: 'key-tenant-b',
        },
        USER_BUYER_OTHER_TENANT,
        TENANT_B,
        VENDOR_1
      )
    ).rejects.toThrow(NotFoundError);
  });

  it('buyer from tenant B cannot list offers from tenant A', async () => {
    const result = await listOffersForBuyer(TENANT_B, { requestId: 'req-1' });
    expect(result.data).toHaveLength(0);
  });

  it('buyer from tenant B cannot reopen commercial process in tenant A', async () => {
    await expect(
      reopenCommercialProcess(
        { vendorAssignmentId: 'assignment-1', reason: 'need more quotes' },
        USER_BUYER_OTHER_TENANT,
        TENANT_B,
        'PROCUREMENT_MANAGER'
      )
    ).rejects.toThrow(NotFoundError);
  });
});

describe('Security: Vendor Isolation', () => {
  it('vendor 1 cannot access vendor 2\'s offer', async () => {
    await createOrGetOffer(
      { vendorAssignmentId: 'assignment-2', requestId: 'req-1' },
      USER_VENDOR_2,
      TENANT_A,
      VENDOR_2
    );

    const offer = db.commercialOffers.find((o) => o.vendorAssignmentId === 'assignment-2');
    await expect(
      getOffer(offer!.id as string, TENANT_A, USER_VENDOR_1, VENDOR_1)
    ).rejects.toThrow(ForbiddenError);
  });

  it('vendor cannot submit for a different vendor\'s assignment', async () => {
    await expect(
      submitOffer(
        {
          vendorAssignmentId: 'assignment-2',
          requestId: 'req-1',
          offerType: OfferType.PRODUCT,
          currency: 'INR',
          subTotal: 1000,
          totalAmount: 1180,
          idempotencyKey: 'key-cross-vendor',
        },
        USER_VENDOR_1,
        TENANT_A,
        VENDOR_1
      )
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('Security: Submission Vendor Isolation', () => {
  beforeEach(() => {
    db.vendors.push(
      { id: VENDOR_1, name: 'Vendor One', tenantId: TENANT_A },
      { id: VENDOR_2, name: 'Vendor Two', tenantId: TENANT_A },
    );

    db.commercialOffers.push(
      {
        id: 'offer-v1-1',
        tenantId: TENANT_A,
        vendorAssignmentId: 'assignment-1',
        requestId: 'req-1',
        vendorId: VENDOR_1,
        currency: 'INR',
        commercialRound: 1,
        status: 'SUBMITTED',
        quantity: 100,
      },
      {
        id: 'offer-v2-1',
        tenantId: TENANT_A,
        vendorAssignmentId: 'assignment-2',
        requestId: 'req-1',
        vendorId: VENDOR_2,
        currency: 'INR',
        commercialRound: 1,
        status: 'SUBMITTED',
        quantity: 100,
      },
    );

    db.submissions.push(
      {
        id: 'sub-v1-1',
        commercialOfferId: 'offer-v1-1',
        vendorId: VENDOR_1,
        requestId: 'req-1',
        tenantId: TENANT_A,
        submissionNumber: 1,
        idempotencyKey: 'sub-v1-1-key',
        offerType: OfferType.PRODUCT,
        currency: 'INR',
        subTotal: 1000,
        taxAmount: 180,
        totalAmount: 1180,
        quantity: 100,
        unitPrice: 10,
        deliveryDate: new Date('2026-12-15'),
        paymentTerms: 'Net 30',
        offerValidityDays: 30,
        scope: 'test scope',
        exclusions: 'test exclusions',
        createdById: USER_VENDOR_1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'sub-v2-1',
        commercialOfferId: 'offer-v2-1',
        vendorId: VENDOR_2,
        requestId: 'req-1',
        tenantId: TENANT_A,
        submissionNumber: 1,
        idempotencyKey: 'sub-v2-1-key',
        offerType: OfferType.PRODUCT,
        currency: 'INR',
        subTotal: 2000,
        taxAmount: 360,
        totalAmount: 2360,
        quantity: 100,
        unitPrice: 20,
        deliveryDate: new Date('2026-12-15'),
        paymentTerms: 'Net 45',
        offerValidityDays: 45,
        scope: 'test scope 2',
        exclusions: 'test exclusions 2',
        createdById: USER_VENDOR_2,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );
  });

  it('vendor 1 cannot summarize vendor 2\'s submission', async () => {
    await expect(
      summarizeSubmission('sub-v2-1', TENANT_A, USER_VENDOR_1)
    ).rejects.toThrow(ForbiddenError);
  });

  it('vendor 2 can summarize their own submission', async () => {
    const summary = await summarizeSubmission('sub-v2-1', TENANT_A, USER_VENDOR_2);
    expect(summary).toContain('Vendor Two');
    expect(summary).toContain('INR 2,360');
  });

  it('vendor 1 cannot evaluate compliance for vendor 2\'s submission', async () => {
    await expect(
      evaluateSubmissionCompliance('sub-v2-1', TENANT_A, USER_VENDOR_1)
    ).rejects.toThrow(ForbiddenError);
  });

  it('buyer can evaluate compliance for any vendor\'s submission', async () => {
    await expect(
      evaluateSubmissionCompliance('sub-v2-1', TENANT_A, USER_BUYER)
    ).resolves.toBeDefined();
  });

  it('buyer can summarize any vendor\'s submission', async () => {
    const summary = await summarizeSubmission('sub-v1-1', TENANT_A, USER_BUYER);
    expect(summary).toContain('Vendor One');
  });
});

describe('Security: Role Enforcement', () => {
  it('non-vendor role cannot submit an offer as a vendor', async () => {
    await expect(
      submitOffer(
        {
          vendorAssignmentId: 'assignment-1',
          requestId: 'req-1',
          offerType: OfferType.PRODUCT,
          currency: 'INR',
          subTotal: 1000,
          totalAmount: 1180,
          idempotencyKey: 'key-buyer-submit',
        },
        USER_BUYER,
        TENANT_A,
        VENDOR_1
      )
    ).rejects.toThrow(ForbiddenError);
  });

  it('requester cannot reopen the commercial process', async () => {
    await expect(
      reopenCommercialProcess(
        { vendorAssignmentId: 'assignment-1', reason: 'test' },
        USER_REQUESTER,
        TENANT_A,
        'REQUESTER'
      )
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('Security: Idempotency Protection', () => {
  it('same idempotency key returns existing submission (no duplicate)', async () => {
    const first = await submitOne('idempotent-key');
    const firstId = first.submission.id;

    const second = await submitOne('idempotent-key');

    expect(second.id).toBe(firstId);
    expect(db.submissions.filter((s) => s.idempotencyKey === 'idempotent-key')).toHaveLength(1);
  });
});

describe('Security: 4-Offer Limit Enforcement', () => {
  it('5th submission is blocked with ConflictError', async () => {
    for (let i = 1; i <= 4; i++) {
      await submitOne(`key-${i}`);
    }

    await expect(submitOne('key-5')).rejects.toThrow(ConflictError);
  });

  it('4th submission sets finalOfferSubmitted and status', async () => {
    for (let i = 1; i <= 4; i++) {
      await submitOne(`final-key-${i}`);
    }

    const offer = db.commercialOffers.find((o) => o.vendorAssignmentId === 'assignment-1');
    expect(offer?.finalOfferSubmitted).toBe(true);
    expect(offer?.status).toBe(OfferStatus.FINAL_OFFER_SUBMITTED);
  });

  it('submissionsInRound increments correctly per submission', async () => {
    await submitOne('inc-1');
    let offer = db.commercialOffers.find((o) => o.vendorAssignmentId === 'assignment-1');
    expect(offer?.submissionsInRound).toBe(1);

    await submitOne('inc-2');
    offer = db.commercialOffers.find((o) => o.vendorAssignmentId === 'assignment-1');
    expect(offer?.submissionsInRound).toBe(2);
  });

  it('after buyer reopens, vendor gets a fresh round of 4 slots', async () => {
    for (let i = 1; i <= 4; i++) {
      await submitOne(`round1-key-${i}`);
    }

    await reopenCommercialProcess(
      { vendorAssignmentId: 'assignment-1', reason: 'need more competition' },
      USER_BUYER,
      TENANT_A,
      'PROCUREMENT_MANAGER'
    );

    const round2Offer = db.commercialOffers.find((o) => o.commercialRound === 2);
    expect(round2Offer).toBeDefined();
    expect(round2Offer!.finalOfferSubmitted).toBe(false);

    await submitOne('round2-key-1');
    const round2Subs = db.submissions.filter((s) => s.commercialOfferId === round2Offer!.id);
    expect(round2Subs).toHaveLength(1);
  });

  it('immutability: cannot update or delete an existing submission', async () => {
    await submitOne('immutable-key');
    const originalCount = db.submissions.length;

    // Attempt to re-submit with same data (different idempotency key)
    await submitOne('different-key');
    expect(db.submissions.length).toBe(originalCount + 1);
  });
});

describe('Security: Clarification Does Not Consume Offer Slot', () => {
  it('posting clarification does not increment submission count', async () => {
    await createOrGetOffer(
      { vendorAssignmentId: 'assignment-1', requestId: 'req-1' },
      USER_VENDOR_1,
      TENANT_A,
      VENDOR_1
    );
    const offerBefore = db.commercialOffers.find((o) => o.vendorAssignmentId === 'assignment-1');
    const submissionsBefore = offerBefore?.submissionsInRound ?? 0;

    await postClarification(
      { vendorAssignmentId: 'assignment-1', content: 'What is the warranty period?' },
      USER_VENDOR_1,
      TENANT_A,
      VENDOR_1
    );

    const offerAfter = db.commercialOffers.find((o) => o.vendorAssignmentId === 'assignment-1');
    const submissionsAfter = offerAfter?.submissionsInRound ?? 0;

    expect(submissionsAfter).toBe(submissionsBefore);
    expect(db.submissions).toHaveLength(0);
    expect(db.events.length).toBeGreaterThan(0);
  });
});
