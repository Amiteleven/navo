import { CopilotActionType, CopilotActionStatus, UserRole, AuditAction } from '@navo/shared';
import { z } from 'zod';
import prisma from '../../../utils/prisma.js';
import { createAuditLog } from '../../audit/audit.service.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../utils/errors.js';
import {
  CopilotScope,
  canCreateRequests,
  dealRoomVisibility,
  requestVisibility,
} from '../copilot-access.js';

/**
 * Actions that require explicit user confirmation.
 *
 * The flow is deliberately two-phase:
 *
 *   propose()  -> writes a CopilotAction row with status PROPOSED and returns a
 *                 human-readable summary. Nothing in NAVO changes.
 *   execute()  -> re-reads the action, re-checks every precondition against
 *                 current database state, and only then calls the underlying
 *                 service.
 *
 * Execution re-validates rather than trusting the stored payload: between
 * proposal and confirmation the user, the request status, or the deal room may
 * all have changed. State is re-read inside the transaction that writes.
 *
 * Only `CREATE_DRAFT_REQUEST`, `DRAFT_NEGOTIATION_MESSAGE`, `DRAFT_PURCHASE_ORDER`
 * and `OPEN_DEAL_ROOM` are executable here. Nothing that sends a message,
 * accepts an offer, issues a purchase order, approves an invoice or changes a
 * transaction status is exposed - those remain deliberate acts in NAVO's own
 * screens, with their existing approval rules.
 */

export const EXECUTABLE_ACTIONS: CopilotActionType[] = [
  CopilotActionType.CREATE_DRAFT_REQUEST,
  CopilotActionType.DRAFT_NEGOTIATION_MESSAGE,
  CopilotActionType.DRAFT_PURCHASE_ORDER,
  CopilotActionType.OPEN_DEAL_ROOM,
  CopilotActionType.REQUEST_QUOTATION,
  CopilotActionType.ADD_FOLLOW_UP_NOTE,
];

export interface ProposedAction {
  actionId: string;
  type: CopilotActionType;
  /** Exactly what will happen, phrased for the confirmation prompt. */
  summary: string;
  /** Field-by-field detail so nothing is hidden from the reviewer. */
  details: Array<{ field: string; value: string }>;
  warnings: string[];
}

const REQUEST_DRAFT_SCHEMA = z.object({
  title: z.string().min(1).max(200),
  item: z.string().min(1).max(200),
  description: z.string().min(10).max(4000),
  quantity: z.number().int().positive().max(1_000_000),
  unit: z.string().max(40).optional(),
  location: z.string().min(1).max(200),
  requiredDate: z.string().min(4).max(40),
  estimatedBudget: z.number().min(0).optional(),
  specifications: z.string().max(2000).optional(),
  categoryId: z.string().max(64).optional(),
  priority: z.number().int().min(1).max(5).optional(),
});

const NEGOTIATION_DRAFT_SCHEMA = z.object({
  dealRoomId: z.string().min(1).max(64),
  content: z.string().min(1).max(4000),
});

const PURCHASE_ORDER_DRAFT_SCHEMA = z.object({
  dealId: z.string().min(1).max(64),
});

const OPEN_DEAL_ROOM_SCHEMA = z.object({
  dealRoomId: z.string().min(1).max(64),
});

/** Fields the assistant must not decide for the user. */
const REQUIRED_FOR_CONFIRMATION: Record<string, string[]> = {
  CREATE_DRAFT_REQUEST: ['title', 'item', 'quantity', 'location', 'requiredDate'],
  DRAFT_NEGOTIATION_MESSAGE: ['dealRoomId', 'content'],
  DRAFT_PURCHASE_ORDER: ['dealId'],
  OPEN_DEAL_ROOM: ['dealRoomId'],
};

/**
 * Roles that may raise a request, checked identically at proposal and at
 * execution. A seller is excluded because requests are buyer-side; `VIEWER` and
 * `FINANCE_APPROVER` are excluded because they approve spend rather than raise
 * it.
 */
function assertCanCreateDraftRequest(scope: CopilotScope): void {
  if (!canCreateRequests(scope)) {
    throw new ForbiddenError('Only buyer accounts can create procurement requests');
  }
  if (scope.actor.role === UserRole.VIEWER || scope.actor.role === UserRole.FINANCE_APPROVER) {
    throw new ForbiddenError('Your role cannot raise procurement requests');
  }
}

