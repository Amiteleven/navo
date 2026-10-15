import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  createOrUpdateDraftHandler,
  getActiveDraftHandler,
  getDraftByIdHandler,
  listDraftsHandler,
  answerClarificationHandler,
  confirmDraftHandler,
  abandonDraftHandler,
  getCategoriesHandler,
  getCategoryFieldsHandler,
  getDraftVersionsHandler,
  checkMaterialChangeHandler,
} from './requirement-intake.controller.js';
import {
  submitRequirementForApproval,
  decideOnRequirementApproval,
  getPendingRequirementApprovalsForUser,
  getApprovalStatusForRequest,
} from '../requirement-approval/requirement-approval.service.js';

const router = Router();

/**
 * @swagger
 * /requirement-intake/draft:
 *   post:
 *     summary: Create or update a requirement draft from a chat message
 *     tags: [Requirement Intake]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message:
 *                 type: string
 *               conversationId:
 *                 type: string
 *               extractedData:
 *                 type: object
 *     responses:
 *       200:
 *         description: Draft created/updated successfully
 */
router.post(
  '/draft',
  authenticate,
  validate(
    z.object({
      body: z.object({
        message: z.string().min(1),
        conversationId: z.string().optional(),
        extractedData: z.record(z.unknown()).optional(),
      }),
    })
  ),
  createOrUpdateDraftHandler
);

/**
 * @swagger
 * /requirement-intake/draft:
 *   get:
 *     summary: Get the active requirement draft for the current user
 *     tags: [Requirement Intake]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: conversationId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Active draft or null
 */
router.get('/draft', authenticate, getActiveDraftHandler);
router.get('/draft/active', authenticate, getActiveDraftHandler);
router.get('/drafts', authenticate, listDraftsHandler);
router.get('/draft/:draftId', authenticate, getDraftByIdHandler);
router.get('/draft/:draftId/versions', authenticate, getDraftVersionsHandler);

/**
 * @swagger
 * /requirement-intake/draft/{draftId}/answer:
 *   post:
 *     summary: Answer a clarification question
 *     tags: [Requirement Intake]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: draftId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               field:
 *                 type: string
 *               answer:
 *                 type: string
 *     responses:
 *       200:
 *         description: Answer recorded, updated draft returned
 */
router.post(
  '/draft/:draftId/answer',
  authenticate,
  validate(
    z.object({
      params: z.object({ draftId: z.string().min(1) }),
      body: z.object({ field: z.string().min(1), answer: z.string() }),
    })
  ),
  answerClarificationHandler
);
router.post(
  '/draft/answer',
  authenticate,
  validate(
    z.object({
      body: z.object({ draftId: z.string().min(1), field: z.string().min(1), answer: z.string() }),
    })
  ),
  answerClarificationHandler
);

/**
 * @swagger
 * /requirement-intake/draft/{draftId}/confirm:
 *   post:
 *     summary: Confirm the draft and create a ProcurementRequest
 *     tags: [Requirement Intake]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: draftId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Draft confirmed, ProcurementRequest created
 */
router.post(
  '/draft/:draftId/confirm',
  authenticate,
  validate(
    z.object({
      params: z.object({ draftId: z.string().min(1) }),
    })
  ),
  confirmDraftHandler
);
router.post(
  '/draft/confirm',
  authenticate,
  validate(
    z.object({
      body: z.object({ draftId: z.string().min(1) }),
    })
  ),
  confirmDraftHandler
);

/**
 * @swagger
 * /requirement-intake/draft/{draftId}/abandon:
 *   post:
 *     summary: Mark a draft as abandoned
 *     tags: [Requirement Intake]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: draftId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Draft abandoned
 */
router.post(
  '/draft/:draftId/abandon',
  authenticate,
  validate(
    z.object({
      params: z.object({ draftId: z.string().min(1) }),
    })
  ),
  abandonDraftHandler
);
router.post(
  '/draft/abandon',
  authenticate,
  validate(
    z.object({
      body: z.object({ draftId: z.string().min(1) }),
    })
  ),
  abandonDraftHandler
);

/**
 * @swagger
 * /requirement-intake/categories:
 *   get:
 *     summary: Get available procurement categories
 *     tags: [Requirement Intake]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of categories
 */
router.get('/categories', authenticate, getCategoriesHandler);

/**
 * @swagger
 * /requirement-intake/category/{category}/fields:
 *   get:
 *     summary: Get critical and optional fields for a category
 *     tags: [Requirement Intake]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: category
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category field definitions
 */
router.get('/category/:category/fields', authenticate, getCategoryFieldsHandler);
router.get('/categories/fields', authenticate, getCategoryFieldsHandler);

/** Submit a confirmed request for department head approval */
router.post(
  '/request/:requestId/submit-for-approval',
  authenticate,
  validate(
    z.object({
      params: z.object({ requestId: z.string().min(1) }),
      body: z.object({ requesterComment: z.string().optional() }),
    })
  ),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const result = await submitRequirementForApproval({
        requestId: req.params.requestId,
        submitterId: req.user!.userId,
        tenantId: req.user!.tenantId,
        requesterComment: req.body.requesterComment,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

/** Get pending requirement approvals for the current approver */
router.get(
  '/approvals/pending',
  authenticate,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const data = await getPendingRequirementApprovalsForUser(
        req.user!.userId,
        req.user!.tenantId
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/** Decide on a requirement approval (approve / reject / send back) */
router.post(
  '/approvals/:approvalId/decide',
  authenticate,
  validate(
    z.object({
      params: z.object({ approvalId: z.string().min(1) }),
      body: z.object({
        decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
        comments: z.string().optional(),
      }),
    })
  ),
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const result = await decideOnRequirementApproval({
        approvalId: req.params.approvalId,
        decision: req.body.decision,
        comments: req.body.comments,
        approverId: req.user!.userId,
        actorRole: req.user!.role,
        tenantId: req.user!.tenantId,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

/** Get approval status for a specific requirement */
router.get(
  '/request/:requestId/approval-status',
  authenticate,
  async (req: AuthenticatedRequest, res: Response, next) => {
    try {
      const data = await getApprovalStatusForRequest(
        req.params.requestId,
        req.user!.tenantId
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/** Check if proposed changes require re-approval */
router.post(
  '/request/:requestId/check-material-change',
  authenticate,
  checkMaterialChangeHandler
);

export default router;