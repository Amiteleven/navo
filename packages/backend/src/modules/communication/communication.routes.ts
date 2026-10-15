import { Router } from '../../utils/router';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate.js';
import { z } from 'zod';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { Response } from 'express';
import prisma from '../../utils/prisma.js';
import { serializeMoney } from '../../utils/serialize.js';
import { createAuditLog } from '../audit/audit.service.js';
import {
  AuditAction,
  ReportReason,
  UserRole,
} from '@navo/shared';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { notify } from '../notifications/notification.service.js';
import {
  assertPublishableVisibility,
  assertSellerMayContact,
  assertSellerMayRequestConnection,
  assertVendorCanParticipate,
  clearRestriction,
  listRestrictedVendors,
  openMarketWhere,
  resolveInteractionBasis,
  resolveSellerActor,
  setRestriction,
} from './communication.service.js';

/**
 * Open market + controlled communication HTTP surface.
 *
 * Two audiences live here:
 *   - sellers, who may only see PUBLISHED open-market requirements, with
 *     confidential buyer fields projected away;
 *   - buyers, who manage their own requirements, invitations and restrictions.
 *
 * Every seller path re-resolves the seller from the database and re-checks
 * eligibility. Nothing here trusts a role or vendor id supplied by the client.
 */

const router = Router();

router.use(authenticate);

/** Buyer roles allowed to publish requirements. Sellers may not. */
const PUBLISHER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.REQUESTER,
];

// ─────────────────────────────────────────────────────────────────────────────
// Seller open market
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List open-market requirements.
 *
 * The projection is the security control: the buyer's identity, the budget, the
 * private description and any attachment are simply not selected. A seller
 * therefore cannot recover them from this response, whatever they do with it.
 */
