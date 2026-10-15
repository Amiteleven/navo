import { Prisma } from '@prisma/client';
import {
  AuditAction,
  DealExecutionEventType,
  DealExecutionStatus,
  DealExecutionType,
  DealStatus,
  NotificationEventType,
  OfferComplianceStatus,
  PurchaseApprovalStatus,
  RequestStatus as SharedRequestStatus,
  UserRole,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { decimalToNumber, toDecimal } from '../../utils/money.js';
import { nextDocumentNumber } from '../../utils/documentNumber.js';
import { ApprovalActor, assertApprovalBuyer } from '../purchase-approvals/approval-roles.js';
import {
  ApprovalSubject,
  loadActivePolicy,
  priceForPolicy,
  resolveApprovalRoute,
} from '../purchase-approvals/approval-policy.service.js';
import { assertNotSplitPurchase } from '../purchase-approvals/purchase-approval.service.js';
import { createAuditLog } from '../audit/audit.service.js';
import { notify } from '../notifications/notification.service.js';
import { createPoFromDeal } from '../purchase-orders/purchase-order.service.js';
import type { CreatePoFromDealInput } from '../purchase-orders/purchase-order.service.js';

/**
 * Final Approval & Deal Execution Engine.
 *
 * Bridges the 4-offer CommercialOfferSubmission engine to the purchase-authorization
 * pipeline, then tracks the category-specific execution that follows deal creation.
 *
 * Flow:
 *   1. Buyer selects a winning submission  → selectFinalOffer
 *   2. Buyer submits it for final approval → submitForFinalApproval
 *   3. Approvers decide (existing purchase-approval flow)
 *   4. On final approval, deal is created  → createDealFromSubmission (called from finalizeIfAuthorized)
 *   5. Buyer confirms the purchase        → confirmPurchase (existing)
 *   6. Category-specific execution         → advanceExecutionStatus / recordExecutionEvent
 */

const EXECUTION_TRANSITIONS: Record<DealExecutionStatus, DealExecutionStatus[]> = {
  [DealExecutionStatus.PENDING_EXECUTION]: [
    DealExecutionStatus.SUPPLIER_CONFIRMED,
    DealExecutionStatus.IN_PROGRESS,
    DealExecutionStatus.CANCELLED,
  ],
  [DealExecutionStatus.SUPPLIER_CONFIRMED]: [
    DealExecutionStatus.IN_PROGRESS,
    DealExecutionStatus.CANCELLED,
  ],
  [DealExecutionStatus.IN_PROGRESS]: [
    DealExecutionStatus.FULFILLED,
    DealExecutionStatus.CANCELLED,
  ],
  [DealExecutionStatus.FULFILLED]: [
    DealExecutionStatus.CLOSED,
    DealExecutionStatus.CANCELLED,
  ],
  [DealExecutionStatus.CLOSED]: [],
  [DealExecutionStatus.CANCELLED]: [],
};

const STATUS_REQUIRES_BUYER_CONFIRMATION: DealExecutionStatus[] = [
  DealExecutionStatus.IN_PROGRESS,
  DealExecutionStatus.FULFILLED,
  DealExecutionStatus.CLOSED,
];

/**
 * Map a commercial-offer OfferType to the execution category.
 * PROJECT is mapped from SERVICE requests that carry milestone/deliverable data.
 */
function resolveExecutionType(offerType: string): DealExecutionType {
  switch (offerType) {
    case 'PRODUCT':
      return DealExecutionType.PRODUCTS;
    case 'SOFTWARE_SUBSCRIPTION':
      return DealExecutionType.SAAS_SUBSCRIPTION;
    case 'SERVICE':
      return DealExecutionType.SERVICES;
    default:
      return DealExecutionType.PRODUCTS;
  }
}

/**
 * Derive an ApprovalSubject from a CommercialOfferSubmission.
 *
 * For PRODUCT submissions the unitPrice/quantity fields are used directly;
 * for SERVICE and SOFTWARE_SUBSCRIPTION the total amount is treated as a
 * single-unit purchase so the policy threshold is compared against the full
 * commercial value.
 */
function buildSubjectFromSubmission(
  submission: {
    currency: string;
    subTotal: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    unitPrice: Prisma.Decimal | null;
    quantity: number | null;
    offerType: string;
  },
  request: { department?: string | null; categoryId?: string | null; costCenter?: string | null },
): ApprovalSubject {
  const subTotal = toDecimal(submission.subTotal, 'subTotal');
  const taxAmount = toDecimal(submission.taxAmount, 'taxAmount');

  let unitPrice: Prisma.Decimal;
  let quantity: number;

  if (submission.offerType === 'PRODUCT' && submission.unitPrice && submission.quantity && submission.quantity > 0) {
    unitPrice = toDecimal(submission.unitPrice, 'unitPrice');
    quantity = submission.quantity;
  } else {
    // Non-product: treat the entire subtotal as one unit so the threshold
    // is compared against the full commercial value.
    unitPrice = subTotal.isZero() ? toDecimal(submission.totalAmount, 'totalAmount') : subTotal;
    quantity = 1;
  }

  // Derive the tax rate from the stored tax amount and subtotal.
  let taxRate: Prisma.Decimal;
  if (!subTotal.isZero()) {
    taxRate = taxAmount.dividedBy(subTotal).times(100).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_EVEN);
  } else {
    taxRate = new Prisma.Decimal(0);
  }

  return {
    currency: submission.currency,
    unitPrice,
    quantity,
    taxRate,
    freightAmount: new Prisma.Decimal(0),
    installationAmount: new Prisma.Decimal(0),
    otherCharges: new Prisma.Decimal(0),
    department: request.department,
    categoryId: request.categoryId,
    costCenter: request.costCenter,
  };
}

