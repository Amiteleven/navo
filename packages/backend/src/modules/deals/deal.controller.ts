import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createConnection,
  getConnection,
  listConnections,
  respondToConnection,
  createOffer,
  getDealRoom,
  getMessages,
  addMessage,
  acceptOffer,
  updateDealStatus,
  getDeal,
  listDeals,
  getVendorAvailability,
  updateVendorAvailability,
  getOnlineVendors,
  calculateOfferTotal,
  CreateConnectionInput,
  CreateOfferInput,
} from './deal.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { UserRole } from '@navo/shared';

const createConnectionSchema = z.object({
  requestId: idSchema,
  vendorId: idSchema,
});

const respondToConnectionSchema = z.object({
  accept: z.boolean(),
});

const createOfferSchema = z.object({
  dealRoomId: idSchema,
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
});

const addMessageSchema = z.object({
  content: z.string().min(1, 'Message cannot be empty'),
});

const acceptOfferSchema = z.object({
  offerId: idSchema,
});

const updateVendorAvailabilitySchema = z.object({
  isOnline: z.boolean(),
  isBusy: z.boolean(),
});

const updateDealStatusSchema = z.object({
  status: z.enum(['ACCEPTED', 'ORDERED', 'DELIVERED', 'COMPLETED', 'CANCELLED']),
});

export const createConnectionHandler = [
  validate(createConnectionSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateConnectionInput = req.body;
    const connection = await createConnection(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: connection });
  },
];

export const getConnectionHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { connectionId } = req.params;
  const connection = await getConnection(connectionId, req.user!.tenantId);
  res.json({ success: true, data: connection });
};

export const listConnectionsHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { status, requestId, vendorId, page, limit } = req.query;
  const filters: Record<string, unknown> = {};
  if (status) filters.status = status;
  if (requestId) filters.requestId = requestId;
  if (vendorId) filters.vendorId = vendorId;
  if (page) filters.page = parseInt(page as string, 10);
  if (limit) filters.limit = parseInt(limit as string, 10);

  const result = await listConnections(req.user!.tenantId, req.user!.userId, req.user!.role as UserRole, filters);
  res.json({ success: true, data: result });
};

export const respondToConnectionHandler = [
  validate(respondToConnectionSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { connectionId } = req.params;
    const { accept } = req.body;
    const connection = await respondToConnection(connectionId, req.user!.userId, req.user!.tenantId, accept);
    res.json({ success: true, data: connection });
  },
];

export const createOfferHandler = [
  validate(createOfferSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateOfferInput = req.body;
    const offer = await createOffer(input, req.user!.userId, req.user!.role, req.user!.tenantId);
    res.status(201).json({ success: true, data: offer });
  },
];

export const getDealRoomHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { dealRoomId } = req.params;
  const dealRoom = await getDealRoom(dealRoomId, req.user!.tenantId);
  res.json({ success: true, data: dealRoom });
};

export const getMessagesHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { dealRoomId } = req.params;
  const messages = await getMessages(dealRoomId, req.user!.tenantId);
  res.json({ success: true, data: messages });
};

export const addMessageHandler = [
  validate(addMessageSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { dealRoomId } = req.params;
    const { content } = req.body;
    const message = await addMessage(dealRoomId, req.user!.userId, req.user!.role, content, req.user!.tenantId);
    res.status(201).json({ success: true, data: message });
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

export const updateDealStatusHandler = [
  validate(updateDealStatusSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { dealId } = req.params;
    const { status } = req.body;
    const deal = await updateDealStatus(dealId, status as any, req.user!.userId, req.user!.tenantId);
    res.json({ success: true, data: deal });
  },
];

export const getDealHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { dealId } = req.params;
  const deal = await getDeal(dealId, req.user!.tenantId);
  res.json({ success: true, data: deal });
};

export const listDealsHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { status, requestId, vendorId, page, limit } = req.query;
  const filters: Record<string, unknown> = {};
  if (status) filters.status = status;
  if (requestId) filters.requestId = requestId;
  if (vendorId) filters.vendorId = vendorId;
  if (page) filters.page = parseInt(page as string, 10);
  if (limit) filters.limit = parseInt(limit as string, 10);

  const result = await listDeals(req.user!.tenantId, req.user!.userId, req.user!.role as UserRole, filters);
  res.json({ success: true, data: result });
};

export const getVendorAvailabilityHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { vendorId } = req.params;
  const availability = await getVendorAvailability(vendorId);
  res.json({ success: true, data: availability });
};

export const updateVendorAvailabilityHandler = [
  validate(updateVendorAvailabilitySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { vendorId } = req.params;
    const { isOnline, isBusy } = req.body;
    const availability = await updateVendorAvailability(vendorId, isOnline, isBusy, req.user!.tenantId);
    res.json({ success: true, data: availability });
  },
];

export const getOnlineVendorsHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { categoryId } = req.query;
  const vendors = await getOnlineVendors(req.user!.tenantId, categoryId as string | undefined);
  res.json({ success: true, data: vendors });
};

export const calculateOfferTotalHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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
};