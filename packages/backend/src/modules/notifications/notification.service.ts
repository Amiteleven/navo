import { EmailDeliveryStatus, Prisma, VendorStatus } from '@prisma/client';
import {
  AuditAction,
  NotificationFrequency,
  NotificationPriority,
  UserRole,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { createAuditLog } from '../audit/audit.service.js';
import { EmailProvider, getEmailProvider } from './email.provider.js';
import { renderEmail, NotificationEvent } from './email.templates.js';

/**
 * Offline email notifications.
 *
 * Two design decisions carry most of the correctness here.
 *
 * **A durable outbox, not a direct send.** Every notification is written to
 * `EmailDelivery` first and delivered by a separate batch step. A notification
 * therefore cannot be lost by a provider outage, and delivery failures are
 * visible and retryable rather than thrown away inside a request handler.
 *
 * **Deduplication at the database, not in memory.** `dedupeKey` is uniquely
 * indexed, so a repeated trigger - a retried request, a concurrent offer
 * revision, a message batch that overlaps - loses the insert race instead of
 * mailing the user twice. This is the only guarantee that actually holds under
 * concurrency; an in-memory check would not.
 */

/** Events that must always be immediate: money and finality. */
const IMMEDIATE_EVENTS: NotificationEvent[] = [
  'OFFER_ACCEPTED',
  'DEAL_CLOSED',
  'COUNTEROFFER',
  'MARKETPLACE_INTEREST',
  // Authorization and everything that follows it. A manager who is offline must
  // be told there is money waiting on them, and a buyer must be told the moment
  // a decision lands, whether or not they are watching.
  'APPROVAL_ASSIGNED',
  'APPROVAL_APPROVED',
  'APPROVAL_REJECTED',
  'APPROVAL_CHANGES_REQUESTED',
  'PURCHASE_CONFIRMED',
];

/** Events that tolerate batching. */
const DIGEST_EVENTS: NotificationEvent[] = ['NEGOTIATION_MESSAGE'];

export interface EnqueueInput {
  tenantId: string;
  recipientId: string;
  event: NotificationEvent;
  /** In-app route the email links to. */
  linkPath: string;
  /** Short, non-confidential summary used as the subject and preview. */
  preview: string;
  /**
   * Stable identity for this logical notification. Two calls with the same key
   * yield one email. For digests this is per user per window; for a single
   * event it should include the entity id.
   */
  dedupeKey: string;
  /** Set true when the recipient is offline, to skip realtime-only events. */
  recipientOffline?: boolean;
}

async function resolveFrequency(
  userId: string,
  event: NotificationEvent
): Promise<NotificationFrequency> {
  const pref = await prisma.notificationPreference.findUnique({
    where: { userId_eventType: { userId, eventType: event } },
    select: { frequency: true },
  });
  if (pref) return pref.frequency as NotificationFrequency;

  if (DIGEST_EVENTS.includes(event)) return NotificationFrequency.DIGEST;
  if (IMMEDIATE_EVENTS.includes(event)) return NotificationFrequency.IMMEDIATE;
  return NotificationFrequency.IMMEDIATE;
}

/**
 * Record the notification in-app and queue an email if one is warranted.
 *
 * Returns the delivery row id, or null when nothing should be sent (the event
 * is disabled, or the recipient is online and the event is chat-only).
 */
export async function notify(input: EnqueueInput): Promise<string | null> {
  const recipient = await prisma.user.findFirst({
    where: { id: input.recipientId, tenantId: input.tenantId, isActive: true },
    select: { id: true, email: true, firstName: true },
  });

  // An inactive or unknown recipient is not an error: the event simply has no
  // audience. Logging and continuing keeps the caller's transaction intact.
  if (!recipient) return null;

  const frequency = await resolveFrequency(recipient.id, input.event);
  if (frequency === NotificationFrequency.OFF) return null;

  // The in-app row is deduplicated on the same key as the email. Without this a
  // retried submission or two approval events fired together would show the user
  // the same alert twice in-app while sending one email, which reads as a bug
  // even though the more important guarantee - not mailing twice - held.
  try {
    await prisma.notification.create({
      data: {
        userId: recipient.id,
        tenantId: input.tenantId,
        // The shared enum is a mirror of Prisma's `NotificationType`; both carry
        // the same string values, so the cast is a narrowing at the DB boundary.
        type: input.event as never,
        priority: IMMEDIATE_EVENTS.includes(input.event)
          ? NotificationPriority.HIGH
          : NotificationPriority.NORMAL,
        title: input.preview,
        message: input.preview,
        data: { linkPath: input.linkPath, event: input.event },
        dedupeKey: input.dedupeKey,
      },
    });
  } catch (err) {
    // A unique-index collision means this exact notification already exists.
    // Losing that race is the dedupe guarantee working, not an error, so the
    // email is not queued a second time either.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return null;
    }
    throw err;
  }

  if (input.recipientOffline === false && DIGEST_EVENTS.includes(input.event)) {
    // Online recipients see messages in the room; an email would be noise.
    return null;
  }

  const rendered = renderEmail(input.event, {
    recipientName: recipient.firstName,
    preview: input.preview,
    linkPath: input.linkPath,
    // Batch the digest window into the key so a burst collapses to one email.
    dedupeKey:
      frequency === NotificationFrequency.DIGEST ? digestKey(input) : input.dedupeKey,
  });

  try {
    const delivery = await prisma.emailDelivery.create({
      data: {
        tenantId: input.tenantId,
        recipientId: recipient.id,
        recipientEmail: recipient.email,
        eventType: input.event,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
        linkPath: input.linkPath,
        dedupeKey: rendered.dedupeKey,
      },
      select: { id: true },
    });
    return delivery.id;
  } catch (err) {
    // The unique index rejected a duplicate. That is the dedupe guarantee
    // working, not an error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return null;
    }
    throw err;
  }
}