/**
 * Build a serializable commercial snapshot from the winning submission.
 * This is stored on the Deal so the executed terms can be audited years later
 * without recomputing from the original submission.
 */
function buildCommercialSnapshot(submission: {
  id: string;
  submissionNumber: number;
  offerType: string;
  currency: string;
  subTotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal | null;
  discountPercentage: number | null;
  unitPrice: Prisma.Decimal | null;
  quantity: number | null;
  contractDuration: string | null;
  numberOfLicenses: number | null;
  billingFrequency: string | null;
  subscriptionTerm: string | null;
  renewalTerms: string | null;
  implementationFees: Prisma.Decimal | null;
  recurringFees: Prisma.Decimal | null;
  oneTimeFees: Prisma.Decimal | null;
  deliveryDate: Date | null;
  paymentTerms: string | null;
  offerValidityDays: number | null;
  offerValidityDate: Date | null;
  commercialConditions: string | null;
  scope: string | null;
  exclusions: string | null;
  complianceStatus: string;
}): Record<string, unknown> {
  return {
    submissionId: submission.id,
    submissionNumber: submission.submissionNumber,
    offerType: submission.offerType,
    currency: submission.currency,
    subTotal: decimalToNumber(submission.subTotal),
    taxAmount: decimalToNumber(submission.taxAmount),
    totalAmount: decimalToNumber(submission.totalAmount),
    discountAmount: submission.discountAmount ? decimalToNumber(submission.discountAmount) : undefined,
    discountPercentage: submission.discountPercentage ?? undefined,
    unitPrice: submission.unitPrice ? decimalToNumber(submission.unitPrice) : undefined,
    quantity: submission.quantity ?? undefined,
    contractDuration: submission.contractDuration ?? undefined,
    numberOfLicenses: submission.numberOfLicenses ?? undefined,
    billingFrequency: submission.billingFrequency ?? undefined,
    subscriptionTerm: submission.subscriptionTerm ?? undefined,
    renewalTerms: submission.renewalTerms ?? undefined,
    implementationFees: submission.implementationFees ? decimalToNumber(submission.implementationFees) : undefined,
    recurringFees: submission.recurringFees ? decimalToNumber(submission.recurringFees) : undefined,
    oneTimeFees: submission.oneTimeFees ? decimalToNumber(submission.oneTimeFees) : undefined,
    deliveryDate: submission.deliveryDate ? submission.deliveryDate.toISOString() : undefined,
    paymentTerms: submission.paymentTerms ?? undefined,
    offerValidityDays: submission.offerValidityDays ?? undefined,
    offerValidityDate: submission.offerValidityDate ? submission.offerValidityDate.toISOString() : undefined,
    commercialConditions: submission.commercialConditions ?? undefined,
    scope: submission.scope ?? undefined,
    exclusions: submission.exclusions ?? undefined,
    complianceStatus: submission.complianceStatus,
  };
}

/**
 * Step 1 — Buyer selects the winning submission from the 4-offer comparison.
 *
 * The submission must be compliant and not the result of a reopened round
 * unless the buyer explicitly chose it. The procurement request advances to
 * FINAL_COMMERCIAL_SELECTION so the UI knows approval submission is next.
 */
