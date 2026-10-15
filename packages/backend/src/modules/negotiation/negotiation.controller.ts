import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  getDealRoom,
  addNegotiationMessage,
  getNegotiationMessages,
  submitCounterOffer,
  getDealRoomOffers,
  generateNegotiationDraft,
  acceptOffer,
  updateNegotiationStatus,
  calculateOfferTotal,
  assessNegotiationWorthiness,
  CreateNegotiationMessageInput,
  SubmitCounterOfferInput,
  GenerateNegotiationDraftInput,
} from './negotiation.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { NegotiationStatus, DealOfferStatus } from '@navo/shared';

const updateDealRoomStatusSchema = z.object({
  params: z.object({ dealRoomId: z.string().min(1, 'Deal room ID is required') }),
  body: z.object({
    status: z.nativeEnum(NegotiationStatus),
  }),
});

const addMessageSchema = z.object({
  params: z.object({ dealRoomId: z.string().min(1, 'Deal room ID is required') }),
  body: z.object({
    content: z.string().min(1, 'Message cannot be empty'),
    messageType: z.string().optional(),
    targetPrice: z.number().optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
});

const counterOfferSchema = z.object({
  params: z.object({ dealRoomId: z.string().min(1, 'Deal room ID is required') }),
  body: z.object({
    unitPrice: z.number().positive('Unit price must be positive'),
    quantity: z.number().int().positive('Quantity must be positive'),
    gst: z.number().min(0).max(100).default(0),
    freightAmount: z.number().min(0).default(0),
    installationAmount: z.number().min(0).default(0),
    warrantyMonths: z.number().int().positive().optional(),
    deliveryTimelineDays: z.number().int().positive().optional(),
    paymentTerms: z.string().optional(),
    validityDays: z.number().int().positive().optional(),
    otherCharges: z.number().min(0).default(0),
    otherChargesDetails: z.string().optional(),
  }),
});

const negotiationDraftSchema = z.object({
  params: z.object({ dealRoomId: z.string().min(1, 'Deal room ID is required') }),
  body: z.object({
    targetPrice: z.number().optional(),
    targetDeliveryDays: z.number().int().positive().optional(),
    buyerNotes: z.string().optional(),
  }),
});

const acceptOfferSchema = z.object({
  body: z.object({
    offerId: z.string().min(1, 'Offer ID is required'),
  }),
});

const calculateTotalSchema = z.object({
  query: z.object({
    unitPrice: z.coerce.number().positive(),
    quantity: z.coerce.number().int().positive(),
    gst: z.coerce.number().min(0).max(100).default(0),
    freightAmount: z.coerce.number().min(0).default(0),
    installationAmount: z.coerce.number().min(0).default(0),
    otherCharges: z.coerce.number().min(0).default(0),
  }),
});

const worthinessParamSchema = z.object({
  params: z.object({ dealRoomId: z.string().min(1, 'Deal room ID is required') }),
});

export const getDealRoomHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { dealRoomId } = req.params;
  const dealRoom = await getDealRoom(dealRoomId, req.user!.tenantId);
  res.json({ success: true, data: dealRoom });
};

export const addNegotiationMessageHandler = [
  validate(addMessageSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateNegotiationMessageInput = { ...req.body, dealRoomId: req.params.dealRoomId };
    const message = await addNegotiationMessage(input, req.user!.userId, req.user!.role, req.user!.tenantId);
    res.status(201).json({ success: true, data: message });
  },
];

export const getNegotiationMessagesHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { dealRoomId } = req.params;
  const messages = await getNegotiationMessages(dealRoomId, req.user!.tenantId);
  res.json({ success: true, data: messages });
};

export const submitCounterOfferHandler = [
  validate(counterOfferSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: SubmitCounterOfferInput = { ...req.body, dealRoomId: req.params.dealRoomId };
    const offer = await submitCounterOffer(input, req.user!.userId, req.user!.role, req.user!.tenantId);
    res.status(201).json({ success: true, data: offer });
  },
];

export const getDealRoomOffersHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { dealRoomId } = req.params;
  const offers = await getDealRoomOffers(dealRoomId, req.user!.tenantId);
  res.json({ success: true, data: offers });
};

export const generateNegotiationDraftHandler = [
  validate(negotiationDraftSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: GenerateNegotiationDraftInput = { ...req.body, dealRoomId: req.params.dealRoomId };
    const draft = await generateNegotiationDraft(input, req.user!.userId, req.user!.tenantId);
    res.json({ success: true, data: draft });
  },
];

export const acceptOfferHandler = [
  validate(acceptOfferSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { offerId } = req.body;
    const result = await acceptOffer(offerId, req.user!.userId, req.user!.tenantId);
    res.json({ success: true, data: result });
  },
];

export const updateNegotiationStatusHandler = [
  validate(updateDealRoomStatusSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { dealRoomId } = req.params;
    const { status } = req.body;
    const dealRoom = await updateNegotiationStatus(dealRoomId, status, req.user!.userId, req.user!.tenantId);
    res.json({ success: true, data: dealRoom });
  },
];

export const calculateOfferTotalHandler = [
  validate(calculateTotalSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { unitPrice, quantity, gst, freightAmount, installationAmount, otherCharges } = req.query;
    const offer = {
      unitPrice: parseFloat(unitPrice as string),
      quantity: parseInt(quantity as string, 10),
      gst: parseFloat(gst as string) || 0,
      freightAmount: parseFloat(freightAmount as string) || 0,
      installationAmount: parseFloat(installationAmount as string) || 0,
      otherCharges: parseFloat(otherCharges as string) || 0,
    };
    const total = await calculateOfferTotal(offer);
    res.json({ success: true, data: total });
  },
];

/**
 * Worthiness assessment for a negotiation room. Buyer-only:
 * the service enforces that the caller owns the room.
 */
export const getNegotiationWorthinessHandler = [
  validate(worthinessParamSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { dealRoomId } = req.params;
    const result = await assessNegotiationWorthiness(dealRoomId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: result });
  },
];