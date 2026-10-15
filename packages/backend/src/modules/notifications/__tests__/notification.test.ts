import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { NotificationFrequency } from '@navo/shared';
import { renderEmail } from '../email.templates.js';
import { setEmailProvider, EmailProvider, SendInput } from '../email.provider.js';
import { createAuditLog } from '../../audit/audit.service.js';
import {
  listNotifications,
  markNotificationRead,
  markRoomRead,
  notify,
  processPendingEmails,
  setPreference,
  suppressPendingFor,
  unreadCount,
} from '../notification.service.js';

/**
 * Notification tests.
 *
 * Three behaviours are worth proving here, because each is easy to get subtly
 * wrong and none is visible in a manual smoke test:
 *
 *  1. **No duplicate email.** A unique `dedupeKey` must collapse repeated and
 *     concurrent triggers into one delivery row.
 *  2. **No confidential leakage.** Email previews must not carry prices,
 *     quantities, attachments or counterparty contact details.
 *  3. **Reading suppresses email.** Opening a conversation must stop the
 *     pending backlog rather than producing a burst of stale mail.
 */

interface Row {
  [key: string]: unknown;
}

type ErrorConstructorLike = new (...args: unknown[]) => Error;

const {
  db,
  prismaMock,
  adoptPrismaErrorClass,
} = vi.hoisted(() => {
  const state = {
    users: [] as Row[],
    notifications: [] as Row[],
    deliveries: [] as Row[],
    prefs: [] as Row[],
    messages: [] as Row[],
    readReceipts: [] as Row[],
  };

  /** Prisma accepts either a bare enum value or `{ in: [...] }`. */
  const matchesStatus = (value: unknown, filter: unknown): boolean => {
    if (filter && typeof filter === 'object' && 'in' in (filter as Row)) {
      return ((filter as { in: unknown[] }).in as unknown[]).includes(value);
    }
    return value === filter;
  };

  const applyUpdate = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in (value as Row)) {
        row[key] = (Number(row[key]) || 0) + Number((value as { increment: number }).increment);
      } else {
        row[key] = value;
      }
    }
  };

  /**
   * A stand-in for `Prisma.PrismaClientKnownRequestError`.
   *
   * The service branches on `instanceof`, so the mock must satisfy that check
   * rather than merely carry a `code` property. The real class is not reachable
   * from inside a hoisted factory, so the thrown object is re-prototyped onto
   * it by `adoptPrismaErrorClass` once the module graph has loaded.
   */
  let PrismaErrorCtor: ErrorConstructorLike | null = null;
  const uniqueError = (message: string): Error => {
    const err = new Error(message);
    if (PrismaErrorCtor) Object.setPrototypeOf(err, PrismaErrorCtor.prototype);
    (err as unknown as Row).code = 'P2002';
    return err;
  };

  const mock = {
  user: {
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const user = state.users.find((u) => u.id === where.id);
      if (!user) return null;
      if (where.isActive && user.isActive !== true) return null;
      if (where.tenantId && user.tenantId !== where.tenantId) return null;
      return user;
    }),
  },
  notificationPreference: {
    findUnique: vi.fn(async ({ where }: { where: { userId_eventType: { userId: string; eventType: string } } }) =>
      state.prefs.find(
        (p) =>
          p.userId === where.userId_eventType.userId &&
          p.eventType === where.userId_eventType.eventType
      ) ?? null
    ),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = state.prefs.find(
        (p) => p.userId === where.userId_eventType.userId && p.eventType === where.userId_eventType.eventType
      );
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const created = { id: `pref-${state.prefs.length + 1}`, ...create };
      state.prefs.push(created);
      return created;
    }),
    findMany: vi.fn(async () => state.prefs),
  },
  notification: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = {
        id: `notif-${state.notifications.length + 1}`,
        isRead: false,
        readAt: null,
        ...data,
      };
      state.notifications.push(row);
      return row;
    }),
    count: vi.fn(async ({ where }: { where: Row }) =>
      state.notifications.filter(
        (n) => n.userId === where.userId && (where.isRead === undefined || n.isRead === where.isRead)
      ).length
    ),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      state.notifications.filter((n) => n.userId === where.userId).slice().reverse()
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = state.notifications.filter(
        (n) => n.id === where.id && n.userId === where.userId
      );
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    }),
  },
    /**
   * Prisma applies column defaults in the database, not in the client, so the
   * mock has to seed them on insert. Without this, `status` would be undefined
   * and every "is it still pending?" assertion would be meaningless.
   */
  emailDelivery: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = {
        id: `delivery-${state.deliveries.length + 1}`,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(),
        ...data,
      } as Row;
      // Unique-index semantics: a duplicate key loses the insert race.
      if (state.deliveries.some((d) => d.dedupeKey === row.dedupeKey)) {
        throw uniqueError('Unique constraint failed on dedupeKey');
      }
      state.deliveries.push(row);
      return row;
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      state.deliveries
        .filter((d) => {
          if (where.status !== undefined && !matchesStatus(d.status, where.status)) return false;
          const lte = (where.nextAttemptAt as { lte?: Date } | undefined)?.lte;
          if (lte && new Date(d.nextAttemptAt as string) > lte) return false;
          return true;
        })
        .sort(
          (a, b) =>
            new Date(a.nextAttemptAt as string).getTime() -
            new Date(b.nextAttemptAt as string).getTime()
        )
    ),
    // Claiming is a conditional update: a row another worker already claimed
    // must match zero rows here, which is what makes the batch safe to run
    // concurrently.
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const rows = state.deliveries.filter((d) => {
        if (where.id !== undefined && d.id !== where.id) return false;
        if (where.recipientId !== undefined && d.recipientId !== where.recipientId) return false;
        if (where.status !== undefined && !matchesStatus(d.status, where.status)) return false;
        return true;
      });
      rows.forEach((r) => applyUpdate(r, data));
      return { count: rows.length };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = state.deliveries.find((d) => d.id === where.id);
      if (row) applyUpdate(row, data);
      return row;
    }),
  },
  dealMessage: {
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      state.messages.filter(
        (m) =>
          m.dealRoomId === where.dealRoomId &&
          m.senderId !== (where.senderId as { not: string }).not
      )
    ),
    count: vi.fn(async ({ where }: { where: Row }) => {
      const senderNot = (where.senderId as { not: string }).not;
      const gt = (where.createdAt as { gt?: Date } | undefined)?.gt;
      return state.messages.filter(
        (m) =>
          m.dealRoomId === where.dealRoomId &&
          m.senderId !== senderNot &&
          (!gt || (m.createdAt as Date) > gt)
      ).length;
    }),
  },
  dealMessageRead: {
    findMany: vi.fn(async ({ where }: { where: Row }) =>
      state.readReceipts
        .filter((r) => r.readerId === where.readerId && r.dealRoomId === where.dealRoomId)
        .map((r) => {
          const message = state.messages.find((m) => m.id === r.messageId);
          return message ? ({ ...r, message } as Row) : null;
        })
        .filter((r): r is Row => r !== null)
    ),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      let created = 0;
      for (const row of data) {
        const dup = state.readReceipts.some(
          (r) => r.messageId === row.messageId && r.readerId === row.readerId
        );
        if (!dup) {
          state.readReceipts.push({ ...row, readAt: new Date().toISOString() });
          created += 1;
        }
      }
return { count: created };
    }),
  },
  };

  return {
    db: state,
    prismaMock: mock,
    adoptPrismaErrorClass: (ctor: ErrorConstructorLike) => {
      PrismaErrorCtor = ctor;
    },
  };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../../audit/audit.service.js', () => ({ createAuditLog: vi.fn(async () => undefined) }));