export async function selectFinalOffer(
  actor: ApprovalActor,
  submissionId: string,
): Promise<{ requestId: string; submission: { id: string; submissionNumber: number; offerType: string } }> {
  assertApprovalBuyer(actor);

  const submission = await prisma.commercialOfferSubmission.findFirst({
    where: { id: submissionId, tenantId: actor.tenantId },
    include: {
      commercialOffer: {
        include: {
          vendor: { select: { id: true, name: true } },
          vendorAssignment: { include: { request: true } },
        },
      },
    },
  });

  if (!submission) {
    throw new NotFoundError('Commercial offer submission');
  }

  const request = submission.commercialOffer.vendorAssignment.request;
  const offer = submission.commercialOffer;

  // Only the requester or a buyer-side admin may select a final offer.
  if (request.requesterId !== actor.userId && !['VENDOR', 'VIEWER'].includes(actor.role)) {
    throw new ForbiddenError('Only the requester or a procurement manager can select a final offer');
  }

  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Supplier accounts cannot select final offers');
  }

  // Compliance must be resolved — a non-compliant submission cannot become a deal.
  if (submission.complianceStatus === OfferComplianceStatus.NON_COMPLIANT) {
    throw new ValidationError(
      `This submission is marked ${submission.complianceStatus} and cannot be selected as the final offer`,
    );
  }

  // The submission must have been submitted by the vendor.
  if (!submission.submittedAt) {
    throw new ValidationError('Only submitted offers can be selected as the final offer');
  }

  await prisma.procurementRequest.update({
    where: { id: request.id },
    data: { status: SharedRequestStatus.FINAL_COMMERCIAL_SELECTION as never },
  });

  await notify({
    tenantId: actor.tenantId,
    recipientId: request.requesterId,
    event: NotificationEventType.DEAL_STATUS_CHANGE as never,
    linkPath: `/requests/${request.id}/commercial`,
    preview: `Final offer selected from ${offer.vendor?.name || 'vendor'} - ready for approval`,
    dedupeKey: `final-selection-${submission.id}`,
  });

  return {
    requestId: request.id,
    submission: {
      id: submission.id,
      submissionNumber: submission.submissionNumber,
      offerType: submission.offerType,
    },
  };
}

/**
 * Step 2 — Submit the selected submission for final approval.
 *
 * This reuses the organization's approval policy engine to determine whether
 * manager authorization is needed and at which levels. The resulting
 * PurchaseApprovalRequest links to the CommercialOfferSubmission via
 * selectedSubmissionId (rather than to a DealOffer), so finalizeIfAuthorized
 * knows to call createDealFromSubmission instead of finalizeAcceptedOffer.
 */
export interface SubmitFinalApprovalResult {
  requestId: string;
  reference: string;
  approvalRequired: boolean;
  status: string;
}

