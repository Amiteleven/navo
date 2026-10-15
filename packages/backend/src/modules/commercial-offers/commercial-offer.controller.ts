import { Response } from 'express';
import { z } from 'zod';
import { UserRole } from '@navo/shared';
import {
  createOrGetOffer,
  getOffer,
  getOfferByAssignment,
  listOffersForBuyer,
  upsertOfferDraft,
  submitOffer,
  getOfferSubmissions,
  listVendorOffers,
  getClarificationThread,
  postClarification,
  postClarificationResponse,
  withdrawOffer,
  declineOpportunity,
  reopenCommercialProcess,
  validateOfferData,
  getOfferEvents,
  evaluateSubmissionCompliance,
  summarizeSubmission,
} from './commercial-offer.service';
import { Router } from '../../utils/router';
import { AuthenticatedRequest } from '../../middleware/auth';
import { validate } from '../../middleware/validate.js';
import { ValidationError } from '../../utils/errors';

const router = Router();

const VENDOR_ROLES = [UserRole.VENDOR];

function isVendor(req: AuthenticatedRequest): boolean {
  return VENDOR_ROLES.includes(req.user?.role as UserRole) && req.user?.vendorId != null;
}

function vendorIdOf(req: AuthenticatedRequest): string | undefined {
  if (VENDOR_ROLES.includes(req.user?.role as UserRole) && req.user?.vendorId) {
    return req.user.vendorId;
  }
  return undefined;
}

function requireVendor(req: AuthenticatedRequest): string {
  const v = vendorIdOf(req);
  if (!v) throw new ValidationError('Only vendors can perform this action');
  return v;
}

const offerIdParam = z.object({ params: z.object({ offerId: z.string().min(1) }) });
const assignmentIdParam = z.object({ params: z.object({ vendorAssignmentId: z.string().min(1) }) });
const submissionIdParam = z.object({ params: z.object({ submissionId: z.string().min(1) }) });

const listOffersQuerySchema = z.object({
  query: z.object({
    requestId: z.string().min(1).optional(),
    vendorId: z.string().min(1).optional(),
    status: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

const createOfferSchema = z.object({
  body: z.object({
    vendorAssignmentId: z.string().min(1, 'Vendor assignment ID is required'),
    requestId: z.string().min(1, 'Request ID is required'),
    offerType: z.enum(['PRODUCT', 'SERVICE', 'SOFTWARE_SUBSCRIPTION', 'PROJECT']),
    currency: z.string().length(3, 'Currency must be a 3-letter code'),
    deadline: z.string().datetime().optional(),
  }),
});

const draftSchema = z.object({
  body: z.object({
    currency: z.string().length(3).optional(),
    subTotal: z.number().nonnegative().optional(),
    taxAmount: z.number().nonnegative().optional(),
    totalAmount: z.number().nonnegative().optional(),
    discountAmount: z.number().nonnegative().optional(),
    discountPercentage: z.number().min(0).max(100).optional(),
    unitPrice: z.number().nonnegative().optional(),
    quantity: z.number().int().positive().optional(),
    contractDuration: z.string().max(500).optional(),
    milestones: z.array(z.record(z.unknown())).optional(),
    deliverables: z.array(z.record(z.unknown())).optional(),
    serviceLevels: z.array(z.record(z.unknown())).optional(),
    staffingAssumptions: z.string().max(2000).optional(),
    numberOfLicenses: z.number().int().positive().optional(),
    billingFrequency: z.string().max(100).optional(),
    subscriptionTerm: z.string().max(200).optional(),
    renewalTerms: z.string().max(500).optional(),
    implementationFees: z.number().nonnegative().optional(),
    recurringFees: z.number().nonnegative().optional(),
    oneTimeFees: z.number().nonnegative().optional(),
    deliveryDate: z.string().datetime().optional(),
    paymentTerms: z.string().max(500).optional(),
    offerValidityDays: z.number().int().positive().optional(),
    offerValidityDate: z.string().datetime().optional(),
    commercialConditions: z.string().max(2000).optional(),
    scope: z.string().max(5000).optional(),
    exclusions: z.string().max(2000).optional(),
    supportingDocuments: z.array(z.string()).optional(),
  }),
});

const submitOfferSchema = z.object({
  body: z.object({
    offerType: z.enum(['PRODUCT', 'SERVICE', 'SOFTWARE_SUBSCRIPTION', 'PROJECT']),
    currency: z.string().length(3),
    subTotal: z.number().nonnegative(),
    taxAmount: z.number().nonnegative(),
    totalAmount: z.number().nonnegative(),
    quantity: z.number().int().positive().optional(),
    unitPrice: z.number().nonnegative().optional(),
    deliveryDate: z.string().datetime().optional(),
    paymentTerms: z.string().max(500).optional(),
    offerValidityDays: z.number().int().positive().optional(),
    offerValidityDate: z.string().datetime().optional(),
    commercialConditions: z.string().max(2000).optional(),
    scope: z.string().max(5000).optional(),
    exclusions: z.string().max(2000).optional(),
    discountAmount: z.number().nonnegative().optional(),
    discountPercentage: z.number().min(0).max(100).optional(),
    contractDuration: z.string().max(500).optional(),
    numberOfLicenses: z.number().int().positive().optional(),
    billingFrequency: z.string().max(100).optional(),
    subscriptionTerm: z.string().max(200).optional(),
    renewalTerms: z.string().max(500).optional(),
    implementationFees: z.number().nonnegative().optional(),
    recurringFees: z.number().nonnegative().optional(),
    oneTimeFees: z.number().nonnegative().optional(),
    milestones: z.array(z.record(z.unknown())).optional(),
    deliverables: z.array(z.record(z.unknown())).optional(),
    serviceLevels: z.array(z.record(z.unknown())).optional(),
    staffingAssumptions: z.string().max(2000).optional(),
  }),
});

const messageContentSchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Message content is required').max(5000),
  }),
});

const reopenSchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'Reason is required').max(2000),
  }),
});

router.get('/', validate(listOffersQuerySchema), async (req: AuthenticatedRequest, res: Response) => {
  const { requestId, vendorId, status, page, limit } = req.query;

  if (isVendor(req)) {
    const vendor = req.user!.vendorId as string;
    const result = await listVendorOffers(vendor, req.user!.tenantId, req.user!.userId, {
      requestId: requestId as string,
      status: status as string,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });
    res.json(result);
    return;
  }

  const result = await listOffersForBuyer(req.user!.tenantId, {
    requestId: requestId as string,
    vendorId: vendorId as string,
    status: status as string,
    page: page ? parseInt(page as string, 10) : undefined,
    limit: limit ? parseInt(limit as string, 10) : undefined,
  });
  res.json(result);
});

router.post('/offer', validate(createOfferSchema), async (req: AuthenticatedRequest, res: Response) => {
  const { vendorAssignmentId, requestId, offerType, currency, deadline } = req.body;

  const vendorId = vendorIdOf(req);

  const offer = await createOrGetOffer(
    { vendorAssignmentId, requestId, offerType, currency, deadline },
    req.user!.userId,
    req.user!.tenantId,
    vendorId
  );
  res.status(201).json(offer);
});

router.get('/offer/:offerId', validate(offerIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { offerId } = req.params;
  const vendorId = vendorIdOf(req);

  const offer = await getOffer(offerId, req.user!.tenantId, req.user!.userId, vendorId);
  res.json(offer);
});

router.get('/assignment/:vendorAssignmentId', validate(assignmentIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { vendorAssignmentId } = req.params;
  const vendorId = vendorIdOf(req);

  const offer = await getOfferByAssignment(vendorAssignmentId, req.user!.tenantId, req.user!.userId, vendorId);
  res.json(offer);
});

router.get('/:offerId/submissions', validate(offerIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { offerId } = req.params;
  const vendorId = vendorIdOf(req);

  const submissions = await getOfferSubmissions(offerId, req.user!.tenantId, req.user!.userId, vendorId);
  res.json(submissions);
});

