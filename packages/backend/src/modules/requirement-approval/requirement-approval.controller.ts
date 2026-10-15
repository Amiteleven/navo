import { Response } from 'express';
import { UserRole } from '@navo/shared';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import {
  submitRequirementForApproval,
  decideOnRequirementApproval,
  getPendingRequirementApprovalsForUser,
  getApprovalStatusForRequest,
} from './requirement-approval.service.js';
import { resolveRequirementApprovalRoute } from './approval-policy.service.js';
import prisma from '../../utils/prisma.js';

export async function submitForApproval(req: AuthenticatedRequest, res: Response) {
  const { requestId } = req.body;
  const { userId, tenantId } = req.user!;

  if (!requestId) throw new ValidationError('requestId is required');

  const request = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
  });
  if (!request) throw new NotFoundError('ProcurementRequest');

  const result = await submitRequirementForApproval({
    requestId,
    submitterId: userId,
    tenantId,
    requesterComment: req.body.requesterComment,
  });

  res.json({ success: true, data: result });
}

export async function decide(req: AuthenticatedRequest, res: Response) {
  const { approvalId } = req.params;
  const { decision, comments } = req.body;
  const { userId, tenantId, role } = req.user!;

  if (!['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'].includes(decision)) {
    throw new ValidationError('decision must be APPROVED, REJECTED, or CHANGES_REQUESTED');
  }

  const result = await decideOnRequirementApproval({
    approvalId,
    decision,
    comments,
    approverId: userId,
    actorRole: role as UserRole,
    tenantId,
  });

  res.json({ success: true, data: result });
}

export async function listPending(req: AuthenticatedRequest, res: Response) {
  const { userId, tenantId } = req.user!;

  const approvals = await getPendingRequirementApprovalsForUser(userId, tenantId);

  res.json({ success: true, data: approvals });
}

export async function getStatus(req: AuthenticatedRequest, res: Response) {
  const { tenantId } = req.user!;
  const { requestId } = req.params;

  const status = await getApprovalStatusForRequest(requestId, tenantId);

  res.json({ success: true, data: status });
}

export async function previewRoute(req: AuthenticatedRequest, res: Response) {
  const { requestId } = req.params;
  const { userId, tenantId, role } = req.user!;

  const request = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId },
  });
  if (!request) throw new NotFoundError('ProcurementRequest');

  const route = await resolveRequirementApprovalRoute({
    actor: {
      userId,
      tenantId,
      role,
    },
    requirement: {
      id: request.id,
      title: request.title,
      category: request.categoryId ?? null,
      department: request.department ?? null,
      costCenter: request.costCenter ?? null,
      estimatedBudget: request.estimatedBudget ?? null,
      currency: 'INR',
      requesterId: request.requesterId,
    },
  });

  res.json({ success: true, data: route });
}