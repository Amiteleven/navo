import { Request, Response } from 'express';
import { UserRole } from '@navo/shared';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma.js';
import {
  upsertRequirementDraft,
  confirmRequirementDraft,
  getActiveDraft,
  answerClarification,
  normalizeCategory,
  isDraftConfirmable,
  generateClarificationQuestions,
} from './requirement-intake.service.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { ForbiddenError, ValidationError, NotFoundError } from '../../utils/errors.js';

import { processRequirementChatMessage } from './requirement-intelligence.service.js';
import { getDraftVersionHistory, evaluatePostApprovalReapproval } from './intelligence/version-tracker.js';

/**
 * POST /requirement-intake/draft
 * Create or update a requirement draft from a chat message using the Requirement Intelligence Engine.
 */
export async function createOrUpdateDraftHandler(req: AuthenticatedRequest, res: Response) {
  const { message, conversationId } = req.body as {
    message: string;
    conversationId?: string;
    extractedData?: Record<string, unknown>;
  };

  if (!message?.trim()) {
    throw new ValidationError('Message is required');
  }

  const user = req.user!;
  const tenantId = user.tenantId;

  const result = await processRequirementChatMessage({
    tenantId,
    userId: user.userId,
    copilotConversationId: conversationId || `conv-${user.userId}`,
    message: message.trim(),
  });

  res.json({
    success: true,
    data: {
      ...result.draft,
      replyMessage: result.replyMessage,
      intent: result.intent,
      completeness: result.completeness,
      versionHistory: result.versionHistory,
      questions: result.completeness.nextQuestions,
    },
  });
}

/**
 * GET /requirement-intake/draft/:draftId/versions
 * Get full version revision history for a requirement draft.
 */
export async function getDraftVersionsHandler(req: AuthenticatedRequest, res: Response) {
  const { draftId } = req.params;
  const versions = await getDraftVersionHistory(draftId);
  res.json({ success: true, data: versions });
}

/**
 * POST /requirement-intake/request/:requestId/check-material-change
 * Evaluate if proposed changes to an approved requirement require re-approval.
 */
export async function checkMaterialChangeHandler(req: AuthenticatedRequest, res: Response) {
  const { requestId } = req.params;
  const { changes } = req.body as { changes: Record<string, any> };
  const user = req.user!;

  const request = await prisma.procurementRequest.findFirst({
    where: { id: requestId, tenantId: user.tenantId },
  });
  if (!request) throw new NotFoundError('Procurement request not found');

  const evaluation = evaluatePostApprovalReapproval(request, changes);
  res.json({ success: true, data: evaluation });
}

/**
 * GET /requirement-intake/draft
 * Get the active requirement draft for the current user.
 */
export async function getActiveDraftHandler(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;
  const { conversationId } = req.query as { conversationId?: string };

  const draft = await getActiveDraft({
    tenantId: user.tenantId,
    userId: user.userId,
    copilotConversationId: conversationId,
  });

  if (!draft) {
    return res.json({ success: true, data: null });
  }

  // Include clarification questions
  const questions = await prisma.clarificationQuestion.findMany({
    where: { draftId: draft.id },
    orderBy: { order: 'asc' },
  });

  const confirmable = isDraftConfirmable(draft);

  res.json({
    success: true,
    data: {
      ...draft,
      clarifications: questions,
      confirmable,
    },
  });
}

/**
 * GET /requirement-intake/draft/:draftId
 */
export async function getDraftByIdHandler(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;
  const { draftId } = req.params;

  const draft = await prisma.requirementDraft.findFirst({
    where: { id: draftId, tenantId: user.tenantId, userId: user.userId },
  });

  if (!draft) {
    throw new NotFoundError('Draft not found');
  }

  const questions = await prisma.clarificationQuestion.findMany({
    where: { draftId: draft.id },
    orderBy: { order: 'asc' },
  });

  const confirmable = isDraftConfirmable({ ...draft, category: draft.category || undefined });

  res.json({
    success: true,
    data: {
      ...draft,
      clarifications: questions,
      confirmable,
    },
  });
}

