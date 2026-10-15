import { describe, expect, it, vi } from 'vitest';
import { UserRole } from '@navo/shared';
import { ForbiddenError, ValidationError } from '../../../utils/errors.js';
import {
  CopilotScope,
} from '../copilot-access.js';
import { availableToolNames, getTool, invokeTool, listTools } from '../tool-registry.js';

// The registry self-populates from these imports.
import '../tools/read-tools.js';
import '../tools/analysis-tools.js';

/**
 * Registry tests: role gating, argument validation, and the guarantee that a
 * question can never turn into a write.
 *
 * The audit sink is stubbed because denial auditing must not require a database
 * in unit tests, and because a failing audit write is explicitly non-fatal.
 */
vi.mock('../../audit/audit.service.js', () => ({
  createAuditLog: vi.fn(async () => undefined),
}));

function scopeFor(role: UserRole): CopilotScope {
  return {
    actor: { userId: 'user-1', tenantId: 'tenant-a', role },
    isSeller: role === UserRole.VENDOR,
    vendorIdFilter: role === UserRole.VENDOR ? 'vendor-1' : undefined,
  };
}

const BUYER = scopeFor(UserRole.PROCUREMENT_MANAGER);
const SELLER = scopeFor(UserRole.VENDOR);

describe('registry contents', () => {
  it('registers a non-empty set of tools', () => {
    expect(listTools().length).toBeGreaterThan(0);
  });

  it('exposes only read-only tools', () => {
    // The registry is the read surface. Writes live in the confirmed-action
    // flow, so no tool here may be able to change state.
    for (const tool of listTools()) {
      expect(tool.readOnly).toBe(true);
    }
  });

  it('gives every tool a unique name and a description', () => {
    const names = listTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of listTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('does not register any copilot action as an invocable tool', () => {
    // Actions must go through propose -> confirm. If an action type ever showed
    // up here it would be reachable straight from a question.
    for (const name of ['create_draft_request', 'draft_negotiation_message', 'execute_action']) {
      expect(getTool(name)).toBeUndefined();
    }
  });
});

describe('role gating', () => {
  it('refuses a tool the caller\'s role is not allowed to use', async () => {
    await expect(invokeTool('list_vendors', {}, SELLER)).rejects.toThrow(ForbiddenError);
  });

  it('reports a refusal before touching argument validation', async () => {
    // An unauthorized caller must not be able to learn a tool's argument shape
    // by sending nonsense and seeing whether it complains about the arguments.
    await expect(invokeTool('list_vendors', { limit: 'not-a-number' }, SELLER)).rejects.toThrow(
      /not permitted/
    );
  });

  it('never advertises a buyer-only tool to a seller', () => {
    const sellerTools = availableToolNames(SELLER);
    expect(sellerTools).not.toContain('list_vendors');
    expect(availableToolNames(BUYER)).toContain('list_vendors');
  });
});

describe('argument validation', () => {
  it('refuses an unknown tool name', async () => {
    await expect(invokeTool('definitely_not_a_tool', {}, BUYER)).rejects.toThrow(ValidationError);
  });

  it('rejects an out-of-range limit instead of clamping it silently', async () => {
    await expect(invokeTool('list_requests', { limit: 10_000 }, BUYER)).rejects.toThrow(
      ValidationError
    );
  });

  it('rejects an over-long free-text search term', async () => {
    await expect(invokeTool('list_requests', { search: 'x'.repeat(500) }, BUYER)).rejects.toThrow(
      ValidationError
    );
  });

  it('rejects a negative monetary bound rather than passing it to the query', async () => {
    await expect(
      invokeTool('list_purchase_orders', { minValue: -500 }, BUYER)
    ).rejects.toThrow(ValidationError);
  });
});

describe('argument injection resistance', () => {
  it('ignores an attempt to smuggle a scope override through tool arguments', async () => {
    // `tenantId`, `vendorId`-as-scope and `as` are not part of any tool schema.
    // Zod strips unknown keys, so they cannot reach the query layer.
    const result = await invokeTool(
      'list_requests',
      { tenantId: 'tenant-victim', isSeller: true, requesterId: 'someone-else' },
      BUYER
    );
    expect(Array.isArray(result.citations)).toBe(true);
    expect(result.citations.every((c) => typeof c.entityId === 'string')).toBe(true);
  });

  it('rejects a record detail lookup with an oversized id', async () => {
    await expect(
      invokeTool('get_record_detail', { entityType: 'REQUEST', entityId: 'a'.repeat(500) }, BUYER)
    ).rejects.toThrow(ValidationError);
  });

  it('strips a vendorId smuggled into a tool that takes no vendor argument', async () => {
    // `list_awaiting_negotiation` is legitimately available to sellers, so it
    // cannot be asserted as denied. The guarantee that matters is that the
    // injected vendorId is dropped by Zod before the query is built: a seller
    // asking about another supplier's rooms still gets only their own, because
    // `dealRoomVisibility` pins vendorId from the scope and the argument is gone.
    const tool = getTool('list_awaiting_negotiation')!;
    const parsed = tool.schema.parse({ vendorId: 'vendor-other', limit: 5 });
    expect(parsed).not.toHaveProperty('vendorId');
    expect(parsed).toEqual({ limit: 5 });
  });

  it('never lets a scope-only key survive into any tool\'s parsed arguments', () => {
    // Sweeps every registered tool so adding a new one cannot quietly introduce
    // an argument that overrides an authorization-derived filter.
    const forbidden = ['tenantId', 'isSeller', 'actor', 'scope', 'vendorIdFilter', 'requesterIdFilter'];
    for (const tool of listTools()) {
      const shape = (tool.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      for (const key of forbidden) {
        if (key in shape) {
          // `vendorId`/`categoryId` exist on buyer-side tools, but the
          // scope-override keys must never appear on any tool.
          throw new Error(`${tool.name} exposes a scope-override argument: ${key}`);
        }
      }
    }
  });
});