import { Prisma, OfferStatus, OfferType, OfferComplianceStatus, OfferEventType, AuditAction as PrismaAuditAction } from '@prisma/client';
import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, UserRole } from '@navo/shared';
import { toDecimal, decimalToNumber } from '../../utils/money';
import { evaluateCompliance, ComplianceContext } from './offer-compliance.service';

const MAX_SUBMISSIONS = 4;

export interface CreateOfferDraftInput {
  requestId: string;
  vendorAssignmentId: string;
  offerType?: OfferType;
  currency?: string;
  deadline?: string;
}

export interface UpdateOfferDraftInput {
  currency?: string;
  subTotal?: number;
  taxAmount?: number;
  totalAmount?: number;
  discountAmount?: number;
  discountPercentage?: number;
  unitPrice?: number;
  quantity?: number;
  contractDuration?: string;
  milestones?: Record<string, unknown>[];
  deliverables?: Record<string, unknown>[];
  serviceLevels?: Record<string, unknown>[];
  staffingAssumptions?: string;
  numberOfLicenses?: number;
  billingFrequency?: string;
  subscriptionTerm?: string;
  renewalTerms?: string;
  implementationFees?: number;
  recurringFees?: number;
  oneTimeFees?: number;
  deliveryDate?: string;
  paymentTerms?: string;
  offerValidityDays?: number;
  offerValidityDate?: string;
  commercialConditions?: string;
  scope?: string;
  exclusions?: string;
  supportingDocuments?: string[];
}

export interface SubmitOfferInput {
  vendorAssignmentId: string;
  requestId: string;
  offerType: OfferType;
  currency: string;
  subTotal: number;
  taxAmount?: number;
  totalAmount: number;
  discountAmount?: number;
  discountPercentage?: number;
  unitPrice?: number;
  quantity?: number;
  contractDuration?: string;
  milestones?: Record<string, unknown>[];
  deliverables?: Record<string, unknown>[];
  serviceLevels?: Record<string, unknown>[];
  staffingAssumptions?: string;
  numberOfLicenses?: number;
  billingFrequency?: string;
  subscriptionTerm?: string;
  renewalTerms?: string;
  implementationFees?: number;
  recurringFees?: number;
  oneTimeFees?: number;
  deliveryDate?: string;
  paymentTerms?: string;
  offerValidityDays?: number;
  offerValidityDate?: string;
  commercialConditions?: string;
  scope?: string;
  exclusions?: string;
  supportingDocuments?: string[];
  idempotencyKey: string;
}

export interface OfferClarificationInput {
  vendorAssignmentId: string;
  content: string;
}

export interface ReopenCommercialInput {
  vendorAssignmentId: string;
  reason: string;
}

/**
 * Resolve the vendor from the database using the user's JWT payload.
 * The vendorId from the token is never trusted alone — it is re-verified
 * against the database to prevent impersonation.
 */
async function resolveVendorFromUser(userId: string, tenantId: string, expectedVendorId?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tenantId: true, vendorId: true, role: true, isActive: true },
  });

  if (!user || !user.isActive) {
    throw new ForbiddenError('Your account is not active');
  }
  if (user.tenantId !== tenantId) {
    throw new ForbiddenError('Access denied: account belongs to another tenant');
  }
  if (user.vendorId !== expectedVendorId) {
    throw new ForbiddenError('You are not authorized to act on this vendor assignment');
  }

  return user;
}

/**
 * Verify that the caller is authorized to access a vendor assignment.
 * For vendors, the assignment's vendorId must match their linked vendor.
 * For buyers, the assignment must be within their tenant.
 */
async function assertAssignmentAccess(
  assignmentId: string,
  tenantId: string,
  userId: string,
  expectedVendorId?: string
) {
  const assignment = await prisma.vendorAssignment.findFirst({
    where: { id: assignmentId, tenantId },
    include: { request: true, vendor: true },
  });

  if (!assignment) {
    throw new NotFoundError('VendorAssignment');
  }

  if (expectedVendorId && assignment.vendorId !== expectedVendorId) {
    throw new ForbiddenError('You cannot access an assignment for a different vendor');
  }

  return assignment;
}

/**
 * Verify that a buyer has authorization to reopen commercial processes.
 */
function assertBuyerAuthority(role: string): void {
  const authorizedRoles = ['COMPANY_ADMIN', 'PROCUREMENT_MANAGER', 'PLATFORM_ADMIN', 'FINANCE_APPROVER'];
  if (!authorizedRoles.includes(role)) {
    throw new ForbiddenError('Only authorized procurement roles may reopen the commercial process');
  }
}

/**
 * Create or fetch the CommercialOffer parent entity for a vendor assignment.
 * The offer entity is created when the vendor first accesses their opportunity.
 */
