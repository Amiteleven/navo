import {
  Prisma,
  RequestStatus as PrismaRequestStatus,
  PurchaseApprovalDecisionStatus as PrismaPurchaseApprovalDecisionStatus,
  PurchaseApprovalStatus as PrismaPurchaseApprovalStatus,
} from '@prisma/client';
import {
  AuditAction,
  PurchaseApprovalChangeTrigger,
  PurchaseApprovalDecisionStatus,
  PurchaseApprovalStatus,
  ResolvedApprovalRoute,
  UserRole,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { decimalToNumber, toDecimal } from '../../utils/money.js';
import { nextDocumentNumber } from '../../utils/documentNumber.js';
import { createAuditLog } from '../audit/audit.service.js';
import { notify } from '../notifications/notification.service.js';
import { finalizeAcceptedOffer } from '../negotiation/negotiation.service.js';
import {
  ApprovalActor,
  APPROVAL_AUDIT_ROLES,
  assertApprovalBuyer,
  assertApprover,
  canDecideApprovalLevel,
  isApprovalAuditor,
} from './approval-roles.js';
import {
  ApprovalSubject,
  assertCanViewApprovals,
  assertMaySelfApprove,
  detectMaterialChanges,
  loadActivePolicy,
  priceForPolicy,
  resolveApprovalRoute,
} from './approval-policy.service.js';

/**
 * Purchase authorization: a buyer asks a manager to release company funds for a
 * specific negotiated offer, the manager approves, rejects or asks for changes,
 * and only then can the buyer confirm the purchase and raise an order.
 *
 * The invariants this module exists to hold:
 *
 *  - **Approval is not purchase.** A submitted or fully approved request is never
 *    reported as a completed purchase. `isPurchaseComplete` requires both the
 *    buyer's confirmation and a raised order.
 *  - **Terms are frozen.** The commercial block is written once from the offer and
 *    never edited. A changed offer becomes a new revision that supersedes its
 *    predecessor, so the figures a manager agreed to remain readable.
 *  - **Decisions are appended, never rewritten.** Each level is a row that moves
 *    from PENDING to a terminal verdict exactly once; a second attempt loses a
 *    conditional update rather than overwriting the first decision.
 *  - **Authorization is checked server-side on every mutating path.** The UI
 *    hides actions the actor cannot take, but hiding is not enforcement.
 */

/** Levels that were skipped are retained so the history has no unexplained gaps. */
const ASSIGNMENTS_SELECT = {
  toApprover: { select: { id: true, firstName: true, lastName: true, email: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

const REQUEST_INCLUDE = {
  decisions: {
    orderBy: { level: 'asc' as const },
    include: {
      assignedApprover: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
      decidedBy: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
      // Nested rather than a sibling of `decisions`: an assignment belongs to
      // the level it was made on, and reading it from there keeps the two from
      // being able to disagree about which level was reassigned.
      assignments: { orderBy: { createdAt: 'asc' as const }, include: ASSIGNMENTS_SELECT },
    },
  },
  vendor: { select: { id: true, name: true, email: true } },
  request: {
    select: {
      id: true,
      title: true,
      item: true,
      quantity: true,
      department: true,
      costCenter: true,
    },
  },
  submittedBy: { select: { id: true, firstName: true, lastName: true, email: true, role: true, department: true } },
  purchaseOrder: { select: { id: true, poNumber: true, status: true } },
  policy: {
    select: {
      id: true,
      version: true,
      currency: true,
      allowSelfApproval: true,
      selfApprovalJustification: true,
      includeTaxesInThreshold: true,
      includeDeliveryChargesInThreshold: true,
      autoApproveBelowAmount: true,
      reapprovalRules: true,
    },
  },
  appliedRule: { select: { id: true, name: true } },
} satisfies Prisma.PurchaseApprovalRequestInclude;

type RequestWithRelations = Prisma.PurchaseApprovalRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

/**
 * Prisma's enum members and the shared mirror carry identical literals but are
 * distinct nominal types. These two helpers are the single conversion point, so
 * a rename in one place surfaces as a type error rather than as a runtime
 * "Invalid value for argument" after the row has already been written.
 */
const decisionStatus = (value: PrismaPurchaseApprovalDecisionStatus): PurchaseApprovalDecisionStatus =>
  value as unknown as PurchaseApprovalDecisionStatus;

const requestStatus = (value: PrismaPurchaseApprovalStatus): PurchaseApprovalStatus =>
  value as unknown as PurchaseApprovalStatus;

/** Statuses a revision may be started from. */
const REVISABLE: PurchaseApprovalStatus[] = [
  PurchaseApprovalStatus.CHANGES_REQUESTED,
  PurchaseApprovalStatus.REJECTED,
  PurchaseApprovalStatus.APPROVED,
  PurchaseApprovalStatus.PURCHASE_CONFIRMED,
];

// ── Serialization ─────────────────────────────────────────────────────────────

/**
 * Present a request to the API.
 *
 * Decimals become numbers here and nowhere else, so a stored value is never
 * re-derived from a float. `isPurchaseComplete` is computed, not stored, because
 * it depends on two facts that live in different tables.
 */
export function serializeRequest(approval: RequestWithRelations) {
  return {
    id: approval.id,
    reference: approval.reference,
    requestId: approval.requestId,
    vendorId: approval.vendorId,
    vendor: approval.vendor ?? undefined,
    dealRoomId: approval.dealRoomId ?? undefined,
    dealId: approval.dealId ?? undefined,
    offerId: approval.offerId ?? undefined,
    selectedSubmissionId: approval.selectedSubmissionId ?? undefined,
    quoteId: approval.quoteId ?? undefined,
    submittedById: approval.submittedById,
    submittedBy: approval.submittedBy ?? undefined,
    status: approval.status,
    currency: approval.currency,
    unitPrice: decimalToNumber(approval.unitPrice),
    quantity: approval.quantity,
    taxRate: decimalToNumber(approval.taxRate),
    taxAmount: decimalToNumber(approval.taxAmount),
    freightAmount: decimalToNumber(approval.freightAmount),
    installationAmount: decimalToNumber(approval.installationAmount),
    otherCharges: decimalToNumber(approval.otherCharges),
    subtotal: decimalToNumber(approval.subtotal),
    totalAmount: decimalToNumber(approval.totalAmount),
    thresholdAmount: decimalToNumber(approval.thresholdAmount),
    paymentTerms: approval.paymentTerms ?? undefined,
    deliveryTimelineDays: approval.deliveryTimelineDays ?? undefined,
    warrantyMonths: approval.warrantyMonths ?? undefined,
    deliverySchedule: approval.deliverySchedule ?? undefined,
    otherChargesDetails: approval.otherChargesDetails ?? undefined,
    documents: (approval.documents as string[] | null) ?? undefined,
    policyId: approval.policyId ?? undefined,
    policyVersion: approval.policyVersion ?? undefined,
    appliedRuleId: approval.appliedRuleId ?? undefined,
    requesterComment: approval.requesterComment ?? undefined,
    negotiationSnapshot: approval.negotiationSnapshot ?? undefined,
    currentLevel: approval.currentLevel,
    revision: approval.revision,
    parentRequestId: approval.parentRequestId ?? undefined,
    supersededById: approval.supersededById ?? undefined,
    supersedeReason: approval.supersedeReason ?? undefined,
    decidedAt: approval.decidedAt ?? undefined,
    purchaseConfirmedAt: approval.purchaseConfirmedAt ?? undefined,
    purchaseConfirmedById: approval.purchaseConfirmedById ?? undefined,
    purchaseOrderId: approval.purchaseOrderId ?? undefined,
    purchaseOrder: approval.purchaseOrder ?? undefined,
    cancelledAt: approval.cancelledAt ?? undefined,
    cancelReason: approval.cancelReason ?? undefined,
    dueAt: approval.dueAt ?? undefined,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    decisions: approval.decisions,
    // Flattened for the UI: an approver reviewing a request wants one list of
    // "who was asked, and who was asked instead", not a per-level nesting.
    assignments: approval.decisions.flatMap((decision) => decision.assignments),
    route: reconstructRoute(approval),
    /**
     * A purchase is complete only when the buyer confirmed it *and* an order
     * exists. Approval alone leaves this false, which is what keeps an approved
     * request from being shown as a completed purchase.
     */
    isPurchaseComplete:
      approval.status === PurchaseApprovalStatus.PURCHASE_CONFIRMED && Boolean(approval.purchaseOrderId),
  };
}

/**
 * Rebuild what the policy said at submission time.
 *
 * Read from the stored snapshots rather than the current policy, so the
 * explanation beside an old request cannot drift after the organization edits
 * its thresholds.
 */
function reconstructRoute(approval: RequestWithRelations): ResolvedApprovalRoute | undefined {
  const snapshot = approval.policySnapshot as Record<string, unknown> | null;
  if (!snapshot) {
    return {
      approvalRequired: false,
      reason:
        approval.status === PurchaseApprovalStatus.APPROVED ||
        approval.status === PurchaseApprovalStatus.PURCHASE_CONFIRMED
          ? 'No approval was required for this purchase.'
          : 'Awaiting configuration of your organization\'s approval policy.',
      thresholdAmount: decimalToNumber(approval.thresholdAmount),
      currency: approval.currency,
      levels: [],
    };
  }

  const ruleSnapshot = approval.ruleSnapshot as Record<string, unknown> | null;
  const levels = (snapshot.levels as Array<Record<string, unknown>> | undefined) ?? [];
  const approvalRequired = snapshot.approvalRequired !== false;

  return {
    approvalRequired,
    reason: String(snapshot.reason ?? ''),
    policyId: approval.policyId ?? undefined,
    policyVersion: approval.policyVersion ?? undefined,
    ruleId: approval.appliedRuleId ?? undefined,
    ruleName: ruleSnapshot?.name as string | undefined,
    thresholdAmount: decimalToNumber(approval.thresholdAmount),
    currency: approval.currency,
    autoApprovedBelowThreshold:
      typeof snapshot.autoApproveBelowAmount === 'string'
        ? Number(snapshot.autoApproveBelowAmount)
        : undefined,
    levels: levels.map((level) => ({
      level: Number(level.level),
      requiredRole: level.requiredRole as UserRole,
      label: level.label as string | undefined,
      approverId: level.approverId as string | undefined,
      approverName: level.approverName as string | undefined,
    })),
  };
}

// ── Access ────────────────────────────────────────────────────────────────────

/**
 * Load a request the actor is allowed to see.
 *
 * Three audiences: the buyer who submitted it, any current or past approver of
 * it, and tenant-wide approver roles. Everyone else is refused, which is what
 * keeps a private requirement's commercial terms inside the organization.
 */
export async function loadVisibleRequest(approvalId: string, actor: ApprovalActor) {
  assertCanViewApprovals(actor as never);

  const approval = await prisma.purchaseApprovalRequest.findFirst({
    where: { id: approvalId, tenantId: actor.tenantId },
    include: REQUEST_INCLUDE,
  });
  if (!approval) throw new NotFoundError('Purchase approval request');

  if (!canViewRequest(approval, actor)) {
    throw new ForbiddenError('You are not authorized to view this purchase approval');
  }

  return approval;
}

function canViewRequest(approval: RequestWithRelations, actor: ApprovalActor): boolean {
  if (isApprovalAuditor(actor.role)) return true;
  if (approval.submittedById === actor.userId) return true;
  return approval.decisions.some(
    (decision) => decision.assignedApproverId === actor.userId || decision.decidedById === actor.userId,
  );
}

export async function getPurchaseApproval(approvalId: string, actor: ApprovalActor) {
  return serializeRequest(await loadVisibleRequest(approvalId, actor));
}

// ── Listing ───────────────────────────────────────────────────────────────────

export interface ApprovalListFilters {
  scope?: 'assigned' | 'requested' | 'all';
  status?: PurchaseApprovalStatus;
  requesterId?: string;
  vendorId?: string;
  department?: string;
  minAmount?: number;
  maxAmount?: number;
  from?: Date;
  to?: Date;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * The approval inbox.
 *
 * `assigned` resolves to requests with a level waiting on the actor - either
 * assigned to them by name, or open to their role. A buyer who is also an
 * approver therefore sees only what genuinely needs them, not every request in
 * the tenant.
 */
export async function listPurchaseApprovals(actor: ApprovalActor, filters: ApprovalListFilters = {}) {
  assertCanViewApprovals(actor as never);

  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const scope = filters.scope ?? 'all';

  const amountFilter: Prisma.Decimal[] = [];
  if (filters.minAmount !== undefined) amountFilter.push(toDecimal(filters.minAmount, 'minAmount'));
  if (filters.maxAmount !== undefined) amountFilter.push(toDecimal(filters.maxAmount, 'maxAmount'));

  const where: Prisma.PurchaseApprovalRequestWhereInput = { tenantId: actor.tenantId };

  if (filters.status) where.status = filters.status;
  if (filters.vendorId) where.vendorId = filters.vendorId;
  if (filters.department) where.request = { department: filters.department };
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }
  if (amountFilter.length > 0) {
    where.totalAmount = {
      ...(filters.minAmount !== undefined ? { gte: amountFilter[0] } : {}),
      ...(filters.maxAmount !== undefined ? { lte: amountFilter[1] } : {}),
    };
  }
  if (filters.search) {
    where.OR = [
      { reference: { contains: filters.search, mode: 'insensitive' } },
      { vendor: { name: { contains: filters.search, mode: 'insensitive' } } },
      { request: { title: { contains: filters.search, mode: 'insensitive' } } },
      { request: { item: { contains: filters.search, mode: 'insensitive' } } },
    ];
  }

  if (scope === 'requested' || filters.requesterId) {
    where.submittedById = filters.requesterId ?? actor.userId;
  }

  if (scope === 'assigned') {
    // The current level must be this actor's. Matching on `status: PENDING`
    // alone would surface a request where an earlier level is still open, which
    // reads as "your turn" when it is not.
    //
    // The prefilter is deliberately loose: named-to-me, or any pending level at
    // all. Narrowing it to `assignedApproverId = me` here would drop every open
    // level before it is ever loaded - an unnamed level has a NULL
    // assignedApproverId by definition - and the inbox would show nothing to
    // every approver whose level was opened by role rather than by name. It also
    // pins level 1, which is wrong for any request that reached level 2.
    // The precise "level == currentLevel, and yours to decide" test is applied
    // per row below, where currentLevel is actually readable.
    where.status = PurchaseApprovalStatus.PENDING_APPROVAL;
    where.decisions = { some: { status: PurchaseApprovalDecisionStatus.PENDING } };

    // Open levels (no named approver) are anyone-holding-the-role's to decide.
    // resolved in the service after the row is loaded, because Prisma cannot
    // express "level == currentLevel" against a column.
    const candidates = await prisma.purchaseApprovalRequest.findMany({
      where,
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    const { APPROVER_ROLES } = await import('./approval-roles.js');
    const mine = candidates.filter((approval) => {
      const level = approval.decisions.find((d) => d.level === approval.currentLevel);
      if (!level || level.status !== PurchaseApprovalDecisionStatus.PENDING) return false;
      if (level.assignedApproverId) return level.assignedApproverId === actor.userId;
      return APPROVER_ROLES.includes(actor.role) && canDecideApprovalLevel(actor.role, level.requiredRole);
    });

    return paginate(mine, page, limit, scope);
  }

  const [rows, total] = await Promise.all([
    prisma.purchaseApprovalRequest.findMany({
      where,
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.purchaseApprovalRequest.count({ where }),
  ]);

  return {
    data: rows.map(serializeRequest),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    scope,
  };
}

function paginate(rows: RequestWithRelations[], page: number, limit: number, scope: string) {
  const start = (page - 1) * limit;
  return {
    data: rows.slice(start, start + limit).map(serializeRequest),
    total: rows.length,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(rows.length / limit)),
    scope,
  };
}

// ── Submission ────────────────────────────────────────────────────────────────

export interface SubmitApprovalInput {
  offerId: string;
  requesterComment?: string;
  /** The offer that supersedes a previous request, when this is a revision. */
  parentRequestId?: string;
}

/**
 * Submit a negotiated offer for manager authorization.
 *
 * The commercial snapshot is taken from the offer here and never recomputed
 * afterwards. Whether approval is needed, and at which levels, is decided by the
 * organization's policy - never by a threshold in this file.
 */
export async function submitPurchaseApproval(
  actor: ApprovalActor,
  input: SubmitApprovalInput,
): Promise<{ request: ReturnType<typeof serializeRequest>; route: ResolvedApprovalRoute }> {
  assertApprovalBuyer(actor);

  const offer = await prisma.dealOffer.findFirst({
    where: { id: input.offerId, dealRoom: { tenantId: actor.tenantId } },
    include: {
      dealRoom: {
        include: {
          request: true,
          vendor: { select: { id: true, name: true } },
          negotiationMessages: { orderBy: { createdAt: 'asc' } },
          offers: { orderBy: { createdAt: 'asc' } },
        },
      },
    },
  });

  if (!offer) throw new NotFoundError('Offer');
  const dealRoom = offer.dealRoom;

  // The buyer's own room, or a buyer-side administrator acting on their behalf.
  const isRoomBuyer = dealRoom.buyerId === actor.userId;
  const isBuyerSideAdmin = !['VENDOR', 'VIEWER'].includes(actor.role);
  if (!isRoomBuyer && !isBuyerSideAdmin) {
    throw new ForbiddenError('Only the buyer of this negotiation may submit it for approval');
  }
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Supplier accounts cannot submit purchases for approval');
  }

  if (!['ACTIVE', 'PENDING_APPROVAL'].includes(offer.status)) {
    throw new ValidationError('This offer can no longer be submitted for approval');
  }

  // One live authorization per offer. The unique index on (offerId, tenantId) is
  // the real guard; this check turns the common double-click into a clear
  // message instead of a constraint violation.
  const existingForOffer = await prisma.purchaseApprovalRequest.findFirst({
    where: { offerId: offer.id, tenantId: actor.tenantId },
  });
  if (existingForOffer) {
    const existingStatus = requestStatus(existingForOffer.status);
    if (REVISABLE.includes(existingStatus)) {
      throw new ConflictError(
        `This offer already has approval request ${existingForOffer.reference} (${existingStatus.toLowerCase().replace(/_/g, ' ')})`,
      );
    }
    throw new ConflictError(
      `This offer was already submitted as ${existingForOffer.reference}. A revised offer needs its own submission.`,
    );
  }

  if (!Number.isInteger(offer.quantity) || offer.quantity <= 0) {
    throw new ValidationError('The offer quantity must be a positive whole number');
  }

  const subject: ApprovalSubject = {
    currency: (await loadActivePolicy(actor.tenantId))?.currency ?? 'INR',
    unitPrice: toDecimal(offer.unitPrice, 'unitPrice'),
    quantity: offer.quantity,
    taxRate: toDecimal(offer.gst, 'taxRate'),
    freightAmount: toDecimal(offer.freightAmount, 'freightAmount'),
    installationAmount: toDecimal(offer.installationAmount, 'installationAmount'),
    otherCharges: toDecimal(offer.otherCharges, 'otherCharges'),
    department: dealRoom.request.department,
    categoryId: dealRoom.request.categoryId,
    costCenter: dealRoom.request.costCenter,
  };

  const policy = await loadActivePolicy(actor.tenantId);
  const priced = priceForPolicy(
    {
      currency: subject.currency,
      unitPrice: subject.unitPrice,
      quantity: subject.quantity,
      taxRate: subject.taxRate,
      freightAmount: subject.freightAmount,
      installationAmount: subject.installationAmount,
      otherCharges: subject.otherCharges,
    },
    policy ?? { includeTaxesInThreshold: true, includeDeliveryChargesInThreshold: true },
  );

  const route = await resolveApprovalRoute(actor.tenantId, subject);
  await assertNotSplitPurchase(actor, dealRoom.vendorId, dealRoom.request.item, priced.thresholdAmount, policy);

  const parent = input.parentRequestId
    ? await prisma.purchaseApprovalRequest.findFirst({
        where: { id: input.parentRequestId, tenantId: actor.tenantId },
      })
    : null;
  if (input.parentRequestId && !parent) {
    throw new NotFoundError('Approval request being revised');
  }

  const reference = await nextDocumentNumber('PAR', actor.tenantId);

  const snapshot = {
    approvalRequired: route.approvalRequired,
    reason: route.reason,
    currency: route.currency,
    includeTaxesInThreshold: policy?.includeTaxesInThreshold ?? true,
    includeDeliveryChargesInThreshold: policy?.includeDeliveryChargesInThreshold ?? true,
    autoApproveBelowAmount: policy?.autoApproveBelowAmount?.toString() ?? null,
    allowSelfApproval: policy?.allowSelfApproval ?? false,
    selfApprovalJustification: policy?.selfApprovalJustification ?? null,
    reapprovalRules: (policy?.reapprovalRules as Prisma.InputJsonValue | null) ?? null,
    levels: route.levels as unknown as Prisma.InputJsonValue,
    resolvedAt: new Date().toISOString(),
  };

  const created = await prisma.purchaseApprovalRequest.create({
    data: {
      reference,
      tenantId: actor.tenantId,
      requestId: dealRoom.requestId,
      vendorId: dealRoom.vendorId,
      dealRoomId: dealRoom.id,
      offerId: offer.id,
      submittedById: actor.userId,
      status: route.approvalRequired
        ? PurchaseApprovalStatus.PENDING_APPROVAL
        : PurchaseApprovalStatus.APPROVED,

      currency: route.currency,
      unitPrice: priced.unitPrice,
      quantity: offer.quantity,
      taxRate: priced.taxRate,
      taxAmount: priced.taxAmount,
      freightAmount: priced.freight,
      installationAmount: priced.installation,
      otherCharges: priced.other,
      subtotal: priced.subtotal,
      totalAmount: priced.total,
      thresholdAmount: priced.thresholdAmount,

      paymentTerms: offer.paymentTerms ?? undefined,
      deliveryTimelineDays: offer.deliveryTimelineDays ?? undefined,
      warrantyMonths: offer.warrantyMonths ?? undefined,
      // The seller's quoted schedule is carried in full rather than reduced to a
      // day count, because an approver judges the schedule as it was agreed.
      deliverySchedule: buildDeliverySchedule(offer.deliveryTimelineDays),
      otherChargesDetails: offer.otherChargesDetails ?? undefined,
      documents: (offerStatusDocuments(offer) as Prisma.InputJsonValue) ?? Prisma.JsonNull,

      policyId: policy?.id,
      policyVersion: policy?.version,
      appliedRuleId: route.ruleId ?? null,
      policySnapshot: snapshot as unknown as Prisma.InputJsonValue,
      ruleSnapshot:
        route.approvalRequired
          ? ({
              id: route.ruleId,
              name: route.ruleName,
              thresholdAmount: route.thresholdAmount,
              levels: route.levels,
            } as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,

      requesterComment: input.requesterComment ?? undefined,
      negotiationSnapshot: buildNegotiationSnapshot(dealRoom) as Prisma.InputJsonValue,

      revision: parent ? parent.revision + 1 : 1,
      parentRequestId: parent?.id ?? null,
      currentLevel: 1,
      decidedAt: route.approvalRequired ? null : new Date(),

      decisions: route.approvalRequired
        ? {
            create: route.levels.map((level) => ({
              tenantId: actor.tenantId,
              level: level.level,
              requiredRole: level.requiredRole,
              label: level.label ?? null,
              status: PurchaseApprovalDecisionStatus.PENDING,
              assignedApproverId: level.approverId ?? null,
            })),
          }
        : undefined,
    },
    include: REQUEST_INCLUDE,
  });

  // A superseding approval invalidates its predecessor without erasing it, so
  // the figures and the decision given against them both remain readable.
  if (parent) {
    await prisma.purchaseApprovalRequest.update({
      where: { id: parent.id },
      data: {
        status: PurchaseApprovalStatus.SUPERSEDED,
        supersededById: created.id,
        supersededAt: new Date(),
        supersedeReason: 'Replaced by a revised offer',
      },
    });
  }

  // The offer is held rather than accepted: it cannot be finalized into a deal
  // while the authorization is outstanding.
  if (route.approvalRequired) {
    await prisma.dealOffer.updateMany({
      where: { dealRoomId: dealRoom.id, status: 'ACTIVE' },
      data: { status: 'PENDING_APPROVAL' },
    });
    await syncRequestStatus(dealRoom.requestId, actor.tenantId, PurchaseApprovalStatus.PENDING_APPROVAL);
  } else {
    await createAuditLog({
      userId: actor.userId,
      action: AuditAction.PURCHASE_APPROVAL_AUTO_APPROVED,
      entityType: 'PurchaseApprovalRequest',
      entityId: created.id,
      tenantId: actor.tenantId,
      newStatus: PurchaseApprovalStatus.APPROVED,
      decision: route.reason,
      metadata: {
        reference,
        thresholdAmount: priced.thresholdAmount.toString(),
        autoApprovedBelowThreshold: route.autoApprovedBelowThreshold,
        currency: route.currency,
      },
    });
  }

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PURCHASE_APPROVAL_SUBMITTED,
    entityType: 'PurchaseApprovalRequest',
    entityId: created.id,
    newStatus: created.status,
    tenantId: actor.tenantId,
    metadata: {
      reference,
      requestId: dealRoom.requestId,
      vendorId: dealRoom.vendorId,
      offerId: offer.id,
      unitPrice: priced.unitPrice.toString(),
      quantity: offer.quantity,
      subtotal: priced.subtotal.toString(),
      taxAmount: priced.taxAmount.toString(),
      freightAmount: priced.freight.toString(),
      installationAmount: priced.installation.toString(),
      otherCharges: priced.other.toString(),
      totalAmount: priced.total.toString(),
      thresholdAmount: priced.thresholdAmount.toString(),
      currency: route.currency,
      paymentTerms: offer.paymentTerms ?? undefined,
      deliveryTimelineDays: offer.deliveryTimelineDays ?? undefined,
      policyId: policy?.id,
      policyVersion: policy?.version,
      appliedRuleId: route.ruleId ?? undefined,
      approvalRequired: route.approvalRequired,
      levels: route.levels.map((level) => `L${level.level}:${level.requiredRole}`).join(','),
      revision: created.revision,
      supersedes: parent?.reference,
    },
  });

  if (route.approvalRequired) {
    await notifyApprovers(created, route, actor);
  }

  return { request: serializeRequest(created), route };
}

/** Where the notify link lands. Authentication is enforced when it is opened. */
const APPROVAL_LINK = (id: string) => `/purchase-approvals/${id}`;

async function notifyApprovers(approval: RequestWithRelations, route: ResolvedApprovalRoute, actor: ApprovalActor) {
  const firstLevel = approval.decisions.find((decision) => decision.level === 1);
  if (!firstLevel) return;

  // Previews carry no price, quantity, vendor or attachment name: the email may
  // travel, and the amount is only ever read behind authentication.
  const preview = `Purchase ${approval.reference} is awaiting ${route.levels.length} approval${
    route.levels.length === 1 ? '' : 's'
  } from ${approval.request?.title ?? 'a requirement'}`;

  const targets = new Set<string>();
  if (firstLevel.assignedApproverId) {
    targets.add(firstLevel.assignedApproverId);
  } else {
    // No named approver: everyone holding the level's role may decide, so the
    // first level's role holders are notified.
    const holders = await prisma.user.findMany({
      where: { tenantId: actor.tenantId, isActive: true, role: firstLevel.requiredRole },
      select: { id: true },
    });
    holders.forEach((holder) => targets.add(holder.id));
  }

  await Promise.all(
    [...targets].map((recipientId) =>
      notify({
        tenantId: actor.tenantId,
        recipientId,
        event: 'APPROVAL_ASSIGNED',
        linkPath: APPROVAL_LINK(approval.id),
        preview,
        // One notification per request per approver, however many levels they
        // could act at. A retried submission must not re-alert anyone.
        dedupeKey: `approval-assigned:${approval.id}:${recipientId}`,
      }).catch(() => undefined),
    ),
  );
}

/** Sellers attach documents by URL; the names are what an approver needs to see. */
function offerStatusDocuments(offer: { id: string }) {
  return [] as string[];
}

function buildDeliverySchedule(deliveryTimelineDays: number | null | undefined): string | undefined {
  if (!deliveryTimelineDays || !Number.isFinite(deliveryTimelineDays)) return undefined;
  const date = new Date();
  date.setDate(date.getDate() + deliveryTimelineDays);
  return `${deliveryTimelineDays} day${deliveryTimelineDays === 1 ? '' : 's'} - expected ${date.toISOString().slice(0, 10)}`;
}

/**
 * The negotiation history as it stood at submission.
 *
 * Stored rather than joined so an approver reads the history that existed when
 * they decided, even after the room moves on. Amounts are included: the
 * approver is inside the organization and this snapshot never leaves NAVO.
 */
function buildNegotiationSnapshot(dealRoom: {
  id: string;
  vendor: { name: string };
  negotiationMessages: Array<{ createdAt: Date }>;
  offers: Array<{
    id: string;
    unitPrice: number;
    quantity: number;
    gst: number;
    freightAmount: number;
    installationAmount: number;
    otherCharges: number;
    status: string;
    submittedByRole: string;
    createdAt: Date;
  }>;
}) {
  return {
    dealRoomId: dealRoom.id,
    vendorName: dealRoom.vendor.name,
    messageCount: dealRoom.negotiationMessages.length,
    offerCount: dealRoom.offers.length,
    lastMessageAt: dealRoom.negotiationMessages.at(-1)?.createdAt?.toISOString(),
    offers: dealRoom.offers.map((offer) => {
      const priced = priceForPolicy(
        {
          currency: 'INR',
          unitPrice: toDecimal(offer.unitPrice, 'unitPrice'),
          quantity: offer.quantity,
          taxRate: toDecimal(offer.gst, 'taxRate'),
          freightAmount: toDecimal(offer.freightAmount, 'freightAmount'),
          installationAmount: toDecimal(offer.installationAmount, 'installationAmount'),
          otherCharges: toDecimal(offer.otherCharges, 'otherCharges'),
        },
        { includeTaxesInThreshold: true, includeDeliveryChargesInThreshold: true },
      );
      return {
        id: offer.id,
        unitPrice: offer.unitPrice,
        quantity: offer.quantity,
        totalAmount: decimalToNumber(priced.total),
        status: offer.status,
        submittedByRole: offer.submittedByRole,
        createdAt: offer.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * Refuse a purchase that looks like a split of a larger one.
 *
 * The exemption an organization configures (`autoApproveBelowAmount`) is
 * worthless if a buyer can defeat it by submitting the same purchase in pieces,
 * so submissions by the same person for the same vendor and item inside the
 * policy's window are summed against the exemption and refused when the total
 * crosses it. Genuinely separate purchases of the same item are unaffected
 * because the window is the organization's to set.
 */
export async function assertNotSplitPurchase(
  actor: ApprovalActor,
  vendorId: string,
  item: string,
  thresholdAmount: Prisma.Decimal,
  policy: Awaited<ReturnType<typeof loadActivePolicy>>,
): Promise<void> {
  if (!policy || !policy.splitGuardEnabled || policy.autoApproveBelowAmount === null) return;
  if (thresholdAmount.gte(policy.autoApproveBelowAmount)) return;

  const windowStart = new Date(Date.now() - policy.splitGuardWindowDays * 24 * 60 * 60 * 1000);
  const normalizedItem = item.trim().toLowerCase();

  const recent = await prisma.purchaseApprovalRequest.findMany({
    where: {
      tenantId: actor.tenantId,
      submittedById: actor.userId,
      vendorId,
      createdAt: { gte: windowStart },
      status: {
        in: [
          PurchaseApprovalStatus.PENDING_APPROVAL,
          PurchaseApprovalStatus.APPROVED,
          PurchaseApprovalStatus.PURCHASE_CONFIRMED,
        ],
      },
      request: { item: { equals: item, mode: 'insensitive' } },
    },
    select: { id: true, reference: true, thresholdAmount: true, request: { select: { item: true } } },
  });

  // Exact item match on top of the query filter: two spellings of the same item
  // ("Laptops" / "laptops") must not slip through the comparison.
  const sameItem = recent.filter((row) => row.request.item.trim().toLowerCase() === normalizedItem);
  if (sameItem.length === 0) return;

  const combined = sameItem.reduce(
    (sum, row) => sum.plus(row.thresholdAmount),
    thresholdAmount,
  );

  if (combined.gte(policy.autoApproveBelowAmount)) {
    throw new ConflictError(
      `This looks like part of a larger purchase: ${sameItem.length} recent request${
        sameItem.length === 1 ? '' : 's'
      } for the same item and vendor total ${combined.toString()} ${policy.currency}, which is above the ` +
        `${policy.autoApproveBelowAmount.toString()} ${policy.currency} approval threshold. ` +
        'Submit it as a single purchase, or ask an administrator to review the threshold.',
    );
  }
}

// ── Decisions ─────────────────────────────────────────────────────────────────

export interface DecisionInput {
  status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  comments?: string;
}

/**
 * Record a decision on one approval level.
 *
 * Ordering is enforced: a level cannot be decided until every lower level is
 * approved, so a finance approval cannot unlock the purchase while procurement
 * review is still open. The write is a conditional update, which is what makes
 * two managers clicking Approve at the same moment produce one decision rather
 * than two.
 */
export async function decidePurchaseApproval(
  decisionId: string,
  actor: ApprovalActor,
  input: DecisionInput,
) {
  assertApprover(actor);

  const decision = await prisma.purchaseApprovalDecision.findFirst({
    where: { id: decisionId, tenantId: actor.tenantId },
    include: { purchaseApprovalRequest: { include: REQUEST_INCLUDE } },
  });
  if (!decision) throw new NotFoundError('Approval level');
  const approval = decision.purchaseApprovalRequest;

  if (approval.status !== PurchaseApprovalStatus.PENDING_APPROVAL) {
    throw new ConflictError(
      `This purchase approval is ${approval.status.toLowerCase().replace(/_/g, ' ')} and is not awaiting a decision`,
    );
  }

  if (decision.level !== approval.currentLevel) {
    throw new ConflictError(
      `Level ${decision.level} is not the level awaiting a decision (level ${approval.currentLevel} is)`,
    );
  }

  if (!canDecideApprovalLevel(actor.role, decision.requiredRole)) {
    throw new ForbiddenError(
      `Level ${decision.level} requires ${decision.requiredRole.replace(/_/g, ' ').toLowerCase()}`,
    );
  }

  // A level routed to a named approver is that approver's to decide.
  if (decision.assignedApproverId && decision.assignedApproverId !== actor.userId) {
    throw new ForbiddenError('This approval was assigned to someone else');
  }

  // A rejection or a return with no reason gives the buyer nothing to act on.
  if (input.status !== 'APPROVED' && !input.comments?.trim()) {
    throw new ValidationError('A comment is required when rejecting or requesting changes');
  }

  const selfApprovalJustification = assertMaySelfApprove(
    approval.policy
      ? {
          allowSelfApproval: approval.policy.allowSelfApproval,
          selfApprovalJustification: approval.policy.selfApprovalJustification,
        }
      : null,
    approval.submittedById,
    actor.userId,
    actor.role,
  );

  const nextStatus =
    input.status === 'APPROVED'
      ? PurchaseApprovalDecisionStatus.APPROVED
      : input.status === 'REJECTED'
        ? PurchaseApprovalDecisionStatus.REJECTED
        : PurchaseApprovalDecisionStatus.CHANGES_REQUESTED;

  // Conditional write: the second of two concurrent approvers updates zero rows
  // and is told the decision was already made, rather than overwriting it.
  const claimed = await prisma.purchaseApprovalDecision.updateMany({
    where: { id: decisionId, status: PurchaseApprovalDecisionStatus.PENDING },
    data: {
      status: nextStatus,
      comments: input.comments?.trim() || null,
      decidedById: actor.userId,
      decidedAt: new Date(),
      // A level nobody was named for is claimed by whoever decided it, so the
      // record shows who was actually asked.
      assignedApproverId: decision.assignedApproverId ?? actor.userId,
    },
  });
  if (claimed.count === 0) {
    throw new ConflictError('This approval level has already been decided');
  }

  const remaining = await prisma.purchaseApprovalDecision.findMany({
    where: { purchaseApprovalRequestId: approval.id },
    orderBy: { level: 'asc' },
  });

  const approved = remaining.filter((level) => level.status === PurchaseApprovalDecisionStatus.APPROVED);
  const blocked = remaining.find(
    (level) =>
      level.status === PurchaseApprovalDecisionStatus.REJECTED ||
      level.status === PurchaseApprovalDecisionStatus.CHANGES_REQUESTED,
  );
  const allApproved = remaining.every((level) => level.status === PurchaseApprovalDecisionStatus.APPROVED);

  let requestStatus: PurchaseApprovalStatus;
  if (blocked) {
    requestStatus =
      blocked.status === PurchaseApprovalDecisionStatus.REJECTED
        ? PurchaseApprovalStatus.REJECTED
        : PurchaseApprovalStatus.CHANGES_REQUESTED;
  } else if (allApproved) {
    requestStatus = PurchaseApprovalStatus.APPROVED;
  } else {
    requestStatus = PurchaseApprovalStatus.PENDING_APPROVAL;
  }

  const nextLevel = remaining.find(
    (level) => level.status === PurchaseApprovalDecisionStatus.PENDING && level.level > decision.level,
  );

  const updated = await prisma.purchaseApprovalRequest.update({
    where: { id: approval.id },
    data: {
      status: requestStatus,
      currentLevel: nextLevel?.level ?? approval.currentLevel,
      decidedAt: allApproved ? new Date() : approval.decidedAt,
    },
    include: REQUEST_INCLUDE,
  });

  await createAuditLog({
    userId: actor.userId,
    action:
      input.status === 'APPROVED'
        ? AuditAction.PURCHASE_APPROVAL_APPROVED
        : input.status === 'REJECTED'
          ? AuditAction.PURCHASE_APPROVAL_REJECTED
          : AuditAction.PURCHASE_APPROVAL_CHANGES_REQUESTED,
    entityType: 'PurchaseApprovalDecision',
    entityId: decisionId,
    previousStatus: PurchaseApprovalDecisionStatus.PENDING,
    newStatus: nextStatus,
    decision: input.comments?.trim() || undefined,
    tenantId: actor.tenantId,
    metadata: {
      reference: approval.reference,
      level: decision.level,
      requiredRole: decision.requiredRole,
      totalAmount: approval.totalAmount.toString(),
      thresholdAmount: approval.thresholdAmount.toString(),
      currency: approval.currency,
      policyId: approval.policyId,
      policyVersion: approval.policyVersion,
      appliedRuleId: approval.appliedRuleId,
      // Recorded whenever the organization permits it, so an approved
      // self-approval is never an unexplained exception in the trail.
      selfApprovalJustification,
      requestStatus,
      nextLevel: nextLevel?.level ?? null,
      approvedLevels: approved.length,
    },
  });

  await notifyRequesterOfDecision(updated, actor, input.status, input.comments?.trim());

  // Only a fully approved request may be finalized into a deal. Rejection and
  // changes-requested leave the offer selected but uncommitted.
  if (allApproved) {
    await finalizeIfAuthorized(updated.id, actor.tenantId, actor.userId);
  }

  return serializeRequest(updated);
}

async function notifyRequesterOfDecision(
  approval: RequestWithRelations,
  actor: ApprovalActor,
  status: DecisionInput['status'],
  comments?: string,
) {
  const event =
    status === 'APPROVED'
      ? 'APPROVAL_APPROVED'
      : status === 'REJECTED'
        ? 'APPROVAL_REJECTED'
        : 'APPROVAL_CHANGES_REQUESTED';

  const verb =
    status === 'APPROVED' ? 'approved' : status === 'REJECTED' ? 'rejected' : 'returned for changes';

  await notify({
    tenantId: actor.tenantId,
    recipientId: approval.submittedById,
    event,
    linkPath: APPROVAL_LINK(approval.id),
    // A comment is written by a manager and may legitimately name figures, so
    // the email preview stays summary-only; the full text is behind the link.
    preview: `Purchase ${approval.reference} was ${verb}${comments ? ' with comments' : ''}`,
    dedupeKey: `approval-decision:${decisionKey(approval.id, status, actor.userId)}`,
  }).catch(() => undefined);
}

/** Distinguishes repeated decisions at different levels for one request. */
function decisionKey(approvalId: string, status: string, actorId: string): string {
  return `${approvalId}:${status}:${actorId}`;
}

/**
 * Turn a fully approved request into a deal.
 *
  * The offer was held in PENDING_APPROVAL during the review, so the deal is
   * created here rather than by the buyer. Runs after the final level is approved
   * and before the buyer can confirm, so a confirmed purchase always sits on an
   * approved request.
   */
  async function finalizeIfAuthorized(approvalId: string, tenantId: string, actorId: string): Promise<void> {
    const approval = await prisma.purchaseApprovalRequest.findFirst({
      where: { id: approvalId, tenantId },
      include: { offer: true },
    });
    if (!approval || approval.dealId) return;
    if (approval.status !== PurchaseApprovalStatus.APPROVED) return;

    // CommercialOfferSubmission path: the approval was submitted from the
    // 4-offer engine rather than the negotiation DealOffer engine.
    if (approval.selectedSubmissionId && !approval.offerId) {
      const { createDealFromSubmission } = await import('../deal-execution/deal-execution.service.js');
      await createDealFromSubmission(approval.selectedSubmissionId, actorId, tenantId);
      return;
    }

    if (!approval.offerId || !approval.offer) return;
    if (approval.offer.status !== 'PENDING_APPROVAL' && approval.offer.status !== 'ACTIVE') return;

    const result = await finalizeAcceptedOffer(approval.offerId, actorId, tenantId);

    await prisma.purchaseApprovalRequest.update({
      where: { id: approvalId },
      data: { dealId: result.deal.id },
    });
  }

// ── Reassignment ──────────────────────────────────────────────────────────────

/**
 * Route a pending level to a different approver.
 *
 * Restricted to approvers and administrators, and every change is appended to the
 * assignment history rather than overwriting the previous approver, so "who was
 * actually asked" survives every later change.
 */
export async function reassignApproval(
  decisionId: string,
  actor: ApprovalActor,
  input: { approverId: string; reason: string },
) {
  if (!APPROVAL_AUDIT_ROLES.includes(actor.role)) {
    throw new ForbiddenError('Only an approver or administrator can reassign an approval');
  }

  const decision = await prisma.purchaseApprovalDecision.findFirst({
    where: { id: decisionId, tenantId: actor.tenantId },
    include: { purchaseApprovalRequest: { select: { id: true, reference: true, status: true } } },
  });
  if (!decision) throw new NotFoundError('Approval level');
  if (decision.status !== PurchaseApprovalDecisionStatus.PENDING) {
    throw new ConflictError('A decided approval level cannot be reassigned');
  }
  if (decision.purchaseApprovalRequest.status !== PurchaseApprovalStatus.PENDING_APPROVAL) {
    throw new ConflictError('This purchase approval is no longer awaiting a decision');
  }

  // The new approver must be able to decide the level they are being given.
  const target = await prisma.user.findFirst({
    where: { id: input.approverId, tenantId: actor.tenantId, isActive: true },
    select: { id: true, firstName: true, lastName: true, role: true },
  });
  if (!target) throw new NotFoundError('Approver');
  if (!canDecideApprovalLevel(target.role, decision.requiredRole)) {
    throw new ValidationError(
      `${target.firstName} ${target.lastName} cannot decide a ${decision.requiredRole
        .replace(/_/g, ' ')
        .toLowerCase()} approval`,
    );
  }

  const previous = decision.assignedApproverId;

  await prisma.$transaction(async (tx) => {
    await tx.purchaseApprovalDecision.update({
      where: { id: decisionId },
      data: {
        assignedApproverId: target.id,
        delegatedFromApproverId: previous,
        delegationReason: input.reason,
      },
    });
    await tx.purchaseApprovalAssignment.create({
      data: {
        tenantId: actor.tenantId,
        decisionId,
        fromApproverId: previous,
        toApproverId: target.id,
        reason: input.reason,
        createdById: actor.userId,
      },
    });
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PURCHASE_APPROVAL_REASSIGNED,
    entityType: 'PurchaseApprovalDecision',
    entityId: decisionId,
    previousStatus: previous ?? 'UNASSIGNED',
    newStatus: target.id,
    decision: input.reason,
    tenantId: actor.tenantId,
    metadata: {
      reference: decision.purchaseApprovalRequest.reference,
      level: decision.level,
      requiredRole: decision.requiredRole,
      fromApproverId: previous,
      toApproverId: target.id,
    },
  });

  await notify({
    tenantId: actor.tenantId,
    recipientId: target.id,
    event: 'APPROVAL_ASSIGNED',
    linkPath: APPROVAL_LINK(decision.purchaseApprovalRequest.id),
    preview: `Purchase ${decision.purchaseApprovalRequest.reference} has been assigned to you`,
    dedupeKey: `approval-assigned:${decision.purchaseApprovalRequest.id}:${target.id}:${decisionId}`,
  }).catch(() => undefined);

  return prisma.purchaseApprovalDecision.findUnique({
    where: { id: decisionId },
    include: { assignedApprover: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
}

// ── Cancellation ──────────────────────────────────────────────────────────────

export async function cancelPurchaseApproval(
  approvalId: string,
  actor: ApprovalActor,
  input: { reason: string },
) {
  assertApprovalBuyer(actor);

  const approval = await loadVisibleRequest(approvalId, actor);
  if (approval.submittedById !== actor.userId && !APPROVAL_AUDIT_ROLES.includes(actor.role)) {
    throw new ForbiddenError('Only the requester or an administrator can cancel this request');
  }
  if (
    approval.status === PurchaseApprovalStatus.CANCELLED ||
    approval.status === PurchaseApprovalStatus.SUPERSEDED
  ) {
    throw new ConflictError(`This request is already ${approval.status.toLowerCase()}`);
  }
  if (approval.status === PurchaseApprovalStatus.PURCHASE_CONFIRMED) {
    throw new ConflictError('A confirmed purchase cannot be cancelled through approvals');
  }

  const updated = await prisma.purchaseApprovalRequest.update({
    where: { id: approvalId },
    data: {
      status: PurchaseApprovalStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: input.reason,
    },
    include: REQUEST_INCLUDE,
  });

  // Pending levels are marked skipped rather than left dangling, so the history
  // explains why nobody is expected to act on them.
  await prisma.purchaseApprovalDecision.updateMany({
    where: { purchaseApprovalRequestId: approvalId, status: PurchaseApprovalDecisionStatus.PENDING },
    data: { status: PurchaseApprovalDecisionStatus.SKIPPED },
  });

  // The hold on the offer is released: the buyer may keep negotiating, and any
  // later submission is judged on its own terms.
  await prisma.dealOffer.updateMany({
    where: { dealRoomId: approval.dealRoomId ?? undefined, status: 'PENDING_APPROVAL' },
    data: { status: 'ACTIVE' },
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PURCHASE_APPROVAL_CANCELLED,
    entityType: 'PurchaseApprovalRequest',
    entityId: approvalId,
    previousStatus: approval.status,
    newStatus: PurchaseApprovalStatus.CANCELLED,
    decision: input.reason,
    tenantId: actor.tenantId,
    metadata: { reference: approval.reference, totalAmount: approval.totalAmount.toString() },
  });

  await syncRequestStatus(approval.requestId, actor.tenantId, PurchaseApprovalStatus.CANCELLED);

  return serializeRequest(updated);
}

// ── Purchase confirmation ─────────────────────────────────────────────────────

/**
 * Confirm an approved purchase.
 *
 * This is the step that commits company funds, and it is deliberately separate
 * from approval: an approved request is an authorization, not a purchase. The
 * actor must be the requester or a buyer-side administrator, and the terms must
 * still match the snapshot that was approved - if the offer moved since, the
 * approval was already superseded and this call refuses.
 */
export async function confirmPurchase(approvalId: string, actor: ApprovalActor) {
  assertApprovalBuyer(actor);

  const approval = await loadVisibleRequest(approvalId, actor);
  if (approval.submittedById !== actor.userId && !APPROVAL_AUDIT_ROLES.includes(actor.role)) {
    throw new ForbiddenError('Only the requester or an administrator can confirm this purchase');
  }
  if (approval.status === PurchaseApprovalStatus.PURCHASE_CONFIRMED) {
    throw new ConflictError('This purchase has already been confirmed');
  }
  if (approval.status !== PurchaseApprovalStatus.APPROVED) {
    throw new ConflictError(
      `This purchase is ${approval.status.toLowerCase().replace(/_/g, ' ')} and is not approved for confirmation`,
    );
  }

  // The approved figures must still be the offer's figures. A post-approval
  // change suspends the request rather than silently re-pricing what was bought.
  if (approval.offerId) {
    const offer = await prisma.dealOffer.findFirst({
      where: { id: approval.offerId },
      select: { unitPrice: true, quantity: true, paymentTerms: true, deliveryTimelineDays: true },
    });
    if (offer) {
      const triggers = detectMaterialChanges(
        (approval.policy?.reapprovalRules ?? null) as Record<string, boolean> | null,
        {
          unitPrice: decimalToNumber(approval.unitPrice),
          quantity: approval.quantity,
          paymentTerms: approval.paymentTerms,
          deliveryTimelineDays: approval.deliveryTimelineDays,
          warrantyMonths: approval.warrantyMonths,
          otherChargesDetails: approval.otherChargesDetails,
        },
        {
          unitPrice: decimalToNumber(offer.unitPrice),
          quantity: offer.quantity,
          paymentTerms: offer.paymentTerms,
          deliveryTimelineDays: offer.deliveryTimelineDays,
          warrantyMonths: approval.warrantyMonths,
          otherChargesDetails: approval.otherChargesDetails,
        },
      );
      if (triggers.length > 0) {
        throw new ConflictError(
          `The approved terms changed after approval (${triggers.join(', ')}). ` +
            'The approval has been suspended and the revised offer must be submitted again.',
        );
      }
    }
  } else if (approval.selectedSubmissionId) {
    const submission = await prisma.commercialOfferSubmission.findFirst({
      where: { id: approval.selectedSubmissionId },
      select: { unitPrice: true, quantity: true, paymentTerms: true, deliveryDate: true },
    });
    if (submission) {
      const triggers = detectMaterialChanges(
        (approval.policy?.reapprovalRules ?? null) as Record<string, boolean> | null,
        {
          unitPrice: decimalToNumber(approval.unitPrice),
          quantity: approval.quantity,
          paymentTerms: approval.paymentTerms,
          deliveryTimelineDays: approval.deliveryTimelineDays,
          warrantyMonths: approval.warrantyMonths,
          otherChargesDetails: approval.otherChargesDetails,
        },
        {
          unitPrice: submission.unitPrice ? decimalToNumber(submission.unitPrice) : decimalToNumber(approval.unitPrice),
          quantity: submission.quantity ?? approval.quantity,
          paymentTerms: submission.paymentTerms,
          deliveryTimelineDays: approval.deliveryTimelineDays,
          warrantyMonths: approval.warrantyMonths,
          otherChargesDetails: approval.otherChargesDetails,
        },
      );
      if (triggers.length > 0) {
        throw new ConflictError(
          `The approved terms changed after approval (${triggers.join(', ')}). ` +
            'The approval has been suspended and the revised offer must be submitted again.',
        );
      }
    }
  } else {
    throw new ConflictError('This approval has no offer or selected submission to verify against');
  }

  const updated = await prisma.purchaseApprovalRequest.update({
    where: { id: approvalId },
    data: {
      status: PurchaseApprovalStatus.PURCHASE_CONFIRMED,
      purchaseConfirmedAt: new Date(),
      purchaseConfirmedById: actor.userId,
    },
    include: REQUEST_INCLUDE,
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PURCHASE_CONFIRMED,
    entityType: 'PurchaseApprovalRequest',
    entityId: approvalId,
    previousStatus: approval.status,
    newStatus: PurchaseApprovalStatus.PURCHASE_CONFIRMED,
    tenantId: actor.tenantId,
    metadata: {
      reference: approval.reference,
      policyId: approval.policyId,
      policyVersion: approval.policyVersion,
      appliedRuleId: approval.appliedRuleId,
      unitPrice: approval.unitPrice.toString(),
      quantity: approval.quantity,
      totalAmount: approval.totalAmount.toString(),
      thresholdAmount: approval.thresholdAmount.toString(),
      currency: approval.currency,
      // Confirmation is not the end of the story: the order is what makes the
      // purchase complete, and the flag is derived rather than assumed.
      purchaseOrderRaised: Boolean(approval.purchaseOrderId),
    },
  });

  await notify({
    tenantId: actor.tenantId,
    recipientId: approval.submittedById,
    event: 'PURCHASE_CONFIRMED',
    linkPath: APPROVAL_LINK(approvalId),
    preview: `Purchase ${approval.reference} has been confirmed`,
    dedupeKey: `purchase-confirmed:${approvalId}`,
  }).catch(() => undefined);

  return serializeRequest(updated);
}

// ── Purchase order linkage ────────────────────────────────────────────────────

/**
 * Record that a purchase order was raised against this authorization.
 *
 * Called by the purchase-order service when the order is created. It is what
 * turns an approved-and-confirmed request into a completed purchase, and the
 * one-to-one constraint on `purchaseOrderId` is what guarantees the same
 * authorization cannot produce a second order.
 */
export async function linkPurchaseOrder(approvalId: string, poId: string, tenantId: string): Promise<void> {
  const approval = await prisma.purchaseApprovalRequest.findFirst({
    where: { id: approvalId, tenantId },
    select: { id: true, reference: true, requestId: true, status: true, totalAmount: true },
  });
  if (!approval) return;

  if (approval.status !== PurchaseApprovalStatus.PURCHASE_CONFIRMED) {
    throw new ConflictError(
      'A purchase order can only be raised against a confirmed purchase approval',
    );
  }

  await prisma.purchaseApprovalRequest.update({
    where: { id: approvalId },
    data: { purchaseOrderId: poId },
  });

  await syncRequestStatus(approval.requestId, tenantId, PurchaseApprovalStatus.PURCHASE_CONFIRMED);
}

// ── History and reporting ─────────────────────────────────────────────────────

/**
 * Approval history for one requirement, newest first.
 *
 * Every submission, decision, reassignment and confirmation for the requirement,
 * read from the permanent audit log rather than from the current state of the
 * rows - so a superseded or cancelled attempt is still visible.
 */
export async function getApprovalHistoryForRequest(requestId: string, actor: ApprovalActor) {
  assertCanViewApprovals(actor as never);

  const approvals = await prisma.purchaseApprovalRequest.findMany({
    where: { requestId, tenantId: actor.tenantId },
    include: REQUEST_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });

  if (approvals.length === 0) return [];
  if (!approvals.some((approval) => canViewRequest(approval, actor))) {
    throw new ForbiddenError('You are not authorized to view this purchase approval history');
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      tenantId: actor.tenantId,
      entityType: { in: ['PurchaseApprovalRequest', 'PurchaseApprovalDecision'] },
      entityId: { in: approvals.map((approval) => approval.id) },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });

  const decisions = await prisma.purchaseApprovalDecision.findMany({
    where: { purchaseApprovalRequestId: { in: approvals.map((a) => a.id) } },
    orderBy: [{ purchaseApprovalRequestId: 'asc' }, { level: 'asc' }],
    include: {
      assignedApprover: { select: { id: true, firstName: true, lastName: true, email: true } },
      decidedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      assignments: {
        orderBy: { createdAt: 'asc' },
        include: {
          toApprover: { select: { id: true, firstName: true, lastName: true, email: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
    },
  });

  return {
    requests: approvals.map(serializeRequest),
    decisions,
    auditTrail: logs,
  };
}

/**
 * Administrative overview, computed entirely from stored rows.
 *
 * Turnaround is the real elapsed time between submission and the final decision
 * on requests that have reached one, with the count of undecided requests stated
 * alongside so a reviewer can see the sample size. Nothing here is a placeholder:
 * if there is no data, the figures are zero and the count explains why.
 */
export async function getApprovalOverview(actor: ApprovalActor) {
  if (!isApprovalAuditor(actor.role)) {
    throw new ForbiddenError('Only an administrator can view the approval overview');
  }

  const byStatus = await prisma.purchaseApprovalRequest.groupBy({
    by: ['status'],
    where: { tenantId: actor.tenantId },
    _count: { _all: true },
  });

  const statusCounts = Object.fromEntries(
    byStatus.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;

  const decided = await prisma.purchaseApprovalRequest.findMany({
    where: { tenantId: actor.tenantId, decidedAt: { not: null } },
    select: { createdAt: true, decidedAt: true, status: true, totalAmount: true, currency: true },
    orderBy: { decidedAt: 'desc' },
    take: 1000,
  });

  const turnaroundHours = decided
    .filter((row) => row.decidedAt)
    .map((row) => (row.decidedAt!.getTime() - row.createdAt.getTime()) / (1000 * 60 * 60))
    .filter((hours) => Number.isFinite(hours) && hours >= 0);

  const pending = await prisma.purchaseApprovalRequest.findMany({
    where: { tenantId: actor.tenantId, status: PurchaseApprovalStatus.PENDING_APPROVAL },
    select: {
      id: true,
      reference: true,
      createdAt: true,
      totalAmount: true,
      currency: true,
      currentLevel: true,
      submittedBy: { select: { id: true, firstName: true, lastName: true } },
      vendor: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  const returned = await prisma.purchaseApprovalRequest.findMany({
    where: {
      tenantId: actor.tenantId,
      status: {
        in: [PurchaseApprovalStatus.REJECTED, PurchaseApprovalStatus.CHANGES_REQUESTED],
      },
    },
    select: {
      id: true,
      reference: true,
      status: true,
      createdAt: true,
      totalAmount: true,
      currency: true,
      submittedBy: { select: { id: true, firstName: true, lastName: true } },
      vendor: { select: { id: true, name: true } },
      decisions: {
        where: { status: { in: ['REJECTED', 'CHANGES_REQUESTED'] } },
        select: { comments: true, decidedAt: true, decidedBy: { select: { firstName: true, lastName: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const average = turnaroundHours.length
    ? turnaroundHours.reduce((sum, value) => sum + value, 0) / turnaroundHours.length
    : null;

  const sorted = [...turnaroundHours].sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  return {
    // Stated so the figures above can never be read as a complete population.
    sampleSize: decided.length,
    pendingCount: statusCounts[PurchaseApprovalStatus.PENDING_APPROVAL] ?? 0,
    byStatus: statusCounts,
    averageTurnaroundHours: average === null ? null : Math.round(average * 10) / 10,
    medianTurnaroundHours: median === null ? null : Math.round(median * 10) / 10,
    longestPendingDays: pending.length
      ? Math.max(
          ...pending.map((row) =>
            Math.floor((Date.now() - row.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
          ),
        )
      : 0,
    pending: pending.map((row) => ({
      id: row.id,
      reference: row.reference,
      totalAmount: decimalToNumber(row.totalAmount),
      currency: row.currency,
      currentLevel: row.currentLevel,
      submittedBy: row.submittedBy,
      vendor: row.vendor,
      waitingDays: Math.floor((Date.now() - row.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
    })),
    returnedOrRejected: returned.map((row) => ({
      id: row.id,
      reference: row.reference,
      status: row.status,
      totalAmount: decimalToNumber(row.totalAmount),
      currency: row.currency,
      submittedBy: row.submittedBy,
      vendor: row.vendor,
      comments: row.decisions[0]?.comments ?? null,
      decidedBy: row.decisions[0]?.decidedBy ?? null,
    })),
  };
}

// ── Pre-submission explanation ────────────────────────────────────────────────

/**
 * Tell a buyer what will happen before they commit to submitting.
 *
 * Answers the two questions the workflow has to answer up front: why is approval
 * required, and who must give it. Same resolver the submission uses, so the
 * explanation cannot disagree with the outcome.
 */
export async function previewApprovalRoute(offerId: string, actor: ApprovalActor): Promise<ResolvedApprovalRoute> {
  assertApprovalBuyer(actor);

  const offer = await prisma.dealOffer.findFirst({
    where: { id: offerId, dealRoom: { tenantId: actor.tenantId } },
    include: { dealRoom: { include: { request: true } } },
  });
  if (!offer) throw new NotFoundError('Offer');

  const policy = await loadActivePolicy(actor.tenantId);
  return resolveApprovalRoute(actor.tenantId, {
    currency: policy?.currency ?? 'INR',
    unitPrice: toDecimal(offer.unitPrice, 'unitPrice'),
    quantity: offer.quantity,
    taxRate: toDecimal(offer.gst, 'taxRate'),
    freightAmount: toDecimal(offer.freightAmount, 'freightAmount'),
    installationAmount: toDecimal(offer.installationAmount, 'installationAmount'),
    otherCharges: toDecimal(offer.otherCharges, 'otherCharges'),
    department: offer.dealRoom.request.department,
    categoryId: offer.dealRoom.request.categoryId,
    costCenter: offer.dealRoom.request.costCenter,
  });
}

// ── Requirement status projection ─────────────────────────────────────────────

/**
 * Mirror the authorization's state onto the requirement.
 *
 * The requirement's own status is what most screens already read, so leaving it
 * stale would show a buyer "Approved" for a purchase that was never confirmed.
 * PURCHASE_CONFIRMED advances to PURCHASE_ORDER_CREATED only once the order
 * exists; until then the requirement stays APPROVED, because authorization is
 * not a completed purchase.
 */
async function syncRequestStatus(
  requestId: string,
  tenantId: string,
  status: PurchaseApprovalStatus,
): Promise<void> {
  // The Prisma enum, not the shared mirror: the value is written to the column.
  const map: Partial<Record<PurchaseApprovalStatus, PrismaRequestStatus>> = {
    [PurchaseApprovalStatus.PENDING_APPROVAL]: PrismaRequestStatus.APPROVAL_PENDING,
    [PurchaseApprovalStatus.APPROVED]: PrismaRequestStatus.APPROVED,
    [PurchaseApprovalStatus.REJECTED]: PrismaRequestStatus.REJECTED,
    [PurchaseApprovalStatus.CHANGES_REQUESTED]: PrismaRequestStatus.CHANGES_REQUESTED,
    [PurchaseApprovalStatus.CANCELLED]: PrismaRequestStatus.CANCELLED,
  };

  const target = map[status];
  if (!target) return;

  // A requirement that already reached a terminal purchase state is not walked
  // backwards by a later, unrelated approval.
  const current = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
    select: { status: true },
  });
  if (!current) return;
  const terminal: PrismaRequestStatus[] = [
    PrismaRequestStatus.PURCHASE_ORDER_CREATED,
    PrismaRequestStatus.COMPLETED,
  ];
  if (terminal.includes(current.status)) return;

  await prisma.procurementRequest.update({ where: { id: requestId }, data: { status: target } });
}

// ── Re-exports used by the negotiation and purchase-order paths ───────────────

export { detectMaterialChanges } from './approval-policy.service.js';
export type { PurchaseApprovalChangeTrigger };
