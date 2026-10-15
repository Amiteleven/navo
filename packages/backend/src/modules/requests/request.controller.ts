import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createRequest,
  getRequest,
  listRequests,
  updateRequest,
  submitRequest,
  extractAndUpdateRequirements,
  updateRequestStatus,
  deleteRequest,
  getRequestStats,
  CreateRequestInput,
  UpdateRequestInput,
} from './request.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { RequestStatus } from '@navo/shared';

const createRequestSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200),
    description: z.string().min(10),
    categoryId: idSchema.optional(),
    item: z.string().min(1),
    quantity: z.number().int().positive(),
    unit: z.string().optional(),
    location: z.string().min(1),
    requiredDate: z.string().datetime(),
    specifications: z.string().optional(),
    estimatedBudget: z.number().positive().optional(),
    priority: z.number().int().min(1).max(5).default(1),
  }),
});

const updateRequestSchema = z.object({
  params: z.object({ requestId: idSchema }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(10).optional(),
    categoryId: idSchema.optional(),
    item: z.string().min(1).optional(),
    quantity: z.number().int().positive().optional(),
    unit: z.string().optional(),
    location: z.string().min(1).optional(),
    requiredDate: z.string().datetime().optional(),
    specifications: z.string().optional(),
    estimatedBudget: z.number().positive().optional(),
    priority: z.number().int().min(1).max(5).optional(),
  }),
});

const requestIdSchema = z.object({
  params: z.object({ requestId: idSchema }),
});

const listRequestsSchema = z.object({
  query: z.object({
    status: z.nativeEnum(RequestStatus).optional(),
    requesterId: idSchema.optional(),
    assigneeId: idSchema.optional(),
    categoryId: idSchema.optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    sortBy: z.string().default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

const updateStatusSchema = z.object({
  params: z.object({ requestId: idSchema }),
  body: z.object({
    status: z.nativeEnum(RequestStatus),
  }),
});

export const createRequestHandler = [
  validate(createRequestSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateRequestInput = req.body;
    const request = await createRequest(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: request });
  },
];

export const getRequestHandler = [
  validate(requestIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const request = await getRequest(req.params.requestId, req.user!.tenantId);
    res.json({ success: true, data: request });
  },
];

export const listRequestsHandler = [
  validate(listRequestsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await listRequests(req.user!.tenantId, req.query as Record<string, string>);
    res.json({ success: true, data: result });
  },
];

export const updateRequestHandler = [
  validate(updateRequestSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: UpdateRequestInput = req.body;
    const request = await updateRequest(req.params.requestId, req.user!.tenantId, input, req.user!.userId);
    res.json({ success: true, data: request });
  },
];

export const submitRequestHandler = [
  validate(requestIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const request = await submitRequest(req.params.requestId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: request });
  },
];

export const extractRequirementsHandler = [
  validate(requestIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await extractAndUpdateRequirements(req.params.requestId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: result });
  },
];

export const updateRequestStatusHandler = [
  validate(updateStatusSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { status } = req.body;
    const request = await updateRequestStatus(req.params.requestId, req.user!.tenantId, status, req.user!.userId);
    res.json({ success: true, data: request });
  },
];

export const deleteRequestHandler = [
  validate(requestIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await deleteRequest(req.params.requestId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, message: 'Request deleted' });
  },
];

export const getRequestStatsHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const stats = await getRequestStats(req.user!.tenantId);
  res.json({ success: true, data: stats });
};