export async function createOrGetOffer(
  input: CreateOfferDraftInput,
  userId: string,
  tenantId: string,
  vendorId?: string
): Promise<any> {
  // If a vendor is acting, resolve and verify them
  if (vendorId) {
    await resolveVendorFromUser(userId, tenantId, vendorId);
  }

  const assignment = await assertAssignmentAccess(input.vendorAssignmentId, tenantId, userId, vendorId);

  const currentRound = assignment.commercialRound;

  const existing = await prisma.commercialOffer.findUnique({
    where: {
      vendorAssignmentId_commercialRound: {
        vendorAssignmentId: input.vendorAssignmentId,
        commercialRound: currentRound,
      },
    },
  });

  if (existing) {
    return existing;
  }

  const currency = input.currency || assignment.currency || 'INR';

  const offer = await prisma.commercialOffer.create({
    data: {
      tenantId,
      requestId: input.requestId,
      vendorAssignmentId: assignment.id,
      vendorId: assignment.vendorId,
      offerType: input.offerType || OfferType.PRODUCT,
      status: OfferStatus.VENDOR_INVITED,
      currency,
      deadline: input.deadline ? new Date(input.deadline) : assignment.deadlineExtendedAt,
    },
  });

  return offer;
}

/**
 * Get the commercial offer for a vendor assignment.
 */
export async function getOffer(
  offerId: string,
  tenantId: string,
  userId: string,
  vendorId?: string
): Promise<any> {
  const offer = await prisma.commercialOffer.findFirst({
    where: { id: offerId, tenantId },
    include: {
      submissions: { orderBy: { submissionNumber: 'desc' } },
      events: { orderBy: { createdAt: 'desc' } },
      request: {
        select: {
          id: true,
          title: true,
          item: true,
          quantity: true,
          unit: true,
          specifications: true,
          location: true,
          requiredDate: true,
          description: true,
        },
      },
      vendor: {
        select: {
          id: true,
          name: true,
          email: true,
          vendorType: true,
          verificationStatus: true,
        },
      },
    },
  });

  if (!offer) {
    throw new NotFoundError('CommercialOffer');
  }

  if (vendorId && offer.vendorId !== vendorId) {
    throw new ForbiddenError('You cannot access another vendor\'s offer');
  }

  return offer;
}

/**
 * Get offer by assignment ID (used for the vendor-facing opportunity page).
 */
export async function getOfferByAssignment(
  vendorAssignmentId: string,
  tenantId: string,
  userId: string,
  vendorId?: string
): Promise<any> {
  const assignment = await assertAssignmentAccess(vendorAssignmentId, tenantId, userId, vendorId);

  const currentRound = assignment.commercialRound;

  const offer = await prisma.commercialOffer.findUnique({
    where: {
      vendorAssignmentId_commercialRound: {
        vendorAssignmentId,
        commercialRound: currentRound,
      },
    },
    include: {
      submissions: { orderBy: { submissionNumber: 'desc' } },
      events: { orderBy: { createdAt: 'desc' }, take: 20 },
      request: {
        select: {
          id: true,
          title: true,
          item: true,
          quantity: true,
          unit: true,
          specifications: true,
          location: true,
          requiredDate: true,
          description: true,
        },
      },
      vendor: {
        select: {
          id: true,
          name: true,
          email: true,
          vendorType: true,
          verificationStatus: true,
        },
      },
    },
  });

  if (!offer) {
    // Create initial offer entity
    return createOrGetOffer(
      {
        requestId: assignment.requestId,
        vendorAssignmentId: assignment.id,
        offerType: OfferType.PRODUCT,
      },
      userId,
      tenantId,
      vendorId
    );
  }

  return offer;
}

/**
 * List all offers for a buyer (scoped to tenant).
 * Supports filtering by requestId, vendorId, status.
 */
export async function listOffersForBuyer(
  tenantId: string,
  params: {
    requestId?: string;
    vendorId?: string;
    status?: string;
    page?: number;
    limit?: number;
  } = {}
): Promise<{ data: any[]; total: number; page: number; limit: number }> {
  const where: Prisma.CommercialOfferWhereInput = { tenantId };

  if (params.requestId) where.requestId = params.requestId;
  if (params.vendorId) where.vendorId = params.vendorId;
  if (params.status) where.status = params.status as OfferStatus;

  const page = params.page || 1;
  const limit = Math.min(params.limit || 20, 100);
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    prisma.commercialOffer.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true, email: true, vendorType: true } },
        request: {
          select: { id: true, title: true, item: true, quantity: true, unit: true, requiredDate: true },
        },
        submissions: {
          orderBy: { submissionNumber: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.commercialOffer.count({ where }),
  ]);

  return { data, total, page, limit };
}

/**
 * Create or update an offer draft.
 * Does NOT consume an offer slot.
 */
