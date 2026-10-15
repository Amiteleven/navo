import { z } from 'zod';
import { Router } from '../../utils/router';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate.js';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  getRequirementWithNavoStatus,
  getActiveRequirementsForUser,
  getVendorOffersForRequirement,
  runCommercialEvaluation,
  getPendingApprovalsForUser,
  decideRequirementApproval,
} from './navo.service';

import type { Response } from 'express';

const router = Router();

router.use(authenticate);

const limitOffsetSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().positive().max(100).default(20),
    offset: z.coerce.number().int().nonnegative().default(0),
  }),
});

const requestIdParam = z.object({
  params: z.object({ requestId: z.string().min(1, 'Request ID is required') }),
});

const decisionSchema = z.object({
  body: z.object({
    decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
    comments: z.string().max(2000).optional(),
  }),
});

// ─── Requirement lifecycle ────────────────────────────────────────────────────

/** List all active requirements for the authenticated buyer */
router.get(
  '/requirements',
  validate(limitOffsetSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset);
    const data = await getActiveRequirementsForUser(
      req.user!.userId,
      req.user!.tenantId,
      limit,
      offset
    );
    res.json({ success: true, data });
  },
);

/** Get a single requirement with its full NAVO workflow status */
router.get(
  '/requirements/:requestId',
  validate(requestIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const data = await getRequirementWithNavoStatus(
      req.params.requestId,
      req.user!.userId,
      req.user!.tenantId
    );
    res.json({ success: true, data });
  },
);

/** Get all vendor offers for a requirement (buyer view) */
router.get(
  '/requirements/:requestId/offers',
  validate(requestIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const data = await getVendorOffersForRequirement(
      req.params.requestId,
      req.user!.userId,
      req.user!.tenantId
    );
    res.json({ success: true, data });
  },
);

/** Run commercial evaluation — returns recommendation + negotiation advice */
router.get(
  '/requirements/:requestId/commercial-eval',
  validate(requestIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const data = await runCommercialEvaluation(
      req.params.requestId,
      req.user!.userId,
      req.user!.tenantId
    );
    res.json({ success: true, data });
  },
);

// ─── Approvals ───────────────────────────────────────────────────────────────

/** Get all pending approvals assigned to the authenticated user */
router.get(
  '/approvals/pending',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const data = await getPendingApprovalsForUser(req.user!.userId, req.user!.tenantId);
    res.json({ success: true, data });
  },
);

/** Decide on a requirement approval (first approval / department head) */
router.post(
  '/approvals/requirement/:approvalId/decide',
  validate(
    z.object({
      params: z.object({ approvalId: z.string().min(1, 'Approval ID is required') }),
      body: decisionSchema.shape.body,
    })
  ),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { decision, comments } = req.body;
    const data = await decideRequirementApproval(
      req.params.approvalId,
      decision,
      comments,
      req.user!.userId,
      req.user!.tenantId
    );
    res.json({ success: true, data });
  },
);

export default router;
