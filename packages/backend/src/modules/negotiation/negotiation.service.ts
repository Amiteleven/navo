import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, NegotiationStatus, DealRoomStatus, DealOfferStatus } from '@navo/shared';
import { generateNegotiationMessage } from '../../modules/ai/ai.service';
import {
  assertOfferAuthorized,
  suspendApprovalsForMaterialChange,
} from '../purchase-approvals/approval-policy.service.js';
import { Prisma } from '@prisma/client';

export interface CreateNegotiationMessageInput {
  dealRoomId: string;
  content: string;
  messageType?: string;
  targetPrice?: number;
  metadata?: Record<string, unknown>;
}

export interface SubmitCounterOfferInput {
  dealRoomId: string;
  unitPrice: number;
  quantity: number;
  gst?: number;
  freightAmount?: number;
  installationAmount?: number;
  warrantyMonths?: number;
  deliveryTimelineDays?: number;
  paymentTerms?: string;
  validityDays?: number;
  otherCharges?: number;
  otherChargesDetails?: string;
}

export interface GenerateNegotiationDraftInput {
  dealRoomId: string;
  targetPrice?: number;
  targetDeliveryDays?: number;
  buyerNotes?: string;
}

export async function getDealRoom(dealRoomId: string, tenantId: string) {
  const dealRoom = await prisma.dealRoom.findFirst({
    where: { id: dealRoomId, tenantId },
    include: {
      request: { include: { category: true } },
      vendor: true,
      buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
      messages: { orderBy: { createdAt: 'asc' } },
      offers: { 
        orderBy: { createdAt: 'desc' },
        include: { dealRoom: true },
      },
      connection: true,
      deal: true,
    },
  });

  if (!dealRoom) {
    throw new NotFoundError('Deal Room');
  }

  return dealRoom;
}

export async function addNegotiationMessage(
  input: CreateNegotiationMessageInput,
  senderId: string,
  senderRole: string,
  tenantId: string
) {
  const dealRoom = await getDealRoom(input.dealRoomId, tenantId);

  if (dealRoom.status !== DealRoomStatus.ACTIVE && dealRoom.status !== DealRoomStatus.NEGOTIATING) {
    throw new ValidationError('Cannot add messages to closed or expired deal room');
  }

  const isBuyer = dealRoom.buyerId === senderId;
  const isVendor = dealRoom.vendorId === senderId;

  if (!isBuyer && !isVendor) {
    throw new ForbiddenError('Not authorized to send messages in this deal room');
  }

  const message = await prisma.negotiationMessage.create({
    data: {
      dealRoomId: input.dealRoomId,
      senderId,
      senderRole,
      content: input.content,
      messageType: input.messageType || 'TEXT',
      metadata: (input.metadata as Prisma.JsonValue) ?? Prisma.DbNull,
      targetPrice: input.targetPrice,
      status: NegotiationStatus.ACTIVE,
      tenantId,
    },
  });

  await createAuditLog({
    userId: senderId,
    action: AuditAction.NEGOTIATION_STARTED,
    entityType: 'NegotiationMessage',
    entityId: message.id,
    tenantId,
    metadata: { dealRoomId: input.dealRoomId, messageType: input.messageType },
  });

  return message;
}

