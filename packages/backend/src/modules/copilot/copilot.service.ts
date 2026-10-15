import { UserRole } from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { resolveCopilotActor, CopilotScope } from './copilot-access.js';
import { invokeTool, ToolInvocation } from './tool-registry.js';
import { planCalls } from './planner.js';
import { composeAnswer } from './composer.js';

// Tool modules self-register on import. The imports must stay: removing them
// would leave the registry empty and every question would answer "no data".
import './tools/read-tools.js';
import './tools/analysis-tools.js';
import '../requirement-intake/tools/requirement-intake-tools.js';

export { CopilotActionType } from '@navo/shared';

/**
 * The copilot orchestrator.
 *
 * Flow for one message:
 *   1. Resolve the caller into a scope (tenant, vendor link, buyer restriction).
 *   2. Plan deterministic tool calls from the message and the conversation's
 *      anchored record.
 *   3. Run each tool, which re-checks authorization per query.
 *   4. Compose a factual answer from the tool results.
 *   5. Persist both messages and audit the answer.
 *
 * No step asks a language model what to read or what is true. That is what makes
 * the access guarantees hold regardless of what the user types.
 */

export interface CopilotAnswer {
  /** The assistant's message, ready to render. */
  content: string;
  citations: Array<{
    entityType: string;
    entityId: string;
    label: string;
    href: string;
    status?: string;
    date?: string;
  }>;
  /** Follow-up chips. */
  suggestedQuestions: string[];
  /** True when the assistant could not answer from stored data. */
  notAnswerable: boolean;
  /** Which tools ran, for the UI's "answered from" disclosure. */
  toolsUsed: string[];
  /** A proposed action awaiting confirmation, if the user asked for one. */
  proposedAction?: {
    actionId: string;
    summary: string;
    details: Array<{ field: string; value: string }>;
    warnings: string[];
  };
}

export interface AskResult extends CopilotAnswer {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface AskInput {
  message: string;
  conversationId?: string;
  /** Records the caller is currently looking at, for contextual answers. */
  context?: { entityType?: string; entityId?: string; entityLabel?: string };
}

/**
 * Ask the copilot a question, creating or continuing a conversation.
 */
export async function ask(input: AskInput, actor: {
  userId: string;
  tenantId: string;
  role: UserRole;
}): Promise<AskResult> {
  const copilotActor = await resolveCopilotActor(actor.userId, actor.tenantId, actor.role);
  const scope: CopilotScope = { actor: copilotActor, isSeller: copilotActor.role === UserRole.VENDOR };

  const conversation = await resolveConversation(input.conversationId, scope, input.context);
  const question = input.message.trim();

  if (!question) {
    throw new Error('A question is required');
  }

  const userMessage = await prisma.copilotMessage.create({
    data: { conversationId: conversation.id, role: 'USER', content: question },
    select: { id: true },
  });

  // Anchor context is set on the conversation the first time it is supplied, so
  // later follow-ups ("what about delivery?") resolve against the same record.
  await applyContext(conversation, input.context, scope);

  const planned = planCalls(question, {
    role: copilotActor.role,
    contextEntityType: conversation.contextType ?? undefined,
    contextEntityId: conversation.contextId ?? undefined,
  });

  const invocations: ToolInvocation[] = [];
  const failures: Array<{ tool: string; reason: string }> = [];

  for (const call of planned) {
    try {
      const result = await invokeTool(call.tool, call.args, scope);
      invocations.push({ name: call.tool, args: call.args, result });
    } catch (err) {
      // A refused tool is recorded and surfaced, never silently replaced with a
      // guess. This is the visible trace of an authorization denial.
      failures.push({
        tool: call.tool,
        reason: err instanceof Error ? err.message : 'Tool failed',
      });
    }
  }

  const proposed = await maybeProposeAction(question, conversation.id, scope);

  const answer = await composeAnswer({
    question,
    invocations,
    failures,
    proposedAction: proposed,
    scope,
    hasContext: Boolean(conversation.contextId),
  });

  const assistantMessage = await prisma.copilotMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'ASSISTANT',
      content: answer.content,
      toolCalls: invocations.map((i) => ({
        tool: i.name,
        args: i.args,
        kind: i.result.kind,
        recordCount: i.result.citations.length,
      })) as never,
      citations: answer.citations as never,
      requiresConfirmation: Boolean(answer.proposedAction),
    },
    select: { id: true },
  });

  await prisma.copilotConversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });

  await auditAnswer(scope, answer, invocations.length);

  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    ...answer,
  };
}

