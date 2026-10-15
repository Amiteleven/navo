import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  UserRole,
  DealExecutionStatus,
  DealExecutionEventType,
  PurchaseApprovalStatus,
} from '@navo/shared';
import type { ApprovalActor } from '../../purchase-approvals/approval-roles.js';
import {
  selectFinalOffer,
  submitForFinalApproval,
  advanceExecutionStatus,
  recordExecutionEvent,
  getDealExecutionDetail,
} from '../deal-execution.service.js';
import { decidePurchaseApproval, confirmPurchase } from '../../purchase-approvals/purchase-approval.service.js';
import { loadActivePolicy, resolveApprovalRoute } from '../../purchase-approvals/approval-policy.service.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../utils/errors.js';

interface Row { [key: string]: unknown }

const { db, prismaMock } = vi.hoisted(() => {
  const state: Record<string, Row[]> = {
    commercialOfferSubmissions: [],
    commercialOffers: [],
    vendorAssignments: [],
    procurementRequests: [],
    purchaseApprovalRequests: [],
    purchaseApprovalDecisions: [],
    purchaseApprovalPolicies: [],
    deals: [],
    dealExecutionEvents: [],
    auditLogs: [],
    notifications: [],
    purchaseOrders: [],
    vendor: [],
    users: [],
  };

  function resolveApprovalIncludes(approval: Row, include: Record<string, unknown>): Record<string, unknown> {
    const result = { ...approval };
    for (const [key] of Object.entries(include)) {
      if (key === 'decisions') {
        const decisions = (state.purchaseApprovalDecisions as Row[])
          .filter((d) => d.purchaseApprovalRequestId === approval.id)
          .sort((a, b) => (a.level as number) - (b.level as number));
        if (include.decisions && typeof include.decisions === 'object' && include.decisions !== null) {
          const decInclude = include.decisions as Record<string, unknown>;
          if (decInclude.include) {
            const subInclude = decInclude.include as Record<string, unknown>;
            result.decisions = decisions.map((d) => {
              const r = { ...d };
              for (const [sk] of Object.entries(subInclude)) {
                if (sk === 'assignedApprover' || sk === 'decidedBy') {
                  const sel = subInclude[sk] as Record<string, unknown>;
                  const fields = (sel as Record<string, unknown>).select as Record<string, boolean> | undefined;
                  const u = (state.users as Row[]).find((u) => u.id === d[sk === 'assignedApprover' ? 'assignedApproverId' : 'decidedById']);
                  if (u && fields) {
                    const filtered: Row = {};
                    for (const k of Object.keys(fields)) { if (fields[k]) filtered[k] = u[k]; }
                    r[sk] = filtered;
                  } else {
                    r[sk] = u ?? null;
                  }
                }
              }
              return r;
            });
          } else {
            result.decisions = decisions;
          }
        } else {
          result.decisions = decisions;
        }
      } else if (key === 'policy') {
        result.policy = (state.purchaseApprovalPolicies as Row[]).find((p) => p.id === approval.policyId) ?? null;
      } else if (key === 'vendor') {
        result.vendor = (state.vendor as Row[]).find((v) => v.id === approval.vendorId) ?? null;
      } else if (key === 'request') {
        const r = (state.procurementRequests as Row[]).find((r) => r.id === approval.requestId);
        if (!r) { result.request = null; continue; }
        const sel = include.request as Record<string, unknown>;
        if (sel.select) {
          const fields = sel.select as Record<string, boolean>;
          const filtered: Row = {};
          for (const k of Object.keys(fields)) { if (fields[k]) filtered[k] = r[k]; }
          result.request = filtered;
        } else {
          result.request = r;
        }
      } else if (key === 'submittedBy') {
        const u = (state.users as Row[]).find((u) => u.id === approval.submittedById);
        if (!u) { result.submittedBy = null; continue; }
        const sel = include.submittedBy as Record<string, unknown>;
        if (sel.select) {
          const fields = sel.select as Record<string, boolean>;
          const filtered: Row = {};
          for (const k of Object.keys(fields)) { if (fields[k]) filtered[k] = u[k]; }
          result.submittedBy = filtered;
        } else {
          result.submittedBy = u;
        }
      } else if (key === 'purchaseOrder') {
        result.purchaseOrder = (state.purchaseOrders as Row[]).find((p) => p.id === approval.purchaseOrderId) ?? null;
      } else if (key === 'appliedRule') {
        result.appliedRule = null;
      } else if (key === 'offer') {
        result.offer = null;
      }
    }
    return result;
  }

  function resolveSubmissionIncludes(submission: Row, include: Record<string, unknown>): Record<string, unknown> {
    const result = { ...submission };
    for (const [key] of Object.entries(include)) {
      if (key === 'commercialOffer') {
        const offer = (state.commercialOffers as Row[]).find((o) => o.id === submission.commercialOfferId);
        result.commercialOffer = offer ? resolveOfferIncludes(offer, include.commercialOffer as Record<string, unknown>) : null;
      }
    }
    return result;
  }

  function resolveOfferIncludes(offer: Row, include: Record<string, unknown>): Record<string, unknown> {
    const result = { ...offer };
    for (const [key] of Object.entries(include)) {
      if (key === 'vendor') {
        result.vendor = (state.vendor as Row[]).find((v) => v.id === offer.vendorId) ?? null;
      } else if (key === 'vendorAssignment') {
        const va = (state.vendorAssignments as Row[]).find((a) => a.id === offer.vendorAssignmentId);
        if (!va) { result.vendorAssignment = null; continue; }
        const subInclude = include.vendorAssignment as Record<string, unknown>;
        const vaResult = { ...va };
        for (const [vaKey] of Object.entries(subInclude)) {
          if (vaKey === 'request') {
            vaResult.request = (state.procurementRequests as Row[]).find((r) => r.id === va.requestId) ?? null;
          }
          if (vaKey === 'vendor') {
            vaResult.vendor = (state.vendor as Row[]).find((v) => v.id === va.vendorId) ?? null;
          }
        }
        result.vendorAssignment = vaResult;
      }
    }
    return result;
  }

  function matchWhere(obj: Row, where?: Row): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'selectedSubmissionId' && v === undefined) continue;
      if (k === 'status' && Array.isArray(v)) {
        if (!v.includes(obj[k])) return false;
        continue;
      }
      if (obj[k] !== v) return false;
    }
    return true;
  }

  const mock: Record<string, unknown> = {
    commercialOfferSubmission: {
      findFirst: async ({ where, include }: { where?: Row; include?: Record<string, unknown> }) => {
        const s = (state.commercialOfferSubmissions as Row[]).find((s) => matchWhere(s, where));
        if (!s) return null;
        if (!include) return s;
        return resolveSubmissionIncludes(s, include);
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const s = (state.commercialOfferSubmissions as Row[]).find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return s ?? null;
      },
    },
    commercialOffer: {
      findFirst: async ({ where, include }: { where?: Row; include?: Record<string, unknown> }) => {
        const o = (state.commercialOffers as Row[]).find((o) => matchWhere(o, where));
        if (!o) return null;
        if (!include) return o;
        return resolveOfferIncludes(o, include);
      },
    },
    vendorAssignment: {
      findMany: async ({ where }: { where?: Row }) => {
        if (!where) return state.vendorAssignments;
        return (state.vendorAssignments as Row[]).filter((a) => matchWhere(a, where));
      },
      findFirst: async ({ where }: { where?: Row }) => {
        return (state.vendorAssignments as Row[]).find((a) => matchWhere(a, where)) ?? null;
      },
    },
    procurementRequest: {
      findFirst: async ({ where, select }: { where?: Row; select?: Record<string, boolean> }) => {
        const r = (state.procurementRequests as Row[]).find((r) => matchWhere(r, where));
        if (!r) return null;
        if (!select) return r;
        const sel: Row = {};
        for (const k of Object.keys(select)) { if (select[k]) sel[k] = r[k]; }
        return sel;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const r = (state.procurementRequests as Row[]).find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r ?? null;
      },
    },
    purchaseApprovalRequest: {
      findFirst: async ({ where, include }: { where?: Row; include?: Record<string, unknown> }) => {
        const r = (state.purchaseApprovalRequests as Row[]).find((r) => matchWhere(r, where));
        if (!r) return null;
        if (!include) return r;
        return resolveApprovalIncludes(r, include);
      },
      findMany: async ({ where, include }: { where?: Row; include?: Record<string, unknown> }) => {
        let results = (state.purchaseApprovalRequests as Row[]).filter((r) => matchWhere(r, where));
        if (include) {
          results = results.map((r) => resolveApprovalIncludes(r, include));
        }
        return results;
      },
      create: async ({ data }: { data: Row }) => {
        const r: Row = { id: `approval-${state.purchaseApprovalRequests.length + 1}`, ...data };
        (state.purchaseApprovalRequests as Row[]).push(r);
        if (data.decisions && typeof data.decisions === 'object' && (data.decisions as Row).create) {
          const decisions = (data.decisions as Row).create as Row[];
          for (const dec of decisions) {
            const d: Row = {
              id: `decision-${state.purchaseApprovalDecisions.length + 1}`,
              purchaseApprovalRequestId: r.id,
              tenantId: r.tenantId,
              ...dec,
            };
            (state.purchaseApprovalDecisions as Row[]).push(d);
          }
        }
        return r;
      },
      update: async ({ where, data, include }: { where: { id: string }; data: Row; include?: Record<string, unknown> }) => {
        const r = (state.purchaseApprovalRequests as Row[]).find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        if (!r) return null;
        if (include) return resolveApprovalIncludes(r, include);
        return r;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const r of (state.purchaseApprovalRequests as Row[])) {
          if (matchWhere(r, where)) { Object.assign(r, data); count++; }
        }
        return { count };
      },
      count: async ({ where }: { where?: Row }) => {
        if (!where) return state.purchaseApprovalRequests.length;
        return (state.purchaseApprovalRequests as Row[]).filter((r) => matchWhere(r, where)).length;
      },
    },
    purchaseApprovalDecision: {
      findFirst: async ({ where, include }: { where?: Row; include?: Record<string, unknown> }) => {
        const d = (state.purchaseApprovalDecisions as Row[]).find((d) => matchWhere(d, where));
        if (!d) return null;
        if (!include) return d;

        const result = { ...d };
        for (const [key] of Object.entries(include)) {
          if (key === 'purchaseApprovalRequest') {
            const approval = (state.purchaseApprovalRequests as Row[]).find((r) => r.id === d.purchaseApprovalRequestId);
            if (!approval) { result.purchaseApprovalRequest = null; continue; }
            const subInclude = include.purchaseApprovalRequest as Record<string, unknown>;
            if (subInclude.include) {
              result.purchaseApprovalRequest = resolveApprovalIncludes(approval, subInclude.include as Record<string, unknown>);
            } else {
              result.purchaseApprovalRequest = approval;
            }
          }
        }
        return result;
      },
      findMany: async ({ where }: { where?: Row }) => {
        if (!where) return state.purchaseApprovalDecisions;
        return (state.purchaseApprovalDecisions as Row[]).filter((d) => matchWhere(d, where));
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const d of (state.purchaseApprovalDecisions as Row[])) {
          if (matchWhere(d, where)) { Object.assign(d, data); count++; }
        }
        return { count };
      },
      create: async ({ data }: { data: Row }) => {
        const d = { id: `decision-${state.purchaseApprovalDecisions.length + 1}`, ...data };
        (state.purchaseApprovalDecisions as Row[]).push(d);
        return d;
      },
    },
    purchaseApprovalPolicy: {
      findFirst: async ({ where }: { where?: Row }) => {
        return (state.purchaseApprovalPolicies as Row[]).find((p) => matchWhere(p, where)) ?? null;
      },
    },
    deal: {
      findFirst: async ({ where, include }: { where?: Row; include?: Record<string, unknown> }) => {
        const d = (state.deals as Row[]).find((d) => matchWhere(d, where));
        if (!d) return null;
        if (!include) return d;

        const result = { ...d };
        for (const [key] of Object.entries(include)) {
          if (key === 'request') {
            result.request = (state.procurementRequests as Row[]).find((r) => r.id === d.requestId) ?? null;
          } else if (key === 'vendor') {
            result.vendor = (state.vendor as Row[]).find((v) => v.id === d.vendorId) ?? null;
          } else if (key === 'selectedSubmission') {
            result.selectedSubmission = (state.commercialOfferSubmissions as Row[]).find((s) => s.id === d.selectedSubmissionId) ?? null;
          } else if (key === 'purchaseOrder') {
            result.purchaseOrder = (state.purchaseOrders as Row[]).find((p) => p.dealId === d.id) ?? null;
          } else if (key === 'executionEvents') {
            result.executionEvents = (state.dealExecutionEvents as Row[]).filter((e) => e.dealId === d.id);
          } else if (key === 'purchaseApprovalRequest') {
            result.purchaseApprovalRequest = (state.purchaseApprovalRequests as Row[]).find((a) => a.dealId === d.id) ?? null;
          }
        }
        return result;
      },
      findMany: async ({ where, orderBy, skip, take, select }: Record<string, unknown>) => {
        let results = (state.deals as Row[]).filter((d) => matchWhere(d, where as Row));
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
        return (state.deals as Row[]).filter((d) => matchWhere(d, where)).length;
      },
      create: async ({ data }: { data: Row }) => {
        const d = { id: `deal-${state.deals.length + 1}`, ...data };
        (state.deals as Row[]).push(d);
        return d;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const d = (state.deals as Row[]).find((x) => x.id === where.id);
        if (d) Object.assign(d, data);
        return d ?? null;
      },
    },
    dealExecutionEvent: {
      create: async ({ data }: { data: Row }) => {
        const e = { id: `event-${state.dealExecutionEvents.length + 1}`, ...data };
        (state.dealExecutionEvents as Row[]).push(e);
        return e;
      },
      findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Record<string, string> }) => {
        let results = (state.dealExecutionEvents as Row[]).filter((e) => matchWhere(e, where));
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
        return (state.purchaseOrders as Row[]).find((p) => matchWhere(p, where)) ?? null;
      },
      create: async ({ data }: { data: Row }) => {
        const po = { id: `po-${state.purchaseOrders.length + 1}`, ...data };
        (state.purchaseOrders as Row[]).push(po);
        return po;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        const a = { id: `audit-${state.auditLogs.length + 1}`, ...data };
        (state.auditLogs as Row[]).push(a);
        return a;
      },
    },
    notification: {
      create: async ({ data }: { data: Row }) => {
        const n = { id: `notif-${state.notifications.length + 1}`, ...data };
        (state.notifications as Row[]).push(n);
        return n;
      },
    },
    notificationPreference: {
      findUnique: async () => null,
    },
    user: {
      findFirst: async ({ where, select }: { where?: Row; select?: Record<string, boolean> }) => {
        const u = (state.users as Row[]).find((u) => matchWhere(u, where));
        if (!u) return null;
        if (!select) return u;
        const sel: Row = {};
        for (const k of Object.keys(select)) { if (select[k]) sel[k] = u[k]; }
        return sel;
      },
    },
    vendor: {
      findFirst: async ({ where }: { where?: Row }) => {
        return (state.vendor as Row[]).find((v) => matchWhere(v, where)) ?? null;
      },
    },
     $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb(mock);
    },
  };

  return { db: state, prismaMock: mock };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));

