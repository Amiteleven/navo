/**
 * NAVO Core Workflow Service
 *
 * This is the central orchestrator for the NAVO chat-first procurement platform.
 * It manages the complete state machine:
 * REQUIREMENT_DRAFT → PENDING_DEPT_APPROVAL → APPROVED_FOR_SOURCING →
 * VENDOR_MATCHING → VENDOR_INVITED → OFFERS_RECEIVED → COMMERCIAL_EVALUATION →
 * NEGOTIATION → FINAL_COMMERCIAL_SELECTION → PENDING_FINAL_APPROVAL →
 * DEAL_CONFIRMED → EXECUTION
 */
import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors';

// ─── State Machine ────────────────────────────────────────────────────────────

export type NavoWorkflowStatus =
  | 'REQUIREMENT_DRAFT'
  | 'PENDING_DEPT_APPROVAL'
  | 'DEPT_APPROVED'
  | 'DEPT_REJECTED'
  | 'APPROVED_FOR_SOURCING'
  | 'REQUIREMENT_COMPLETION'
  | 'VENDOR_MATCHING'
  | 'VENDOR_INVITED'
  | 'OFFERS_RECEIVED'
  | 'COMMERCIAL_EVALUATION'
  | 'NEGOTIATION_RECOMMENDED'
  | 'NO_NEGOTIATION_NEEDED'
  | 'NEGOTIATION'
  | 'FINAL_COMMERCIAL_SELECTION'
  | 'PENDING_FINAL_APPROVAL'
  | 'FINAL_APPROVED'
  | 'FINAL_REJECTED'
  | 'DEAL_CONFIRMED'
  | 'EXECUTION'
  | 'COMPLETED'
  | 'CANCELLED';

// ─── Requirement Summary ──────────────────────────────────────────────────────

export interface RequirementSummary {
  id: string;
  title: string;
  item?: string | null;
  category?: string | null;
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  deliveryLocation?: string | null;
  requiredDate?: Date | null;
  estimatedBudget?: number | null;
  currency?: string | null;
  specifications?: string | null;
  description?: string | null;
  status: string;
  navoStatus: NavoWorkflowStatus;
  department?: string | null;
  createdAt: Date;
  updatedAt: Date;
  requesterId: string;
  requesterName?: string;
}

// ─── Vendor Offer (Four-Offer Engine) ────────────────────────────────────────

export interface VendorOffer {
  id: string;
  dealRoomId: string;
  vendorId: string;
  vendorName: string;
  offerNumber: number; // 1–4
  unitPrice: number;
  quantity: number;
  totalPrice: number;
  currency: string;
  deliveryTimelineDays?: number | null;
  paymentTerms?: string | null;
  warrantyMonths?: number | null;
  installationAmount: number;
  otherCharges: number;
  gst: number;
  totalLandedCost: number;
  status: string;
  submittedAt: Date;
  isVendorsFinalOffer: boolean; // true when this is offer 4
}

// ─── Commercial Evaluation ────────────────────────────────────────────────────

export interface CommercialEvaluation {
  requirementId: string;
  vendorOffers: VendorOfferSummary[];
  recommendedVendorId: string;
  recommendedVendorName: string;
  recommendedOfferId: string;
  reasoning: string;
  negotiationRecommended: boolean;
  negotiationReason?: string;
  estimatedSavingsMin?: number;
  estimatedSavingsMax?: number;
  currency: string;
  evaluatedAt: Date;
}

export interface VendorOfferSummary {
  vendorId: string;
  vendorName: string;
  offerCount: number;
  bestOffer: {
    id: string;
    totalLandedCost: number;
    deliveryDays?: number | null;
    paymentTerms?: string | null;
    warrantyMonths?: number | null;
    installationIncluded: boolean;
  };
  score: number;
  rank: number;
  isRecommended: boolean;
}

// ─── NAVO Chat Message ────────────────────────────────────────────────────────

export type NavoMessageType =
  | 'text'
  | 'requirement_draft'
  | 'approval_request'
  | 'approval_decision'
  | 'vendor_matched'
  | 'vendor_opportunity'
  | 'offer_received'
  | 'commercial_evaluation'
  | 'negotiation_open'
  | 'deal_recommendation'
  | 'deal_confirmed'
  | 'execution_update'
  | 'system';