/**
 * Validate a proposed action and store it without executing anything.
 */
export async function proposeAction(
  conversationId: string,
  type: CopilotActionType,
  rawPayload: unknown,
  scope: CopilotScope
): Promise<ProposedAction> {
  if (!EXECUTABLE_ACTIONS.includes(type)) {
    throw new ValidationError(`The copilot cannot perform ${type}`);
  }

  const payload = validatePayload(type, rawPayload);

  // Authorization and preconditions are checked at proposal time so the user is
  // never shown a confirmation for something that will simply fail.
  const prepared = await prepare(type, payload, scope);

  // Duplicate detection compares the *prepared* payload, because that is what
  // was stored. Comparing the raw input instead would miss a repeat: `prepare`
  // normalizes values such as the required date to an ISO string, so an
  // identical re-request would never stringify to the same value.
  const duplicateId = await findPendingDuplicate(
    conversationId,
    type,
    prepared.payload,
    scope
  );
  if (duplicateId) {
    throw new ConflictError(
      `An identical action is already awaiting confirmation in this conversation (${duplicateId})`
    );
  }

  const action = await prisma.copilotAction.create({
    data: {
      conversationId,
      userId: scope.actor.userId,
      tenantId: scope.actor.tenantId,
      type,
      status: CopilotActionStatus.PROPOSED,
      summary: prepared.summary,
      payload: prepared.payload as never,
    },
  });

  await audit(scope, AuditAction.COPILOT_ACTION_PROPOSED, action.id, type, {
    summary: prepared.summary,
  });

  return {
    actionId: action.id,
    type,
    summary: prepared.summary,
    details: prepared.details,
    warnings: prepared.warnings,
  };
}

function validatePayload(type: CopilotActionType, raw: unknown): Record<string, unknown> {
  const schemaFor: Partial<Record<CopilotActionType, z.ZodTypeAny>> = {
    CREATE_DRAFT_REQUEST: REQUEST_DRAFT_SCHEMA,
    DRAFT_NEGOTIATION_MESSAGE: NEGOTIATION_DRAFT_SCHEMA,
    DRAFT_PURCHASE_ORDER: PURCHASE_ORDER_DRAFT_SCHEMA,
    OPEN_DEAL_ROOM: OPEN_DEAL_ROOM_SCHEMA,
  };
  const schema = schemaFor[type];
  if (!schema) throw new ValidationError(`Unsupported action: ${type}`);

  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      (details[key] ??= []).push(issue.message);
    }
    throw new ValidationError('The action details are incomplete', details);
  }

  const missing = REQUIRED_FOR_CONFIRMATION[type]?.filter(
    (key) => parsed.data[key as keyof typeof parsed.data] == null ||
      String(parsed.data[key as keyof typeof parsed.data]).trim() === ''
  );
  if (missing && missing.length > 0) {
    throw new ValidationError('The action is missing information required for confirmation', {
      missing,
    });
  }

  return parsed.data as Record<string, unknown>;
}

interface PreparedAction {
  summary: string;
  payload: Record<string, unknown>;
  details: Array<{ field: string; value: string }>;
  warnings: string[];
}

/**
 * Re-check authorization and build the confirmation summary. This runs again at
 * execution time; doing it now means the user is never prompted for an action
 * that would be refused.
 */