export async function submitForFinalApproval(
  actor: ApprovalActor,
  input: { submissionId: string; requesterComment?: string },
): Promise<SubmitFinalApprovalResult> {
  assertApprovalBuyer(actor);

  const submission = await prisma.commercialOfferSubmission.findFirst({
    where: { id: input.submissionId, tenantId: actor.tenantId },
    include: {
      commercialOffer: {
        include: {
          vendor: { select: { id: true, name: true } },
          vendorAssignment: { include: { request: true } },
        },
      },
    },
  });

  if (!submission) {
    throw new NotFoundError('Commercial offer submission');
  }

  const request = submission.commercialOffer.vendorAssignment.request;
  const offer = submission.commercialOffer;

  // Only the requester (or buyer-side admin acting on their behalf) may submit.
  const isRoomBuyer = request.requesterId === actor.userId;
  const isBuyerSideAdmin = !['VENDOR', 'VIEWER'].includes(actor.role);
  if (!isRoomBuyer && !isBuyerSideAdmin) {
    throw new ForbiddenError('Only the requester can submit the final offer for approval');
  }
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Supplier accounts cannot submit purchases for approval');
  }

  // Must have been marked as a final offer by the buyer first.
  if (request.status !== SharedRequestStatus.FINAL_COMMERCIAL_SELECTION as never) {
    throw new ValidationError(
      'This submission must first be selected as the final offer before it can be submitted for approval',
    );
  }

  // A compliance issue blocks submission.
  if (submission.complianceStatus === OfferComplianceStatus.NON_COMPLIANT) {
    throw new ValidationError('Non-compliant submissions cannot be submitted for approval');
  }

  // One live authorization per submission. The database is the backstop.
  const existingForSubmission = await prisma.purchaseApprovalRequest.findFirst({
    where: { selectedSubmissionId: submission.id, tenantId: actor.tenantId },
  });
  if (existingForSubmission) {
    const status = existingForSubmission.status;
    if (['PENDING_APPROVAL', 'CHANGES_REQUESTED'].includes(status)) {
      throw new ConflictError(
        `This submission is already in approval request ${existingForSubmission.reference} (${status.toLowerCase()})`,
      );
    }
    throw new ConflictError(
      `This submission was already submitted as ${existingForSubmission.reference}. A revised submission needs a new approval.`,
    );
  }

  // Resolve the approval route using the organization's policy.
  const subject: ApprovalSubject = buildSubjectFromSubmission(submission, request);
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

  // Reuse the same split-purchase guard that protects the DealOffer path.
  await assertNotSplitPurchase(
    actor,
    offer.vendorId,
    request.item,
    priced.thresholdAmount,
    policy,
  );

  // Generate the human-readable reference.
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

  await prisma.procurementRequest.update({
    where: { id: request.id },
    data: { status: SharedRequestStatus.PENDING_FINAL_APPROVAL as never },
  });

  await prisma.purchaseApprovalRequest.create({
    data: {
      reference,
      tenantId: actor.tenantId,
      requestId: request.id,
      vendorId: offer.vendorId,
      dealRoomId: undefined,
      offerId: undefined,
      selectedSubmissionId: submission.id,
      submittedById: actor.userId,
      status: route.approvalRequired
        ? PurchaseApprovalStatus.PENDING_APPROVAL
        : PurchaseApprovalStatus.APPROVED,

      currency: route.currency,
      unitPrice: priced.unitPrice,
      quantity: submission.quantity ?? 1,
      taxRate: priced.taxRate,
      taxAmount: priced.taxAmount,
      freightAmount: priced.freight,
      installationAmount: priced.installation,
      otherCharges: priced.other,
      subtotal: priced.subtotal,
      totalAmount: priced.total,
      thresholdAmount: priced.thresholdAmount,

      paymentTerms: submission.paymentTerms ?? undefined,
      deliveryTimelineDays: undefined,
      warrantyMonths: undefined,
      otherChargesDetails: undefined,
      documents: Prisma.JsonNull,

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
      negotiationSnapshot: Prisma.JsonNull,

      revision: 1,
      parentRequestId: null,
      currentLevel: 1,
      decidedAt: route.approvalRequired ? null : new Date(),

      decisions: route.approvalRequired
        ? {
            create: route.levels.map((level) => ({
              tenantId: actor.tenantId,
              level: level.level,
              requiredRole: level.requiredRole,
              label: level.label ?? null,
              status: 'PENDING' as const,
              assignedApproverId: level.approverId ?? null,
            })),
          }
        : undefined,
    },
  });

  // Notify approvers if authorization is required.
  if (route.approvalRequired) {
    for (const level of route.levels) {
      if (level.approverId) {
        await notify({
          tenantId: actor.tenantId,
          recipientId: level.approverId,
          event: NotificationEventType.APPROVAL_ASSIGNED as never,
          linkPath: `/purchase-approvals`,
          preview: `Final offer from ${offer.vendor?.name || 'vendor'} needs your approval`,
          dedupeKey: `approval-assigned-${reference}`,
        });
      }
    }
  }

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.PURCHASE_APPROVAL_SUBMITTED,
    entityType: 'PurchaseApprovalRequest',
    entityId: reference,
    newStatus: route.approvalRequired
      ? PurchaseApprovalStatus.PENDING_APPROVAL
      : PurchaseApprovalStatus.APPROVED,
    tenantId: actor.tenantId,
    metadata: {
      reference,
      submissionId: submission.id,
      requestId: request.id,
      vendorId: offer.vendorId,
      totalAmount: decimalToNumber(priced.total),
      approvalRequired: route.approvalRequired,
    },
  });

  return {
    requestId: request.id,
    reference,
    approvalRequired: route.approvalRequired,
    status: route.approvalRequired ? PurchaseApprovalStatus.PENDING_APPROVAL : PurchaseApprovalStatus.APPROVED,
  };
}

/**
 * Step 4 — Create a Deal from an approved CommercialOfferSubmission.
 *
 * Called from finalizeIfAuthorized (in purchase-approval.service) after the last
 * approval level is decided. This is the CommercialOfferSubmission counterpart
 * to negotiation.finalizeAcceptedOffer.
 *
 * The deal is created with execution tracking fields populated so the category-
 * specific workflow can begin immediately.
 */