export interface NavoChatMessage {
  id: string;
  role: 'user' | 'navo' | 'system';
  type: NavoMessageType;
  content: string;
  data?: Record<string, unknown>;
  timestamp: Date;
  requirementId?: string;
}

// ─── Get Requirement with NAVO Status ────────────────────────────────────────

export async function getRequirementWithNavoStatus(
  requestId: string,
  userId: string,
  tenantId: string
): Promise<RequirementSummary | null> {
  const req = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
    include: {
      requester: { select: { firstName: true, lastName: true } },
      requirementDraft: true,
      requirementApprovalRequests: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!req) return null;

  // Determine NAVO workflow status from underlying state
  const navoStatus = deriveNavoStatus(req);

  return {
    id: req.id,
    title: req.title,
    item: req.item,
    category: req.requirementDraft?.category ?? null,
    quantity: req.quantity,
    unit: req.unit,
    location: req.location,
    deliveryLocation: req.location,
    requiredDate: req.requiredDate,
    estimatedBudget: req.estimatedBudget,
    currency: 'INR',
    specifications: req.specifications,
    description: req.description,
    status: req.status,
    navoStatus,
    department: req.department,
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
    requesterId: req.requesterId,
    requesterName: req.requester ? `${req.requester.firstName} ${req.requester.lastName}` : undefined,
  };
}

// ─── Derive NAVO Status from DB State ────────────────────────────────────────

function deriveNavoStatus(req: {
  status: string;
  requirementApprovalRequests?: Array<{ status: string }>;
  connections?: Array<{ status: string }>;
}): NavoWorkflowStatus {
  // Direct mapping for new NAVO states
  switch (req.status) {
    case 'REQUIREMENT_DRAFT':
      return 'REQUIREMENT_DRAFT';
    case 'PENDING_DEPARTMENT_APPROVAL':
      return 'PENDING_DEPT_APPROVAL';
    case 'APPROVED_FOR_SOURCING':
      return 'APPROVED_FOR_SOURCING';
    case 'REQUIREMENT_COMPLETION':
      return 'REQUIREMENT_COMPLETION';
    case 'VENDOR_MATCHING':
      return 'VENDOR_MATCHING';
    case 'VENDOR_INVITED':
      return 'VENDOR_INVITED';
    case 'OFFERS_RECEIVED':
      return 'OFFERS_RECEIVED';
    case 'COMMERCIAL_EVALUATION':
      return 'COMMERCIAL_EVALUATION';
    case 'NEGOTIATION_RECOMMENDED':
      return 'NEGOTIATION_RECOMMENDED';
    case 'NO_NEGOTIATION':
      return 'NO_NEGOTIATION_NEEDED';
    case 'NEGOTIATION':
      return 'NEGOTIATION';
    case 'FINAL_COMMERCIAL_SELECTION':
      return 'FINAL_COMMERCIAL_SELECTION';
    case 'PENDING_FINAL_APPROVAL':
      return 'PENDING_FINAL_APPROVAL';
    case 'DEAL_CONFIRMED':
      return 'DEAL_CONFIRMED';
    case 'EXECUTION':
      return 'EXECUTION';
    case 'SEND_BACK':
      return 'REQUIREMENT_DRAFT'; // Buyer can re-edit
    case 'EXPIRED':
      return 'CANCELLED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'CANCELLED':
      return 'CANCELLED';

    // Legacy status mapping (for existing data)
    case 'DRAFT': {
      const approvalReqs = req.requirementApprovalRequests ?? [];
      const latestApproval = approvalReqs[0];
      if (!latestApproval) return 'REQUIREMENT_DRAFT';
      if (latestApproval.status === 'PENDING_APPROVAL') return 'PENDING_DEPT_APPROVAL';
      if (latestApproval.status === 'APPROVED') return 'APPROVED_FOR_SOURCING';
      if (latestApproval.status === 'REJECTED') return 'DEPT_REJECTED';
      if (latestApproval.status === 'CHANGES_REQUESTED') return 'REQUIREMENT_DRAFT';
      return 'REQUIREMENT_DRAFT';
    }
    case 'SUBMITTED':
      return 'PENDING_DEPT_APPROVAL';
    case 'REQUIREMENT_EXTRACTED':
      return 'APPROVED_FOR_SOURCING';
    case 'VENDORS_IDENTIFIED':
      return 'VENDOR_MATCHING';
    case 'RFQ_CREATED':
    case 'RFQ_SENT':
      return 'VENDOR_INVITED';
    case 'QUOTES_RECEIVED':
      return 'OFFERS_RECEIVED';
    case 'COMPARISON_COMPLETED':
      return 'COMMERCIAL_EVALUATION';
    case 'RECOMMENDATION_READY':
      return 'NEGOTIATION_RECOMMENDED';
    case 'APPROVAL_PENDING':
      return 'PENDING_FINAL_APPROVAL';
    case 'APPROVED':
      return 'FINAL_APPROVED';
    case 'REJECTED': {
      const approvalReqs = req.requirementApprovalRequests ?? [];
      return approvalReqs.length > 0 ? 'FINAL_REJECTED' : 'DEPT_REJECTED';
    }
    case 'PURCHASE_ORDER_CREATED':
      return 'EXECUTION';

    default:
      return 'REQUIREMENT_DRAFT';
  }
}