export async function getNegotiationMessages(dealRoomId: string, tenantId: string) {
  return prisma.negotiationMessage.findMany({
    where: { dealRoomId, tenantId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function submitCounterOffer(
  input: SubmitCounterOfferInput,
  submittedById: string,
  submittedByRole: string,
  tenantId: string
) {
  const dealRoom = await getDealRoom(input.dealRoomId, tenantId);

  if (dealRoom.status !== DealRoomStatus.ACTIVE && dealRoom.status !== DealRoomStatus.NEGOTIATING) {
    throw new ValidationError('Cannot submit counteroffer to closed or expired deal room');
  }

  const isBuyer = dealRoom.buyerId === submittedById;
  const isVendor = dealRoom.vendorId === submittedById;

  if (!isBuyer && !isVendor) {
    throw new ForbiddenError('Not authorized to submit offers in this deal room');
  }

  // Supersede any existing active offers
  await prisma.dealOffer.updateMany({
    where: { dealRoomId: input.dealRoomId, status: DealOfferStatus.ACTIVE },
    data: { status: DealOfferStatus.SUPERSEDED },
  });

  // An offer that was pending approval is no longer the offer being negotiated,
  // so the review is void before the new one is even created.
  await prisma.dealOffer.updateMany({
    where: { dealRoomId: input.dealRoomId, status: DealOfferStatus.PENDING_APPROVAL },
    data: { status: DealOfferStatus.SUPERSEDED },
  });

  const offer = await prisma.dealOffer.create({
    data: {
      dealRoomId: input.dealRoomId,
      submittedById,
      submittedByRole,
      unitPrice: input.unitPrice,
      quantity: input.quantity,
      gst: input.gst || 0,
      freightAmount: input.freightAmount || 0,
      installationAmount: input.installationAmount || 0,
      warrantyMonths: input.warrantyMonths,
      deliveryTimelineDays: input.deliveryTimelineDays,
      paymentTerms: input.paymentTerms,
      validityDays: input.validityDays,
      otherCharges: input.otherCharges || 0,
      otherChargesDetails: input.otherChargesDetails,
      status: DealOfferStatus.ACTIVE,
    },
  });

  await prisma.dealRoom.update({
    where: { id: input.dealRoomId },
    data: { status: DealRoomStatus.NEGOTIATING },
  });

await prisma.negotiationMessage.create({
      data: {
        dealRoomId: input.dealRoomId,
        senderId: submittedById,
        senderRole: submittedByRole,
        content: `Submitted counteroffer: ${input.unitPrice} × ${input.quantity} units = ₹${(input.unitPrice * input.quantity).toLocaleString()} base`,
        messageType: 'OFFER',
        metadata: { offerId: offer.id } as Prisma.InputJsonValue,
        tenantId,
      },
    });

  await createAuditLog({
    userId: submittedById,
    action: AuditAction.COUNTEROFFER_SUBMITTED,
    entityType: 'DealOffer',
    entityId: offer.id,
    tenantId,
    metadata: { dealRoomId: input.dealRoomId, unitPrice: input.unitPrice },
  });

  // Negotiation continues after a submission - a buyer and seller may keep
  // talking before a decision - but once terms move, any approval already given
  // no longer describes what would be bought. Those approvals are suspended
  // here, and the buyer has to submit the revised offer again.
  const suspended = await suspendApprovalsForMaterialChange({
    tenantId,
    dealRoomId: input.dealRoomId,
    offerId: offer.id,
    current: {
      unitPrice: input.unitPrice,
      quantity: input.quantity,
      paymentTerms: input.paymentTerms,
      deliveryTimelineDays: input.deliveryTimelineDays,
      warrantyMonths: input.warrantyMonths,
      otherChargesDetails: input.otherChargesDetails,
    },
    actorId: submittedById,
  });

  if (suspended.suspended.length > 0) {
    await prisma.negotiationMessage.create({
      data: {
        dealRoomId: input.dealRoomId,
        senderId: submittedById,
        senderRole: submittedByRole,
        content:
          `Revised terms supersede ${suspended.suspended.length} previous approval` +
          `${suspended.suspended.length === 1 ? '' : 's'} (${suspended.suspended
            .map((entry) => entry.reference)
            .join(', ')}). The revised offer must be submitted for approval again.`,
        messageType: 'SYSTEM',
        status: NegotiationStatus.ACTIVE,
        tenantId,
      },
    });
  }

  return offer;
}

export async function getDealRoomOffers(dealRoomId: string, tenantId: string) {
  return prisma.dealOffer.findMany({
    where: { dealRoom: { id: dealRoomId, tenantId } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function generateNegotiationDraft(
  input: GenerateNegotiationDraftInput,
  buyerId: string,
  tenantId: string
) {
  const dealRoom = await getDealRoom(input.dealRoomId, tenantId);

  if (dealRoom.buyerId !== buyerId) {
    throw new ForbiddenError('Only the buyer can generate negotiation drafts');
  }

  const currentOffer = dealRoom.offers
    .filter(o => o.status === DealOfferStatus.ACTIVE)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  if (!currentOffer) {
    throw new ValidationError('No active offer to negotiate against');
  }

  // Get negotiation history
  const messages = await getNegotiationMessages(input.dealRoomId, tenantId);

  const context = {
    currentOffer: {
      unitPrice: currentOffer.unitPrice,
      quantity: currentOffer.quantity,
      totalLandedCost: currentOffer.unitPrice * currentOffer.quantity + currentOffer.gst * (currentOffer.unitPrice * currentOffer.quantity) / 100 + currentOffer.freightAmount + currentOffer.installationAmount + currentOffer.otherCharges,
      deliveryDays: currentOffer.deliveryTimelineDays || 0,
      paymentTerms: currentOffer.paymentTerms || 'Not specified',
      warrantyMonths: currentOffer.warrantyMonths ?? undefined,
    },
    targetPrice: input.targetPrice,
    targetDeliveryDays: input.targetDeliveryDays,
    buyerNotes: input.buyerNotes,
    negotiationHistory: messages.map(m => ({
      from: (m.senderRole === 'BUYER' ? 'buyer' : 'seller') as 'buyer' | 'seller',
      message: m.content,
      timestamp: m.createdAt,
    })),
    vendorName: dealRoom.vendor.name,
  };

  const draft = await generateNegotiationMessage(context);

  return {
    ...draft,
    context: {
      currentOfferPrice: context.currentOffer.totalLandedCost,
      targetPrice: input.targetPrice || Math.round(context.currentOffer.totalLandedCost * 0.9),
    },
  };
}

/**
 * Accept an offer: close the room, create the deal, record the acceptance.
 *
 * The commercial close itself lives in `finalizeAcceptedOffer` so the purchase
 * approval service can invoke exactly the same transaction when the last
 * approval level is approved. There is one code path that turns an offer into a
 * deal, and the authorization check happens before it is reached.
 */
export async function acceptOffer(
  offerId: string,
  buyerId: string,
  tenantId: string
) {
  const offer = await prisma.dealOffer.findFirst({
    where: { id: offerId },
    include: { dealRoom: true },
  });

  if (!offer) {
    throw new NotFoundError('Offer');
  }

  if (offer.dealRoom.tenantId !== tenantId) {
    throw new ForbiddenError('Offer not found in this tenant');
  }

  const dealRoomId = offer.dealRoomId;

  if (offer.dealRoom.buyerId !== buyerId) {
    throw new ForbiddenError('Only the buyer can accept offers');
  }

  // An offer under review is already with the approvers; accepting it here would
  // finalize a purchase nobody has authorized yet. Checked before the general
  // status test so the buyer gets the reason rather than "not active".
  if (offer.status === DealOfferStatus.PENDING_APPROVAL) {
    throw new ValidationError(
      'This offer is awaiting manager approval and cannot be accepted until it is approved',
    );
  }

  if (offer.status !== DealOfferStatus.ACTIVE) {
    throw new ValidationError('Offer is not active');
  }

  await assertOfferAuthorized(tenantId, offerId);

  return finalizeAcceptedOffer(offerId, buyerId, tenantId);
}

/**
 * Create the deal for an offer that is already known to be acceptable.
 *
 * Refuses an offer that is not ACTIVE or PENDING_APPROVAL, and an offer that
 * already has a deal, so a repeated call cannot produce a second one. The
 * `dealRoomId` unique constraint on `Deal` is the backstop.
 */
export async function finalizeAcceptedOffer(
  offerId: string,
  actorId: string,
  tenantId: string
) {
  const offer = await prisma.dealOffer.findFirst({
    where: { id: offerId },
    include: { dealRoom: true },
  });
  if (!offer) throw new NotFoundError('Offer');

  if (offer.dealRoom.tenantId !== tenantId) {
    throw new ForbiddenError('Offer not found in this tenant');
  }

  const finalizable: string[] = [DealOfferStatus.ACTIVE, DealOfferStatus.PENDING_APPROVAL];
  if (!finalizable.includes(offer.status)) {
    throw new ValidationError('Offer is not available to be finalized');
  }

  const closed = await prisma.deal.findFirst({ where: { dealRoomId: offer.dealRoomId } });
  if (closed) {
    throw new ValidationError(`This negotiation already produced deal ${closed.dealNumber}`);
  }

  const dealRoomId = offer.dealRoomId;
  const dealNumber = `DEAL-${Date.now().toString(36).toUpperCase()}`;

  const result = await prisma.$transaction(async (tx) => {
    const updatedOffer = await tx.dealOffer.update({
      where: { id: offerId },
      data: { status: DealOfferStatus.ACCEPTED },
    });

    // Get deal room to access connectionId and other fields
    const dealRoom = await tx.dealRoom.findUnique({
      where: { id: dealRoomId },
      include: { connection: true },
    });

    const deal = await tx.deal.create({
      data: {
        dealNumber,
        dealRoomId,
        requestId: dealRoom!.requestId,
        buyerId: dealRoom!.buyerId,
        vendorId: dealRoom!.vendorId,
        tenantId,
        status: 'ACCEPTED',
        acceptedOfferId: offerId,
      },
    });

    await tx.dealRoom.update({
      where: { id: dealRoomId },
      data: { status: DealRoomStatus.CLOSED, dealId: deal.id, closedAt: new Date() },
    });

    await tx.connection.update({
      where: { id: dealRoom!.connectionId },
      data: { status: 'ACCEPTED' },
    });

    await tx.negotiationMessage.create({
      data: {
        dealRoomId,
        senderId: actorId,
        senderRole: 'BUYER',
        content: `Offer accepted! Deal ${dealNumber} created.`,
        messageType: 'SYSTEM',
        status: NegotiationStatus.ACCEPTED,
        tenantId,
      },
    });

    return { deal, updatedOffer };
  });

  await createAuditLog({
    userId: actorId,
    action: AuditAction.OFFER_ACCEPTED,
    entityType: 'DealOffer',
    entityId: offerId,
    tenantId,
    metadata: { dealNumber, offerId },
  });

  await createAuditLog({
    userId: actorId,
    action: AuditAction.DEAL_CLOSED,
    entityType: 'Deal',
    entityId: result.deal.id,
    tenantId,
    metadata: { dealNumber, offerId },
  });

  return result;
}

export async function updateNegotiationStatus(
  dealRoomId: string,
  status: NegotiationStatus,
  userId: string,
  tenantId: string
) {
  const dealRoom = await getDealRoom(dealRoomId, tenantId);

  if (dealRoom.buyerId !== userId && dealRoom.vendorId !== userId) {
    throw new ForbiddenError('Not authorized');
  }

  return prisma.dealRoom.update({
    where: { id: dealRoomId },
    data: { status: status as any },
  });
}

export async function calculateOfferTotal(offer: {
  unitPrice: number;
  quantity: number;
  gst?: number;
  freightAmount?: number;
  installationAmount?: number;
  otherCharges?: number;
}) {
  const basePrice = offer.unitPrice * offer.quantity;
  const gstAmount = basePrice * ((offer.gst || 0) / 100);
  const total = basePrice + gstAmount + (offer.freightAmount || 0) + (offer.installationAmount || 0) + (offer.otherCharges || 0);

  return {
    basePrice,
    gstAmount,
    freightAmount: offer.freightAmount || 0,
    installationAmount: offer.installationAmount || 0,
    otherCharges: offer.otherCharges || 0,
    totalLandedCost: total,
  };
}

export type NegotiationRecommendation = 'NEGOTIATE' | 'ACCEPT_AS_IS' | 'OVER_BUDGET';

export interface NegotiationWorthinessResult {
  dealRoomId: string;
  vendorId: string;
  worthinessScore: number;
  recommendation: NegotiationRecommendation;
  reasoning: string;
  factors: {
    budgetFit: { score: number; weight: number; budget: number | null; offerTotal: number; savingsAmount: number | null; savingsPercent: number | null };
    deliveryFit: { score: number; weight: number; deliveryTimelineDays: number | null; daysRemaining: number | null };
    warranty: { score: number; weight: number; warrantyMonths: number | null };
    paymentTerms: { score: number; weight: number; paymentTerms: string | null };
    vendorTrackRecord: { score: number; weight: number; completedDeals: number };
    competitiveLeverage: { score: number; weight: number; activeOffers: number };
  };
  analyzedAt: string;
}

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

/**
 * Assess whether a negotiation is worth pursuing before the
 * buyer invests time in it.
 *
 * Deliberately deterministic: the score is a weighted blend of
 * budget fit, delivery fit, warranty, payment terms, the vendor's
 * track record and the buyer's competitive leverage. An LLM would
 * only restate these numbers, so the recommendation is stable,
 * auditable and free of the reliability concerns that affect
 * generative paths.
 */
export async function assessNegotiationWorthiness(
  dealRoomId: string,
  tenantId: string,
  userId: string
): Promise<NegotiationWorthinessResult> {
  const dealRoom = await getDealRoom(dealRoomId, tenantId);

  if (dealRoom.buyerId !== userId) {
    throw new ForbiddenError('Only the buyer can assess negotiation worthiness');
  }

  const request = dealRoom.request;
  const budget = request.estimatedBudget ? Number(request.estimatedBudget) : null;
  const requiredDate = request.requiredDate ? new Date(request.requiredDate) : null;

  const activeOffers = dealRoom.offers.filter((o) => o.status === 'ACTIVE');
  const latestOffer = activeOffers[0] ?? null;

  // Budget fit (35%): how far the best current offer lands from
  // the estimated budget.
  let budgetScore = 60;
  let offerTotal = 0;
  let savingsAmount: number | null = null;
  let savingsPercent: number | null = null;
  if (latestOffer) {
    const totals = await calculateOfferTotal(latestOffer);
    offerTotal = totals.totalLandedCost;
    if (budget !== null && budget > 0) {
      savingsAmount = budget - offerTotal;
      savingsPercent = (savingsAmount / budget) * 100;
      budgetScore = clamp(50 + savingsPercent * 2);
    }
  } else {
    budgetScore = 30;
  }

  // Delivery fit (20%): can the vendor deliver before the
  // requirement's required date?
  let deliveryScore = 60;
  let daysRemaining: number | null = null;
  const timelineDays = latestOffer?.deliveryTimelineDays ?? null;
  if (timelineDays !== null && requiredDate) {
    daysRemaining = Math.ceil((requiredDate.getTime() - Date.now()) / 86400000);
    if (timelineDays <= daysRemaining) {
      const slack = daysRemaining - timelineDays;
      deliveryScore = clamp(80 + slack * 2);
    } else {
      deliveryScore = clamp(40 - (timelineDays - daysRemaining) * 2);
    }
  } else if (timelineDays === null) {
    deliveryScore = 40;
  }

  // Warranty (10%)
  const warrantyMonths = latestOffer?.warrantyMonths ?? null;
  let warrantyScore = 40;
  if (warrantyMonths !== null) {
    warrantyScore =
      warrantyMonths >= 24 ? 100 : warrantyMonths >= 12 ? 80 : warrantyMonths >= 6 ? 60 : 30;
  }

  // Payment terms (10%): longer credit and no prepayment are
  // favorable for the buyer's cash position.
  const paymentTerms = latestOffer?.paymentTerms ?? null;
  let paymentScore = 60;
  if (paymentTerms) {
    const terms = paymentTerms.toLowerCase();
    if (terms.includes('advance') || terms.includes('prepaid') || terms.includes('upfront')) {
      paymentScore = 30;
    } else if (terms.includes('net90') || terms.includes('90 days') || terms.includes('net 90')) {
      paymentScore = 95;
    } else if (terms.includes('net60') || terms.includes('60 days') || terms.includes('net 60')) {
      paymentScore = 85;
    } else if (terms.includes('net30') || terms.includes('30 days') || terms.includes('net 30')) {
      paymentScore = 70;
    }
  }

  // Vendor track record (15%): completed deals with this vendor
  // in this tenant.
  const completedDeals = await prisma.deal.count({
    where: {
      tenantId,
      vendorId: dealRoom.vendorId,
      executionStatus: { not: 'PENDING_EXECUTION' },
    },
  });
  const trackRecordScore =
    completedDeals === 0 ? 50 : completedDeals <= 2 ? 65 : completedDeals <= 5 ? 80 : 90;

  // Competitive leverage (10%): the more comparable offers the
  // buyer holds, the stronger their position.
  const leverageScore =
    activeOffers.length === 0 ? 20 : activeOffers.length === 1 ? 40 : activeOffers.length === 2 ? 65 : activeOffers.length === 3 ? 85 : 100;

  const worthinessScore = Math.round(
    budgetScore * 0.35 +
      deliveryScore * 0.2 +
      warrantyScore * 0.1 +
      paymentScore * 0.1 +
      trackRecordScore * 0.15 +
      leverageScore * 0.1
  );

  let recommendation: NegotiationRecommendation;
  let reasoning: string;
  if (budget !== null && latestOffer && offerTotal > budget) {
    recommendation = 'OVER_BUDGET';
    reasoning = `Latest offer lands ${(offerTotal - budget).toLocaleString()} above the estimated budget of ${budget.toLocaleString()}. Do not negotiate on these terms; send the requirement back for revision or re-sourcing.`;
  } else if (budget !== null && savingsPercent !== null && savingsPercent >= 10) {
    recommendation = 'ACCEPT_AS_IS';
    reasoning = `Latest offer is already ${savingsPercent.toFixed(1)}% under budget (${savingsAmount!.toLocaleString()} savings). Value is strong; accept, or negotiate only on secondary terms such as delivery or warranty.`;
  } else {
    recommendation = 'NEGOTIATE';
    reasoning = budget !== null && savingsPercent !== null
      ? `Latest offer is only ${savingsPercent.toFixed(1)}% under budget. There is headroom to improve price, payment terms or delivery before accepting.`
      : 'No comparable offer terms against a budget yet. Negotiate to establish price, delivery and payment baselines before committing.';
  }

  return {
    dealRoomId,
    vendorId: dealRoom.vendorId,
    worthinessScore,
    recommendation,
    reasoning,
    factors: {
      budgetFit: { score: Math.round(budgetScore), weight: 0.35, budget, offerTotal, savingsAmount, savingsPercent },
      deliveryFit: { score: Math.round(deliveryScore), weight: 0.2, deliveryTimelineDays: timelineDays, daysRemaining },
      warranty: { score: warrantyScore, weight: 0.1, warrantyMonths },
      paymentTerms: { score: paymentScore, weight: 0.1, paymentTerms },
      vendorTrackRecord: { score: trackRecordScore, weight: 0.15, completedDeals },
      competitiveLeverage: { score: leverageScore, weight: 0.1, activeOffers: activeOffers.length },
    },
    analyzedAt: new Date().toISOString(),
  };
}