vi.mock('../../purchase-approvals/approval-policy.service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../purchase-approvals/approval-policy.service.js')>();
  return {
    ...actual,
    loadActivePolicy: vi.fn(),
    resolveApprovalRoute: vi.fn(),
  };
});

vi.mock('../negotiation/negotiation.service.js', () => ({
  finalizeAcceptedOffer: vi.fn().mockResolvedValue({ deal: { id: 'deal-dummy', dealNumber: 'DEAL-DUMMY' } }),
}));

vi.mock('../../notifications/notification.service.js', () => ({
  notify: vi.fn().mockResolvedValue(null),
  resolveFrequency: vi.fn().mockResolvedValue('IMMEDIATE'),
}));

vi.mock('../audit/audit.service.js', () => ({
  createAuditLog: vi.fn().mockResolvedValue({ id: 'audit-1' }),
}));

vi.mock('../../../utils/documentNumber.js', () => ({
  nextDocumentNumber: vi.fn().mockResolvedValue('PAR-2026-0001'),
}));

vi.mock('../purchase-orders/purchase-order.service.js', () => ({
  createPoFromDeal: vi.fn().mockImplementation(async (input: Record<string, unknown>) => ({
    id: `po-${(db as Record<string, Row[]>).purchaseOrders.length + 1}`,
    dealId: (input as Record<string, unknown>).dealId,
  })),
}));

