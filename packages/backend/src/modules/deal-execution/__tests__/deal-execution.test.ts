import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { UserRole, DealExecutionStatus, DealExecutionEventType } from '@navo/shared';
import type { ApprovalActor } from '../../purchase-approvals/approval-roles.js';
import {
  selectFinalOffer,
  submitForFinalApproval,
  createDealFromSubmission,
  advanceExecutionStatus,
  recordExecutionEvent,
  getDealExecutionDetail,
  listDealExecutions,
  createExecutionRecord,
} from '../deal-execution.service.js';
import { ForbiddenError, NotFoundError, ConflictError, ValidationError } from '../../../utils/errors.js';

/**
 * Tests for the Final Approval & Deal Execution Engine.
 *
 * Prisma and the approval-policy, notification, and document-number modules are
 * mocked so every scenario is expressed as an explicit record set. The guarantee
 * under test is *authorization, isolation, state-machine correctness, and
 * idempotency* logic.
 */

interface Row { [key: string]: unknown }

const { db, prismaMock } = vi.hoisted(() => {
  const state = {
    commercialOfferSubmissions: [] as Row[],
    commercialOffers: [] as Row[],
    vendorAssignments: [] as Row[],
    procurementRequests: [] as Row[],
    purchaseApprovalRequests: [] as Row[],
    deals: [] as Row[],
    dealExecutionEvents: [] as Row[],
    auditLogs: [] as Row[],
    notifications: [] as Row[],
    notificationPreferences: [] as Row[],
    purchaseOrders: [] as Row[],
    vendor: [] as Row[],
    users: [] as Row[],
  };

  const mock: Record<string, unknown> = {
    commercialOfferSubmission: {
      findFirst: async ({ where }: { where: Row }) => {
        return state.commercialOfferSubmissions.find((s) => {
          for (const [k, v] of Object.entries(where)) {
            if (s[k] !== v) return false;
          }
          return true;
        }) ?? null;
      },
    },
    commercialOffer: {
      findFirst: async ({ where }: { where: Row }) => {
        return state.commercialOffers.find((o) => {
          for (const [k, v] of Object.entries(where)) {
            if (o[k] !== v) return false;
          }
          return true;
        }) ?? null;
      },
    },
    vendorAssignment: {
      findFirst: async ({ where }: { where: Row }) => {
        return state.vendorAssignments.find((a) => {
          for (const [k, v] of Object.entries(where)) {
            if (a[k] !== v) return false;
          }
          return true;
        }) ?? null;
      },
    },
    procurementRequest: {
      findFirst: async ({ where }: { where: Row }) => {
        return state.procurementRequests.find((r) => {
          for (const [k, v] of Object.entries(where)) {
            if (r[k] !== v) return false;
          }
          return true;
        }) ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const r = state.procurementRequests.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r ?? null;
      },
    },
    purchaseApprovalRequest: {
      findFirst: async ({ where }: { where: Row }) => {
        return state.purchaseApprovalRequests.find((r) => {
          for (const [k, v] of Object.entries(where)) {
            if (k === 'selectedSubmissionId' && v === undefined) continue;
            if (r[k] !== v) return false;
          }
          return true;
        }) ?? null;
      },
      findMany: async ({ where }: { where?: Row }) => {
        if (!where) return state.purchaseApprovalRequests;
        return state.purchaseApprovalRequests.filter((r) => {
          for (const [k, v] of Object.entries(where)) {
            if (k === 'selectedSubmissionId' && v === undefined) continue;
            if (r[k] !== v) return false;
          }
          return true;
        });
      },
      create: async ({ data }: { data: Row }) => {
        const r = { id: `approval-${state.purchaseApprovalRequests.length + 1}`, ...data };
        state.purchaseApprovalRequests.push(r);
        return r;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const r = state.purchaseApprovalRequests.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r ?? null;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        state.purchaseApprovalRequests.forEach((r) => {
          let match = true;
          for (const [k, v] of Object.entries(where)) {
            if (r[k] !== v) {
              match = false;
              break;
            }
          }
          if (match) Object.assign(r, data);
        });
        return { count: 1 };
      },
      count: async () => state.purchaseApprovalRequests.length,
    },
    deal: {
      findFirst: async ({ where, include }: { where?: Row; include?: Record<string, unknown> }) => {
        const whereObj = where || {};
        const d = state.deals.find((d) => {
          for (const [k, v] of Object.entries(whereObj)) {
            if (d[k] !== v) return false;
          }
          return true;
        });
        if (!d) return null;
        if (!include) return d;

        const result = { ...d };
        for (const [key] of Object.entries(include)) {
          if (key === 'request') {
            result.request = state.procurementRequests.find((r) => r.id === d.requestId) ?? null;
          } else if (key === 'vendor') {
            result.vendor = state.vendor.find((v) => v.id === d.vendorId) ?? null;
          } else if (key === 'selectedSubmission') {
            result.selectedSubmission = state.commercialOfferSubmissions.find((s) => s.id === d.selectedSubmissionId) ?? null;
          } else if (key === 'purchaseOrder') {
            result.purchaseOrder = state.purchaseOrders.find((p) => p.dealId === d.id) ?? null;
          } else if (key === 'executionEvents') {
            result.executionEvents = state.dealExecutionEvents.filter((e) => e.dealId === d.id);
          } else if (key === 'purchaseApprovalRequest') {
            result.purchaseApprovalRequest = state.purchaseApprovalRequests.find((a) => a.dealId === d.id) ?? null;
          }
        }
        return result;
      },
      findMany: async ({ where, orderBy, skip, take, select }: Record<string, unknown>) => {
        let results = state.deals.filter((d) => {
          if (!where) return true;
          for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
            if (d[k] !== v) return false;
          }
          return true;
        });
        if (orderBy) {
          const key = Object.keys(orderBy as Record<string, unknown>)[0];
          const dir = (orderBy as Record<string, unknown>)[key];
          results.sort((a, b) => {
            const av = a[key] as string;
            const bv = b[key] as string;
            if (av < bv) return dir === 'desc' ? 1 : -1;
            if (av > bv) return dir === 'desc' ? -1 : 1;
            return 0;
          });
        }
        const skipN = (skip as number) || 0;
        const takeN = (take as number) || results.length;
        if (select) {
          const sel = select as Record<string, boolean>;
          return results.slice(skipN, skipN + takeN).map((d: Row) => {
            const r: Row = {};
            for (const k of Object.keys(sel)) { if (sel[k]) r[k] = d[k]; }
            return r;
          });
        }
        return results.slice(skipN, skipN + takeN);
      },
      count: async ({ where }: { where?: Row }) => {
        if (!where) return state.deals.length;
        return state.deals.filter((d) => {
          for (const [k, v] of Object.entries(where)) {
            if (d[k] !== v) return false;
          }
          return true;
        }).length;
      },
      create: async ({ data }: { data: Row }) => {
        const d = { id: `deal-${state.deals.length + 1}`, ...data };
        state.deals.push(d);
        return d;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const d = state.deals.find((x) => x.id === where.id);
        if (d) Object.assign(d, data);
        return d ?? null;
      },
    },
    dealExecutionEvent: {
      create: async ({ data }: { data: Row }) => {
        const e = { id: `event-${state.dealExecutionEvents.length + 1}`, ...data };
        state.dealExecutionEvents.push(e);
        return e;
      },
      findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Record<string, string> }) => {
        let results = state.dealExecutionEvents.filter((e) => {
          if (!where) return true;
          for (const [k, v] of Object.entries(where)) {
            if (e[k] !== v) return false;
          }
          return true;
        });
        if (orderBy) {
          const key = Object.keys(orderBy)[0];
          const dir = orderBy[key];
          results.sort((a, b) => {
            const av = a[key] as string;
            const bv = b[key] as string;
            if (av < bv) return dir === 'desc' ? 1 : -1;
            if (av > bv) return dir === 'desc' ? -1 : 1;
            return 0;
          });
        }
        return results;
      },
    },
    purchaseOrder: {
      findFirst: async ({ where }: { where: Row }) => {
        return state.purchaseOrders.find((p) => {
          for (const [k, v] of Object.entries(where)) {
            if (p[k] !== v) return false;
          }
          return true;
        }) ?? null;
      },
      create: async ({ data }: { data: Row }) => {
        const po = { id: `po-${state.purchaseOrders.length + 1}`, ...data };
        state.purchaseOrders.push(po);
        return po;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        const a = { id: `audit-${state.auditLogs.length + 1}`, ...data };
        state.auditLogs.push(a);
        return a;
      },
    },
    notification: {
      create: async ({ data }: { data: Row }) => {
        const n = { id: `notif-${state.notifications.length + 1}`, ...data };
        state.notifications.push(n);
        return n;
      },
    },
    notificationPreference: {
      findUnique: async () => null,
    },
    user: {
      findFirst: async ({ where }: { where: Row }) => {
        return state.users.find((u) => {
          for (const [k, v] of Object.entries(where)) {
            if (u[k] !== v) return false;
          }
          return true;
        }) ?? null;
      },
    },
    vendor: {
      findFirst: async ({ where }: { where: Row }) => {
        return state.vendor.find((v) => {
          for (const [k, v2] of Object.entries(where)) {
            if (v[k] !== v2) return false;
          }
          return true;
        }) ?? null;
      },
    },
     $transaction: async (cb: (tx: any) => Promise<unknown>) => {
      return cb(mock);
    },
  };

  return { db: state, prismaMock: mock };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));