export async function upsertOfferDraft(
  vendorAssignmentId: string,
  input: UpdateOfferDraftInput & { offerType?: OfferType; currency?: string },
  userId: string,
  tenantId: string,
  vendorId?: string
): Promise<any> {
  const assignment = await assertAssignmentAccess(vendorAssignmentId, tenantId, userId, vendorId);

  const offer = await createOrGetOffer(
    {
      requestId: assignment.requestId,
      vendorAssignmentId: assignment.id,
      offerType: input.offerType,
      currency: input.currency,
    },
    userId,
    tenantId,
    vendorId
  );

  // Build the submission data for the draft
  const submissionData: Prisma.CommercialOfferSubmissionUncheckedCreateInput = {
    commercialOfferId: offer.id,
    tenantId,
    submissionNumber: 0, // Draft submissions use number 0; real submissions increment
    offerType: input.offerType || offer.offerType,
    currency: input.currency || offer.currency,
    subTotal: toDecimal(input.subTotal ?? 0, 'subTotal'),
    taxAmount: input.taxAmount !== undefined ? toDecimal(input.taxAmount, 'taxAmount') : undefined,
    totalAmount: toDecimal(input.totalAmount ?? 0, 'totalAmount'),
    discountAmount: input.discountAmount !== undefined && input.discountAmount !== null
      ? toDecimal(input.discountAmount, 'discountAmount')
      : undefined,
    discountPercentage: input.discountPercentage,
    unitPrice: input.unitPrice !== undefined && input.unitPrice !== null
      ? toDecimal(input.unitPrice, 'unitPrice')
      : undefined,
    quantity: input.quantity,
    contractDuration: input.contractDuration,
    milestones: input.milestones ? JSON.stringify(input.milestones) : undefined,
    deliverables: input.deliverables ? JSON.stringify(input.deliverables) : undefined,
    serviceLevels: input.serviceLevels ? JSON.stringify(input.serviceLevels) : undefined,
    staffingAssumptions: input.staffingAssumptions,
    numberOfLicenses: input.numberOfLicenses,
    billingFrequency: input.billingFrequency,
    subscriptionTerm: input.subscriptionTerm,
    renewalTerms: input.renewalTerms,
    implementationFees: input.implementationFees !== undefined && input.implementationFees !== null
      ? toDecimal(input.implementationFees, 'implementationFees')
      : undefined,
    recurringFees: input.recurringFees !== undefined && input.recurringFees !== null
      ? toDecimal(input.recurringFees, 'recurringFees')
      : undefined,
    oneTimeFees: input.oneTimeFees !== undefined && input.oneTimeFees !== null
      ? toDecimal(input.oneTimeFees, 'oneTimeFees')
      : undefined,
    deliveryDate: input.deliveryDate ? new Date(input.deliveryDate) : undefined,
    paymentTerms: input.paymentTerms,
    offerValidityDays: input.offerValidityDays,
    offerValidityDate: input.offerValidityDate ? new Date(input.offerValidityDate) : undefined,
    commercialConditions: input.commercialConditions,
    scope: input.scope,
    exclusions: input.exclusions,
    supportingDocuments: input.supportingDocuments || [],
    submittedById: undefined,
    submittedAt: undefined,
    isFinal: false,
    idempotencyKey: undefined,
  };

  // Check if there's an existing draft (submissionNumber 0)
  const existingDraft = await prisma.commercialOfferSubmission.findFirst({
    where: {
      commercialOfferId: offer.id,
      submissionNumber: 0,
    },
  });

  let submission;
  if (existingDraft) {
    submission = await prisma.commercialOfferSubmission.update({
      where: { id: existingDraft.id },
      data: submissionData,
    });
  } else {
    submission = await prisma.commercialOfferSubmission.create({
      data: submissionData,
    });
  }

  // Update offer status to DRAFT if it was VENDOR_INVITED
  if (offer.status === OfferStatus.VENDOR_INVITED) {
    await prisma.commercialOffer.update({
      where: { id: offer.id },
      data: { status: OfferStatus.OFFER_DRAFT },
    });
  }

  return { offer, submission };
}

/**
 * Submit a commercial offer (creates an immutable submission).
 * Consumes one of the four offer slots.
 * Uses idempotency keys to prevent duplicates from retries.
 */