/**
 * Detect an explicit request to create something and prepare - but not run - an
 * action. Parsing is deliberately conservative: only unambiguous phrasings
 * produce a proposal, because a wrong proposal still costs the user a click.
 */
async function maybeProposeAction(
  question: string,
  conversationId: string,
  scope: CopilotScope
): Promise<CopilotAnswer['proposedAction']> {
  const text = question.toLowerCase();

  const wantsRequest =
    /\b(create|raise|draft|start|make|new)\b.*\b(request|requisition|purchase request)\b/.test(text) ||
    /\b(i (need|want) to buy|i need)\b/.test(text);

  if (!wantsRequest) return undefined;
  if (scope.isSeller) return undefined;

  const draft = parseRequestDraft(question);
  if (!draft) return undefined;

  // Import lazily to keep the action tool module out of the read path.
  const { proposeAction } = await import('./tools/action-tools.js');
  const proposal = await proposeAction(
    conversationId,
    'CREATE_DRAFT_REQUEST' as never,
    draft,
    scope
  );

  return {
    actionId: proposal.actionId,
    summary: proposal.summary,
    details: proposal.details,
    warnings: proposal.warnings,
  };
}

/**
 * Extract request fields from a sentence. Returns null unless every required
 * field is present, so the assistant asks a follow-up rather than proposing an
 * incomplete record.
 */
function parseRequestDraft(text: string): Record<string, unknown> | null {
  const quantity = /\b(\d{1,7})\s*(?:units?|pcs|pieces|nos|items?|sets?|kg|kgs|tonnes?|mt|litres?|liters?|boxes?|pallets?)\b/i.exec(
    text
  );
  const money = /\b(?:budget|for)\s+(?:rs\.?|inr|₹)?\s*([\d.,]+\s*(?:k|lakh|lakhs|cr|crore)?)\b/i.exec(text);
  const byWhen = /\b(?:by|before|needed by|required by|deliver by|due)\s+([a-z0-9 ,/-]{4,30})/i.exec(text);

  const itemMatch =
    /\b(?:for|need|require|buy|purchase|procure)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9 \-]{2,60})/i.exec(text);
  if (!itemMatch || !quantity) return null;

  let item = itemMatch[1]
    .split(/\b(?:for|at|in|to|with|from)\b/)[0]
    .replace(/\s+(please|thanks?)$/i, '')
    .trim();
  if (item.length < 3) return null;

  // "I need 50 units of industrial bearings" -> item is the noun, not the quantity.
  const ofMatch = new RegExp(`\\bof\\s+(?:a|an|the)?\\s*([a-z0-9][a-z0-9 \\-]{2,60})`, 'i').exec(text);
  if (ofMatch) item = ofMatch[1].replace(/\bplease$/i, '').trim();

  const unitMatch = new RegExp(
    `(\\d{1,7})\\s*(units?|pcs|pieces|nos|items?|sets?|kg|kgs|tonnes?|mt|litres?|liters?|boxes?|pallets?)\\b`,
    'i'
  ).exec(text);

  const requiredDate = parseFlexibleDate(byWhen?.[1]);
  if (!requiredDate) return null;

  let budget: number | undefined;
  if (money) {
    const raw = money[1].replace(/,/g, '').trim();
    const k = /^([\d.]+)\s*k$/i.exec(raw);
    const lakh = /^([\d.]+)\s*(lakh|lakhs|lac|lacs)$/i.exec(raw);
    const cr = /^([\d.]+)\s*(cr|crore|crores)$/i.exec(raw);
    if (k) budget = Number(k[1]) * 1000;
    else if (lakh) budget = Number(lakh[1]) * 100_000;
    else if (cr) budget = Number(cr[1]) * 10_000_000;
    else budget = Number(raw);
    if (!Number.isFinite(budget)) budget = undefined;
  }

  const title = item.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 120);

  return {
    title,
    item,
    description: buildDescription(text, item),
    quantity: Number(quantity[1]),
    unit: unitMatch ? unitMatch[2].toLowerCase() : 'units',
    location: extractLocation(text) ?? 'Not specified',
    requiredDate: requiredDate.toISOString(),
    ...(budget != null ? { estimatedBudget: budget } : {}),
  };
}

function buildDescription(original: string, item: string): string {
  const trimmed = original.trim();
  if (trimmed.length >= 10) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1, 1000);
  }
  return `Procurement request for ${item}, captured by the NAVO copilot.`;
}