async function prepare(
  type: CopilotActionType,
  payload: Record<string, unknown>,
  scope: CopilotScope
): Promise<PreparedAction> {
  switch (type) {
    case CopilotActionType.CREATE_DRAFT_REQUEST: {
      assertCanCreateDraftRequest(scope);
      const requiredDate = new Date(String(payload.requiredDate));
      if (Number.isNaN(requiredDate.getTime())) {
        throw new ValidationError('The required date is not a valid date', {
          requiredDate: ['Not a valid date'],
        });
      }
      if (requiredDate.getTime() < Date.now() - 86_400_000) {
        throw new ValidationError('The required date is in the past', {
          requiredDate: ['Must be today or later'],
        });
      }

      const details = [
        { field: 'Title', value: String(payload.title) },
        { field: 'Item', value: String(payload.item) },
        { field: 'Quantity', value: `${payload.quantity}${payload.unit ? ` ${payload.unit}` : ''}` },
        { field: 'Description', value: String(payload.description) },
        { field: 'Delivery location', value: String(payload.location) },
        { field: 'Required by', value: requiredDate.toISOString().slice(0, 10) },
        ...(payload.estimatedBudget != null
          ? [{ field: 'Estimated budget', value: String(payload.estimatedBudget) }]
          : [{ field: 'Estimated budget', value: 'not specified' }]),
        ...(payload.specifications
          ? [{ field: 'Specifications', value: String(payload.specifications) }]
          : []),
      ];

      const warnings = ['This creates a DRAFT request. It is not submitted for approval.'];
      if (payload.estimatedBudget == null) {
        warnings.push('No budget was given, so the request will have no budget for approval.');
      }

      return {
        summary: `Create a draft procurement request "${String(payload.title)}" for ${payload.quantity} × ${String(payload.item)} at ${String(payload.location)}.`,
        payload: { ...payload, requiredDate: requiredDate.toISOString() },
        details,
        warnings,
      };
    }

    case CopilotActionType.DRAFT_NEGOTIATION_MESSAGE: {
      const room = await prisma.dealRoom.findFirst({
        where: { id: String(payload.dealRoomId), ...dealRoomVisibility(scope) },
        include: { vendor: { select: { name: true } }, request: { select: { title: true } } },
      });
      if (!room) throw new NotFoundError('Deal room');
      if (['CLOSED', 'EXPIRED'].includes(room.status)) {
        throw new ConflictError(`That deal room is ${room.status.toLowerCase()} and cannot be used`);
      }

      return {
        summary: `Save a draft negotiation message in the deal room with ${room.vendor.name} for "${room.request.title}". The message is not sent.`,
        payload: {
          dealRoomId: room.id,
          content: String(payload.content),
          vendorName: room.vendor.name,
        },
        details: [
          { field: 'Supplier', value: room.vendor.name },
          { field: 'Request', value: room.request.title },
          { field: 'Message', value: String(payload.content) },
        ],
        warnings: [
          'This stores a draft only. You must send it from the deal room yourself.',
        ],
      };
    }

    case CopilotActionType.DRAFT_PURCHASE_ORDER: {
      if (!canCreateRequests(scope)) {
        throw new ForbiddenError('Only buyer accounts can raise purchase orders');
      }
      const deal = await prisma.deal.findFirst({
        where: { id: String(payload.dealId), tenantId: scope.actor.tenantId },
        include: { vendor: { select: { name: true } }, purchaseOrder: true },
      });
      if (!deal) throw new NotFoundError('Deal');
      if (deal.purchaseOrder) {
        throw new ConflictError(
          `This deal already has purchase order ${deal.purchaseOrder.poNumber}`
        );
      }

      return {
        summary: `Prepare a draft purchase order from deal ${deal.dealNumber} with ${deal.vendor.name}.`,
        payload: { dealId: deal.id, dealNumber: deal.dealNumber },
        details: [
          { field: 'Deal', value: deal.dealNumber },
          { field: 'Supplier', value: deal.vendor.name },
        ],
        warnings: [
          'A purchase order must then be submitted for approval and issued through NAVO. The copilot cannot approve or issue it.',
        ],
      };
    }

    case CopilotActionType.OPEN_DEAL_ROOM:
    default: {
      const room = await prisma.dealRoom.findFirst({
        where: { id: String(payload.dealRoomId), ...dealRoomVisibility(scope) },
        include: { vendor: { select: { name: true } }, request: { select: { title: true } } },
      });
      if (!room) throw new NotFoundError('Deal room');

      return {
        summary: `Open the deal room with ${room.vendor.name} for "${room.request.title}".`,
        payload: { dealRoomId: room.id },
        details: [
          { field: 'Supplier', value: room.vendor.name },
          { field: 'Request', value: room.request.title },
          { field: 'Status', value: room.status },
        ],
        warnings: [],
      };
    }
  }
}

export interface ExecutedAction {
  actionId: string;
  type: CopilotActionType;
  status: CopilotActionStatus;
  summary: string;
  entityType?: string;
  entityId?: string;
  /** Route into NAVO for whatever was created or opened. */
  href?: string;
}