export async function submitOffer(
  input: SubmitOfferInput,
  userId: string,
  tenantId: string,
  vendorId?: string
): Promise<any> {
  const assignment = await assertAssignmentAccess(input.vendorAssignmentId, tenantId, userId, vendorId);

  // Idempotency check: if this key was already used, return the existing submission
  const existingIdempotent = await prisma.commercialOfferSubmission.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existingIdempotent) {
    return existingIdempotent;
  }

  const offer = await createOrGetOffer(
    {
      requestId: input.requestId,
      vendorAssignmentId: assignment.id,
      offerType: input.offerType,
      currency: input.currency,
    },
    userId,
    tenantId,
    vendorId
  );

  // Validate compliance
  const requirement = await prisma.procurementRequest.findUnique({
    where: { id: input.requestId },
    select: {
      id: true,
      quantity: true,
      unit: true,
      requiredDate: true,
      specifications: true,
      location: true,
      categoryId: true,
      category: { select: { name: true } },
    },
  });

  if (!requirement) {
    throw new NotFoundError('ProcurementRequest');
  }

  const complianceContext: ComplianceContext = {
    requestId: requirement.id,
    quantity: requirement.quantity,
    unit: requirement.unit,
    requiredDate: requirement.requiredDate,
    category: requirement.category?.name ?? requirement.categoryId,
    specifications: requirement.specifications,
    location: requirement.location,
  };

  const compliance = evaluateCompliance(
    {
      offerType: input.offerType,
      currency: input.currency,
      subTotal: input.subTotal,
      taxAmount: input.taxAmount,
      totalAmount: input.totalAmount,
      discountAmount: input.discountAmount,
      discountPercentage: input.discountPercentage,
      unitPrice: input.unitPrice,
      quantity: input.quantity,
      deliveryDate: input.deliveryDate ? new Date(input.deliveryDate) : null,
      paymentTerms: input.paymentTerms,
      offerValidityDays: input.offerValidityDays,
      offerValidityDate: input.offerValidityDate ? new Date(input.offerValidityDate) : null,
      contractDuration: input.contractDuration,
      staffingAssumptions: input.staffingAssumptions,
      numberOfLicenses: input.numberOfLicenses,
      billingFrequency: input.billingFrequency,
      subscriptionTerm: input.subscriptionTerm,
    },
    complianceContext
  );

  // Use a transaction to enforce the 4-offer limit atomically
  const result = await prisma.$transaction(async (tx) => {
    // Re-fetch the offer with current submission count (to handle concurrency)
    const currentOffer = await tx.commercialOffer.findUnique({
      where: { id: offer.id },
      select: {
        id: true,
        submissionsInRound: true,
        finalOfferSubmitted: true,
        commercialRound: true,
        status: true,
      },
    });

    if (!currentOffer) {
      throw new NotFoundError('CommercialOffer');
    }

    // Check the 4-offer limit
    if (currentOffer.submissionsInRound >= MAX_SUBMISSIONS) {
      throw new ConflictError(
        `You have already submitted ${MAX_SUBMISSIONS} offers. A fifth submission is not allowed unless the buyer reopens the commercial process.`
      );
    }

    if (currentOffer.finalOfferSubmitted) {
      throw new ConflictError('The final offer has already been submitted. The commercial process must be reopened by the buyer.');
    }

    // Check deadline
    if (offer.deadline && offer.deadline < new Date()) {
      throw new ConflictError('The offer submission deadline has passed');
    }

    // Check if there's an existing draft that we're submitting
    const draft = await tx.commercialOfferSubmission.findFirst({
      where: {
        commercialOfferId: offer.id,
        submissionNumber: 0,
      },
    });

    // Determine the new submission number
    const newSubmissionNumber = currentOffer.submissionsInRound + 1;
    const isFinal = newSubmissionNumber === MAX_SUBMISSIONS;

    // Create the immutable submission via idempotency key
    const submission = await tx.commercialOfferSubmission.create({
      data: {
        commercialOfferId: offer.id,
        tenantId,
        submissionNumber: newSubmissionNumber,
        previousSubmissionId: draft?.id || (await tx.commercialOfferSubmission.findFirst({
          where: { commercialOfferId: offer.id, submissionNumber: newSubmissionNumber - 1 },
          select: { id: true },
        }))?.id,
        offerType: input.offerType,
        currency: input.currency,
        subTotal: toDecimal(input.subTotal, 'subTotal'),
        taxAmount: input.taxAmount !== undefined ? toDecimal(input.taxAmount, 'taxAmount') : undefined,
        totalAmount: toDecimal(input.totalAmount, 'totalAmount'),
        discountAmount: input.discountAmount !== undefined && input.discountAmount !== null
          ? toDecimal(input.discountAmount, 'discountAmount')
          : undefined,
        discountPercentage: input.discountPercentage,
        unitPrice: input.unitPrice !== undefined && input.unitPrice !== null
          ? toDecimal(input.unitPrice, 'unitPrice')
          : undefined,
        quantity: input.quantity,
        contractDuration: input.contractDuration,
        milestones: input.milestones ? JSON.stringify(input.milestones) : undefined,
        deliverables: input.deliverables ? JSON.stringify(input.deliverables) : undefined,
        serviceLevels: input.serviceLevels ? JSON.stringify(input.serviceLevels) : undefined,
        staffingAssumptions: input.staffingAssumptions,
        numberOfLicenses: input.numberOfLicenses,
        billingFrequency: input.billingFrequency,
        subscriptionTerm: input.subscriptionTerm,
        renewalTerms: input.renewalTerms,
        implementationFees: input.implementationFees !== undefined && input.implementationFees !== null
          ? toDecimal(input.implementationFees, 'implementationFees')
          : undefined,
        recurringFees: input.recurringFees !== undefined && input.recurringFees !== null
          ? toDecimal(input.recurringFees, 'recurringFees')
          : undefined,
        oneTimeFees: input.oneTimeFees !== undefined && input.oneTimeFees !== null
          ? toDecimal(input.oneTimeFees, 'oneTimeFees')
          : undefined,
        deliveryDate: input.deliveryDate ? new Date(input.deliveryDate) : undefined,
        paymentTerms: input.paymentTerms,
        offerValidityDays: input.offerValidityDays,
        offerValidityDate: input.offerValidityDate ? new Date(input.offerValidityDate) : undefined,
        commercialConditions: input.commercialConditions,
        scope: input.scope,
        exclusions: input.exclusions,
        supportingDocuments: input.supportingDocuments || [],
        complianceStatus: compliance.status,
        complianceDetails: compliance.details ? JSON.stringify(compliance.details) : undefined,
        submittedAt: new Date(),
        submittedById: userId,
        isFinal,
        idempotencyKey: input.idempotencyKey,
      },
    });

    // Update the parent offer
    const newStatus = isFinal ? OfferStatus.FINAL_OFFER_SUBMITTED : OfferStatus.OFFER_SUBMITTED;
    await tx.commercialOffer.update({
      where: { id: offer.id },
      data: {
        currentSubmissionNumber: newSubmissionNumber,
        submissionsInRound: newSubmissionNumber,
        finalOfferSubmitted: isFinal,
        status: newStatus,
      },
    });

    // Update the assignment's offer count
    await tx.vendorAssignment.update({
      where: { id: assignment.id },
      data: {
        offersSubmitted: { increment: 1 },
        finalOfferSubmitted: isFinal,
        hasQuoted: true,
      },
    });

    // Delete the draft if it was submitted
    if (draft) {
      await tx.commercialOfferSubmission.delete({
        where: { id: draft.id },
      });
    }

    // Record audit event
    await tx.offerEvent.create({
      data: {
        commercialOfferId: offer.id,
        submissionId: submission.id,
        tenantId,
        eventType: isFinal ? OfferEventType.OFFER_REVIEWED : OfferEventType.OFFER_SUBMITTED,
        description: `Offer ${newSubmissionNumber} of ${MAX_SUBMISSIONS} submitted by vendor`,
        actorId: userId,
        metadata: JSON.stringify({
          submissionNumber: newSubmissionNumber,
          isFinal,
          complianceStatus: compliance.status,
        }),
      },
    });

    // Also create a standard audit log entry
    await tx.auditLog.create({
      data: {
        userId,
        action: PrismaAuditAction.OFFER_SUBMITTED,
        entityType: 'CommercialOfferSubmission',
        entityId: submission.id,
        previousStatus: draft ? 'DRAFT' : 'NONE',
        newStatus: isFinal ? 'FINAL' : 'SUBMITTED',
        tenantId,
        metadata: {
          submissionNumber: newSubmissionNumber,
          isFinal,
          offerId: offer.id,
          vendorId: assignment.vendorId,
        },
      },
    });

    return { submission, offerId: offer.id, isFinal, submissionNumber: newSubmissionNumber };
  });

  return result;
}