/** Extract a delivery location if the sentence names one. */
function extractLocation(text: string): string | null {
  const m = /\b(?:to|at|in|near|for delivery (?:to|at))\s+((?:[a-z]+\s*){1,4}(?:india|gurugram|delhi|mumbai|pune|bangalore|bengaluru|chennai|kolkata|hyderabad|ahmedabad|jaipur|lucknow|noida|faridabad|chandigarh|kochi|indore|nagpur|coimbatore|vadodara|bhopal|patna|ranchi|thiruvananthapuram|kochi))/i.exec(
    text
  );
  if (m) return m[1].replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const generic = /\b(?:warehouse|plant|site|office|godown|factory|store|unit)\s*(?:no\.?\s*)?([a-z0-9, \-]{0,30})/i.exec(text);
  if (generic) {
    return `${generic[0].replace(/\s+/g, ' ').trim()}`;
  }
  return null;
}

/** Accept "next week", "in 14 days", "2026-03-01", "end of month". */
function parseFlexibleDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  const now = new Date();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const inDays = /^in (\d{1,3}) days?$/.exec(text);
  if (inDays) return new Date(now.getTime() + Number(inDays[1]) * 86_400_000);

  if (/^(next week|tomorrow|next week)$/.test(text)) {
    if (text === 'tomorrow') return new Date(now.getTime() + 86_400_000);
    return new Date(now.getTime() + 7 * 86_400_000);
  }

  if (/^(this month|end of month|month end)$/.test(text)) {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0, 18, 0, 0);
  }

  if (/^next month$/.test(text)) {
    return new Date(now.getFullYear(), now.getMonth() + 1, 15, 18, 0, 0);
  }

  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const named = new RegExp(`^(${months.join('|')})(?:\\s+(\\d{1,2}))?`).exec(text);
  if (named) {
    const monthIndex = months.indexOf(named[1]);
    const day = named[2] ? Number(named[2]) : 15;
    let year = now.getFullYear();
    const candidate = new Date(year, monthIndex, day, 18, 0, 0);
    // A bare month name in the past means next year.
    if (candidate.getTime() < now.getTime() - 86_400_000) year += 1;
    return new Date(year, monthIndex, day, 18, 0, 0);
  }

  return null;
}

async function resolveConversation(
  conversationId: string | undefined,
  scope: CopilotScope,
  context: AskInput['context']
): Promise<{ id: string; contextType: string | null; contextId: string | null }> {
  if (conversationId) {
    const existing = await prisma.copilotConversation.findFirst({
      where: { id: conversationId, userId: scope.actor.userId, tenantId: scope.actor.tenantId },
      select: { id: true, contextType: true, contextId: true },
    });
    // A conversation belonging to another user is treated as absent rather than
    // reported as forbidden, so ids cannot be probed for existence.
    if (existing) return existing;
  }

  const created = await prisma.copilotConversation.create({
    data: {
      userId: scope.actor.userId,
      tenantId: scope.actor.tenantId,
      title: null,
    },
    select: { id: true, contextType: true, contextId: true },
  });
  return created;
}

const CONTEXT_ENTITY_TYPES = new Set([
  'REQUEST',
  'VENDOR',
  'RFQ',
  'QUOTE',
  'DEAL',
  'DEAL_ROOM',
  'PURCHASE_ORDER',
  'INVOICE',
]);

async function applyContext(
  conversation: { id: string },
  context: AskInput['context'],
  scope: CopilotScope
): Promise<void> {
  if (!context?.entityId || !context.entityType) return;
  if (!CONTEXT_ENTITY_TYPES.has(context.entityType)) return;

  await prisma.copilotConversation.update({
    where: { id: conversation.id },
    data: {
      contextType: context.entityType as never,
      contextId: context.entityId,
      contextLabel: context.entityLabel ?? null,
    },
  });
}

async function auditAnswer(
  scope: CopilotScope,
  answer: CopilotAnswer,
  toolCount: number
): Promise<void> {
  try {
    const { createAuditLog } = await import('../audit/audit.service.js');
    const { AuditAction } = await import('@navo/shared');
    await createAuditLog({
      userId: scope.actor.userId,
      action: AuditAction.COPILOT_QUERY_ANSWERED,
      entityType: 'CopilotConversation',
      entityId: answer.citations[0]?.entityId ?? 'conversation',
      tenantId: scope.actor.tenantId,
      metadata: {
        toolsInvoked: toolCount,
        notAnswerable: answer.notAnswerable,
        citationCount: answer.citations.length,
      },
    });
  } catch {
    // Auditing must not break the answer.
  }
}

export { EXECUTABLE_ACTIONS, executeAction, proposeAction } from './tools/action-tools.js';