const state = db as Record<string, Row[]>;

const TENANT_A = 'tenant-a';
const VENDOR_1 = 'vendor-1';
const VENDOR_2 = 'vendor-2';
const REQUESTER = 'user-requester';
const APPROVER = 'user-finance-approver';
const VENDOR_USER_1 = 'user-vendor-1';
const VENDOR_USER_2 = 'user-vendor-2';

function buyerActor(): ApprovalActor {
  return { userId: REQUESTER, tenantId: TENANT_A, role: UserRole.REQUESTER };
}

function approverActor(): ApprovalActor {
  return { userId: APPROVER, tenantId: TENANT_A, role: UserRole.FINANCE_APPROVER };
}

function vendorActor1(): ApprovalActor {
  return { userId: VENDOR_USER_1, tenantId: TENANT_A, role: UserRole.VENDOR };
}

function otherTenantActor(): ApprovalActor {
  return { userId: REQUESTER, tenantId: 'tenant-b', role: UserRole.REQUESTER };
}

function resetState() {
  for (const key of Object.keys(state)) {
    (state as Record<string, Row[]>)[key] = [];
  }
}

function setupTwoVendorScenario() {
  resetState();

  state.users.push(
    { id: REQUESTER, tenantId: TENANT_A, role: 'REQUESTER', isActive: true, email: 'req@demo.com', firstName: 'Req', lastName: 'Buyer' },
    { id: APPROVER, tenantId: TENANT_A, role: 'FINANCE_APPROVER', isActive: true, email: 'fin@demo.com', firstName: 'Fin', lastName: 'Approver' },
    { id: VENDOR_USER_1, tenantId: TENANT_A, role: 'VENDOR', vendorId: VENDOR_1, isActive: true, email: 's1@demo.com', firstName: 'V1', lastName: 'Seller' },
    { id: VENDOR_USER_2, tenantId: TENANT_A, role: 'VENDOR', vendorId: VENDOR_2, isActive: true, email: 's2@demo.com', firstName: 'V2', lastName: 'Seller' },
  );

  state.vendor.push(
    { id: VENDOR_1, name: 'Vendor Corp A', email: 'vendor1@demo.com', tenantId: TENANT_A },
    { id: VENDOR_2, name: 'Vendor Corp B', email: 'vendor2@demo.com', tenantId: TENANT_A },
  );

  state.purchaseApprovalPolicies.push({
    id: 'policy-1',
    tenantId: TENANT_A,
    name: 'Default Policy',
    currency: 'INR',
    isActive: true,
    version: 1,
    includeTaxesInThreshold: true,
    includeDeliveryChargesInThreshold: true,
    autoApproveBelowAmount: null,
    allowSelfApproval: false,
    selfApprovalJustification: null,
    splitGuardEnabled: false,
    splitGuardWindowDays: 30,
    reapprovalRules: { priceIncrease: true, priceDecrease: false, quantityChange: true, paymentTermsChange: true, deliveryTermsChange: true, otherTermsChange: false },
    rules: [],
  });

  vi.mocked(loadActivePolicy).mockResolvedValue(state.purchaseApprovalPolicies[0] as any);
  vi.mocked(resolveApprovalRoute).mockResolvedValue({
    approvalRequired: true,
    reason: 'Requires approval',
    currency: 'INR',
    thresholdAmount: 59000,
    levels: [{ level: 1, requiredRole: UserRole.FINANCE_APPROVER, label: 'Finance Approval' }],
  });
}