/**
 * Get the full submission history for an offer (for both vendor and buyer).
 */
export async function getOfferSubmissions(
  offerId: string,
  tenantId: string,
  userId: string,
  vendorId?: string
): Promise<any[]> {
  const offer = await prisma.commercialOffer.findFirst({
    where: { id: offerId, tenantId },
    select: { vendorId: true, vendorAssignmentId: true },
  });

  if (!offer) {
    throw new NotFoundError('CommercialOffer');
  }

  if (vendorId && offer.vendorId !== vendorId) {
    throw new ForbiddenError('You cannot access another vendor\'s offer');
  }

  return prisma.commercialOfferSubmission.findMany({
    where: {
      commercialOfferId: offerId,
      submissionNumber: { gte: 1 },
    },
    orderBy: { submissionNumber: 'asc' },
    include: {
      submittedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      previousSubmission: { select: { id: true, submissionNumber: true, totalAmount: true } },
    },
  });
}

/**
 * List offers for a vendor (vendor-facing view).
 */
export async function listVendorOffers(
  vendorId: string,
  tenantId: string,
  userId: string,
  params: {
    requestId?: string;
    status?: string;
    page?: number;
    limit?: number;
  } = {}
): Promise<{ data: any[]; total: number; page: number; limit: number }> {
  // Verify the user is linked to this vendor
  await resolveVendorFromUser(userId, tenantId, vendorId);

  const where: Prisma.CommercialOfferWhereInput = {
    tenantId,
    vendorId,
  };

  if (params.requestId) where.requestId = params.requestId;
  if (params.status) where.status = params.status as OfferStatus;

  const page = params.page || 1;
  const limit = Math.min(params.limit || 20, 100);
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    prisma.commercialOffer.findMany({
      where,
      include: {
        request: {
          select: { id: true, title: true, item: true, quantity: true, unit: true, requiredDate: true },
        },
        submissions: {
          orderBy: { submissionNumber: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.commercialOffer.count({ where }),
  ]);

  return { data, total, page, limit };
}

/**
 * Get a clarification thread for a vendor assignment.
 */
export async function getClarificationThread(
  vendorAssignmentId: string,
  tenantId: string,
  userId: string,
  vendorId?: string
): Promise<any[]> {
  const assignment = await assertAssignmentAccess(vendorAssignmentId, tenantId, userId, vendorId);

  return prisma.offerEvent.findMany({
    where: {
      commercialOffer: {
        vendorAssignmentId: assignment.id,
      },
      eventType: { in: ['CLARIFICATION_REQUESTED', 'CLARIFICATION_ANSWERED'] as OfferEventType[] },
    },
    orderBy: { createdAt: 'asc' },
    include: { actor: { select: { id: true, firstName: true, lastName: true, role: true } } },
  });
}

/**
 * Post a clarification message (does NOT consume an offer slot).
 */
export async function postClarification(
  input: OfferClarificationInput,
  userId: string,
  tenantId: string,
  vendorId?: string
): Promise<any> {
  const assignment = await assertAssignmentAccess(input.vendorAssignmentId, tenantId, userId, vendorId);

  const offer = await prisma.commercialOffer.findUnique({
    where: {
      vendorAssignmentId_commercialRound: {
        vendorAssignmentId: assignment.id,
        commercialRound: 1,
      },
    },
  });

  if (!offer) {
    throw new NotFoundError('CommercialOffer');
  }

  const event = await prisma.offerEvent.create({
    data: {
      commercialOfferId: offer.id,
      tenantId,
      eventType: OfferEventType.CLARIFICATION_REQUESTED,
      description: input.content,
      actorId: userId,
    },
  });

  await createAuditLog({
    userId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'CommercialOffer',
    entityId: offer.id,
    tenantId,
    metadata: { action: 'clarification_requested', content: input.content },
  });

  return event;
}

/**
 * Post a clarification response (does NOT consume an offer slot).
 */
export async function postClarificationResponse(
  vendorAssignmentId: string,
  content: string,
  userId: string,
  tenantId: string,
  vendorId?: string
): Promise<any> {
  const assignment = await assertAssignmentAccess(vendorAssignmentId, tenantId, userId, vendorId);

  const currentRound = assignment.commercialRound;

  const offer = await prisma.commercialOffer.findUnique({
    where: {
      vendorAssignmentId_commercialRound: {
        vendorAssignmentId,
        commercialRound: currentRound,
      },
    },
  });

  if (!offer) {
    throw new NotFoundError('CommercialOffer');
  }

  const event = await prisma.offerEvent.create({
    data: {
      commercialOfferId: offer.id,
      tenantId,
      eventType: OfferEventType.CLARIFICATION_ANSWERED,
      description: content,
      actorId: userId,
    },
  });

  await createAuditLog({
    userId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'CommercialOffer',
    entityId: offer.id,
    tenantId,
    metadata: { action: 'clarification_answered', content },
  });

  return event;
}

/**
 * Withdraw the current offer/draft.
 * Does NOT restore offer slots that have already been consumed.
 */
export async function withdrawOffer(
  offerId: string,
  tenantId: string,
  userId: string,
  vendorId?: string
): Promise<any> {
  const offer = await getOffer(offerId, tenantId, userId, vendorId);

  if (offer.vendorId !== vendorId) {
    throw new ForbiddenError('Only the vendor can withdraw their offer');
  }

  return await prisma.commercialOffer.update({
    where: { id: offerId },
    data: { status: OfferStatus.WITHDRAWN },
  });
}

/**
 * Decline the opportunity (vendor action).
 */
export async function declineOpportunity(
  offerId: string,
  tenantId: string,
  userId: string,
  vendorId?: string
): Promise<any> {
  const offer = await getOffer(offerId, tenantId, userId, vendorId);

  if (offer.vendorId !== vendorId) {
    throw new ForbiddenError('Only the vendor can decline an opportunity');
  }

  return await prisma.commercialOffer.update({
    where: { id: offerId },
    data: { status: OfferStatus.DECLINED },
  });
}

/**
 * Reopen the commercial process after the fourth offer.
 * Only authorized buyers can do this.
 */
export async function reopenCommercialProcess(
  input: ReopenCommercialInput,
  userId: string,
  tenantId: string,
  userRole: string
): Promise<any> {
  assertBuyerAuthority(userRole);

  const assignment = await prisma.vendorAssignment.findFirst({
    where: { id: input.vendorAssignmentId, tenantId },
  });

  if (!assignment) {
    throw new NotFoundError('VendorAssignment');
  }

  const currentOffer = await prisma.commercialOffer.findUnique({
    where: {
      vendorAssignmentId_commercialRound: {
        vendorAssignmentId: assignment.id,
        commercialRound: assignment.commercialRound,
      },
    },
  });

  if (!currentOffer) {
    throw new NotFoundError('CommercialOffer');
  }

  if (!currentOffer.finalOfferSubmitted) {
    throw new ValidationError('The commercial round must have a final offer submitted before it can be reopened');
  }

  // Create a new round
  const newRound = assignment.commercialRound + 1;

  const newOffer = await prisma.commercialOffer.create({
    data: {
      tenantId,
      requestId: assignment.requestId,
      vendorAssignmentId: assignment.id,
      vendorId: assignment.vendorId,
      offerType: currentOffer.offerType,
      status: OfferStatus.COMMERCIAL_PROCESS_REOPENED,
      currency: currentOffer.currency,
      deadline: currentOffer.deadline,
      commercialRound: newRound,
    },
  });

  // Update assignment
  await prisma.vendorAssignment.update({
    where: { id: assignment.id },
    data: {
      commercialRound: newRound,
      finalOfferSubmitted: false,
      offersSubmitted: 0,
    },
  });

  // Record events
  await prisma.offerEvent.create({
    data: {
      commercialOfferId: currentOffer.id,
      tenantId,
      eventType: OfferEventType.COMMERCIAL_PROCESS_REOPENED,
      description: `Commercial process reopened by buyer. Reason: ${input.reason}. New round: ${newRound}`,
      actorId: userId,
      metadata: JSON.stringify({ reason: input.reason, newRound }),
    },
  });

  await createAuditLog({
    userId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'CommercialOffer',
    entityId: currentOffer.id,
    previousStatus: 'FINAL_OFFER_SUBMITTED',
    newStatus: 'COMMERCIAL_PROCESS_REOPENED',
    tenantId,
    metadata: { reason: input.reason, newRound, newOfferId: newOffer.id },
  });

  return { offer: newOffer, newRound };
}

/**
 * Validate offer data before submission.
 * Throws ValidationError if invalid.
 */
export function validateOfferData(input: SubmitOfferInput): void {
  // Check for non-finite numbers
  if (!Number.isFinite(input.subTotal)) {
    throw new ValidationError('subTotal must be a finite number');
  }
  if (!Number.isFinite(input.totalAmount)) {
    throw new ValidationError('totalAmount must be a finite number');
  }
  if (input.taxAmount !== undefined && !Number.isFinite(input.taxAmount)) {
    throw new ValidationError('taxAmount must be a finite number');
  }
  if (input.unitPrice !== undefined && input.unitPrice !== null && !Number.isFinite(input.unitPrice)) {
    throw new ValidationError('unitPrice must be a finite number');
  }
  if (input.recurringFees !== undefined && input.recurringFees !== null && !Number.isFinite(input.recurringFees)) {
    throw new ValidationError('recurringFees must be a finite number');
  }
  if (input.implementationFees !== undefined && input.implementationFees !== null && !Number.isFinite(input.implementationFees)) {
    throw new ValidationError('implementationFees must be a finite number');
  }
  if (input.oneTimeFees !== undefined && input.oneTimeFees !== null && !Number.isFinite(input.oneTimeFees)) {
    throw new ValidationError('oneTimeFees must be a finite number');
  }
  if (input.discountAmount !== undefined && input.discountAmount !== null && !Number.isFinite(input.discountAmount)) {
    throw new ValidationError('discountAmount must be a finite number');
  }

  if (input.subTotal < 0) {
    throw new ValidationError('subTotal cannot be negative');
  }
  if (input.totalAmount < 0) {
    throw new ValidationError('totalAmount cannot be negative');
  }
  if (input.taxAmount !== undefined && input.taxAmount !== null && input.taxAmount < 0) {
    throw new ValidationError('taxAmount cannot be negative');
  }

  if (!input.currency || input.currency.length !== 3) {
    throw new ValidationError('currency must be a valid 3-letter ISO code');
  }
}

/**
 * Get event history for an offer.
 */
export async function getOfferEvents(
  offerId: string,
  tenantId: string,
  userId: string,
  vendorId?: string
): Promise<any[]> {
  const offer = await getOffer(offerId, tenantId, userId, vendorId);

  return prisma.offerEvent.findMany({
    where: { commercialOfferId: offerId, tenantId },
    orderBy: { createdAt: 'asc' },
    include: {
      actor: { select: { id: true, firstName: true, lastName: true, role: true } },
    },
  });
}

/**
 * Resolve the caller's role and vendor link from the database.
 *
 * The JWT role is a hint for the UI; authorization must re-read from the
 * database so a demotion or vendor-link change takes effect immediately.
 */
async function resolveActor(userId: string, tenantId: string): Promise<{ role: string; vendorId: string | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, role: true, vendorId: true, isActive: true },
  });
  if (!user || !user.isActive) {
    throw new ForbiddenError('Your account is not active or no longer exists');
  }
  if (user.tenantId !== tenantId) {
    throw new ForbiddenError('Access denied: account belongs to another tenant');
  }
  return { role: user.role, vendorId: user.vendorId };
}

