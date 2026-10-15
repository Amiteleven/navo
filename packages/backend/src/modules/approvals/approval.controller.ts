import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createApproval,
  getApproval,
  listApprovals,
  decideApproval,
  generateApprovalRecommendation,
  getRecommendation,
  CreateApprovalInput,
  DecideApprovalInput,
} from './approval.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { ApprovalStatus } from '@navo/shared';

const createApprovalSchema = z.object({
  body: z.object({
    requestId: idSchema,
    approverId: idSchema,
  }),
});

const approvalIdSchema = z.object({
  params: z.object({ approvalId: idSchema }),
});

const requestIdSchema = z.object({
  params: z.object({ requestId: idSchema }),
});

const listApprovalsSchema = z.object({
  query: z.object({
    status: z.nativeEnum(ApprovalStatus).optional(),
    approverId: idSchema.optional(),
    requestId: idSchema.optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

const decideApprovalSchema = z.object({
  params: z.object({ approvalId: idSchema }),
  body: z.object({
    status: z.nativeEnum(ApprovalStatus),
    comments: z.string().optional(),
  }),
});

export const createApprovalHandler = [
  validate(createApprovalSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateApprovalInput = req.body;
    const approval = await createApproval(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: approval });
  },
];

export const getApprovalHandler = [
  validate(approvalIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const approval = await getApproval(req.params.approvalId, req.user!.tenantId);
    res.json({ success: true, data: approval });
  },
];

export const listApprovalsHandler = [
  validate(listApprovalsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await listApprovals(req.user!.tenantId, req.query as Record<string, string>);
    res.json({ success: true, data: result });
  },
];

export const decideApprovalHandler = [
  validate(decideApprovalSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: DecideApprovalInput = req.body;
    const approval = await decideApproval(req.params.approvalId, req.user!.tenantId, input, req.user!.userId);
    res.json({ success: true, data: approval });
  },
];

export const generateRecommendationHandler = [
  validate(requestIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const recommendation = await generateApprovalRecommendation(req.params.requestId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: recommendation });
  },
];

export const getRecommendationHandler = [
  validate(requestIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const recommendation = await getRecommendation(req.params.requestId, req.user!.tenantId);
    res.json({ success: true, data: recommendation });
  },
];