vi.mock('../../purchase-approvals/approval-policy.service.js', () => ({
  loadActivePolicy: vi.fn().mockResolvedValue({
    id: 'policy-1',
    version: 1,
    isActive: true,
    currency: 'INR',
    includeTaxesInThreshold: true,
    includeDeliveryChargesInThreshold: true,
    autoApproveBelowAmount: null,
    allowSelfApproval: false,
    splitGuardEnabled: false,
    splitGuardWindowDays: 30,
    reapprovalRules: {},
    rules: [],
  }),
  priceForPolicy: vi.fn().mockResolvedValue({
    unitPrice: new Prisma.Decimal(1000),
    taxRate: new Prisma.Decimal(18),
    subtotal: new Prisma.Decimal(1000),
    taxAmount: new Prisma.Decimal(180),
    freight: new Prisma.Decimal(0),
    installation: new Prisma.Decimal(0),
    other: new Prisma.Decimal(0),
    total: new Prisma.Decimal(1180),
    thresholdAmount: new Prisma.Decimal(1180),
  }),
  resolveApprovalRoute: vi.fn().mockResolvedValue({
    approvalRequired: true,
    reason: 'Requires approval',
    currency: 'INR',
    thresholdAmount: 1180,
    levels: [{ level: 1, requiredRole: 'FINANCE_APPROVER', label: 'Finance Approval' }],
  }),
}));

