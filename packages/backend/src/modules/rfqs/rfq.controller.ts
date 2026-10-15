import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createRFQ,
  getRFQ,
  listRFQs,
  sendRFQ,
  closeRFQ,
  getRFQVendors,
  CreateRFQInput,
} from './rfq.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { RFQStatus } from '@navo/shared';

const createRFQSchema = z.object({
  body: z.object({
    requestId: idSchema,
    title: z.string().min(1, 'Title is required'),
    description: z.string().min(10, 'Description must be at least 10 characters'),
    quantity: z.number().int().positive(),
    specifications: z.string().optional(),
    deliveryLocation: z.string().min(1, 'Delivery location is required'),
    requiredDeliveryDate: z.string().datetime(),
    submissionDeadline: z.string().datetime(),
    vendorIds: z.array(idSchema).min(1, 'At least one vendor required'),
  }),
});

const rfqIdSchema = z.object({
  params: z.object({ rfqId: idSchema }),
});

const listRFQsSchema = z.object({
  query: z.object({
    status: z.nativeEnum(RFQStatus).optional(),
    requestId: idSchema.optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const createRFQHandler = [
  validate(createRFQSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateRFQInput = req.body;
    const rfq = await createRFQ(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: rfq });
  },
];

export const getRFQHandler = [
  validate(rfqIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rfq = await getRFQ(req.params.rfqId, req.user!.tenantId);
    res.json({ success: true, data: rfq });
  },
];

export const listRFQsHandler = [
  validate(listRFQsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await listRFQs(req.user!.tenantId, req.query as Record<string, string>);
    res.json({ success: true, data: result });
  },
];

export const sendRFQHandler = [
  validate(rfqIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rfq = await sendRFQ(req.params.rfqId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: rfq });
  },
];

export const closeRFQHandler = [
  validate(rfqIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rfq = await closeRFQ(req.params.rfqId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: rfq });
  },
];

export const getRFQVendorsHandler = [
  validate(rfqIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const vendors = await getRFQVendors(req.params.rfqId, req.user!.tenantId);
    res.json({ success: true, data: vendors });
  },
];