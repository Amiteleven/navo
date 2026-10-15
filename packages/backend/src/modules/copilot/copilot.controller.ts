import { UserRole } from '@navo/shared';
import { Response } from 'express';
import { z } from 'zod';
import prisma from '../../utils/prisma.js';
import { validate } from '../../middleware/validate.js';
import { AuthenticationError } from '../../utils/errors.js';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { serializeMoney } from '../../utils/serialize.js';
import { ask, executeAction, proposeAction } from './copilot.service.js';
import {
  resolveCopilotActor,
  buildScope,
  CopilotScope,
} from './copilot-access.js';
import {
  listTools,
  availableToolNames,
  getTool,
} from './tool-registry.js';
import { suggestedPrompts, contextualPrompts } from './planner.js';

// Tool modules self-register on import.
import './tools/read-tools.js';
import './tools/analysis-tools.js';

/**
 * HTTP surface for the copilot.
 *
 * Authorization is resolved once per request into a `CopilotScope` and handed
 * to the services. No handler trusts a client-supplied user, tenant or vendor.
 */

function actor(req: AuthenticatedRequest): {
  userId: string;
  tenantId: string;
  role: UserRole;
} {
  if (!req.user) throw new AuthenticationError();
  return { userId: req.user.userId, tenantId: req.user.tenantId, role: roleOf(req) };
}

async function scopeFor(req: AuthenticatedRequest): Promise<CopilotScope> {
  const base = actor(req);
  const resolved = await resolveCopilotActor(base.userId, base.tenantId, base.role);
  return buildScope(resolved);
}

/**
 * `req.user.role` is the Prisma enum and `@navo/shared`'s `UserRole` is a
 * separate TypeScript enum with identical string values. Narrowing once here
 * keeps a single canonical `UserRole` inside the copilot, matching
 * `resolveSellerVendor` in the purchase-order module.
 */
function roleOf(req: AuthenticatedRequest): UserRole {
  if (!req.user) throw new AuthenticationError();
  return req.user.role as unknown as UserRole;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const askSchema = z.object({
  body: z.object({
    message: z.string().min(1, 'A question is required').max(2000),
    conversationId: z.string().min(1).max(64).optional(),
    context: z
      .object({
        entityType: z
          .enum([
            'REQUEST',
            'VENDOR',
            'RFQ',
            'QUOTE',
            'DEAL',
            'DEAL_ROOM',
            'PURCHASE_ORDER',
            'INVOICE',
          ])
          .optional(),
        entityId: z.string().min(1).max(64).optional(),
        entityLabel: z.string().max(200).optional(),
      })
      .optional(),
  }),
});

const conversationIdParam = z.object({
  params: z.object({ conversationId: z.string().min(1, 'Conversation ID is required') }),
});

const actionIdParam = z.object({
  params: z.object({ actionId: z.string().min(1, 'Action ID is required') }),
});

const proposeSchema = z.object({
  body: z.object({
    type: z.string().min(1).max(64),
    payload: z.record(z.unknown()),
    conversationId: z.string().min(1).max(64).optional(),
  }),
});

const preferenceSchema = z.object({
  key: z.string().min(1).max(64),
  value: z.unknown(),
});

const preferenceKeySchema = z.object({
  body: z.object({ key: z.string().min(1).max(64) }),
});

// ── Handlers ──────────────────────────────────────────────────────────────────

/** Ask a question. */
export const askHandler = [
  validate(askSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await ask(
      {
        message: req.body.message,
        conversationId: req.body.conversationId,
        context: req.body.context,
      },
      actor(req)
    );
    res.json({ success: true, data: serializeMoney(result) });
  },
];

/** List the caller's conversations. */
export const listConversationsHandler = [
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const base = actor(req);
    const conversations = await prisma.copilotConversation.findMany({
      where: { userId: base.userId, tenantId: base.tenantId, isArchived: false },
      select: {
        id: true,
        title: true,
        contextType: true,
        contextId: true,
        contextLabel: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
    res.json({ success: true, data: serializeMoney(conversations) });
  },
];

/** Fetch one conversation with its full message history. */
export const getConversationHandler = [
  validate(conversationIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const base = actor(req);
    const conversation = await prisma.copilotConversation.findFirst({
      where: {
        id: req.params.conversationId,
        userId: base.userId,
        tenantId: base.tenantId,
      },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        actions: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });

    // Absent rather than forbidden, so conversation ids cannot be probed.
    if (!conversation) {
      res.status(404).json({ success: false, error: 'Conversation not found', code: 'NOT_FOUND' });
      return;
    }

    res.json({ success: true, data: serializeMoney(conversation) });
  },
];

/** Start or continue a conversation without asking anything. */
export const createConversationHandler = [
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const base = actor(req);
    const conversation = await prisma.copilotConversation.create({
      data: { userId: base.userId, tenantId: base.tenantId },
      select: { id: true, createdAt: true, updatedAt: true },
    });
    res.status(201).json({ success: true, data: serializeMoney(conversation) });
  },
];

export const deleteConversationHandler = [
  validate(conversationIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const base = actor(req);
    // Cascades to messages and actions. Scoped to the owner so one user cannot
    // delete another's thread.
    await prisma.copilotConversation.deleteMany({
      where: { id: req.params.conversationId, userId: base.userId, tenantId: base.tenantId },
    });
    res.json({ success: true });
  },
];

/**
 * Proposal surface: expose an action for confirmation without running it.
 * Also used by the tests to prove that a prepared action changes nothing.
 */
export const proposeActionHandler = [
  validate(proposeSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const scope = await scopeFor(req);
    const { type, payload, conversationId } = req.body;

    // Without an explicit thread, reuse the caller's most recent one instead of
    // minting a fresh conversation per call. Minting would both orphan an empty
    // thread each time and defeat duplicate detection: two identical proposals
    // would land in different conversations and never be compared.
    const conversation = conversationId
      ? await prisma.copilotConversation.findFirst({
          where: { id: conversationId, userId: scope.actor.userId, tenantId: scope.actor.tenantId },
          select: { id: true },
        })
      : (
          await prisma.copilotConversation.findFirst({
            where: { userId: scope.actor.userId, tenantId: scope.actor.tenantId },
            orderBy: { updatedAt: 'desc' },
            select: { id: true },
          })
        ) ??
        (await prisma.copilotConversation.create({
          data: { userId: scope.actor.userId, tenantId: scope.actor.tenantId },
          select: { id: true },
        }));

    if (!conversation) {
      res.status(404).json({ success: false, error: 'Conversation not found', code: 'NOT_FOUND' });
      return;
    }

    const proposal = await proposeAction(conversation.id, type as never, payload, scope);
    res.status(201).json({ success: true, data: serializeMoney(proposal) });
  },
];

/**
 * Confirm and execute a previously proposed action.
 * This is the only handler that writes a NAVO record through the copilot.
 */
export const confirmActionHandler = [
  validate(actionIdParam),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const scope = await scopeFor(req);
    const result = await executeAction(req.params.actionId, scope);
    res.json({ success: true, data: serializeMoney(result) });
  },
];

/** Capabilities and suggested prompts for the current caller. */
export const describeHandler = [
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const scope = await scopeFor(req);
    const names = availableToolNames(scope);

    res.json({
      success: true,
      data: {
        role: scope.actor.role,
        isSeller: scope.isSeller,
        tools: names.map((name) => {
          const tool = getTool(name);
          return {
            name,
            description: tool?.description ?? '',
            argumentHint: tool?.argHint ?? '',
          };
        }),
        suggestedQuestions: suggestedPrompts(scope.actor.role),
      },
    });
  },
];