function setupProcurementRequest() {
  state.procurementRequests.push({
    id: 'req-1',
    tenantId: TENANT_A,
    title: 'Server Infrastructure',
    item: 'Server',
    quantity: 5,
    unit: 'units',
    department: 'IT',
    costCenter: 'CC-001',
    location: 'BLR',
    requiredDate: new Date('2026-12-31'),
    status: 'FINAL_COMMERCIAL_SELECTION',
    requesterId: REQUESTER,
  });

  state.vendorAssignments.push(
    { id: 'va-1', tenantId: TENANT_A, requestId: 'req-1', vendorId: VENDOR_1, request: state.procurementRequests[0] },
    { id: 'va-2', tenantId: TENANT_A, requestId: 'req-1', vendorId: VENDOR_2, request: state.procurementRequests[0] },
  );

  state.commercialOffers.push(
    {
      id: 'offer-1', tenantId: TENANT_A, requestId: 'req-1', vendorAssignmentId: 'va-1',
      vendorId: VENDOR_1, offerType: 'PRODUCT', currency: 'INR',
      vendor: { id: VENDOR_1, name: 'Vendor Corp A' }, vendorAssignment: state.vendorAssignments[0],
    },
    {
      id: 'offer-2', tenantId: TENANT_A, requestId: 'req-1', vendorAssignmentId: 'va-2',
      vendorId: VENDOR_2, offerType: 'PRODUCT', currency: 'INR',
      vendor: { id: VENDOR_2, name: 'Vendor Corp B' }, vendorAssignment: state.vendorAssignments[1],
    },
  );

  state.commercialOfferSubmissions.push(
    {
      id: 'sub-1', tenantId: TENANT_A, commercialOfferId: 'offer-1',
      submissionNumber: 1, offerType: 'PRODUCT', currency: 'INR',
      subTotal: new Prisma.Decimal(50000), taxAmount: new Prisma.Decimal(9000),
      totalAmount: new Prisma.Decimal(59000), discountAmount: null,
      discountPercentage: null, unitPrice: new Prisma.Decimal(50000), quantity: 5,
      contractDuration: null, numberOfLicenses: null, billingFrequency: null,
      subscriptionTerm: null, renewalTerms: null, implementationFees: null,
      recurringFees: null, oneTimeFees: null, deliveryDate: new Date('2026-11-30'),
      paymentTerms: 'Net 30', offerValidityDays: 30, offerValidityDate: new Date('2026-11-30'),
      commercialConditions: 'FOB origin', scope: '5 servers', exclusions: 'No warranties',
      supportingDocuments: [], complianceStatus: 'COMPLIANT', complianceDetails: null,
      submittedAt: new Date('2026-10-01'), submittedById: VENDOR_USER_1, isFinal: false,
      idempotencyKey: 'key-1', createdAt: new Date('2026-10-01'), updatedAt: new Date('2026-10-01'),
      commercialOffer: state.commercialOffers[0],
    },
    {
      id: 'sub-2', tenantId: TENANT_A, commercialOfferId: 'offer-2',
      submissionNumber: 1, offerType: 'PRODUCT', currency: 'INR',
      subTotal: new Prisma.Decimal(48000), taxAmount: new Prisma.Decimal(8640),
      totalAmount: new Prisma.Decimal(56640), discountAmount: null,
      discountPercentage: null, unitPrice: new Prisma.Decimal(48000), quantity: 5,
      contractDuration: null, numberOfLicenses: null, billingFrequency: null,
      subscriptionTerm: null, renewalTerms: null, implementationFees: null,
      recurringFees: null, oneTimeFees: null, deliveryDate: new Date('2026-12-15'),
      paymentTerms: 'Net 45', offerValidityDays: 30, offerValidityDate: new Date('2026-11-30'),
      commercialConditions: 'FOB origin', scope: '5 servers', exclusions: 'No warranties',
      supportingDocuments: [], complianceStatus: 'COMPLIANT', complianceDetails: null,
      submittedAt: new Date('2026-10-01'), submittedById: VENDOR_USER_2, isFinal: false,
      idempotencyKey: 'key-2', createdAt: new Date('2026-10-01'), updatedAt: new Date('2026-10-01'),
      commercialOffer: state.commercialOffers[1],
    },
  );
}