export async function createDealFromSubmission(
  submissionId: string,
  actorId: string,
  tenantId: string,
): Promise<{ deal: { id: string; dealNumber: string }; offerType: string }> {
  const submission = await prisma.commercialOfferSubmission.findFirst({
    where: { id: submissionId, tenantId },
    include: {
      commercialOffer: {
        include: {
          vendor: { select: { id: true, name: true } },
          vendorAssignment: { include: { request: true } },
        },
      },
    },
  });

  if (!submission) {
    throw new NotFoundError('Commercial offer submission');
  }

  const offer = submission.commercialOffer;
  const request = offer.vendorAssignment.request;

  // Guard against a second deal for the same submission.
  const existingDeal = await prisma.deal.findFirst({
    where: { selectedSubmissionId: submission.id },
  });
  if (existingDeal) {
    throw new ValidationError(`This submission already produced deal ${existingDeal.dealNumber}`);
  }

  const executionType = resolveExecutionType(submission.offerType);
  const dealNumber = `DEAL-${Date.now().toString(36).toUpperCase()}`;
  const commercialSnapshot = buildCommercialSnapshot(submission as any);

  const result = await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.create({
      data: {
        dealNumber,
        dealRoomId: undefined,
        requestId: request.id,
        buyerId: request.requesterId,
        vendorId: offer.vendorId,
        tenantId,
        status: 'ACCEPTED' as never,
        executionStatus: DealExecutionStatus.PENDING_EXECUTION,
        executionType,
        selectedSubmissionId: submission.id,
        commercialSnapshot: commercialSnapshot as Prisma.InputJsonValue,
      },
    });

    await tx.dealExecutionEvent.create({
      data: {
        dealId: deal.id,
        tenantId,
        type: DealExecutionEventType.DEAL_CREATED,
        description: `Deal ${dealNumber} created from approved submission #${submission.submissionNumber} for ${offer.vendor?.name || 'vendor'}`,
        actorId,
        metadata: {
          submissionId: submission.id,
          submissionNumber: submission.submissionNumber,
          offerType: submission.offerType,
          totalAmount: decimalToNumber(submission.totalAmount),
          currency: submission.currency,
        } as Prisma.InputJsonValue,
      },
    });

    return { deal, commercialSnapshot };
  });

  // Link the approval request to the deal.
  await prisma.purchaseApprovalRequest.updateMany({
    where: { selectedSubmissionId: submission.id, tenantId },
    data: { dealId: result.deal.id },
  });

  await createAuditLog({
    userId: actorId,
    action: AuditAction.DEAL_CREATED,
    entityType: 'Deal',
    entityId: result.deal.id,
    previousStatus: undefined,
    newStatus: DealStatus.ACCEPTED,
    tenantId,
    metadata: {
      dealNumber,
      requestId: request.id,
      vendorId: offer.vendorId,
      selectedSubmissionId: submission.id,
      executionType,
    },
  });

  // Notify the requester that the deal was created.
  await notify({
    tenantId,
    recipientId: request.requesterId,
    event: NotificationEventType.DEAL_STATUS_CHANGE as never,
    linkPath: `/deals/${result.deal.id}`,
    preview: `Deal ${dealNumber} created — commercial terms are now locked for execution.`,
    dedupeKey: `deal-created-${dealNumber}`,
  });

  await prisma.procurementRequest.update({
    where: { id: request.id },
    data: { status: SharedRequestStatus.DEAL_CONFIRMED as never },
  });

  return {
    deal: { id: result.deal.id, dealNumber },
    offerType: submission.offerType,
  };
}

/**
 * Step 6 — Advance the execution status of a deal.
 *
 * Transitions are validated against an explicit state machine: a deal can only
 * move forward along an approved path. Cancelling at any point requires a reason.
 */
