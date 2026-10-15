import { Response } from 'express';
import { z } from 'zod';
import { DealExecutionStatus } from '@navo/shared';
import { advanceExecutionSchema, recordExecutionEventSchema } from '@navo/shared';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { ValidationError } from '../../utils/errors.js';
import { ApprovalActor } from '../purchase-approvals/approval-roles.js';
import {
  advanceExecutionStatus,
  createExecutionRecord,
  getDealExecutionDetail,
  listDealExecutions,
  recordExecutionEvent,
  selectFinalOffer,
  submitForFinalApproval,
} from './deal-execution.service.js';

function actorOf(req: AuthenticatedRequest): ApprovalActor {
  const user = req.user;
  if (!user) throw new ValidationError('Authentication required');
  return { userId: user.userId, tenantId: user.tenantId, role: user.role };
}

const submissionParams = z.object({ submissionId: z.string().min(1) });
const dealParams = z.object({ dealId: z.string().min(1) });

// ── Final offer selection & approval submission ──────────────────────────────

export const selectFinalOfferHandler = [
  validate(z.object({ params: submissionParams })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await selectFinalOffer(actorOf(req), req.params.submissionId);
    res.json({ success: true, data: result });
  },
];

export const submitForFinalApprovalHandler = [
  validate(
    z.object({
      params: submissionParams,
      body: z.object({
        requesterComment: z.string().trim().max(2000).optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await submitForFinalApproval(actorOf(req), {
      submissionId: req.params.submissionId,
      requesterComment: req.body.requesterComment,
    });
    res.json({ success: true, data: result });
  },
];

// ── Execution phase ───────────────────────────────────────────────────────────

export const advanceExecutionHandler = [
  validate(z.object({ params: dealParams, body: advanceExecutionSchema }) as never),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await advanceExecutionStatus(actorOf(req), req.params.dealId, {
      status: req.body.status as DealExecutionStatus,
      cancellationReason: req.body.cancellationReason,
    });
    res.json({ success: true, data: result });
  },
];

export const recordExecutionEventHandler = [
  validate(z.object({ params: dealParams, body: recordExecutionEventSchema }) as never),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await recordExecutionEvent(actorOf(req), req.params.dealId, {
      type: req.body.type as never,
      description: req.body.description,
      metadata: req.body.metadata,
    });
    res.json({ success: true, data: result });
  },
];

export const createExecutionRecordHandler = [
  validate(
    z.object({
      params: dealParams,
      body: z.object({
        type: z.enum(['purchase_order', 'service_commencement', 'subscription_registration', 'milestone']),
        deliveryAddress: z.string().optional(),
        expectedDeliveryDate: z.string().optional(),
        paymentTerms: z.string().optional(),
        warrantyMonths: z.number().int().positive().optional(),
        notes: z.string().optional(),
        milestoneName: z.string().optional(),
        milestoneIndex: z.number().int().positive().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        description: z.string().optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await createExecutionRecord(actorOf(req), req.params.dealId, req.body);
    res.json({ success: true, data: result });
  },
];

export const getDealExecutionDetailHandler = [
  validate(z.object({ params: dealParams })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await getDealExecutionDetail(actorOf(req), req.params.dealId);
    res.json({ success: true, data: result });
  },
];

export const listDealExecutionsHandler = [
  validate(
    z.object({
      query: z.object({
        status: z
          .enum(['PENDING_EXECUTION', 'SUPPLIER_CONFIRMED', 'IN_PROGRESS', 'FULFILLED', 'CLOSED', 'CANCELLED'])
          .optional(),
        requestId: z.string().min(1).optional(),
        vendorId: z.string().min(1).optional(),
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().positive().max(50).default(20),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await listDealExecutions(actorOf(req), {
      status: req.query.status as DealExecutionStatus | undefined,
      requestId: req.query.requestId as string | undefined,
      vendorId: req.query.vendorId as string | undefined,
      page: Number(req.query.page),
      limit: Number(req.query.limit),
    });
    res.json({ success: true, data: result });
  },
];