// Teach the hoisted mock about the real Prisma error class now that it is
// importable, so `instanceof Prisma.PrismaClientKnownRequestError` holds.
adoptPrismaErrorClass(Prisma.PrismaClientKnownRequestError as unknown as ErrorConstructorLike);

const BUYER = 'user-buyer';
const SELLER = 'user-seller';

beforeEach(() => {
  db.users.length = 0;
  db.notifications.length = 0;
  db.deliveries.length = 0;
  db.prefs.length = 0;
  db.messages.length = 0;
  db.readReceipts.length = 0;
  vi.clearAllMocks();

  db.users.push(
    { id: BUYER, tenantId: 'tenant-a', email: 'buyer@example.com', firstName: 'Ada', isActive: true },
    { id: SELLER, tenantId: 'tenant-a', email: 'seller@example.com', firstName: 'Sam', isActive: true }
  );
});

describe('duplicate prevention', () => {
  it('does not queue a second email for the same logical notification', async () => {
    const input = {
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'OFFER_ACCEPTED' as const,
      linkPath: '/deals/1',
      preview: 'An offer was accepted',
      dedupeKey: 'offer-accepted:offer-1',
    };

    await notify(input);
    await notify(input);

    expect(db.deliveries).toHaveLength(1);
  });

  it('still records the in-app notification each time', async () => {
    const input = {
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'OFFER_ACCEPTED' as const,
      linkPath: '/deals/1',
      preview: 'An offer was accepted',
      dedupeKey: 'offer-accepted:offer-1',
    };
    await notify(input);
    await notify(input);
    // The inbox is a history; the email is deduplicated.
    expect(db.notifications.length).toBeGreaterThanOrEqual(2);
    expect(db.deliveries).toHaveLength(1);
  });

  it('allows distinct notifications of the same type', async () => {
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'OFFER_ACCEPTED',
      linkPath: '/deals/1',
      preview: 'First',
      dedupeKey: 'offer-accepted:offer-1',
    });
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'OFFER_ACCEPTED',
      linkPath: '/deals/2',
      preview: 'Second',
      dedupeKey: 'offer-accepted:offer-2',
    });
    expect(db.deliveries).toHaveLength(2);
  });

  it('batches a burst of messages into one digest', async () => {
    // Messages default to DIGEST, so the dedupe key is per window, not per
    // message. Five messages in quick succession must yield one email.
    for (let i = 0; i < 5; i++) {
      await notify({
        tenantId: 'tenant-a',
        recipientId: BUYER,
        event: 'NEGOTIATION_MESSAGE',
        linkPath: `/deals/new?dealRoomId=room-1`,
        preview: `Message ${i}`,
        dedupeKey: `message:${i}`,
      });
    }
    expect(db.deliveries).toHaveLength(1);
  });
});

