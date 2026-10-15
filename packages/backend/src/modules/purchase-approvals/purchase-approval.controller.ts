import { Response } from 'express';
import { z } from 'zod';
import { PurchaseApprovalStatus } from '@navo/shared';
import {
  cancelPurchaseApprovalSchema,
  confirmPurchaseSchema,
  decidePurchaseApprovalSchema,
  listPurchaseApprovalsQuerySchema,
  reassignPurchaseApprovalSchema,
  submitPurchaseApprovalSchema,
  upsertApprovalPolicySchema,
  upsertApprovalRuleSchema,
} from '@navo/shared';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { ValidationError } from '../../utils/errors.js';
import { ApprovalActor } from './approval-roles.js';
import {
  cancelPurchaseApproval,
  confirmPurchase,
  decidePurchaseApproval,
  getApprovalHistoryForRequest,
  getApprovalOverview,
  getPurchaseApproval,
  listPurchaseApprovals,
  previewApprovalRoute,
  reassignApproval,
  submitPurchaseApproval,
} from './purchase-approval.service.js';
import { deleteRule, getPolicy, upsertPolicy, upsertRule } from './approval-policy.service.js';

/**
 * HTTP surface for manager approval and purchase authorization.
 *
 * Every handler re-derives the actor from the verified token rather than from the
 * request body, so a caller cannot act as another user by naming them. The role
 * checks live in the services, where they apply to the non-HTTP callers too -
 * the routes decide *which* service call is reachable, the services decide who
 * may make it.
 */

/** The acting user, rebuilt from the token. Never taken from the payload. */
function actorOf(req: AuthenticatedRequest): ApprovalActor {
  const user = req.user;
  if (!user) throw new ValidationError('Authentication required');
  return { userId: user.userId, tenantId: user.tenantId, role: user.role };
}

const approvalIdParams = z.object({ approvalId: z.string().min(1) });
const decisionIdParams = z.object({ decisionId: z.string().min(1) });
const ruleIdParams = z.object({ ruleId: z.string().min(1) });
const offerIdParams = z.object({ offerId: z.string().min(1) });
const requestIdParams = z.object({ requestId: z.string().min(1) });

// ── Policy configuration ─────────────────────────────────────────────────────

export const getPolicyHandler = [
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const policy = await getPolicy(actorOf(req).tenantId);
    res.json({ success: true, data: policy });
  },
];

export const upsertPolicyHandler = [
  validate(z.object({ body: upsertApprovalPolicySchema })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const policy = await upsertPolicy(actorOf(req).tenantId, req.body, actorOf(req));
    res.json({ success: true, data: policy });
  },
];

export const upsertRuleHandler = [
  validate(z.object({ params: ruleIdParams, body: upsertApprovalRuleSchema })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rule = await upsertRule(actorOf(req).tenantId, req.params.ruleId, req.body, actorOf(req));
    res.json({ success: true, data: rule });
  },
];

export const deleteRuleHandler = [
  validate(z.object({ params: ruleIdParams })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await deleteRule(actorOf(req).tenantId, req.params.ruleId, actorOf(req));
    res.json({ success: true, data: null });
  },
];

// ── Pre-submission explanation ────────────────────────────────────────────────

export const previewRouteHandler = [
  validate(z.object({ params: offerIdParams })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const route = await previewApprovalRoute(req.params.offerId, actorOf(req));
    res.json({ success: true, data: route });
  },
];

// ── Submission ────────────────────────────────────────────────────────────────

export const submitHandler = [
  validate(z.object({ body: submitPurchaseApprovalSchema })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await submitPurchaseApproval(actorOf(req), req.body);
    res.status(201).json({ success: true, data: result });
  },
];

// ── Inbox and detail ──────────────────────────────────────────────────────────

export const listHandler = [
  validate(z.object({ query: listPurchaseApprovalsQuerySchema })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const query = req.query as unknown as z.infer<typeof listPurchaseApprovalsQuerySchema>;
    const result = await listPurchaseApprovals(actorOf(req), {
      scope: query.scope,
      status: query.status as PurchaseApprovalStatus | undefined,
      requesterId: query.requesterId,
      vendorId: query.vendorId,
      department: query.department,
      minAmount: query.minAmount,
      maxAmount: query.maxAmount,
      from: query.from,
      to: query.to,
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
    res.json({ success: true, data: result });
  },
];

export const getHandler = [
  validate(z.object({ params: approvalIdParams })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const approval = await getPurchaseApproval(req.params.approvalId, actorOf(req));
    res.json({ success: true, data: approval });
  },
];

// ── Decisions ─────────────────────────────────────────────────────────────────

export const decideHandler = [
  validate(z.object({ params: decisionIdParams, body: decidePurchaseApprovalSchema })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const approval = await decidePurchaseApproval(
      req.params.decisionId,
      actorOf(req),
      req.body,
    );
    res.json({ success: true, data: approval });
  },
];

export const reassignHandler = [
  validate(z.object({ params: decisionIdParams, body: reassignPurchaseApprovalSchema })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const decision = await reassignApproval(req.params.decisionId, actorOf(req), req.body);
    res.json({ success: true, data: decision });
  },
];

export const cancelHandler = [
  validate(z.object({ params: approvalIdParams, body: cancelPurchaseApprovalSchema })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const approval = await cancelPurchaseApproval(req.params.approvalId, actorOf(req), req.body);
    res.json({ success: true, data: approval });
  },
];

export const confirmHandler = [
  // The body is intentionally required: confirmation is an assertion that the
  // order matches the approved terms, and a client that sends nothing has not
  // made that assertion.
  validate(z.object({ params: approvalIdParams, body: confirmPurchaseSchema })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const approval = await confirmPurchase(req.params.approvalId, actorOf(req));
    res.json({ success: true, data: approval });
  },
];

// ── History and reporting ─────────────────────────────────────────────────────

export const requestHistoryHandler = [
  validate(z.object({ params: requestIdParams })),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const history = await getApprovalHistoryForRequest(req.params.requestId, actorOf(req));
    res.json({ success: true, data: history });
  },
];

export const overviewHandler = [
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const overview = await getApprovalOverview(actorOf(req));
    res.json({ success: true, data: overview });
  },
];