beforeEach(() => {
  setupTwoVendorScenario();
  setupProcurementRequest();
});

async function runToApproval(): Promise<string> {
  await selectFinalOffer(buyerActor(), 'sub-1');
  await submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' });
  const approval = state.purchaseApprovalRequests[0];
  const decisions = (state.purchaseApprovalDecisions as Row[]).filter((d) => d.purchaseApprovalRequestId === approval.id);
  await decidePurchaseApproval(decisions[0].id as string, approverActor(), { status: 'APPROVED' });
  return approval.id as string;
}

async function runToConfirmation(): Promise<string> {
  const approvalId = await runToApproval();
  await confirmPurchase(approvalId, buyerActor());
  return (state.deals[0]?.id as string) ?? '';
}

describe('Complete Workflow: Two-Vendor Comparison', () => {
  it('sets up two vendor submissions correctly', () => {
    expect(state.commercialOfferSubmissions.length).toBe(2);
    expect(state.commercialOffers.length).toBe(2);
    expect(state.vendor.length).toBe(2);
  });

  it('buyer compares two vendor submissions', () => {
    const sub1 = state.commercialOfferSubmissions.find((s) => s.id === 'sub-1')!;
    const sub2 = state.commercialOfferSubmissions.find((s) => s.id === 'sub-2')!;
    expect((sub1.commercialOffer! as Row).vendorId as string).toBe(VENDOR_1);
    expect((sub2.commercialOffer! as Row).vendorId as string).toBe(VENDOR_2);
    expect(sub1.totalAmount).not.toEqual(sub2.totalAmount);
  });
});