const marketQuerySchema = z.object({
  search: z.string().max(200).optional(),
  categoryId: z.string().max(64).optional(),
  location: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get(
  '/market',
  validate(marketQuerySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const { search, categoryId, location, limit, offset } = req.query as unknown as z.infer<
      typeof marketQuerySchema
    >;

    // A supplier browsing the market is the only caller shape that makes sense
    // here; a buyer has its own requirement list.
    const actor = await resolveSellerActor(req.user!.userId, tenantId);
    await assertVendorCanParticipate(tenantId, actor.vendorId!);

    const where = {
      ...openMarketWhere(tenantId, actor.vendorId),
      ...(categoryId ? { categoryId } : {}),
      ...(location ? { location: { contains: location, mode: 'insensitive' as const } } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' as const } },
              { item: { contains: search, mode: 'insensitive' as const } },
              { specifications: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.procurementRequest.count({ where }),
      prisma.procurementRequest.findMany({
        where,
        orderBy: [{ status: 'asc' }, { quotationDeadline: 'asc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
        select: {
          id: true,
          title: true,
          item: true,
          quantity: true,
          unit: true,
          location: true,
          requiredDate: true,
          quotationDeadline: true,
          categoryId: true,
          category: { select: { id: true, name: true } },
          createdAt: true,
          // `status` is public: a seller needs to know it is still open.
          status: true,
          // `estimatedBudget`, `description`, `requesterId` and `attachments`
          // are deliberately omitted.
        },
      }),
    ]);

    res.json({
      success: true,
      data: serializeMoney(rows),
      meta: { total, limit, offset },
    });
  }
);

/** Detail for one open-market requirement, with the same redaction. */
router.get(
  '/market/:requestId',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const actor = await resolveSellerActor(req.user!.userId, tenantId);
    await assertVendorCanParticipate(tenantId, actor.vendorId!);

    const request = await prisma.procurementRequest.findFirst({
      where: { id: req.params.requestId, ...openMarketWhere(tenantId, actor.vendorId) },
      select: {
        id: true,
        title: true,
        item: true,
        quantity: true,
        unit: true,
        location: true,
        requiredDate: true,
        quotationDeadline: true,
        status: true,
        category: { select: { id: true, name: true } },
        createdAt: true,
        interests: {
          where: { vendorId: actor.vendorId },
          select: { id: true, status: true, quoteId: true, createdAt: true },
        },
      },
    });

    // Absent rather than forbidden, so a seller cannot probe for the existence
    // of a private requirement.
    if (!request) {
      res.status(404).json({ success: false, error: 'Requirement not found', code: 'NOT_FOUND' });
      return;
    }

    res.json({ success: true, data: serializeMoney(request) });
  }
);

/**
 * Express interest. This is the seller's own act, and it is what creates the
 * permitted interaction that later allows them to be messaged.
 */
const interestSchema = z.object({
  note: z.string().max(1000).optional(),
});

router.post(
  '/market/:requestId/interest',
  validate(interestSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const actor = await resolveSellerActor(req.user!.userId, tenantId);
    await assertVendorCanParticipate(tenantId, actor.vendorId!);

const request = await prisma.procurementRequest.findFirst({
      where: { id: req.params.requestId, ...openMarketWhere(tenantId) },
      select: { id: true, title: true, requesterId: true },
    });
    if (!request) {
      throw new NotFoundError('Requirement');
    }

    const existing = await prisma.marketplaceInterest.findUnique({
      where: { requestId_vendorId: { requestId: request.id, vendorId: actor.vendorId! } },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new ValidationError('You have already expressed interest in this requirement');
    }

    const interest = await prisma.marketplaceInterest.create({
      data: {
        requestId: request.id,
        vendorId: actor.vendorId!,
        submittedById: actor.userId,
        tenantId,
        note: req.body.note ?? null,
      },
      select: { id: true, status: true, createdAt: true },
    });

await createAuditLog({
      userId: actor.userId,
      action: AuditAction.MARKETPLACE_INTEREST_EXPRESSED,
      entityType: 'MarketplaceInterest',
      entityId: interest.id,
      tenantId,
      metadata: { requestId: request.id, vendorId: actor.vendorId },
    });

    // The buyer is told, through the notification service so their frequency
    // preference applies. The preview names the requirement but not the
    // supplier's identity or any commercial detail: a marketplace alert is the
    // most likely notification to be forwarded or read on a shared screen.
    await notify({
      tenantId,
      recipientId: request.requesterId,
      event: 'MARKETPLACE_INTEREST',
      linkPath: `/requests/${request.id}`,
      // The preview is the detail line, not a restatement of the framing: the
      // subject already says "A supplier is interested", so repeating it there
      // reads as a stutter and wastes the most visible part of the email.
      preview: `Requirement: ${request.title}`,
      dedupeKey: `marketplace-interest:${interest.id}`,
    });

    res.status(201).json({ success: true, data: interest });
  }
);

/** Withdraw interest, so a seller is no longer reachable through it. */
router.delete(
  '/market/:requestId/interest',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const actor = await resolveSellerActor(req.user!.userId, tenantId);

    const result = await prisma.marketplaceInterest.deleteMany({
      where: { requestId: req.params.requestId, vendorId: actor.vendorId, tenantId },
    });
    if (result.count === 0) throw new NotFoundError('Interest');

    await createAuditLog({
      userId: actor.userId,
      action: AuditAction.MARKETPLACE_INTEREST_WITHDRAWN,
      entityType: 'MarketplaceInterest',
      entityId: req.params.requestId,
      tenantId,
    });

    res.json({ success: true });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Buyer requirement publication
// ─────────────────────────────────────────────────────────────────────────────

const publishSchema = z.object({
  visibility: z.enum(['PRIVATE', 'OPEN_MARKET']),
  quotationDeadline: z.string().datetime().optional(),
  /**
   * Publishing exposes a requirement to every eligible seller, so it is
   * treated as consequential: the client must confirm explicitly. The UI shows
   * a preview and sets this; a direct API call cannot skip it.
   */
  confirmed: z.boolean().optional(),
});

/**
 * Publish (or make private) a requirement.
 *
 * Publishing to the open market is a consequential act - it exposes the item,
 * quantity, location and deadline to every eligible seller - so it takes an
 * explicit confirmation flag and is audited.
 */
router.post(
  '/requests/:requestId/publish',
  validate(publishSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    if (!PUBLISHER_ROLES.includes(req.user!.role as unknown as UserRole)) {
      throw new ForbiddenError('Your role cannot publish requirements');
    }
    if (req.body.confirmed !== true) {
      throw new ValidationError(
        'Publishing a requirement must be explicitly confirmed',
        { confirmed: ['Send confirmed: true to publish'] }
      );
    }

    const request = await prisma.procurementRequest.findFirst({
      where: {
        id: req.params.requestId,
        tenantId,
        requester: { id: req.user!.userId },
      },
      select: { id: true, status: true, visibility: true, title: true },
    });
    if (!request) throw new NotFoundError('Requirement');

    const deadline = req.body.quotationDeadline
      ? new Date(req.body.quotationDeadline)
      : req.body.visibility === 'OPEN_MARKET'
        ? null
        : undefined;

    assertPublishableVisibility({
      visibility: req.body.visibility,
      status: request.status,
      quotationDeadline: deadline ?? null,
    });

    if (deadline && deadline.getTime() <= Date.now()) {
      throw new ValidationError('The quotation deadline must be in the future', {
        quotationDeadline: ['Must be a future date'],
      });
    }

    const updated = await prisma.procurementRequest.update({
      where: { id: request.id },
      data: {
        visibility: req.body.visibility,
        publishedAt: req.body.visibility === 'OPEN_MARKET' ? new Date() : null,
        quotationDeadline: deadline ?? null,
      },
      select: { id: true, visibility: true, quotationDeadline: true, publishedAt: true },
    });

    await createAuditLog({
      userId: req.user!.userId,
      action: AuditAction.REQUIREMENT_PUBLISHED,
      entityType: 'ProcurementRequest',
      entityId: request.id,
      previousStatus: request.visibility,
      newStatus: req.body.visibility,
      tenantId,
      metadata: { quotationDeadline: deadline?.toISOString() ?? null },
    });

await notify({
      tenantId,
      recipientId: req.user!.userId,
      event: 'REQUIREMENT_PUBLISHED',
      linkPath: `/requests/${request.id}`,
      preview:
        updated.visibility === 'OPEN_MARKET'
          ? `${request.title} is now visible to approved suppliers`
          : `${request.title} was made private`,
      dedupeKey: `requirement-visibility:${request.id}:${updated.publishedAt?.toISOString() ?? 'private'}`,
    });

    res.json({ success: true, data: serializeMoney(updated) });
  }
);

/** Withdraw a requirement from the market without deleting its history. */
router.post(
  '/requests/:requestId/withdraw',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const request = await prisma.procurementRequest.findFirst({
      where: { id: req.params.requestId, tenantId, requester: { id: req.user!.userId } },
      select: { id: true, visibility: true },
    });
    if (!request) throw new NotFoundError('Requirement');

    await prisma.procurementRequest.update({
      where: { id: request.id },
      data: { visibility: 'PRIVATE', publishedAt: null },
    });

    await createAuditLog({
      userId: req.user!.userId,
      action: AuditAction.REQUIREMENT_WITHDRAWN,
      entityType: 'ProcurementRequest',
      entityId: request.id,
      previousStatus: request.visibility,
      newStatus: 'PRIVATE',
      tenantId,
    });

    res.json({ success: true });
  }
);

/** A seller's own submitted quotations and interests. */
router.get(
  '/my-submissions',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const actor = await resolveSellerActor(req.user!.userId, tenantId);

    const rows = await prisma.marketplaceInterest.findMany({
      where: { tenantId, vendorId: actor.vendorId },
      orderBy: { createdAt: 'desc' },
      include: {
        request: {
          select: { id: true, title: true, status: true, quotationDeadline: true },
        },
        quote: { select: { id: true, unitPrice: true, quantity: true, status: true } },
      },
    });

    res.json({ success: true, data: serializeMoney(rows) });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Buyer moderation controls
// ─────────────────────────────────────────────────────────────────────────────

const restrictionSchema = z.object({
  vendorId: z.string().min(1).max(64),
  kind: z.enum(['BLOCK', 'MUTE']),
  reason: z.string().max(500).optional(),
  expiresAt: z.string().datetime().optional(),
});

router.post(
  '/restrictions',
  validate(restrictionSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const vendor = await prisma.vendor.findFirst({
      where: { id: req.body.vendorId, tenantId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundError('Vendor');

    const created = await setRestriction({
      tenantId,
      buyerId: req.user!.userId,
      vendorId: vendor.id,
      kind: req.body.kind,
      reason: req.body.reason,
      expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
    });

    await createAuditLog({
      userId: req.user!.userId,
      action:
        req.body.kind === 'BLOCK'
          ? AuditAction.VENDOR_BLOCKED
          : AuditAction.VENDOR_MUTED,
      entityType: 'ContactRestriction',
      entityId: vendor.id,
      tenantId,
      metadata: { kind: req.body.kind, reason: req.body.reason ?? null },
    });

    res.status(201).json({ success: true, data: created });
  }
);

router.delete(
  '/restrictions/:vendorId',
async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const removed = await clearRestriction(
      tenantId,
      req.user!.userId,
      req.params.vendorId
    );
    if (removed === 0) throw new NotFoundError('Restriction');

    await createAuditLog({
      userId: req.user!.userId,
      action: AuditAction.VENDOR_UNBLOCKED,
      entityType: 'ContactRestriction',
      entityId: req.params.vendorId,
      tenantId,
    });

    res.json({ success: true });
  }
);

router.get(
  '/restrictions',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rows = await listRestrictedVendors(req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: serializeMoney(rows) });
  }
);

const reportSchema = z.object({
  vendorId: z.string().min(1).max(64),
  reason: z.enum(Object.values(ReportReason) as [string, ...string[]]),
  details: z.string().max(2000).optional(),
});

router.post(
  '/reports',
  validate(reportSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const vendor = await prisma.vendor.findFirst({
      where: { id: req.body.vendorId, tenantId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundError('Vendor');

    const report = await prisma.abuseReport.create({
      data: {
        tenantId,
        reporterId: req.user!.userId,
        vendorId: vendor.id,
        reason: req.body.reason as ReportReason,
        details: req.body.details ?? null,
      },
      select: { id: true, status: true, createdAt: true },
    });

    await createAuditLog({
      userId: req.user!.userId,
      action: AuditAction.ABUSE_REPORT_FILED,
      entityType: 'AbuseReport',
      entityId: report.id,
      tenantId,
      metadata: { vendorId: vendor.id, reason: req.body.reason },
    });

    res.status(201).json({ success: true, data: report });
  }
);

/**
 * Why may this seller contact this buyer?
 *
 * Exposed so the UI can explain a refusal precisely, and so the restriction is
 * inspectable rather than a silent 403.
 */
router.get(
  '/interaction/:buyerId',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const actor = await resolveSellerActor(req.user!.userId, tenantId);
    const basis = await resolveInteractionBasis(tenantId, actor.userId, req.params.buyerId);
    res.json({ success: true, data: { basis, mayContact: basis !== 'NONE' } });
  }
);

export default router;