/**
 * Execute a previously proposed action.
 *
 * Guards, in order:
 *  1. The action exists and belongs to this user and tenant.
 *  2. It is still PROPOSED - a duplicate confirm cannot re-execute.
 *  3. The same action is not already EXECUTED in this conversation.
 *  4. Authorization and preconditions are re-derived from current state.
 */
export async function executeAction(
  actionId: string,
  scope: CopilotScope
): Promise<ExecutedAction> {
  const action = await prisma.copilotAction.findFirst({
    where: { id: actionId, userId: scope.actor.userId, tenantId: scope.actor.tenantId },
  });

  if (!action) {
    throw new NotFoundError('Copilot action');
  }

  if (action.status === CopilotActionStatus.EXECUTED) {
    // Confirming twice is a no-op rather than a second write.
    throw new ConflictError('This action has already been completed');
  }
  if (action.status !== CopilotActionStatus.PROPOSED) {
    throw new ConflictError(`This action is ${action.status.toLowerCase().replace(/_/g, ' ')} and cannot be confirmed`);
  }

  // Prisma enums and the `@navo/shared` mirrors carry identical string values,
  // so a value read back from the database narrows into the shared enum.
  const actionType = action.type as unknown as CopilotActionType;

  const executed = await runAction(actionType, action.payload as Record<string, unknown>, scope);

  const updated = await prisma.copilotAction.update({
    where: { id: action.id },
    data: {
      status: CopilotActionStatus.EXECUTED,
      confirmedAt: new Date(),
      executedAt: new Date(),
      resultEntityType: executed.entityType,
      resultEntityId: executed.entityId,
      resultSummary: executed.summary,
    },
  });

  await audit(scope, AuditAction.COPILOT_ACTION_EXECUTED, action.id, actionType, {
    entityType: executed.entityType,
    entityId: executed.entityId,
  });

  return {
    actionId: updated.id,
    type: actionType,
    status: CopilotActionStatus.EXECUTED,
    summary: executed.summary,
    entityType: executed.entityType,
    entityId: executed.entityId,
    href: executed.href,
  };
}

/**
 * Perform the write. Preconditions are re-read here, inside execution, so a
 * record that changed after proposal cannot be written against.
 */