/**
 * GET /requirement-intake/drafts
 */
export async function listDraftsHandler(req: AuthenticatedRequest, res: Response) {
  const user = req.user!;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;
  const state = req.query.state as string | undefined;

  const where: any = {
    tenantId: user.tenantId,
    userId: user.userId,
  };
  if (state) where.state = state;

  const [items, total] = await Promise.all([
    prisma.requirementDraft.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        clarifications: {
          orderBy: { order: 'asc' },
        },
      },
    }),
    prisma.requirementDraft.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    },
  });
}

/**
 * POST /requirement-intake/draft/:draftId/answer or /requirement-intake/draft/answer
 * Answer a clarification question.
 */
export async function answerClarificationHandler(req: AuthenticatedRequest, res: Response) {
  const draftId = req.params.draftId || (req.body as any)?.draftId;
  const { field, answer } = req.body as { field: string; answer: string };

  if (!draftId) {
    throw new ValidationError('draftId is required');
  }
  if (!field || answer === undefined) {
    throw new ValidationError('Field and answer are required');
  }

  const user = req.user!;

  const result = await answerClarification({
    draftId,
    field,
    answer,
    tenantId: user.tenantId,
    userId: user.userId,
  });

  res.json({
    success: true,
    data: result,
  });
}

/**
 * POST /requirement-intake/draft/:draftId/confirm or /requirement-intake/draft/confirm
 * Confirm the draft and create a ProcurementRequest.
 */
export async function confirmDraftHandler(req: AuthenticatedRequest, res: Response, next: any) {
  try {
    const draftId = req.params.draftId || (req.body as any)?.draftId;
    if (!draftId) {
      throw new ValidationError('draftId is required');
    }
    const user = req.user!;

    const result = await confirmRequirementDraft({
      draftId,
      userId: user.userId,
      tenantId: user.tenantId,
    });

    res.json({
      success: true,
      data: {
        requestId: result.requestId,
        draftId,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /requirement-intake/draft/:draftId/abandon or /requirement-intake/draft/abandon
 * Mark a draft as abandoned.
 */
export async function abandonDraftHandler(req: AuthenticatedRequest, res: Response) {
  const draftId = req.params.draftId || (req.body as any)?.draftId;
  if (!draftId) {
    throw new ValidationError('draftId is required');
  }
  const user = req.user!;

  await prisma.requirementDraft.update({
    where: { id: draftId, tenantId: user.tenantId, userId: user.userId },
    data: { state: 'ABANDONED' },
  });

  res.json({ success: true, data: { id: draftId, message: 'Draft abandoned' } });
}

/**
 * GET /requirement-intake/categories
 * Get available procurement categories for reference.
 */
export async function getCategoriesHandler(req: AuthenticatedRequest, res: Response) {
  const categories = [
    'Product',
    'Service',
    'Software',
    'Professional Service',
    'Manufacturing',
    'Raw Material',
    'Logistics',
    'Maintenance',
    'Facility Management',
    'Marketing',
    'IT',
    'Consulting',
    'Travel',
    'Event',
    'Construction',
    'Contracted Service',
    'Other',
  ];

  res.json({ success: true, data: { categories } });
}

/**
 * GET /requirement-intake/category/:category/fields or /categories/fields
 * Get critical and optional fields for a category.
 */
export async function getCategoryFieldsHandler(req: AuthenticatedRequest, res: Response) {
  const category = req.params.category || (req.query.category as string) || 'Other';
  const normalized = normalizeCategory(category);
  const { critical, optional } = await import('./requirement-intake.service.js').then((m) => m.getCategoryFields(normalized));

  res.json({
    success: true,
    data: { category: normalized, critical, optional },
  });
}