vi.mock('../../notifications/notification.service.js', () => ({
  notify: vi.fn().mockResolvedValue(null),
  resolveFrequency: vi.fn().mockResolvedValue('IMMEDIATE'),
}));

vi.mock('../../purchase-approvals/purchase-approval.service.js', () => ({
  assertNotSplitPurchase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../utils/documentNumber.js', () => ({
  nextDocumentNumber: vi.fn().mockResolvedValue('PAR-2026-0001'),
}));

vi.mock('../../audit/audit.service.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue({ id: 'audit-1' }),
}));

vi.mock('../../purchase-orders/purchase-order.service.js', () => ({
  createPoFromDeal: vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
    id: `po-test-${Math.random().toString(36).slice(2, 8)}`,
    dealId: input.dealId,
  })),
}));

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const VENDOR_1 = 'vendor-1';
const REQUESTER = 'user-requester';
const APPROVER = 'user-finance-approver';
const VENDOR_USER = 'user-vendor-1';

beforeEach(() => {
  db.commercialOfferSubmissions.length = 0;
  db.commercialOffers.length = 0;
  db.vendorAssignments.length = 0;
  db.procurementRequests.length = 0;
  db.purchaseApprovalRequests.length = 0;
  db.deals.length = 0;
  db.dealExecutionEvents.length = 0;
  db.auditLogs.length = 0;
  db.notifications.length = 0;
  db.notificationPreferences.length = 0;
  db.purchaseOrders.length = 0;
  db.vendor.length = 0;
  db.users.length = 0;

  db.procurementRequests.push({
    id: 'req-1',
    tenantId: TENANT_A,
    title: 'Laptops',
    item: 'Laptop',
    quantity: 10,
    unit: 'units',
    department: 'IT',
    costCenter: 'CC-001',
    location: 'BLR',
    requiredDate: new Date('2026-12-31'),
    status: 'FINAL_COMMERCIAL_SELECTION',
    requesterId: REQUESTER,
  });

  db.vendorAssignments.push({
    id: 'assignment-1',
    tenantId: TENANT_A,
    requestId: 'req-1',
    vendorId: VENDOR_1,
    request: db.procurementRequests[0],
  });

  db.commercialOffers.push({
    id: 'offer-1',
    tenantId: TENANT_A,
    requestId: 'req-1',
    vendorAssignmentId: 'assignment-1',
    vendorId: VENDOR_1,
    offerType: 'PRODUCT',
    currency: 'INR',
    vendor: { id: VENDOR_1, name: 'Vendor Corp' },
    vendorAssignment: db.vendorAssignments[0],
  });

  db.commercialOfferSubmissions.push({
    id: 'sub-1',
    tenantId: TENANT_A,
    commercialOfferId: 'offer-1',
    submissionNumber: 1,
    offerType: 'PRODUCT',
    currency: 'INR',
    subTotal: new Prisma.Decimal(1000),
    taxAmount: new Prisma.Decimal(180),
    totalAmount: new Prisma.Decimal(1180),
    discountAmount: null,
    discountPercentage: null,
    unitPrice: new Prisma.Decimal(1000),
    quantity: 1,
    contractDuration: null,
    numberOfLicenses: null,
    billingFrequency: null,
    subscriptionTerm: null,
    renewalTerms: null,
    implementationFees: null,
    recurringFees: null,
    oneTimeFees: null,
    deliveryDate: new Date('2026-11-15'),
    paymentTerms: 'Net 30',
    offerValidityDays: 30,
    offerValidityDate: new Date('2026-11-30'),
    commercialConditions: 'FOB origin',
    scope: '10 laptops',
    exclusions: 'Software not included',
    supportingDocuments: [],
    complianceStatus: 'COMPLIANT',
    complianceDetails: null,
    submittedAt: new Date('2026-10-01'),
    submittedById: VENDOR_1,
    isFinal: false,
    idempotencyKey: 'key-1',
    createdAt: new Date('2026-10-01'),
    updatedAt: new Date('2026-10-01'),
    commercialOffer: db.commercialOffers[0],
  });

  db.users.push(
    { id: REQUESTER, tenantId: TENANT_A, role: 'REQUESTER', isActive: true, email: 'req@demo.com' },
    { id: APPROVER, tenantId: TENANT_A, role: 'FINANCE_APPROVER', isActive: true, email: 'fin@demo.com' },
    { id: VENDOR_USER, tenantId: TENANT_A, role: 'VENDOR', vendorId: VENDOR_1, isActive: true, email: 'seller@demo.com' },
  );
});