/**
 * When the caller is a vendor, verify the submission belongs to their vendor.
 * Buyers within the tenant may access any submission in that tenant.
 */
async function assertSubmissionVendorAccess(submission: { commercialOffer: { vendorId: string } }, userId: string, tenantId: string): Promise<void> {
  const user = await resolveActor(userId, tenantId);
  if (user.role === UserRole.VENDOR && user.vendorId !== submission.commercialOffer.vendorId) {
    throw new ForbiddenError('Access denied: this submission belongs to another supplier');
  }
}

/**
 * Evaluate compliance for an existing submission (buyer action).
 */
export async function evaluateSubmissionCompliance(
  submissionId: string,
  tenantId: string,
  userId: string
): Promise<any> {
  const submission = await prisma.commercialOfferSubmission.findFirst({
    where: { id: submissionId, tenantId },
    include: { commercialOffer: true },
  });

  if (!submission) {
    throw new NotFoundError('CommercialOfferSubmission');
  }

  await assertSubmissionVendorAccess(submission, userId, tenantId);

  const requirement = await prisma.procurementRequest.findUnique({
    where: { id: submission.commercialOffer.requestId },
    select: {
      id: true,
      quantity: true,
      unit: true,
      requiredDate: true,
      categoryId: true,
      category: { select: { name: true } },
      specifications: true,
      location: true,
    },
  });

  if (!requirement) {
    throw new NotFoundError('ProcurementRequest');
  }

  const compliance = evaluateCompliance(
    {
      offerType: submission.offerType as OfferType,
      currency: submission.currency,
      subTotal: submission.subTotal,
      taxAmount: submission.taxAmount,
      totalAmount: submission.totalAmount,
      discountAmount: submission.discountAmount,
      discountPercentage: submission.discountPercentage,
      unitPrice: submission.unitPrice,
      quantity: submission.quantity,
      deliveryDate: submission.deliveryDate,
      paymentTerms: submission.paymentTerms,
      offerValidityDays: submission.offerValidityDays,
      offerValidityDate: submission.offerValidityDate,
      contractDuration: submission.contractDuration,
      staffingAssumptions: submission.staffingAssumptions,
      numberOfLicenses: submission.numberOfLicenses,
      billingFrequency: submission.billingFrequency,
      subscriptionTerm: submission.subscriptionTerm,
      scope: submission.scope,
      exclusions: submission.exclusions,
    },
    {
      requestId: requirement.id,
      quantity: requirement.quantity,
      unit: requirement.unit,
      requiredDate: requirement.requiredDate,
      category: requirement.category?.name ?? requirement.categoryId,
      specifications: requirement.specifications,
      location: requirement.location,
    }
  );

  await prisma.commercialOfferSubmission.update({
    where: { id: submission.id },
    data: {
      complianceStatus: compliance.status,
      complianceDetails: JSON.stringify(compliance.details),
    },
  });

  await prisma.offerEvent.create({
    data: {
      commercialOfferId: submission.commercialOfferId,
      submissionId: submission.id,
      tenantId,
      eventType: OfferEventType.COMPLIANCE_EVALUATED,
      description: `Compliance evaluated: ${compliance.status}`,
      actorId: userId,
      metadata: JSON.stringify(compliance.details),
    },
  });

  await createAuditLog({
    userId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'CommercialOfferSubmission',
    entityId: submission.id,
    previousStatus: 'REQUIRES_REVIEW',
    newStatus: compliance.status,
    tenantId,
    metadata: { complianceStatus: compliance.status },
  });

  return { submission, compliance };
}