describe('Complete Workflow: Approval Gating', () => {
  it('selected offer cannot be confirmed before final approval', async () => {
    await selectFinalOffer(buyerActor(), 'sub-1');

    const requeued = state.procurementRequests.find((r) => r.id === 'req-1')!;
    expect(requeued.status).toBe('FINAL_COMMERCIAL_SELECTION');

    await submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' });
    const approval = state.purchaseApprovalRequests[0];
    expect(approval.status).toBe(PurchaseApprovalStatus.PENDING_APPROVAL);

    await expect(confirmPurchase(approval.id as string, buyerActor())).rejects.toThrow(ConflictError);
  });

  it('approved offer can be confirmed after final approval', async () => {
    const approvalId = await runToApproval();

    const approval = state.purchaseApprovalRequests[0];
    expect(approval.status).toBe(PurchaseApprovalStatus.APPROVED);
    expect(state.deals.length).toBe(1);
    expect(state.deals[0].executionStatus).toBe('PENDING_EXECUTION');

    const confirmed = await confirmPurchase(approvalId, buyerActor());
    expect(confirmed.status).toBe(PurchaseApprovalStatus.PURCHASE_CONFIRMED);
  });

  it('tenant B cannot confirm a purchase for tenant A', async () => {
    const approvalId = await runToApproval();
    await expect(confirmPurchase(approvalId, otherTenantActor())).rejects.toThrow();
  });
});