function buyerActor(): ApprovalActor {
  return { userId: REQUESTER, tenantId: TENANT_A, role: UserRole.REQUESTER };
}

function adminActor(): ApprovalActor {
  return { userId: 'admin-1', tenantId: TENANT_A, role: UserRole.PROCUREMENT_MANAGER };
}

function vendorActor(): ApprovalActor {
  return { userId: VENDOR_USER, tenantId: TENANT_A, role: UserRole.VENDOR };
}

function otherTenantActor(): ApprovalActor {
  return { userId: REQUESTER, tenantId: TENANT_B, role: UserRole.REQUESTER };
}

describe('Security: Tenant Isolation', () => {
  it('tenant B cannot select a final offer in tenant A', async () => {
    await expect(selectFinalOffer(otherTenantActor(), 'sub-1')).rejects.toThrow(NotFoundError);
  });

  it('vendor cannot select a final offer', async () => {
    await expect(selectFinalOffer(vendorActor(), 'sub-1')).rejects.toThrow(ForbiddenError);
  });

  it('buyer from tenant B cannot submit for approval on submission in tenant A', async () => {
    await expect(
      submitForFinalApproval(otherTenantActor(), { submissionId: 'sub-1' }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('Security: Role Enforcement', () => {
  it('viewer cannot select final offer', async () => {
    await expect(
      selectFinalOffer({ userId: 'viewer-1', tenantId: TENANT_A, role: UserRole.VIEWER }, 'sub-1'),
    ).rejects.toThrow(ForbiddenError);
  });

  it('viewer cannot submit for approval', async () => {
    await expect(
      submitForFinalApproval({ userId: 'viewer-1', tenantId: TENANT_A, role: UserRole.VIEWER }, { submissionId: 'sub-1' }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('selectFinalOffer: Validation', () => {
  it('throws NotFoundError for non-existent submission', async () => {
    await expect(selectFinalOffer(buyerActor(), 'nonexistent')).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError for non-compliant submission', async () => {
    db.commercialOfferSubmissions[0].complianceStatus = 'NON_COMPLIANT';
    await expect(selectFinalOffer(buyerActor(), 'sub-1')).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for unsubmitted submission', async () => {
    db.commercialOfferSubmissions[0].submittedAt = null;
    await expect(selectFinalOffer(buyerActor(), 'sub-1')).rejects.toThrow(ValidationError);
  });
});

describe('selectFinalOffer: Happy Path', () => {
  it('advances request to FINAL_COMMERCIAL_SELECTION', async () => {
    const result = await selectFinalOffer(buyerActor(), 'sub-1');
    expect(result.requestId).toBe('req-1');
    expect(result.submission.submissionNumber).toBe(1);

    const request = db.procurementRequests.find((r) => r.id === 'req-1');
    expect(request?.status).toBe('FINAL_COMMERCIAL_SELECTION');
  });
});

describe('submitForFinalApproval: Validation', () => {
  it('throws ValidationError if request is not in FINAL_COMMERCIAL_SELECTION', async () => {
    db.procurementRequests[0].status = 'COMPARISON_COMPLETED';
    await expect(
      submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for non-compliant submission', async () => {
    db.commercialOfferSubmissions[0].complianceStatus = 'NON_COMPLIANT';
    await expect(
      submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('submitForFinalApproval: Idempotency', () => {
  it('throws ConflictError if submission already has a live approval request', async () => {
    db.purchaseApprovalRequests.push({
      id: 'approval-1',
      tenantId: TENANT_A,
      selectedSubmissionId: 'sub-1',
      status: 'PENDING_APPROVAL',
      reference: 'PAR-2026-0001',
    });
    await expect(
      submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' }),
    ).rejects.toThrow(ConflictError);
  });

  it('throws ConflictError if submission was already submitted (terminal status)', async () => {
    db.purchaseApprovalRequests.push({
      id: 'approval-1',
      tenantId: TENANT_A,
      selectedSubmissionId: 'sub-1',
      status: 'APPROVED',
      reference: 'PAR-2026-0001',
    });
    await expect(
      submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' }),
    ).rejects.toThrow(ConflictError);
  });
});

describe('submitForFinalApproval: Happy Path', () => {
  it('creates approval request with selectedSubmissionId set', async () => {
    const result = await submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' });
    expect(result.requestId).toBe('req-1');
    expect(result.reference).toBe('PAR-2026-0001');
    expect(result.approvalRequired).toBe(true);

    const approval = db.purchaseApprovalRequests.find((a) => a.selectedSubmissionId === 'sub-1')!;
    expect(approval).toBeDefined();
    expect(approval.selectedSubmissionId).toBe('sub-1');
    expect(approval.offerId).toBeUndefined();
    expect(approval.dealRoomId).toBeUndefined();
    expect(approval.status).toBe('PENDING_APPROVAL');
  });

  it('advances request to PENDING_FINAL_APPROVAL', async () => {
    await submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' });
    const request = db.procurementRequests.find((r) => r.id === 'req-1');
    expect(request?.status).toBe('PENDING_FINAL_APPROVAL');
  });
});

describe('createDealFromSubmission', () => {
  it('throws NotFoundError for non-existent submission', async () => {
    await expect(
      createDealFromSubmission('nonexistent', APPROVER, TENANT_A),
    ).rejects.toThrow(NotFoundError);
  });

  it('creates a deal with PENDING_EXECUTION status', async () => {
    const result = await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
    expect(result.deal.dealNumber).toMatch(/^DEAL-/);
    expect(result.offerType).toBe('PRODUCT');

    const deal = db.deals.find((d) => d.id === result.deal.id)!;
    expect(deal.executionStatus).toBe('PENDING_EXECUTION');
    expect(deal.executionType).toBe('PRODUCTS');
    expect(deal.selectedSubmissionId).toBe('sub-1');
    expect(deal.commercialSnapshot).toBeDefined();
  });

  it('prevents duplicate deal creation for same submission', async () => {
    await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
    await expect(
      createDealFromSubmission('sub-1', APPROVER, TENANT_A),
    ).rejects.toThrow(ValidationError);
  });

  it('links the approval request to the new deal', async () => {
    db.purchaseApprovalRequests.push({
      id: 'approval-1',
      tenantId: TENANT_A,
      selectedSubmissionId: 'sub-1',
      status: 'APPROVED',
      reference: 'PAR-2026-0001',
    });
    const { deal } = await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
    const approval = db.purchaseApprovalRequests.find((a) => a.id === 'approval-1')!;
    expect(approval.dealId).toBe(deal.id);
  });

  it('creates a DEAL_CREATED execution event', async () => {
    await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
    const events = db.dealExecutionEvents.filter((e) => e.type === 'DEAL_CREATED');
    expect(events.length).toBe(1);
    expect(events[0].description).toContain('DEAL-');
  });

  it('advances request status to DEAL_CONFIRMED', async () => {
    await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
    const request = db.procurementRequests.find((r) => r.id === 'req-1');
    expect(request?.status).toBe('DEAL_CONFIRMED');
  });
});

describe('createDealFromSubmission: Execution Type Mapping', () => {
  it('maps SERVICE to SERVICES execution type', async () => {
    db.commercialOfferSubmissions[0].offerType = 'SERVICE';
    const { deal } = await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
    const d = db.deals.find((x) => x.id === deal.id)!;
    expect(d.executionType).toBe('SERVICES');
  });

  it('maps SOFTWARE_SUBSCRIPTION to SAAS_SUBSCRIPTION', async () => {
    db.commercialOfferSubmissions[0].offerType = 'SOFTWARE_SUBSCRIPTION';
    const { deal } = await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
    const d = db.deals.find((x) => x.id === deal.id)!;
    expect(d.executionType).toBe('SAAS_SUBSCRIPTION');
  });
});

describe('advanceExecutionStatus: State Machine', () => {
  beforeEach(async () => {
    await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
  });

  it('allows PENDING_EXECUTION -> SUPPLIER_CONFIRMED', async () => {
    const deal = db.deals[0];
    const result = await advanceExecutionStatus(buyerActor(), deal.id as string, {
      status: DealExecutionStatus.SUPPLIER_CONFIRMED,
    });
    expect(result.executionStatus).toBe(DealExecutionStatus.SUPPLIER_CONFIRMED);
  });

  it('allows PENDING_EXECUTION -> IN_PROGRESS', async () => {
    const deal = db.deals[0];
    const result = await advanceExecutionStatus(buyerActor(), deal.id as string, {
      status: DealExecutionStatus.IN_PROGRESS,
    });
    expect(result.executionStatus).toBe(DealExecutionStatus.IN_PROGRESS);
  });

  it('allows PENDING_EXECUTION -> CANCELLED with reason', async () => {
    const deal = db.deals[0];
    const result = await advanceExecutionStatus(buyerActor(), deal.id as string, {
      status: DealExecutionStatus.CANCELLED,
      cancellationReason: 'Budget cut',
    });
    expect(result.executionStatus).toBe(DealExecutionStatus.CANCELLED);
  });

  it('throws ValidationError when cancelling without reason', async () => {
    const deal = db.deals[0];
    await expect(
      advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.CANCELLED }),
    ).rejects.toThrow(ValidationError);
  });

  it('prevents invalid transition PENDING_EXECUTION -> CLOSED', async () => {
    const deal = db.deals[0];
    await expect(
      advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.CLOSED }),
    ).rejects.toThrow(ValidationError);
  });

  it('prevents invalid transition PENDING_EXECUTION -> FULFILLED', async () => {
    const deal = db.deals[0];
    await expect(
      advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.FULFILLED }),
    ).rejects.toThrow(ValidationError);
  });

  it('allows SUPPLIER_CONFIRMED -> IN_PROGRESS', async () => {
    const deal = db.deals[0];
    await advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.SUPPLIER_CONFIRMED });
    const result = await advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.IN_PROGRESS });
    expect(result.executionStatus).toBe(DealExecutionStatus.IN_PROGRESS);
  });

  it('allows IN_PROGRESS -> FULFILLED -> CLOSED', async () => {
    const deal = db.deals[0];
    await advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.IN_PROGRESS });
    await advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.FULFILLED });
    const result = await advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.CLOSED });
    expect(result.executionStatus).toBe(DealExecutionStatus.CLOSED);
  });

  it('blocks terminal state transitions', async () => {
     const deal = db.deals[0];
     await advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.IN_PROGRESS });
     await advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.FULFILLED });
     await advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.CLOSED });
     await expect(
       advanceExecutionStatus(buyerActor(), deal.id as string, { status: DealExecutionStatus.IN_PROGRESS }),
     ).rejects.toThrow(ValidationError);
   });

  it('blocks vendor from advancing execution', async () => {
    const deal = db.deals[0];
    await expect(
      advanceExecutionStatus(vendorActor(), deal.id as string, { status: DealExecutionStatus.SUPPLIER_CONFIRMED }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('recordExecutionEvent', () => {
  beforeEach(async () => {
    await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
  });

  it('records an event against a deal', async () => {
    const deal = db.deals[0];
    const result = await recordExecutionEvent(buyerActor(), deal.id as string, {
      type: DealExecutionEventType.GOODS_RECEIVED,
      description: '10 laptops received and inspected',
      metadata: { receiptNumber: 'GR-2026-0001' },
    });
    expect(result.eventId).toBeDefined();

    const events = db.dealExecutionEvents.filter((e) => e.dealId === deal.id);
    expect(events.length).toBeGreaterThan(1);
  });

  it('throws NotFoundError for non-existent deal', async () => {
    await expect(
      recordExecutionEvent(buyerActor(), 'nonexistent', {
        type: DealExecutionEventType.GOODS_RECEIVED,
        description: 'test',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('blocks vendor from recording events', async () => {
    const deal = db.deals[0];
    await expect(
      recordExecutionEvent(vendorActor(), deal.id as string, {
        type: DealExecutionEventType.GOODS_RECEIVED,
        description: 'test',
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('getDealExecutionDetail', () => {
  beforeEach(async () => {
    await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
  });

  it('returns deal with execution context', async () => {
    const deal = db.deals[0];
    const result = await getDealExecutionDetail(buyerActor(), deal.id as string) as {
      deal: { dealNumber: string; executionStatus: string; commercialSnapshot: unknown };
      executionEvents: unknown[];
    };
    expect(result.deal.dealNumber).toMatch(/^DEAL-/);
    expect(result.deal.executionStatus).toBe('PENDING_EXECUTION');
    expect(result.deal.commercialSnapshot).toBeDefined();
    expect(result.executionEvents).toBeDefined();
  });

  it('throws NotFoundError for non-existent deal', async () => {
    await expect(
      getDealExecutionDetail(buyerActor(), 'nonexistent'),
    ).rejects.toThrow(NotFoundError);
  });

  it('blocks vendor from reading deal execution detail', async () => {
    const deal = db.deals[0];
    await expect(
      getDealExecutionDetail(vendorActor(), deal.id as string),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('listDealExecutions', () => {
  beforeEach(async () => {
    await createDealFromSubmission('sub-1', APPROVER, TENANT_A);
  });

  it('returns deals for the tenant', async () => {
    const result = await listDealExecutions(buyerActor(), {});
    expect(result.deals.length).toBeGreaterThanOrEqual(1);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('filters by execution status', async () => {
    const result = await listDealExecutions(buyerActor(), { status: DealExecutionStatus.PENDING_EXECUTION });
    expect(result.deals.every((d) => d.executionStatus === DealExecutionStatus.PENDING_EXECUTION)).toBe(true);
  });

  it('isolates tenants', async () => {
    const result = await listDealExecutions(otherTenantActor(), {});
    expect(result.deals).toHaveLength(0);
  });
});