describe('preferences', () => {
  it('sends nothing when the user turned the event off', async () => {
    await setPreference('tenant-a', BUYER, 'DEAL_CLOSED', NotificationFrequency.OFF);
    const result = await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/deals/1',
      preview: 'Closed',
      dedupeKey: 'deal-closed:1',
    });
    expect(result).toBeNull();
    expect(db.deliveries).toHaveLength(0);
    // The in-app record is suppressed too, so the UI matches the preference.
    expect(db.notifications).toHaveLength(0);
  });

  it('honours an explicit immediate preference for a digest event', async () => {
    await setPreference('tenant-a', BUYER, 'NEGOTIATION_MESSAGE', NotificationFrequency.IMMEDIATE);
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'NEGOTIATION_MESSAGE',
      linkPath: '/deals/1',
      preview: 'Hello',
      dedupeKey: 'message:1',
    });
    // Immediate means per-message dedupe, so the key is the caller's own.
    expect(db.deliveries[0].dedupeKey).toBe('message:1');
  });

  it('ignores an inactive recipient without throwing', async () => {
    db.users[0].isActive = false;
    const result = await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k',
    });
    expect(result).toBeNull();
  });

  it('ignores a recipient in another tenant', async () => {
    const result = await notify({
      tenantId: 'tenant-b',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k',
    });
    expect(result).toBeNull();
  });
});