describe('Complete Workflow: Reapproval on Term Changes', () => {
  it('changing unit price after approval triggers reapproval', async () => {
    const approvalId = await runToApproval();

    const submission = state.commercialOfferSubmissions.find((s) => s.id === 'sub-1')!;
    submission.unitPrice = new Prisma.Decimal(60000);
    submission.subTotal = new Prisma.Decimal(60000);
    submission.totalAmount = new Prisma.Decimal(69600);

    await expect(confirmPurchase(approvalId, buyerActor())).rejects.toThrow(ConflictError);
  });

  it('changing payment terms after approval triggers reapproval', async () => {
    const approvalId = await runToApproval();

    const submission = state.commercialOfferSubmissions.find((s) => s.id === 'sub-1')!;
    submission.paymentTerms = 'Net 90';

    await expect(confirmPurchase(approvalId, buyerActor())).rejects.toThrow(ConflictError);
  });

  it('no changes after approval allows confirmation', async () => {
    const approvalId = await runToApproval();

    const confirmed = await confirmPurchase(approvalId, buyerActor());
    expect(confirmed.status).toBe(PurchaseApprovalStatus.PURCHASE_CONFIRMED);
  });
});

describe('Complete Workflow: Execution Path', () => {
  it('deal follows execution state machine: PENDING_EXECUTION -> IN_PROGRESS -> FULFILLED -> CLOSED', async () => {
    const dealId = await runToConfirmation();

    let result = await advanceExecutionStatus(buyerActor(), dealId, {
      status: DealExecutionStatus.IN_PROGRESS,
    });
    expect(result.executionStatus).toBe(DealExecutionStatus.IN_PROGRESS);

    result = await advanceExecutionStatus(buyerActor(), dealId, {
      status: DealExecutionStatus.FULFILLED,
    });
    expect(result.executionStatus).toBe(DealExecutionStatus.FULFILLED);

    result = await advanceExecutionStatus(buyerActor(), dealId, {
      status: DealExecutionStatus.CLOSED,
    });
    expect(result.executionStatus).toBe(DealExecutionStatus.CLOSED);
  });

  it('execution events are recorded against the deal', async () => {
    const dealId = await runToConfirmation();

    await recordExecutionEvent(buyerActor(), dealId, {
      type: DealExecutionEventType.GOODS_RECEIVED,
      description: '5 servers received and inspected',
      metadata: { receiptNumber: 'GR-2026-0001' },
    });

    const events = state.dealExecutionEvents.filter((e) => e.dealId === dealId);
    expect(events.length).toBeGreaterThan(1);

    const detail = await getDealExecutionDetail(buyerActor(), dealId) as {
      deal: { dealNumber: string; executionStatus: string };
      executionEvents: unknown[];
    };
    expect(detail.executionEvents).toBeDefined();
    expect(detail.executionEvents.length).toBe(events.length);
  });

  it('deal execution detail is isolated by tenant', async () => {
    const dealId = await runToConfirmation();
    await expect(getDealExecutionDetail(otherTenantActor(), dealId)).rejects.toThrow(NotFoundError);
  });

  it('vendor cannot advance deal execution', async () => {
    const dealId = await runToConfirmation();
    await expect(
      advanceExecutionStatus(vendorActor1(), dealId, { status: DealExecutionStatus.IN_PROGRESS }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('Complete Workflow: Vendor B Selection', () => {
  it('buyer selects vendor B (lower cost) as final offer', async () => {
    await selectFinalOffer(buyerActor(), 'sub-2');

    const request = state.procurementRequests.find((r) => r.id === 'req-1')!;
    expect(request.status).toBe('FINAL_COMMERCIAL_SELECTION');

    await submitForFinalApproval(buyerActor(), { submissionId: 'sub-2' });
    const approval = state.purchaseApprovalRequests[0];
    expect(approval.selectedSubmissionId).toBe('sub-2');
    expect(approval.vendorId).toBe(VENDOR_2);

    const decisions = (state.purchaseApprovalDecisions as Row[]).filter(
      (d) => d.purchaseApprovalRequestId === approval.id,
    );
    await decidePurchaseApproval(decisions[0].id as string, approverActor(), { status: 'APPROVED' });

    const deal = state.deals[0];
    expect(deal.vendorId).toBe(VENDOR_2);
    expect(deal.executionType).toBe('PRODUCTS');
  });

  it('tenant isolation prevents cross-vendor data access', async () => {
    await selectFinalOffer(buyerActor(), 'sub-1');
    await submitForFinalApproval(buyerActor(), { submissionId: 'sub-1' });

    await expect(selectFinalOffer(otherTenantActor(), 'sub-1')).rejects.toThrow(NotFoundError);
  });
});