/**
 * Contextual suggestions for the page the user is on. Purely derived from the
 * role and entity type, so it cannot leak anything about another tenant.
 */
export const suggestionsHandler = [
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const scope = await scopeFor(req);
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const entityLabel = typeof req.query.entityLabel === 'string' ? req.query.entityLabel : undefined;

    res.json({
      success: true,
      data: {
        suggestions: contextualPrompts(scope.actor.role, entityType, entityLabel),
      },
    });
  },
];

export const listToolsHandler = [
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const scope = await scopeFor(req);
    const names = new Set(availableToolNames(scope));
    res.json({
      success: true,
      data: listTools()
        .filter((tool) => names.has(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          argumentHint: tool.argHint,
        })),
    });
  },
];

// ── Preferences ───────────────────────────────────────────────────────────────

/**
 * Store an explicitly approved preference. Never inferred from conversation
 * history, and never used to widen data access - only to shape phrasing.
 */
export const setPreferenceHandler = [
  validate(preferenceSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const base = actor(req);
    const { key, value } = req.body;

    // An allowlist keeps a stored preference from becoming an injection vector
    // for later conversations.
    const ALLOWED = new Set(['preferredLocation', 'responseFormat', 'frequentCategories']);
    if (!ALLOWED.has(key)) {
      res.status(400).json({
        success: false,
        error: `Unknown preference. Allowed keys: ${[...ALLOWED].join(', ')}`,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const preference = await prisma.copilotPreference.upsert({
      where: { userId_key: { userId: base.userId, key } },
      create: {
        userId: base.userId,
        tenantId: base.tenantId,
        key,
        value: value as never,
      },
      update: { value: value as never },
      select: { key: true, value: true, updatedAt: true },
    });

    res.json({ success: true, data: serializeMoney(preference) });
  },
];

export const listPreferencesHandler = [
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const base = actor(req);
    const preferences = await prisma.copilotPreference.findMany({
      where: { userId: base.userId },
      select: { key: true, value: true, updatedAt: true },
      orderBy: { key: 'asc' },
    });
    res.json({ success: true, data: serializeMoney(preferences) });
  },
];

export const deletePreferenceHandler = [
  validate(preferenceKeySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const base = actor(req);
    await prisma.copilotPreference.deleteMany({
      where: { userId: base.userId, key: req.body.key },
    });
    res.json({ success: true });
  },
];