describe('confidentiality of previews', () => {
  it('never includes amounts, quantities or attachment names', () => {
    const rendered = renderEmail('COUNTEROFFER', {
      recipientName: 'Ada',
      // A caller trying to smuggle commercial detail into the preview.
      preview: 'Counter at 48,000 for 200 units, see quotation.pdf',
      linkPath: '/deals/new?dealRoomId=room-1',
      dedupeKey: 'k',
    });

    expect(rendered.subject).toBe('New counteroffer');
    expect(rendered.subject).not.toMatch(/48,000|200 units|\.pdf/);
    // The generic framing is preserved; the detail stays behind authentication.
    expect(rendered.text).toContain('A counteroffer is waiting for you.');
  });

  it('escapes markup in a preview so it cannot inject content', () => {
    const rendered = renderEmail('DEAL_STATUS_CHANGE', {
      recipientName: 'Ada',
      preview: '<script>alert(1)</script> deal moved',
      linkPath: '/deals/1',
      dedupeKey: 'k',
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('truncates an over-long preview so the subject stays short', () => {
    const rendered = renderEmail('NEW_OPPORTUNITY', {
      recipientName: 'Ada',
      preview: 'x'.repeat(500),
      linkPath: '/market',
      dedupeKey: 'k',
    });
    expect(rendered.subject.length).toBeLessThan(160);
  });

  it('links back to NAVO rather than embedding the content', () => {
    const rendered = renderEmail('NEGOTIATION_MESSAGE', {
      recipientName: 'Ada',
      preview: 'New message',
      linkPath: '/deals/new?dealRoomId=room-9',
      dedupeKey: 'k',
    });
    expect(rendered.text).toContain('/deals/new?dealRoomId=room-9');
    expect(rendered.text).toContain('Sign in to NAVO');
  });
});

describe('delivery processing', () => {
  it('marks a sent email as delivered', async () => {
    const sent: SendInput[] = [];
    const provider: EmailProvider = {
      name: 'stub',
      async send(input) {
        sent.push(input);
        return { sent: true, retryable: false };
      },
    };
    setEmailProvider(provider);

    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/deals/1',
      preview: 'Closed',
      dedupeKey: 'k1',
    });

    const result = await processPendingEmails();
    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(db.deliveries[0].status).toBe('SENT');
    setEmailProvider(null);
  });

  it('retries a transient failure instead of losing it', async () => {
    setEmailProvider({
      name: 'flaky',
      async send() {
        return { sent: false, retryable: true, error: 'connection reset' };
      },
    });

    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k2',
    });

    const result = await processPendingEmails();
    expect(result.failed).toBe(1);
    // Still recoverable, so it is not marked permanently failed.
    expect(db.deliveries[0].status).toBe('FAILED');
    expect(db.deliveries[0].lastError).toContain('connection reset');
    setEmailProvider(null);
  });

  it('gives up on a permanent failure and records why', async () => {
    setEmailProvider({
      name: 'hard-fail',
      async send() {
        return { sent: false, retryable: false, error: 'mailbox does not exist' };
      },
    });

    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k3',
    });

    await processPendingEmails();
    expect(db.deliveries[0].status).toBe('PERMANENTLY_FAILED');
    setEmailProvider(null);
  });

  it('does not resend an already-delivered email', async () => {
    const sent: SendInput[] = [];
    setEmailProvider({
      name: 'stub',
      async send(input) {
        sent.push(input);
        return { sent: true, retryable: false };
      },
    });

    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k4',
    });

    await processPendingEmails();
    await processPendingEmails();
    expect(sent).toHaveLength(1);
    setEmailProvider(null);
  });
});

describe('suppression on read', () => {
  it('drops the pending backlog when the user returns', async () => {
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k5',
    });
    expect(db.deliveries[0].status).toBe('PENDING');

    const suppressed = await suppressPendingFor(BUYER);
    expect(suppressed).toBe(1);
    expect(db.deliveries[0].status).toBe('SUPPRESSED');
  });

  it('does not suppress another user\'s queue', async () => {
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k6',
    });
    await suppressPendingFor(SELLER);
    expect(db.deliveries[0].status).toBe('PENDING');
  });
});

