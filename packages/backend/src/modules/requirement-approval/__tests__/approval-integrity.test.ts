import { describe, expect, it, beforeEach, vi } from 'vitest';
import { UserRole } from '@navo/shared';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../../../utils/errors.js';
import {
  submitRequirementForApproval,
  decideOnRequirementApproval,
} from '../requirement-approval.service.js';

interface Row { [key: string]: unknown }

const TENANT = 'tenant-a';
const REQUESTER = 'requester-1';
const APPROVER = 'approver-1';
const APPROVER_2 = 'approver-2';
const REQUEST = 'req-1';
const APPROVAL = 'approval-1';
const DECISION = 'decision-1';

const { db, prismaMock, policyMock } = vi.hoisted(() => {
  const state = {
    requests: [] as Row[],
    approvals: [] as Row[],
    decisions: [] as Row[],
    notifications: [] as Row[],
    decisionUpdates: [] as Row[],
    forceRace: false,
    route: {
      autoApproved: false,
      policyVersion: 1,
      appliedRuleId: null as string | null,
      policySnapshot: {},
      ruleSnapshot: null,
      thresholdAmount: 100,
      levels: [
        { level: 1, requiredRole: 'PROCUREMENT_MANAGER', label: 'Manager review' },
      ],
    },
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const matchesDecisionWhere = (decision: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    if (where.status && decision.status !== where.status) return false;
    if (
      where.requirementApprovalRequestId &&
      decision.requirementApprovalRequestId !== where.requirementApprovalRequestId
    ) {
      return false;
    }
    if (where.OR) {
      const ok = (where.OR as Row[]).some((cond) =>
        Object.entries(cond).every(([k, v]) => decision[k] === v)
      );
      if (!ok) return false;
    }
    return true;
  };

  const mock = {
    procurementRequest: {
      findFirst: async ({ where }: { where: Row }) =>
        state.requests.find((r) => matches(r, where)) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const r = state.requests.find((x) => matches(x, where));
        if (!r) throw new Error('ProcurementRequest not found');
        return Object.assign(r, data);
      },
    },
    requirementApprovalRequest: {
      findFirst: async ({ where, include }: { where: Row; include?: Record<string, unknown> }) => {
        const a = state.approvals.find((x) => matches(x, where));
        if (!a) return null;
        if (!include) return a;
        const result = { ...a };
        if (include.decisions) {
          const dw = (include.decisions as Row).where as Row | undefined;
          result.decisions = state.decisions.filter((d) =>
            d.requirementApprovalRequestId === a.id && matchesDecisionWhere(d, dw)
          );
        }
        if (include.request) {
          result.request = state.requests.find((r) => r.id === a.requestId) ?? null;
        }
        return result;
      },
      count: async () => state.approvals.length,
      create: async ({ data }: { data: Row }) => {
        const created = { id: APPROVAL, ...data };
        state.approvals.push(created);
        return created;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const a = state.approvals.find((x) => matches(x, where));
        if (!a) throw new Error('RequirementApprovalRequest not found');
        return Object.assign(a, data);
      },
    },
    requirementApprovalDecision: {
      findFirst: async ({ where }: { where: Row }) =>
        state.decisions.find((d) => matches(d, where)) ?? null,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        if (!state.forceRace) {
          for (const d of state.decisions) {
            if (matches(d, where)) {
              Object.assign(d, data);
              count += 1;
            }
          }
        }
        state.decisionUpdates.push({ where, data, count });
        return { count };
      },
    },
    notification: {
      create: async ({ data }: { data: Row }) => {
        state.notifications.push(data);
        return data;
      },
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mock),
  };

  const policy = {
    resolveRequirementApprovalRoute: vi.fn(async () => state.route),
    createRequirementApprovalDecisions: vi.fn(
      async (approvalId: string, levels: Row[]) => {
        for (const level of levels) {
          state.decisions.push({
            id: DECISION,
            tenantId: TENANT,
            requirementApprovalRequestId: approvalId,
            level: level.level,
            status: 'PENDING',
            assignedApproverId: APPROVER,
            requiredRole: level.requiredRole,
          });
        }
      }
    ),
  };

  return { db: state, prismaMock: mock, policyMock: policy };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../approval-policy.service', () => policyMock);
vi.mock('../../audit/audit.service.js', () => ({
  createAuditLog: vi.fn(async () => undefined),
}));

describe('Approval Gate #1 integrity', () => {
  beforeEach(() => {
    db.requests.length = 0;
    db.approvals.length = 0;
    db.decisions.length = 0;
    db.notifications.length = 0;
    db.decisionUpdates.length = 0;
    db.forceRace = false;
    db.route = {
      autoApproved: false,
      policyVersion: 1,
      appliedRuleId: null,
      policySnapshot: {},
      ruleSnapshot: null,
      thresholdAmount: 100,
      levels: [
        { level: 1, requiredRole: 'PROCUREMENT_MANAGER', label: 'Manager review' },
      ],
    };
  });

  const seedRequest = (overrides: Row = {}) => {
    db.requests.push({
      id: REQUEST,
      tenantId: TENANT,
      title: 'Laptops',
      item: 'Laptop',
      quantity: 10,
      estimatedBudget: 100000,
      requesterId: REQUESTER,
      status: 'CONFIRMED',
      ...overrides,
    });
  };

  const seedPendingApproval = (decisionOverrides: Row = {}) => {
    db.approvals.push({
      id: APPROVAL,
      tenantId: TENANT,
      requestId: REQUEST,
      submittedById: REQUESTER,
      reference: 'RAR-TEST-1',
      status: 'PENDING_APPROVAL',
      currentLevel: 1,
    });
    db.decisions.push({
      id: DECISION,
      tenantId: TENANT,
      requirementApprovalRequestId: APPROVAL,
      level: 1,
      status: 'PENDING',
      assignedApproverId: APPROVER,
      requiredRole: 'PROCUREMENT_MANAGER',
      ...decisionOverrides,
    });
  };

  describe('decideOnRequirementApproval', () => {
    it('rejects a vendor trying to decide', async () => {
      seedRequest();
      seedPendingApproval();
      await expect(
        decideOnRequirementApproval({
          approvalId: APPROVAL,
          decision: 'APPROVED',
          approverId: APPROVER,
          actorRole: UserRole.VENDOR,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects a requester trying to decide', async () => {
      seedRequest();
      seedPendingApproval();
      await expect(
        decideOnRequirementApproval({
          approvalId: APPROVAL,
          decision: 'APPROVED',
          approverId: REQUESTER,
          actorRole: UserRole.REQUESTER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects an actor whose role is below the level requirement', async () => {
      seedRequest();
      seedPendingApproval({ requiredRole: 'COMPANY_ADMIN' });
      await expect(
        decideOnRequirementApproval({
          approvalId: APPROVAL,
          decision: 'APPROVED',
          approverId: APPROVER,
          actorRole: UserRole.PROCUREMENT_MANAGER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects a decision by an unassigned approver', async () => {
      seedRequest();
      seedPendingApproval();
      await expect(
        decideOnRequirementApproval({
          approvalId: APPROVAL,
          decision: 'APPROVED',
          approverId: APPROVER_2,
          actorRole: UserRole.PROCUREMENT_MANAGER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects self-approval (segregation of duties)', async () => {
      seedRequest();
      // No assigned approver: the requester is the only candidate.
      seedPendingApproval({ assignedApproverId: null });
      await expect(
        decideOnRequirementApproval({
          approvalId: APPROVAL,
          decision: 'APPROVED',
          approverId: REQUESTER,
          actorRole: UserRole.COMPANY_ADMIN,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it('requires comments for rejection', async () => {
      seedRequest();
      seedPendingApproval();
      await expect(
        decideOnRequirementApproval({
          approvalId: APPROVAL,
          decision: 'REJECTED',
          approverId: APPROVER,
          actorRole: UserRole.PROCUREMENT_MANAGER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects a decision claimed concurrently by another approver', async () => {
      seedRequest();
      seedPendingApproval();
      db.forceRace = true;
      await expect(
        decideOnRequirementApproval({
          approvalId: APPROVAL,
          decision: 'APPROVED',
          approverId: APPROVER,
          actorRole: UserRole.PROCUREMENT_MANAGER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ConflictError);
    });

    it('allows the assigned manager to approve and advances the request', async () => {
      seedRequest();
      seedPendingApproval();
      const result = await decideOnRequirementApproval({
        approvalId: APPROVAL,
        decision: 'APPROVED',
        approverId: APPROVER,
        actorRole: UserRole.PROCUREMENT_MANAGER,
        tenantId: TENANT,
      });

      expect(result).toEqual({ requestId: REQUEST, newStatus: 'APPROVED_FOR_SOURCING' });
      expect(db.decisions[0].status).toBe('APPROVED');
      expect(db.decisions[0].decidedById).toBe(APPROVER);
      expect(db.approvals[0].status).toBe('APPROVED');
      expect(db.requests[0].status).toBe('APPROVED_FOR_SOURCING');
      // Requester is notified of the outcome.
      expect(db.notifications).toHaveLength(1);
      expect(db.notifications[0].userId).toBe(REQUESTER);
      expect(db.notifications[0].type).toBe('APPROVAL_APPROVED');
    });

    it('sends the requirement back with comments on CHANGES_REQUESTED', async () => {
      seedRequest();
      seedPendingApproval();
      const result = await decideOnRequirementApproval({
        approvalId: APPROVAL,
        decision: 'CHANGES_REQUESTED',
        comments: 'Please add specifications',
        approverId: APPROVER,
        actorRole: UserRole.PROCUREMENT_MANAGER,
        tenantId: TENANT,
      });

      expect(result.newStatus).toBe('SEND_BACK');
      expect(db.requests[0].status).toBe('SEND_BACK');
      expect(db.notifications[0].type).toBe('APPROVAL_CHANGES_REQUESTED');
    });

    it('throws NotFoundError for an approval in another tenant', async () => {
      seedRequest();
      seedPendingApproval();
      await expect(
        decideOnRequirementApproval({
          approvalId: APPROVAL,
          decision: 'APPROVED',
          approverId: APPROVER,
          actorRole: UserRole.PROCUREMENT_MANAGER,
          tenantId: 'tenant-b',
        })
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('submitRequirementForApproval', () => {
    it('rejects a requirement without a title', async () => {
      seedRequest({ title: '' });
      await expect(
        submitRequirementForApproval({
          requestId: REQUEST,
          submitterId: REQUESTER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects a requirement without a quantity', async () => {
      seedRequest({ quantity: null });
      await expect(
        submitRequirementForApproval({
          requestId: REQUEST,
          submitterId: REQUESTER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects a requirement without an estimated budget', async () => {
      seedRequest({ estimatedBudget: null });
      await expect(
        submitRequirementForApproval({
          requestId: REQUEST,
          submitterId: REQUESTER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ValidationError);
    });

    it('rejects a duplicate pending submission', async () => {
      seedRequest();
      db.approvals.push({
        id: 'approval-existing',
        tenantId: TENANT,
        requestId: REQUEST,
        submittedById: REQUESTER,
        reference: 'RAR-EXISTING',
        status: 'PENDING_APPROVAL',
      });
      await expect(
        submitRequirementForApproval({
          requestId: REQUEST,
          submitterId: REQUESTER,
          tenantId: TENANT,
        })
      ).rejects.toThrow(ConflictError);
    });

    it('auto-approves when the route resolves without levels', async () => {
      seedRequest();
      db.route = { ...db.route, autoApproved: true, levels: [] };
      const result = await submitRequirementForApproval({
        requestId: REQUEST,
        submitterId: REQUESTER,
        tenantId: TENANT,
        requesterComment: 'Urgent',
      });

      expect(result.autoApproved).toBe(true);
      expect(result.status).toBe('APPROVED_FOR_SOURCING');
      expect(db.requests[0].status).toBe('APPROVED_FOR_SOURCING');
      expect(db.approvals[0].status).toBe('APPROVED');
      expect(db.approvals[0].requesterComment).toBe('Urgent');
    });

    it('creates a pending approval routed to the first approver', async () => {
      seedRequest();
      const result = await submitRequirementForApproval({
        requestId: REQUEST,
        submitterId: REQUESTER,
        tenantId: TENANT,
      });

      expect(result.autoApproved).toBe(false);
      expect(result.status).toBe('PENDING_DEPARTMENT_APPROVAL');
      expect(result.approverId).toBe(APPROVER);
      expect(db.requests[0].status).toBe('PENDING_DEPARTMENT_APPROVAL');
      expect(db.approvals[0].status).toBe('PENDING_APPROVAL');
      expect(policyMock.createRequirementApprovalDecisions).toHaveBeenCalledWith(
        APPROVAL,
        db.route.levels,
        TENANT,
        REQUESTER
      );
      // The assigned approver is notified.
      expect(db.notifications).toHaveLength(1);
      expect(db.notifications[0].userId).toBe(APPROVER);
      expect(db.notifications[0].type).toBe('APPROVAL_ASSIGNED');
    });
  });
});