export async function advanceExecutionStatus(
  actor: ApprovalActor,
  dealId: string,
  input: {
    status: DealExecutionStatus;
    cancellationReason?: string;
  },
): Promise<{ dealId: string; executionStatus: DealExecutionStatus }> {
  assertApprovalBuyer(actor);

  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: actor.tenantId },
    include: { request: { select: { id: true, requesterId: true } } },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  const allowed = EXECUTION_TRANSITIONS[deal.executionStatus];
  if (!allowed.includes(input.status)) {
    throw new ValidationError(
      `Cannot move from ${deal.executionStatus} to ${input.status}`,
    );
  }

  if (input.status === DealExecutionStatus.CANCELLED && !input.cancellationReason) {
    throw new ValidationError('A cancellation reason is required');
  }

  await prisma.$transaction(async (tx) => {
    await tx.deal.update({
      where: { id: dealId },
      data: { executionStatus: input.status as never },
    });

    await tx.dealExecutionEvent.create({
      data: {
        dealId: deal.id,
        tenantId: actor.tenantId,
        type: DealExecutionEventType.EXECUTION_STATUS_ADVANCED,
        description: `Execution status advanced to ${input.status}`,
        actorId: actor.userId,
        metadata: {
          fromStatus: deal.executionStatus,
          toStatus: input.status,
          ...(input.cancellationReason
            ? { cancellationReason: input.cancellationReason }
            : {}),
        } as Prisma.InputJsonValue,
      },
    });

    await createAuditLog({
    userId: actor.userId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'Deal',
    entityId: dealId,
    previousStatus: deal.executionStatus,
    newStatus: input.status,
    tenantId: actor.tenantId,
      metadata: { executionType: deal.executionType },
    });
  });

  return { dealId, executionStatus: input.status };
}

/**
 * Record an execution event against a deal (e.g. goods received, milestone
 * completed, subscription registered). The event does not change the execution
 * status — use advanceExecutionStatus for that — but creates an auditable trail.
 */
export async function recordExecutionEvent(
  actor: ApprovalActor,
  dealId: string,
  input: {
    type: DealExecutionEventType;
    description: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ eventId: string }> {
  assertApprovalBuyer(actor);

  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: actor.tenantId },
    include: { request: true, vendor: { select: { id: true, name: true } } },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  const event = await prisma.dealExecutionEvent.create({
    data: {
      dealId: deal.id,
      tenantId: actor.tenantId,
      type: input.type as never,
      description: input.description,
      actorId: actor.userId,
      metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.DEAL_CREATED,
    entityType: 'DealExecutionEvent',
    entityId: event.id,
    newStatus: input.type,
    tenantId: actor.tenantId,
    metadata: { dealId, dealNumber: deal.dealNumber },
  });

  return { eventId: event.id };
}

/**
 * Category-specific execution record creation.
 *
 * For PRODUCTS this raises a purchase order linked to the deal.
 * For SERVICES it records a service commencement event.
 * For SAAS_SUBSCRIPTION it registers subscription tracking.
 * For PROJECT it records a milestone/deliverable.
 *
 * This is intentionally lightweight — it seeds the execution phase and leaves
 * detailed tracking (PO approval chains, delivery events, invoice matching) to
 * the existing purchase-order module.
 */
export async function createExecutionRecord(
  actor: ApprovalActor,
  dealId: string,
  input: {
    type: 'purchase_order' | 'service_commencement' | 'subscription_registration' | 'milestone';
    /** Only required for purchase_order. */
    deliveryAddress?: string;
    expectedDeliveryDate?: string;
    paymentTerms?: string;
    warrantyMonths?: number;
    notes?: string;
    /** Only required for milestone. */
    milestoneName?: string;
    milestoneIndex?: number;
    /** Only required for service_commencement / subscription_registration. */
    startDate?: string;
    endDate?: string;
    description?: string;
  },
): Promise<{ recordId: string; recordType: string }> {
  assertApprovalBuyer(actor);

  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: actor.tenantId },
    include: { request: true, selectedSubmission: true, vendor: { select: { id: true, name: true } } },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  if (deal.executionStatus === DealExecutionStatus.CLOSED || deal.executionStatus === DealExecutionStatus.CANCELLED) {
    throw new ValidationError('Cannot create execution records for a closed or cancelled deal');
  }

  switch (input.type) {
    case 'purchase_order':
      return createPurchaseOrderRecord(actor, deal, input);
    case 'service_commencement':
      return createServiceCommencementRecord(actor, deal, input);
    case 'subscription_registration':
      return createSubscriptionRecord(actor, deal, input);
    case 'milestone':
      return createMilestoneRecord(actor, deal, input);
    default:
      throw new ValidationError(`Unknown execution record type: ${(input as any).type}`);
  }
}