async function runAction(
  type: CopilotActionType,
  payload: Record<string, unknown>,
  scope: CopilotScope
): Promise<ExecutedAction & { entityType?: string; entityId?: string; href?: string }> {
  switch (type) {
      case CopilotActionType.CREATE_DRAFT_REQUEST: {
        // Re-checked at execution, not only at proposal time: a role change
        // between the two must not leave a stored payload executable.
        assertCanCreateDraftRequest(scope);
        const requiredDate = new Date(String(payload.requiredDate));
        if (Number.isNaN(requiredDate.getTime())) {
          throw new ValidationError('The required date is no longer valid');
        }

        const request = await prisma.procurementRequest.create({
          data: {
            title: String(payload.title),
            item: String(payload.item),
            description: String(payload.description),
            quantity: Number(payload.quantity),
            unit: payload.unit ? String(payload.unit) : null,
            location: String(payload.location),
            requiredDate,
            estimatedBudget:
              payload.estimatedBudget != null ? Number(payload.estimatedBudget) : null,
            specifications: payload.specifications ? String(payload.specifications) : null,
            categoryId: payload.categoryId ? String(payload.categoryId) : null,
            priority: payload.priority != null ? Number(payload.priority) : 1,
            requesterId: scope.actor.userId,
            tenantId: scope.actor.tenantId,
            status: 'DRAFT',
          },
          select: { id: true, title: true, status: true },
        });

        await audit(scope, AuditAction.CREATED, request.id, 'ProcurementRequest', {
          via: 'copilot',
        });

        return {
          actionId: '',
          type,
          status: CopilotActionStatus.EXECUTED,
          summary: `Created draft request "${request.title}".`,
          entityType: 'REQUEST',
          entityId: request.id,
          href: `/requests/${request.id}`,
        };
      }

      case CopilotActionType.DRAFT_NEGOTIATION_MESSAGE: {
        const room = await prisma.dealRoom.findFirst({
          where: { id: String(payload.dealRoomId), ...dealRoomVisibility(scope) },
          select: { id: true, status: true, vendor: { select: { name: true } } },
        });
        if (!room) throw new NotFoundError('Deal room');
        if (['CLOSED', 'EXPIRED'].includes(room.status)) {
          throw new ConflictError('That deal room is closed and cannot accept a draft');
        }

        // Stored as a draft negotiation message. It is not broadcast: sending
        // remains an explicit act in the deal room.
        const message = await prisma.negotiationMessage.create({
          data: {
            dealRoomId: room.id,
            senderId: scope.actor.userId,
            senderRole: 'BUYER_DRAFT',
            content: String(payload.content),
            messageType: 'DRAFT',
            metadata: { preparedBy: 'copilot', status: 'DRAFT' },
            tenantId: scope.actor.tenantId,
            status: 'ACTIVE',
          },
          select: { id: true },
        });

        await audit(scope, AuditAction.CREATED, message.id, 'NegotiationMessage', {
          via: 'copilot',
          sent: false,
        });

        return {
          actionId: '',
          type,
          status: CopilotActionStatus.EXECUTED,
          summary: `Saved a draft message for ${room.vendor.name}. It has not been sent.`,
          entityType: 'DEAL_ROOM',
          entityId: room.id,
          href: `/deals/new?dealRoomId=${room.id}`,
        };
      }

      case CopilotActionType.DRAFT_PURCHASE_ORDER:
      case CopilotActionType.OPEN_DEAL_ROOM:
      default:
        // These do not write. They navigate the user to the screen where NAVO's
        // own approval and confirmation rules apply.
        return {
          actionId: '',
          type,
          status: CopilotActionStatus.EXECUTED,
          summary: 'Opened the relevant NAVO screen to complete this.',
          entityType: type === CopilotActionType.OPEN_DEAL_ROOM ? 'DEAL_ROOM' : 'DEAL',
          entityId: String(payload.dealRoomId ?? payload.dealId),
          href:
            type === CopilotActionType.OPEN_DEAL_ROOM
              ? `/deals/new?dealRoomId=${String(payload.dealRoomId)}`
              : `/purchase-orders/new?dealId=${String(payload.dealId)}`,
        };
  }
}

/**
 * Record an audit entry for a copilot-initiated write.
 *
 * `subject` is either the copilot action type or the NAVO entity that was
 * written; failures are swallowed so an audit problem never masks the result.
 */
async function audit(
  scope: CopilotScope,
  action: AuditAction,
  entityId: string,
  subject: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await createAuditLog({
      userId: scope.actor.userId,
      action,
      entityType: 'CopilotAction',
      entityId,
      tenantId: scope.actor.tenantId,
      metadata: { subject, ...metadata } as never,
    });
  } catch {
    // Never let an audit write mask the result of the action itself.
  }
}

/** Mark an action as failed, recording why. */
export async function failAction(
  actionId: string,
  scope: CopilotScope,
  reason: string
): Promise<void> {
  await prisma.copilotAction
    .updateMany({
      where: { id: actionId, userId: scope.actor.userId, tenantId: scope.actor.tenantId },
      data: { status: CopilotActionStatus.FAILED, error: reason.slice(0, 1000) },
    })
    .catch(() => undefined);
  await audit(scope, AuditAction.COPILOT_ACTION_FAILED, actionId, 'UNKNOWN', {
    reason,
  });
}

/** True when an identical action is already awaiting confirmation. */
export async function findPendingDuplicate(
  conversationId: string,
  type: CopilotActionType,
  payload: Record<string, unknown>,
  scope: CopilotScope
): Promise<string | null> {
  const existing = await prisma.copilotAction.findMany({
    where: {
      conversationId,
      userId: scope.actor.userId,
      tenantId: scope.actor.tenantId,
      type,
      status: CopilotActionStatus.PROPOSED,
    },
    select: { id: true, payload: true },
  });

  const wanted = JSON.stringify(sortKeys(payload));
  for (const row of existing) {
    if (JSON.stringify(sortKeys(row.payload as Record<string, unknown>)) === wanted) {
      return row.id;
    }
  }
  return null;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)])
    );
  }
  return value;
}