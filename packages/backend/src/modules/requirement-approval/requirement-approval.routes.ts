import { Router } from '../../utils/router';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate.js';
import { z } from 'zod';
import * as controller from './requirement-approval.controller.js';

/**
 * First approval checkpoint routes.
 *
 * Uses the shared Router wrapper so async rejections reach the error
 * middleware, and validates every route parameter and decision body
 * before the controller runs. Decisions are additionally guarded inside
 * the service (role, level, assignment, segregation of duties).
 */

export const requirementApprovalRoutes = Router();

requirementApprovalRoutes.use(authenticate);

const approvalIdParam = z.object({ params: z.object({ approvalId: z.string().min(1) }) });
const requestIdParam = z.object({ params: z.object({ requestId: z.string().min(1) }) });

const submitSchema = z.object({
  body: z.object({
    requestId: z.string().min(1),
    requesterComment: z.string().max(4000).optional(),
  }),
});

const decideSchema = z.object({
  params: z.object({ approvalId: z.string().min(1) }),
  body: z.object({
    decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
    comments: z.string().max(4000).optional(),
  }),
});

requirementApprovalRoutes.post('/submit', validate(submitSchema), controller.submitForApproval);

requirementApprovalRoutes.post(
  '/:approvalId/decide',
  validate(decideSchema),
  controller.decide
);

requirementApprovalRoutes.get('/pending', controller.listPending);

requirementApprovalRoutes.get(
  '/request/:requestId/status',
  validate(requestIdParam),
  controller.getStatus
);

requirementApprovalRoutes.get(
  '/request/:requestId/preview',
  validate(requestIdParam),
  controller.previewRoute
);