async function createPurchaseOrderRecord(
  actor: ApprovalActor,
  deal: {
    id: string;
    dealNumber: string;
    requestId: string;
    vendorId: string;
    buyerId: string;
    selectedSubmission?: {
      subTotal: Prisma.Decimal;
      taxAmount: Prisma.Decimal;
      totalAmount: Prisma.Decimal;
      currency: string;
      unitPrice?: Prisma.Decimal | null;
      quantity?: number | null;
      paymentTerms?: string | null;
      deliveryDate?: Date | null;
      warrantyMonths?: number | null;
    } | null;
    request: { item: string; quantity: number; unit?: string | null; location: string };
    vendor: { id: string; name: string };
  },
  input: {
    deliveryAddress?: string;
    expectedDeliveryDate?: string;
    paymentTerms?: string;
    warrantyMonths?: number;
    notes?: string;
  },
) {
  if (!deal.selectedSubmission) {
    throw new ValidationError('This deal has no selected submission to base a PO on');
  }

  const sub = deal.selectedSubmission;

  const poInput: CreatePoFromDealInput = {
    dealId: deal.id,
    deliveryAddress: input.deliveryAddress ?? deal.request.location,
    expectedDeliveryDate: input.expectedDeliveryDate ?? (sub.deliveryDate?.toISOString().slice(0, 10) ?? undefined),
    paymentTerms: input.paymentTerms ?? sub.paymentTerms ?? undefined,
    warrantyMonths: input.warrantyMonths ?? sub.warrantyMonths ?? undefined,
    notes: input.notes,
    terms: undefined,
    overrides: {
      quantity: sub.quantity ?? deal.request.quantity,
      unitPrice: sub.unitPrice ? decimalToNumber(sub.unitPrice) : undefined,
      taxRate: !sub.taxAmount.isZero() && !sub.subTotal.isZero()
        ? decimalToNumber(sub.taxAmount.dividedBy(sub.subTotal).times(100))
        : undefined,
      freightAmount: 0,
      installationAmount: 0,
      otherCharges: 0,
    },
  };

  const po = await createPoFromDeal(poInput, { userId: actor.userId, tenantId: actor.tenantId, role: actor.role });

  await prisma.deal.update({
    where: { id: deal.id },
    data: { executionStatus: DealExecutionStatus.IN_PROGRESS as never },
  });

  return { recordId: po.id, recordType: 'purchase_order' };
}

async function createServiceCommencementRecord(
  actor: ApprovalActor,
  deal: { id: string; dealNumber: string; requestId: string; vendorId: string; buyerId: string },
  input: { startDate?: string; endDate?: string; description?: string },
) {
  const event = await prisma.dealExecutionEvent.create({
    data: {
      dealId: deal.id,
      tenantId: actor.tenantId,
      type: DealExecutionEventType.EXECUTION_STATUS_ADVANCED,
      description: `Service commenced${input.description ? `: ${input.description}` : ''}`,
      actorId: actor.userId,
      metadata: {
        startDate: input.startDate,
        endDate: input.endDate,
        description: input.description,
      } as Prisma.InputJsonValue,
    },
  });

  return { recordId: event.id, recordType: 'service_commencement' };
}

async function createSubscriptionRecord(
  actor: ApprovalActor,
  deal: {
    id: string;
    dealNumber: string;
    requestId: string;
    vendorId: string;
    buyerId: string;
    selectedSubmission?: {
      numberOfLicenses?: number | null;
      billingFrequency?: string | null;
      subscriptionTerm?: string | null;
      renewalTerms?: string | null;
      implementationFees?: Prisma.Decimal | null;
      recurringFees?: Prisma.Decimal | null;
      oneTimeFees?: Prisma.Decimal | null;
      currency?: string;
    } | null;
  },
  input: { startDate?: string; endDate?: string; description?: string },
) {
  const sub = deal.selectedSubmission;
  const event = await prisma.dealExecutionEvent.create({
    data: {
      dealId: deal.id,
      tenantId: actor.tenantId,
      type: DealExecutionEventType.SUBSCRIPTION_REGISTERED,
      description: `Subscription registered${sub ? ` for ${sub.numberOfLicenses ?? 'N'} licenses` : ''}`,
      actorId: actor.userId,
      metadata: {
        startDate: input.startDate,
        endDate: input.endDate,
        description: input.description,
        billingFrequency: sub?.billingFrequency,
        subscriptionTerm: sub?.subscriptionTerm,
        renewalTerms: sub?.renewalTerms,
        numberOfLicenses: sub?.numberOfLicenses,
        implementationFees: sub?.implementationFees ? decimalToNumber(sub.implementationFees) : undefined,
        recurringFees: sub?.recurringFees ? decimalToNumber(sub.recurringFees) : undefined,
        oneTimeFees: sub?.oneTimeFees ? decimalToNumber(sub.oneTimeFees) : undefined,
        currency: sub?.currency,
      } as Prisma.InputJsonValue,
    },
  });

  return { recordId: event.id, recordType: 'subscription_registration' };
}