describe('unread tracking', () => {
  beforeEach(() => {
    const t = new Date('2026-01-01T10:00:00Z');
    db.messages.push(
      { id: 'm1', dealRoomId: 'room-1', senderId: SELLER, createdAt: new Date(t.getTime() + 1000) },
      { id: 'm2', dealRoomId: 'room-1', senderId: SELLER, createdAt: new Date(t.getTime() + 2000) },
      { id: 'm3', dealRoomId: 'room-1', senderId: SELLER, createdAt: new Date(t.getTime() + 3000) }
    );
  });

  it('counts every message the reader has not read', async () => {
    expect(await unreadCount('room-1', BUYER)).toBe(3);
  });

  it('never counts the reader\'s own messages', async () => {
    expect(await unreadCount('room-1', SELLER)).toBe(0);
  });

  it('drops the count once the room is marked read', async () => {
    await markRoomRead('room-1', BUYER);
    expect(await unreadCount('room-1', BUYER)).toBe(0);
  });

  it('counts only messages after the last read one', async () => {
    await markRoomRead('room-1', BUYER);
    db.messages.push({
      id: 'm4',
      dealRoomId: 'room-1',
      senderId: SELLER,
      createdAt: new Date('2026-01-01T11:00:00Z'),
    });
    expect(await unreadCount('room-1', BUYER)).toBe(1);
  });

  it('is idempotent: marking read twice changes nothing', async () => {
    await markRoomRead('room-1', BUYER);
    const second = await markRoomRead('room-1', BUYER);
    expect(second).toBe(0);
    expect(db.readReceipts).toHaveLength(3);
  });

  it('keeps read state per reader', async () => {
    await markRoomRead('room-1', BUYER);
    expect(await unreadCount('room-1', BUYER)).toBe(0);
    expect(await unreadCount('room-1', SELLER)).toBe(0);
  });
});

describe('in-app inbox', () => {
  it('reports unread alongside the list', async () => {
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k7',
    });
    const result = await listNotifications('tenant-a', BUYER);
    expect(result.unread).toBe(1);
    expect(result.items).toHaveLength(1);
  });

  it('marks one notification read without touching the others', async () => {
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'One',
      dedupeKey: 'k8',
    });
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'OFFER_ACCEPTED',
      linkPath: '/y',
      preview: 'Two',
      dedupeKey: 'k9',
    });

    const first = db.notifications[0];
    expect(await markNotificationRead('tenant-a', BUYER, first.id as string)).toBe(true);
    expect((await listNotifications('tenant-a', BUYER)).unread).toBe(1);
  });

  it('refuses to mark another user\'s notification', async () => {
    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k10',
    });
    expect(await markNotificationRead('tenant-a', SELLER, db.notifications[0].id as string)).toBe(
      false
    );
  });
});

describe('email delivery failure audit log', () => {
  beforeEach(() => {
    vi.mocked(createAuditLog).mockClear();
  });

  it('audit log for permanent failure includes correct tenantId', async () => {
    setEmailProvider({
      name: 'hard-fail-tenant',
      async send() {
        return { sent: false, retryable: false, error: 'mailbox does not exist' };
      },
    });

    await notify({
      tenantId: 'tenant-a',
      recipientId: BUYER,
      event: 'DEAL_CLOSED',
      linkPath: '/x',
      preview: 'Closed',
      dedupeKey: 'k-hard-fail-tenant',
    });

    await processPendingEmails();

    const failureCall = vi.mocked(createAuditLog).mock.calls.find(
      (call) => call[0].action === 'EMAIL_DELIVERY_FAILED'
    );
    expect(failureCall).toBeDefined();
    expect(failureCall![0].tenantId).toBe('tenant-a');
    setEmailProvider(null);
  });
});