/**
 * Generate an AI summary of a submission using only verified stored data.
 */
export async function summarizeSubmission(
  submissionId: string,
  tenantId: string,
  userId: string
): Promise<string> {
  const submission = await prisma.commercialOfferSubmission.findFirst({
    where: { id: submissionId, tenantId },
    include: {
      commercialOffer: {
        include: {
          vendor: { select: { id: true, name: true } },
          request: { select: { title: true, item: true, quantity: true, unit: true } },
        },
      },
    },
  });

  if (!submission) {
    throw new NotFoundError('CommercialOfferSubmission');
  }

  await assertSubmissionVendorAccess(submission, userId, tenantId);

  const vendorName = submission.commercialOffer.vendor.name;
  const total = decimalToNumber(submission.totalAmount);
  const currency = submission.currency;
  const delivery = submission.deliveryDate ? new Date(submission.deliveryDate).toLocaleDateString() : 'not specified';
  const paymentTerms = submission.paymentTerms || 'not specified';
  const validity = submission.offerValidityDays
    ? `${submission.offerValidityDays} days`
    : (submission.offerValidityDate
        ? new Date(submission.offerValidityDate).toLocaleDateString()
        : 'not specified');
  const warrantyText = (submission as any).warrantyMonths
    ? `${(submission as any).warrantyMonths} months`
    : 'not specified';

  // Build summary based on offer type
  if (submission.offerType === OfferType.SOFTWARE_SUBSCRIPTION) {
    const licenses = submission.numberOfLicenses || 0;
    const frequency = submission.billingFrequency || 'not specified';
    const term = submission.subscriptionTerm || 'not specified';
    const recurring = submission.recurringFees ? decimalToNumber(submission.recurringFees) : 0;
    const impl = submission.implementationFees ? decimalToNumber(submission.implementationFees) : 0;
    const oneTime = submission.oneTimeFees ? decimalToNumber(submission.oneTimeFees) : 0;

    return `${vendorName} submitted ${currency} ${total.toLocaleString()} for ${licenses} licenses (${frequency}, ${term}). ` +
      `Recurring fees: ${currency} ${recurring.toLocaleString()}, implementation fees: ${currency} ${impl.toLocaleString()}, ` +
      `one-time fees: ${currency} ${oneTime.toLocaleString()}. Payment terms: ${paymentTerms}. ` +
      `Delivery/commencement: ${delivery}. Offer valid for: ${validity}.`;
  }

  if (submission.offerType === OfferType.SERVICE) {
    const duration = submission.contractDuration || 'not specified';
    const scope = submission.scope || 'not specified';

    return `${vendorName} submitted ${currency} ${total.toLocaleString()} for ${duration} of service. ` +
      `Payment terms: ${paymentTerms}. Delivery/commencement: ${delivery}. ` +
      `Offer valid for: ${validity}. Scope: ${scope}.`;
  }

  // Product
  const quantity = submission.quantity || 0;
  const unitPrice = submission.unitPrice ? decimalToNumber(submission.unitPrice) : 0;
  const quantityStr = quantity > 0 ? `${quantity} units at ${currency} ${unitPrice.toLocaleString()} each` : 'quantity not specified';

  return `${vendorName} submitted ${currency} ${total.toLocaleString()} for ${quantityStr}. ` +
    `Delivery: ${delivery}. Warranty: ${warrantyText}. Payment terms: ${paymentTerms}. ` +
    `Offer valid for: ${validity}.`;
}