// ─── Get All Active Requirements for User ────────────────────────────────────

export async function getActiveRequirementsForUser(
  userId: string,
  tenantId: string,
  limit = 20,
  offset = 0
) {
  const requests = await prisma.procurementRequest.findMany({
    where: {
      tenantId,
      requesterId: userId,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
    },
    include: {
      requirementApprovalRequests: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      _count: {
        select: { rfqs: true },
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    skip: offset,
  });

  return requests.map((req) => ({
    id: req.id,
    title: req.title,
    item: req.item,
    quantity: req.quantity,
    unit: req.unit,
    estimatedBudget: req.estimatedBudget,
    status: req.status,
    navoStatus: deriveNavoStatus(req),
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
  }));
}

// ─── Get Vendor Offers for a Requirement ─────────────────────────────────────

export async function getVendorOffersForRequirement(
  requestId: string,
  buyerId: string,
  tenantId: string
): Promise<VendorOffer[]> {
  // Get all deal rooms for this requirement
  const dealRooms = await prisma.dealRoom.findMany({
    where: { requestId, tenantId, buyerId },
    include: {
      vendor: {
        select: { id: true, name: true },
      },
      offers: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  const result: VendorOffer[] = [];

  for (const room of dealRooms) {
    const vendorOffers = room.offers;
    for (let i = 0; i < vendorOffers.length; i++) {
      const offer = vendorOffers[i];
      const totalLandedCost =
        offer.unitPrice * offer.quantity +
        (offer.gst || 0) +
        (offer.freightAmount || 0) +
        (offer.installationAmount || 0) +
        (offer.otherCharges || 0);

      result.push({
        id: offer.id,
        dealRoomId: room.id,
        vendorId: room.vendor.id,
        vendorName: room.vendor.name,
        offerNumber: i + 1,
        unitPrice: offer.unitPrice,
        quantity: offer.quantity,
        totalPrice: offer.unitPrice * offer.quantity,
        currency: 'INR',
        deliveryTimelineDays: offer.deliveryTimelineDays,
        paymentTerms: offer.paymentTerms,
        warrantyMonths: offer.warrantyMonths,
        installationAmount: offer.installationAmount || 0,
        otherCharges: offer.otherCharges || 0,
        gst: offer.gst || 0,
        totalLandedCost,
        status: offer.status,
        submittedAt: offer.createdAt,
        isVendorsFinalOffer: i === 3, // 4th offer (0-indexed)
      });
    }
  }

  return result;
}

// ─── Run Commercial Evaluation ────────────────────────────────────────────────

export async function runCommercialEvaluation(
  requestId: string,
  buyerId: string,
  tenantId: string
): Promise<CommercialEvaluation | null> {
  const offers = await getVendorOffersForRequirement(requestId, buyerId, tenantId);
  if (offers.length === 0) return null;

  // Group best offer per vendor
  const vendorMap = new Map<string, VendorOffer[]>();
  for (const offer of offers) {
    if (!vendorMap.has(offer.vendorId)) vendorMap.set(offer.vendorId, []);
    vendorMap.get(offer.vendorId)!.push(offer);
  }

  const vendorSummaries: VendorOfferSummary[] = [];
  for (const [vendorId, vendorOffers] of vendorMap.entries()) {
    // Best offer = lowest total landed cost among active offers
    const active = vendorOffers.filter((o) => o.status !== 'REJECTED' && o.status !== 'WITHDRAWN');
    if (active.length === 0) continue;

    const best = active.reduce((a, b) => (a.totalLandedCost <= b.totalLandedCost ? a : b));

    // Score: lower cost = higher score; delivery speed bonus; warranty bonus
    const maxCost = Math.max(...active.map((o) => o.totalLandedCost));
    const costScore = maxCost > 0 ? (1 - best.totalLandedCost / maxCost) * 50 : 50;
    const deliveryScore = best.deliveryTimelineDays ? Math.max(0, 25 - best.deliveryTimelineDays / 4) : 0;
    const warrantyScore = best.warrantyMonths ? Math.min(best.warrantyMonths / 2, 15) : 0;
    const installScore = best.installationAmount > 0 ? 10 : 0;
    const score = costScore + deliveryScore + warrantyScore + installScore;

    vendorSummaries.push({
      vendorId,
      vendorName: best.vendorName,
      offerCount: active.length,
      bestOffer: {
        id: best.id,
        totalLandedCost: best.totalLandedCost,
        deliveryDays: best.deliveryTimelineDays,
        paymentTerms: best.paymentTerms,
        warrantyMonths: best.warrantyMonths,
        installationIncluded: best.installationAmount > 0,
      },
      score,
      rank: 0, // filled in after sorting
      isRecommended: false,
    });
  }

  // Rank by score
  vendorSummaries.sort((a, b) => b.score - a.score);
  vendorSummaries.forEach((v, i) => {
    v.rank = i + 1;
    v.isRecommended = i === 0;
  });

  if (vendorSummaries.length === 0) return null;

  const top = vendorSummaries[0];
  const second = vendorSummaries[1];

  // Negotiation recommendation: if gap between top and second is <15% or we haven't hit 4 offers
  let negotiationRecommended = false;
  let negotiationReason: string | undefined;
  let estimatedSavingsMin: number | undefined;
  let estimatedSavingsMax: number | undefined;

  const topCost = top.bestOffer.totalLandedCost;
  if (second) {
    const gap = (second.bestOffer.totalLandedCost - topCost) / second.bestOffer.totalLandedCost;
    if (gap < 0.15 && top.offerCount < 4) {
      negotiationRecommended = true;
      negotiationReason = `${top.vendorName} is the strongest option. Based on market signals, there may be room to improve the price by approximately 5–10%.`;
      estimatedSavingsMin = Math.round(topCost * 0.05);
      estimatedSavingsMax = Math.round(topCost * 0.10);
    }
  } else if (top.offerCount < 4) {
    // Single vendor — always recommend negotiation unless 4 offers submitted
    negotiationRecommended = true;
    negotiationReason = `${top.vendorName} is your only responding vendor. Negotiating before finalizing is recommended.`;
    estimatedSavingsMin = Math.round(topCost * 0.03);
    estimatedSavingsMax = Math.round(topCost * 0.08);
  }

  const reasoning = buildReasoningText(top, vendorSummaries);

  return {
    requirementId: requestId,
    vendorOffers: vendorSummaries,
    recommendedVendorId: top.vendorId,
    recommendedVendorName: top.vendorName,
    recommendedOfferId: top.bestOffer.id,
    reasoning,
    negotiationRecommended,
    negotiationReason,
    estimatedSavingsMin,
    estimatedSavingsMax,
    currency: 'INR',
    evaluatedAt: new Date(),
  };
}

function buildReasoningText(top: VendorOfferSummary, all: VendorOfferSummary[]): string {
  const parts: string[] = [];
  parts.push(
    `${top.vendorName} has the strongest overall commercial offer` +
      (all.length > 1 ? ` out of ${all.length} responding vendors` : '') +
      '.'
  );
  if (top.bestOffer.deliveryDays) {
    parts.push(`Delivery in ${top.bestOffer.deliveryDays} days.`);
  }
  if (top.bestOffer.installationIncluded) {
    parts.push('Installation is included.');
  }
  if (top.bestOffer.warrantyMonths) {
    parts.push(`${top.bestOffer.warrantyMonths}-month warranty.`);
  }
  if (top.bestOffer.paymentTerms) {
    parts.push(`Payment terms: ${top.bestOffer.paymentTerms}.`);
  }
  return parts.join(' ');
}

// ─── Get Pending Approvals for Approver ──────────────────────────────────────

export async function getPendingApprovalsForUser(
  userId: string,
  tenantId: string
) {
  // Requirement approvals (first approval)
  const requirementApprovals = await prisma.requirementApprovalRequest.findMany({
    where: {
      tenantId,
      status: 'PENDING_APPROVAL',
      decisions: {
        some: {
          assignedApproverId: userId,
          status: 'PENDING',
        },
      },
    },
    include: {
      request: {
        select: {
          id: true,
          title: true,
          item: true,
          quantity: true,
          unit: true,
          estimatedBudget: true,
          department: true,
          location: true,
          requiredDate: true,
          requester: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Purchase approvals (final commercial approval)
  const purchaseApprovals = await prisma.purchaseApprovalRequest.findMany({
    where: {
      tenantId,
      status: 'PENDING_APPROVAL',
      decisions: {
        some: {
          assignedApproverId: userId,
          status: 'PENDING',
        },
      },
    },
    include: {
      request: {
        select: {
          id: true,
          title: true,
          item: true,
          quantity: true,
        },
      },
      vendor: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    requirementApprovals: requirementApprovals.map((a) => ({
      id: a.id,
      type: 'REQUIREMENT' as const,
      requestId: a.requestId,
      title: a.request.title,
      item: a.request.item,
      quantity: a.request.quantity,
      unit: a.request.unit,
      estimatedBudget: a.request.estimatedBudget,
      department: a.request.department,
      location: a.request.location,
      requiredDate: a.request.requiredDate,
      requesterName: a.request.requester
        ? `${a.request.requester.firstName} ${a.request.requester.lastName}`
        : 'Unknown',
      status: a.status,
      createdAt: a.createdAt,
    })),
    purchaseApprovals: purchaseApprovals.map((a) => ({
      id: a.id,
      type: 'PURCHASE' as const,
      requestId: a.requestId,
      title: a.request.title,
      vendorName: a.vendor.name,
      totalAmount: Number(a.totalAmount),
      currency: a.currency,
      deliveryTimelineDays: a.deliveryTimelineDays,
      paymentTerms: a.paymentTerms,
      warrantyMonths: a.warrantyMonths,
      status: a.status,
      createdAt: a.createdAt,
    })),
  };
}

// ─── Decide on Requirement Approval ──────────────────────────────────────────

export async function decideRequirementApproval(
  approvalId: string,
  decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED',
  comments: string | undefined,
  approverId: string,
  tenantId: string
) {
  const approval = await prisma.requirementApprovalRequest.findFirst({
    where: { id: approvalId, tenantId },
    include: {
      decisions: { where: { assignedApproverId: approverId, status: 'PENDING' } },
    },
  });

  if (!approval) throw new NotFoundError('RequirementApprovalRequest');

  const decisionRecord = approval.decisions[0];
  if (!decisionRecord) {
    throw new ForbiddenError('You are not assigned to this approval');
  }

  if (decision === 'REJECTED' || decision === 'CHANGES_REQUESTED') {
    if (!comments?.trim()) {
      throw new ValidationError('Comments are required for rejection or changes requested');
    }
  }

  // Update the decision
  await prisma.requirementApprovalDecision.update({
    where: { id: decisionRecord.id },
    data: {
      status: decision,
      comments,
      decidedAt: new Date(),
      decidedById: approverId,
    },
  });

  // Update the approval request status
  await prisma.requirementApprovalRequest.update({
    where: { id: approvalId },
    data: {
      status: decision,
      approvedAt: new Date(),
      approvedById: approverId,
    },
  });

  // Update the procurement request status
  if (decision === 'APPROVED') {
    await prisma.procurementRequest.update({
      where: { id: approval.requestId },
      data: { status: 'APPROVED_FOR_SOURCING' },
    });
  } else if (decision === 'REJECTED') {
    await prisma.procurementRequest.update({
      where: { id: approval.requestId },
      data: { status: 'REJECTED' },
    });
  }

  return { success: true, decision, approvalId };
}
