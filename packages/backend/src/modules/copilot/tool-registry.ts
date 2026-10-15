import { z } from 'zod';
import type { CopilotScope } from './copilot-access.js';
import { ForbiddenError, ValidationError } from '../../utils/errors.js';
import { createAuditLog } from '../audit/audit.service.js';
import { AuditAction } from '@navo/shared';

/**
 * The copilot tool registry.
 *
 * Every capability the assistant has is a tool declared here. The registry is
 * the security boundary: the orchestrator may only invoke a tool that is
 * registered, and each tool validates its own arguments and re-derives its
 * authorization from `CopilotScope`.
 *
 * Design rules, each of which exists to stop a specific failure:
 *
 *  - **No tool trusts a caller-supplied scope.** Arguments are data; the scope
 *    is derived from the JWT and the database and is not overridable.
 *  - **No tool performs an LLM call.** Money is computed with `money.ts` so a
 *    model can never invent or alter a total.
 *  - **Read tools return records, not prose.** A model (or the deterministic
 *    planner) composes an answer from these; it cannot assert a fact that is not
 *    backed by a row here.
 *  - **Write tools are not in this registry.** They are proposed and confirmed
 *    separately, so nothing consequential can happen as a side effect of a
 *    question.
 */

/** A record reference the UI can turn into a NAVO link. */
export interface CopilotCitation {
  entityType: string;
  entityId: string;
  label: string;
  /** Route within the SPA. */
  href: string;
  /** Short state summary, e.g. "PENDING_APPROVAL". */
  status?: string;
  date?: string;
}

export interface CopilotToolResult {
  /** Short machine-readable kind, used by the planner to pick a template. */
  kind: string;
  /** Pre-rendered factual lines. Never free text from a model. */
  lines: string[];
  /** Records to cite, already authorization-filtered. */
  citations: CopilotCitation[];
  /** Compact figures for templates, e.g. { count: 3, value: 12000 }. */
  facts: Record<string, string | number | boolean | null>;
  /** True when the query was answerable but matched nothing. */
  empty?: boolean;
  /** Follow-up suggestions drawn from the records actually read. */
  suggestedQuestions?: string[];
}

export type CopilotToolArgs = Record<string, unknown>;

export interface CopilotTool<P extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Tool-call arguments, validated before the handler ever runs. */
  schema: P;
  /** True when the tool only reads. Used to keep writes out of this registry. */
  readOnly: true;
  /** Roles permitted to invoke the tool at all, before any scope check. */
  allowedRoles: readonly string[];
  /** JSON-schema-shaped description of arguments, used to brief a planner. */
  argHint: string;
  execute(args: z.infer<P>, scope: CopilotScope): Promise<CopilotToolResult>;
}

const registry = new Map<string, CopilotTool>();

/** Declare a tool. Registration is the only way to make a capability callable. */
export function defineTool<P extends z.ZodTypeAny>(tool: CopilotTool<P>): CopilotTool<P> {
  registry.set(tool.name, tool as CopilotTool);
  return tool;
}

export function getTool(name: string): CopilotTool | undefined {
  return registry.get(name);
}

export function listTools(): CopilotTool[] {
  return [...registry.values()];
}

/** Tool names a given caller is permitted to invoke, for planner briefing. */
export function availableToolNames(scope: CopilotScope): string[] {
  return listTools()
    .filter((tool) => tool.allowedRoles.includes(scope.actor.role))
    .map((tool) => tool.name);
}

export interface ToolInvocation {
  name: string;
  args: CopilotToolArgs;
  result: CopilotToolResult;
}

/**
 * Validate arguments and run a tool on the caller's behalf.
 *
 * Role gating happens here, before validation, so an unauthorized call cannot
 * even probe argument shapes. A denial is audited.
 */
export async function invokeTool(
  name: string,
  rawArgs: CopilotToolArgs,
  scope: CopilotScope
): Promise<CopilotToolResult> {
  const tool = registry.get(name);

  if (!tool) {
    // An unknown name means either a planner hallucination or an attempt to
    // reach something unregistered. Both are refused, not ignored.
    throw new ValidationError(`Unknown tool: ${name}`);
  }

  if (!tool.allowedRoles.includes(scope.actor.role)) {
    await auditToolDenied(scope, name, 'role_not_permitted');
    throw new ForbiddenError(`You are not permitted to use "${name}"`);
  }

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      (details[key] ??= []).push(issue.message);
    }
    throw new ValidationError(`Invalid arguments for "${name}"`, details);
  }

  try {
    return await tool.execute(parsed.data, scope);
  } catch (err) {
    // A throw from inside a tool is an authorization or state failure. Record
    // it so a systematic denial attempt is visible in the audit trail.
    if (err instanceof ForbiddenError) {
      await auditToolDenied(scope, name, err.message);
    }
    throw err;
  }
}

async function auditToolDenied(
  scope: CopilotScope,
  toolName: string,
  reason: string
): Promise<void> {
  try {
    await createAuditLog({
      userId: scope.actor.userId,
      action: AuditAction.COPILOT_TOOL_DENIED,
      entityType: 'CopilotTool',
      entityId: toolName,
      tenantId: scope.actor.tenantId,
      metadata: { reason },
    });
  } catch {
    // Audit logging must never mask the original denial.
  }
}

/** Common argument fragments reused across tools. */
export const argFragments = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of records to return'),
  search: z.string().max(200).optional().describe('Free-text match on name or title'),
  fromDate: z.string().max(40).optional().describe('ISO date lower bound'),
  toDate: z.string().max(40).optional().describe('ISO date upper bound'),
  minValue: z.number().min(0).optional().describe('Minimum monetary value'),
  maxValue: z.number().min(0).optional().describe('Maximum monetary value'),
  vendorId: z.string().min(1).max(64).optional().describe('Restrict to one supplier'),
  categoryId: z.string().min(1).max(64).optional().describe('Restrict to one category'),
  location: z.string().max(200).optional().describe('Match against the delivery location'),
  recordId: z.string().min(1).max(64).optional().describe('A specific record id from context'),
};