router.put('/assignment/:vendorAssignmentId/draft', validate(assignmentIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { vendorAssignmentId } = req.params;
  const vendorId = vendorIdOf(req);

  const result = await upsertOfferDraft(vendorAssignmentId, req.body, req.user!.userId, req.user!.tenantId, vendorId);
  res.json(result);
});

router.post('/assignment/:vendorAssignmentId/submit', validate(assignmentIdParam), validate(submitOfferSchema), async (req: AuthenticatedRequest, res: Response) => {
  const { vendorAssignmentId } = req.params;
  const input = { ...req.body, vendorAssignmentId, idempotencyKey: req.body.idempotencyKey || `${vendorAssignmentId}-${Date.now()}` };

  validateOfferData(input);

  const vendorId = requireVendor(req);

  const result = await submitOffer(input, req.user!.userId, req.user!.tenantId, vendorId);
  res.status(201).json(result);
});

router.get('/assignment/:vendorAssignmentId/clarifications', validate(assignmentIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { vendorAssignmentId } = req.params;
  const vendorId = vendorIdOf(req);

  const thread = await getClarificationThread(vendorAssignmentId, req.user!.tenantId, req.user!.userId, vendorId);
  res.json(thread);
});

router.post('/assignment/:vendorAssignmentId/clarification', validate(assignmentIdParam), validate(messageContentSchema), async (req: AuthenticatedRequest, res: Response) => {
  const { vendorAssignmentId } = req.params;
  const { content } = req.body;
  const vendorId = vendorIdOf(req);

  const result = await postClarification({ vendorAssignmentId, content }, req.user!.userId, req.user!.tenantId, vendorId);
  res.status(201).json(result);
});

router.post('/assignment/:vendorAssignmentId/clarification-response', validate(assignmentIdParam), validate(messageContentSchema), async (req: AuthenticatedRequest, res: Response) => {
  const { vendorAssignmentId } = req.params;
  const { content } = req.body;
  const vendorId = vendorIdOf(req);

  const result = await postClarificationResponse(vendorAssignmentId, content, req.user!.userId, req.user!.tenantId, vendorId);
  res.status(201).json(result);
});

router.put('/:offerId/withdraw', validate(offerIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { offerId } = req.params;
  const vendorId = requireVendor(req);

  const result = await withdrawOffer(offerId, req.user!.tenantId, req.user!.userId, vendorId);
  res.json(result);
});

router.put('/:offerId/decline', validate(offerIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { offerId } = req.params;
  const vendorId = requireVendor(req);

  const result = await declineOpportunity(offerId, req.user!.tenantId, req.user!.userId, vendorId);
  res.json(result);
});

router.post('/assignment/:vendorAssignmentId/reopen', validate(assignmentIdParam), validate(reopenSchema), async (req: AuthenticatedRequest, res: Response) => {
  const { vendorAssignmentId } = req.params;
  const { reason } = req.body;

  const result = await reopenCommercialProcess(
    { vendorAssignmentId, reason },
    req.user!.userId,
    req.user!.tenantId,
    req.user!.role
  );
  res.json(result);
});

router.get('/:offerId/events', validate(offerIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { offerId } = req.params;
  const vendorId = vendorIdOf(req);

  const events = await getOfferEvents(offerId, req.user!.tenantId, req.user!.userId, vendorId);
  res.json(events);
});

router.post('/submission/:submissionId/compliance', validate(submissionIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { submissionId } = req.params;
  const result = await evaluateSubmissionCompliance(submissionId, req.user!.tenantId, req.user!.userId);
  res.json(result);
});

router.get('/submission/:submissionId/summary', validate(submissionIdParam), async (req: AuthenticatedRequest, res: Response) => {
  const { submissionId } = req.params;
  const summary = await summarizeSubmission(submissionId, req.user!.tenantId, req.user!.userId);
  res.json({ summary });
});

export default router;
