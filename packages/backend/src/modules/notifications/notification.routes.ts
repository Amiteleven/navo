import { Router } from '../../utils/router';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate.js';
import { z } from 'zod';
import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { NotificationFrequency } from '@navo/shared';
import {
  listNotifications,
  listPreferences,
  markNotificationRead,
  markRoomRead,
  processPendingEmails,
  setPreference,
  suppressPendingFor,
  unreadCount,
} from './notification.service.js';
import {
  clearRestriction,
  listRestrictedVendors,
  resolveSellerActor,
} from '../communication/communication.service.js';
import prisma from '../../utils/prisma.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { createAuditLog } from '../audit/audit.service.js';
import { AuditAction, UserRole } from '@navo/shared';

/**
 * Notification and unread HTTP surface.
 *
 * Unread counts are resolved server-side and always against the caller's own
 * deal-room participation, so a user cannot read someone else's conversation
 * state by asking this endpoint for another room id.
 */

const router = Router();
router.use(authenticate);

const dealRoomIdParam = z.object({ params: z.object({ dealRoomId: z.string().min(1) }) });
const notificationIdParam = z.object({ params: z.object({ notificationId: z.string().min(1) }) });
const vendorIdParam = z.object({ params: z.object({ vendorId: z.string().min(1) }) });

/** Unread messages in a negotiation room the caller participates in. */
router.get(
  '/unread/:dealRoomId',
  validate(dealRoomIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const room = await prisma.dealRoom.findFirst({
      where: {
        id: req.params.dealRoomId,
        tenantId: req.user!.tenantId,
        OR: [
          { buyerId: req.user!.userId },
          { vendor: { vendorUsers: { some: { id: req.user!.userId } } } },
        ],
      },
      select: { id: true },
    });
    if (!room) throw new NotFoundError('Negotiation room');

    const count = await unreadCount(room.id, req.user!.userId);
    res.json({ success: true, data: { dealRoomId: room.id, unread: count } });
  }
);

/** Unread totals across every room plus the in-app inbox. */
router.get(
  '/unread',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rooms = await prisma.dealRoom.findMany({
      where: {
        tenantId: req.user!.tenantId,
        OR: [
          { buyerId: req.user!.userId },
          { vendor: { vendorUsers: { some: { id: req.user!.userId } } } },
        ],
      },
      select: { id: true, buyerId: true, vendor: { select: { vendorUsers: { select: { id: true } } } } },
    });

    const perRoom = await Promise.all(
      rooms.map(async (room) => {
        const count = await unreadCount(room.id, req.user!.userId);
        return { dealRoomId: room.id, unread: count };
      })
    );

    const inbox = await listNotifications(req.user!.tenantId, req.user!.userId, 1);

    res.json({
      success: true,
      data: {
        rooms: perRoom.filter((r) => r.unread > 0),
        totalMessages: perRoom.reduce((s, r) => s + r.unread, 0),
        notifications: inbox.unread,
      },
    });
  }
);

/**
 * Mark a room read.
 *
 * Also suppresses any queued email to this user: they are demonstrably online
 * and have now seen the backlog, so re-sending it would be pure noise.
 */
router.post(
  '/unread/:dealRoomId/read',
  validate(dealRoomIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const room = await prisma.dealRoom.findFirst({
      where: {
        id: req.params.dealRoomId,
        tenantId: req.user!.tenantId,
        OR: [
          { buyerId: req.user!.userId },
          { vendor: { vendorUsers: { some: { id: req.user!.userId } } } },
        ],
      },
      select: { id: true },
    });
    if (!room) throw new NotFoundError('Negotiation room');

    const marked = await markRoomRead(room.id, req.user!.userId);
    const suppressed = await suppressPendingFor(req.user!.userId);

    res.json({ success: true, data: { marked, suppressed } });
  }
);

// ── In-app notification inbox ────────────────────────────────────────────────

router.get(
  '/',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const result = await listNotifications(req.user!.tenantId, req.user!.userId, limit);
    res.json({ success: true, data: result.items, meta: { unread: result.unread } });
  }
);

router.post(
  '/:notificationId/read',
  validate(notificationIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const ok = await markNotificationRead(
      req.user!.tenantId,
      req.user!.userId,
      req.params.notificationId
    );
    if (!ok) throw new NotFoundError('Notification');
    res.json({ success: true });
  }
);

// ── Delivery preferences ─────────────────────────────────────────────────────

router.get(
  '/preferences',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.json({ success: true, data: await listPreferences(req.user!.tenantId, req.user!.userId) });
  }
);

const preferenceSchema = z.object({
  eventType: z.string().min(1).max(64),
  frequency: z.nativeEnum(NotificationFrequency),
});

router.put(
  '/preferences',
  validate(preferenceSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await setPreference(
      req.user!.tenantId,
      req.user!.userId,
      req.body.eventType,
      req.body.frequency
    );
    res.json({ success: true });
  }
);

/**
 * Drain the outbox.
 *
 * Exposed as an endpoint rather than only a timer so the pipeline can be driven
 * deterministically: a scheduled `setInterval` calls the same service, and a
 * test or an operator can trigger it on demand. Restricted to admins because it
 * sends mail on behalf of other users.
 */
router.post(
  '/process',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const role = req.user!.role as unknown as UserRole;
    if (role !== UserRole.PLATFORM_ADMIN && role !== UserRole.COMPANY_ADMIN) {
      throw new ForbiddenError('Only administrators can drain the notification queue');
    }
    res.json({ success: true, data: await processPendingEmails(50) });
  }
);

/**
 * Restrictions placed by this buyer.
 *
 * Kept separate from the communication module's own endpoint so the frontend
 * has one place to read buyer-side moderation state.
 */
router.get(
  '/restrictions',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.json({ success: true, data: await listRestrictedVendors(req.user!.tenantId, req.user!.userId) });
  }
);

router.delete(
  '/restrictions/:vendorId',
  validate(vendorIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const removed = await clearRestriction(req.user!.tenantId, req.user!.userId, req.params.vendorId);
    if (removed === 0) throw new NotFoundError('Restriction');

    await createAuditLog({
      userId: req.user!.userId,
      action: AuditAction.VENDOR_UNBLOCKED,
      entityType: 'ContactRestriction',
      entityId: req.params.vendorId,
      tenantId: req.user!.tenantId,
    });

    res.json({ success: true });
  }
);

export default router;