async function createMilestoneRecord(
  actor: ApprovalActor,
  deal: { id: string; dealNumber: string; requestId: string; vendorId: string; buyerId: string },
  input: { milestoneName?: string; milestoneIndex?: number; description?: string; startDate?: string; endDate?: string },
) {
  const event = await prisma.dealExecutionEvent.create({
    data: {
      dealId: deal.id,
      tenantId: actor.tenantId,
      type: DealExecutionEventType.MILESTONE_COMPLETED,
      description: `Milestone completed: ${input.milestoneName ?? 'Unnamed milestone'}`,
      actorId: actor.userId,
      metadata: {
        milestoneName: input.milestoneName,
        milestoneIndex: input.milestoneIndex,
        startDate: input.startDate,
        endDate: input.endDate,
        description: input.description,
      } as Prisma.InputJsonValue,
    },
  });

  return { recordId: event.id, recordType: 'milestone' };
}

/**
 * Fetch a deal with its full execution context: the approval request, the
 * selected submission, and the execution event trail.
 */
export async function getDealExecutionDetail(
  actor: ApprovalActor,
  dealId: string,
): Promise<Record<string, unknown>> {
  assertApprovalBuyer(actor);

  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: actor.tenantId },
    include: {
      request: { select: { id: true, title: true, item: true, quantity: true, unit: true, status: true } },
      vendor: { select: { id: true, name: true } },
      selectedSubmission: true,
      purchaseOrder: { select: { id: true, poNumber: true, status: true } },
      executionEvents: { orderBy: { createdAt: 'desc' as const } },
      purchaseApprovalRequest: {
        select: {
          id: true,
          reference: true,
          status: true,
          decisions: {
            orderBy: { level: 'asc' as const },
            select: {
              level: true,
              status: true,
              assignedApprover: { select: { id: true, firstName: true, lastName: true } },
              decidedBy: { select: { id: true, firstName: true, lastName: true } },
              createdAt: true,
              decidedAt: true,
            },
          },
        },
      },
    },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  return {
    deal: {
      id: deal.id,
      dealNumber: deal.dealNumber,
      status: deal.status,
      executionStatus: deal.executionStatus,
      executionType: deal.executionType,
      commercialSnapshot: deal.commercialSnapshot,
      supplierConfirmedAt: deal.supplierConfirmedAt,
    },
    request: deal.request,
    vendor: deal.vendor,
    approval: deal.purchaseApprovalRequest,
    purchaseOrder: deal.purchaseOrder,
    executionEvents: deal.executionEvents,
  };
}

/**
 * List deals in the execution phase, optionally filtered by status or request.
 */
export interface ListDealExecutionsResult {
  deals: Array<{
    id: string;
    dealNumber: string;
    executionStatus: DealExecutionStatus;
    executionType: DealExecutionType | null;
    status: DealStatus;
    requestId: string;
    vendorId: string;
    createdAt: Date;
  }>;
  total: number;
}

export async function listDealExecutions(
  actor: ApprovalActor,
  filters: {
    status?: DealExecutionStatus;
    requestId?: string;
    vendorId?: string;
    page?: number;
    limit?: number;
  } = {},
): Promise<ListDealExecutionsResult> {
  assertApprovalBuyer(actor);

  const where: Record<string, unknown> = { tenantId: actor.tenantId };

  if (filters.status) where.executionStatus = filters.status;
  if (filters.requestId) where.requestId = filters.requestId;
  if (filters.vendorId) where.vendorId = filters.vendorId;

  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(50, Math.max(1, filters.limit ?? 20));
  const skip = (page - 1) * limit;

  const [deals, total] = await Promise.all([
    prisma.deal.findMany({
      where,
      orderBy: { createdAt: 'desc' as const },
      skip,
      take: limit,
      select: {
        id: true,
        dealNumber: true,
        executionStatus: true,
        executionType: true,
        status: true,
        requestId: true,
        vendorId: true,
        createdAt: true,
      },
    }),
    prisma.deal.count({ where }),
  ]);

  return {
    deals: deals.map((d) => ({
      id: d.id,
      dealNumber: d.dealNumber,
      executionStatus: d.executionStatus as DealExecutionStatus,
      executionType: (d.executionType as DealExecutionType | null) ?? null,
      status: d.status as DealStatus,
      requestId: d.requestId,
      vendorId: d.vendorId,
      createdAt: d.createdAt,
    })),
    total,
  };
}