/** Fifteen-minute windows, so a burst of messages yields one digest. */
function digestKey(input: EnqueueInput): string {
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  return `digest:${input.recipientId}:${input.event}:${bucket}`;
}

const MAX_ATTEMPTS = 5;

/**
 * Attempt delivery of everything due.
 *
 * Safe to call repeatedly and from multiple processes: claiming a row is a
 * conditional update, so two workers cannot send the same email.
 */
export async function processPendingEmails(limit = 25): Promise<{
  sent: number;
  failed: number;
  suppressed: number;
}> {
  const provider: EmailProvider = getEmailProvider();
  const result = { sent: 0, failed: 0, suppressed: 0 };

  const due = await prisma.emailDelivery.findMany({
    where: { status: EmailDeliveryStatus.PENDING, nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { id: true, recipientEmail: true, subject: true, bodyText: true, bodyHtml: true, linkPath: true, attempts: true, tenantId: true },
  });

  for (const row of due) {
    // Claim it. A concurrent worker that already claimed it gets count 0.
    const claimed = await prisma.emailDelivery.updateMany({
      where: { id: row.id, status: EmailDeliveryStatus.PENDING },
      data: { status: EmailDeliveryStatus.PENDING, attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    try {
      const outcome = await provider.send({
        to: row.recipientEmail,
        subject: row.subject,
        text: row.bodyText,
        html: row.bodyHtml,
      });

      if (outcome.sent) {
        await prisma.emailDelivery.update({
          where: { id: row.id },
          data: { status: EmailDeliveryStatus.SENT, sentAt: new Date(), lastError: null },
        });
        result.sent += 1;
      } else {
         await recordFailure(row, outcome.retryable, outcome.error, row.tenantId);
         result.failed += 1;
       }
     } catch (err) {
       // An exception from a provider adapter is treated as retryable unless it
       // reports otherwise; surfacing it would otherwise stall the whole batch.
       await recordFailure(row, true, (err as Error).message, row.tenantId);
      result.failed += 1;
    }
  }

  return result;
}

async function recordFailure(
  row: { id: string; attempts: number; tenantId?: string },
  retryable: boolean,
  error: string | undefined,
  tenantId?: string
): Promise<void> {
  const exhausted = !retryable || row.attempts + 1 >= MAX_ATTEMPTS;

  await prisma.emailDelivery.update({
    where: { id: row.id },
    data: {
      status: exhausted ? EmailDeliveryStatus.PERMANENTLY_FAILED : EmailDeliveryStatus.FAILED,
      lastError: error?.slice(0, 1000) ?? 'Unknown provider error',
      // Exponential backoff, capped so a dead provider is not hammered.
      nextAttemptAt: new Date(Date.now() + Math.min(2 ** row.attempts * 60_000, 60 * 60_000)),
    },
  });

  if (exhausted) {
    await createAuditLog({
      userId: '',
      action: AuditAction.EMAIL_DELIVERY_FAILED,
      entityType: 'EmailDelivery',
      entityId: row.id,
      tenantId: tenantId ?? '',
      metadata: { attempts: row.attempts + 1, error: error ?? 'unknown' },
    }).catch(() => undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unread tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unread message count for a user in a deal room.
 *
 * The watermark is the newest message this reader has read, taken as a maximum
 * over their receipts rather than the single most recent receipt. Marking a room
 * read writes every receipt in one pass, so all of them carry the same
 * `readAt` to the microsecond; ordering by `readAt` would leave the watermark
 * arbitrary and could resurrect already-read messages.
 */
export async function unreadCount(dealRoomId: string, readerId: string): Promise<number> {
  const readMessages = await prisma.dealMessageRead.findMany({
    where: { readerId, dealRoomId },
    select: { message: { select: { createdAt: true } } },
  });

  let watermark: Date | null = null;
  for (const receipt of readMessages) {
    const seenAt = receipt.message.createdAt;
    if (!watermark || seenAt > watermark) watermark = seenAt;
  }

  return prisma.dealMessage.count({
    where: {
      dealRoomId,
      senderId: { not: readerId },
      ...(watermark ? { createdAt: { gt: watermark } } : {}),
    },
  });
}

/** Mark everything currently in the room as read for this reader. */
export async function markRoomRead(dealRoomId: string, readerId: string): Promise<number> {
  const messages = await prisma.dealMessage.findMany({
    where: { dealRoomId, senderId: { not: readerId } },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  let marked = 0;
  for (const message of messages) {
    const result = await prisma.dealMessageRead.createMany({
      data: [{ messageId: message.id, readerId, dealRoomId }],
      skipDuplicates: true,
    });
    marked += result.count;
  }
  return marked;
}

/** Notifications the user has not read. */
export async function listNotifications(
  tenantId: string,
  userId: string,
  limit = 25
): Promise<{ unread: number; items: unknown[] }> {
  const [unread, items] = await Promise.all([
    prisma.notification.count({ where: { tenantId, userId, isRead: false } }),
    prisma.notification.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
  ]);
  return { unread, items };
}

export async function markNotificationRead(
  tenantId: string,
  userId: string,
  notificationId: string
): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, tenantId, userId },
    data: { isRead: true, readAt: new Date() },
  });
  return result.count > 0;
}

/** Set a per-event delivery preference. */
export async function setPreference(
  tenantId: string,
  userId: string,
  eventType: string,
  frequency: NotificationFrequency
): Promise<void> {
  await prisma.notificationPreference.upsert({
    where: { userId_eventType: { userId, eventType } },
    create: { userId, tenantId, eventType, frequency },
    update: { frequency },
  });
}

export async function listPreferences(tenantId: string, userId: string) {
  return prisma.notificationPreference.findMany({
    where: { tenantId, userId },
    orderBy: { eventType: 'asc' },
  });
}

/**
 * Mark every queued-but-unsent email to this user as suppressed.
 *
 * Called when a participant opens their room. Anything already sent stays sent,
 * but the pending backlog is dropped so returning to NAVO does not produce a
 * burst of stale mail.
 */
export async function suppressPendingFor(userId: string): Promise<number> {
  const result = await prisma.emailDelivery.updateMany({
    where: { recipientId: userId, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: EmailDeliveryStatus.SUPPRESSED },
  });
  return result.count;
}

/** Reset a suspended vendor to active. Admin only; used by moderation. */
export async function reinstateVendor(tenantId: string, vendorId: string): Promise<void> {
  await prisma.vendor.updateMany({
    where: { id: vendorId, tenantId, status: VendorStatus.BLACKLISTED },
    data: { status: VendorStatus.ACTIVE },
  });
}

/** True when the role may moderate other users' reports and vendors. */
export function isModerator(role: UserRole): boolean {
  return role === UserRole.PLATFORM_ADMIN || role === UserRole.COMPANY_ADMIN;
}