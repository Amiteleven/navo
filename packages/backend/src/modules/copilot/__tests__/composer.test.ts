import { describe, expect, it } from 'vitest';
import { UserRole } from '@navo/shared';
import { CopilotScope } from '../copilot-access.js';
import { CopilotCitation, ToolInvocation } from '../tool-registry.js';
import { composeAnswer } from '../composer.js';

/**
 * Composer tests.
 *
 * The composer is the last thing standing between a tool result and a user, so
 * these tests assert that it never adds a fact. Every statement in an answer
 * must trace to a tool line, a citation, or one of the fixed refusal strings -
 * there is no model in this path to smooth over a missing record.
 */

const BUYER: CopilotScope = {
  actor: { userId: 'user-1', tenantId: 'tenant-a', role: UserRole.PROCUREMENT_MANAGER },
  isSeller: false,
};
const SELLER: CopilotScope = {
  actor: { userId: 'user-2', tenantId: 'tenant-a', role: UserRole.VENDOR, vendorId: 'vendor-1' },
  isSeller: true,
  vendorIdFilter: 'vendor-1',
};

const citation = (entityId: string, label: string): CopilotCitation => ({
  entityType: 'REQUEST',
  entityId,
  label,
  href: `/requests/${entityId}`,
});

const invocation = (
  name: string,
  result: Partial<ToolInvocation['result']> & { kind: string }
): ToolInvocation => ({
  name,
  args: {},
  result: { lines: [], citations: [], facts: {}, ...result },
});

const compose = (
  invocations: ToolInvocation[],
  overrides: Partial<Parameters<typeof composeAnswer>[0]> = {}
) =>
  composeAnswer({
    question: 'Show my active requests',
    invocations,
    failures: [],
    scope: BUYER,
    hasContext: false,
    ...overrides,
  });

describe('grounding', () => {
  it('states only what the tool returned', async () => {
    const answer = await compose([
      invocation('list_requests', {
        kind: 'request_list',
        lines: ['Office chairs — APPROVED, 40 units of Chair'],
        citations: [citation('r1', 'Office chairs')],
      }),
    ]);

    expect(answer.content).toContain('Office chairs — APPROVED, 40 units of Chair');
    expect(answer.notAnswerable).toBe(false);
    expect(answer.toolsUsed).toEqual(['list_requests']);
  });

  it('never invents a record that no tool returned', async () => {
    const answer = await compose([
      invocation('list_requests', {
        kind: 'request_list',
        lines: ['Office chairs — APPROVED'],
        citations: [citation('r1', 'Office chairs')],
      }),
    ]);

    // Nothing about a supplier, a price, or a total may appear: none was read.
    expect(answer.content).not.toMatch(/supplier|vendor|₹|\$|total/i);
  });

  it('surfaces every citation the tools returned', async () => {
    const answer = await compose([
      invocation('list_requests', {
        kind: 'request_list',
        lines: ['One', 'Two'],
        citations: [citation('r1', 'One'), citation('r2', 'Two')],
      }),
    ]);
    expect(answer.citations.map((c) => c.entityId)).toEqual(['r1', 'r2']);
  });

  it('de-duplicates citations pointing at the same record', async () => {
    const answer = await compose([
      invocation('list_requests', { kind: 'request_list', lines: ['One'], citations: [citation('r1', 'One')] }),
      invocation('search_records', { kind: 'search', lines: ['One again'], citations: [citation('r1', 'One')] }),
    ]);
    expect(answer.citations).toHaveLength(1);
  });

  it('reports a failed check instead of quietly dropping it', async () => {
    const answer = await compose([invocation('list_requests', { kind: 'request_list', lines: ['One'] })], {
      failures: [{ tool: 'list_invoice_discrepancies', reason: 'invoice access denied' }],
    });
    expect(answer.content).toMatch(/could not complete/i);
    expect(answer.content).toContain('invoice access denied');
  });
});

describe('empty results', () => {
  it('says there is no data rather than answering anyway', async () => {
    const answer = await compose([
      invocation('list_requests', { kind: 'request_list', lines: [], empty: true }),
    ]);
    expect(answer.notAnswerable).toBe(true);
    expect(answer.content).toMatch(/no active procurement requests/i);
  });

  it('says there is no supplier without doubling the qualifier', async () => {
    // Regression: this fragment scopes itself to "that filter", so appending
    // the shared "matching that" tail produced "no suppliers matching that
    // filter matching that".
    const answer = await compose([
      invocation('list_vendors', { kind: 'vendor_list', lines: [], empty: true }),
    ]);
    expect(answer.content).toBe('No suppliers in your organisation match that filter.');
    expect(answer.content).not.toMatch(/matching that.*matching that/);
  });

  it('does not present an empty answer as a result', async () => {
    const answer = await compose([
      invocation('list_purchase_orders', { kind: 'purchase_order_list', lines: [], empty: true }),
    ]);
    expect(answer.content).not.toMatch(/^\s*\d+\s/m);
  });

  it('falls back to the standard suggestions when nothing matched', async () => {
    const answer = await compose([
      invocation('list_requests', { kind: 'request_list', lines: [], empty: true }),
    ]);
    expect(answer.suggestedQuestions.length).toBeGreaterThan(0);
  });

  it('tells a seller their answer is limited to their own organisation', async () => {
    const answer = await compose(
      [invocation('purchase_order_list', { kind: 'purchase_order_list', lines: [], empty: true })],
      { scope: SELLER }
    );
    expect(answer.content).toMatch(/your organisation/i);
  });
});

describe('refusals', () => {
  it('refuses to guess when nothing matched the question', async () => {
    const answer = await compose([], { question: 'what is the airspeed velocity of a swallow' });
    expect(answer.notAnswerable).toBe(true);
    expect(answer.content).toMatch(/will not guess|never invent/i);
  });

  it('does not work around an access denial', async () => {
    const answer = await compose([], {
      failures: [{ tool: 'list_vendors', reason: 'You are not permitted to use "list_vendors"' }],
    });
    expect(answer.content).toMatch(/not permitted/i);
    expect(answer.content).toMatch(/will not work around/i);
  });

  it('scopes the seller refusal to their own records', async () => {
    const answer = await compose([], { scope: SELLER, question: 'tell me about other suppliers' });
    expect(answer.content).toMatch(/your own organisation/i);
  });

  it('offers buyer-appropriate follow-ups to a buyer', async () => {
    const answer = await compose([], { question: 'unrelated' });
    expect(answer.suggestedQuestions.join(' ')).toMatch(/request|purchase order|vendor/i);
  });

  it('never offers a buyer-only suggestion to a seller', async () => {
    const answer = await compose([], { scope: SELLER, question: 'unrelated' });
    expect(answer.suggestedQuestions.join(' ')).not.toMatch(/my vendors|suppliers to provide/i);
  });
});

describe('proposed actions', () => {
  const proposal = {
    actionId: 'action-1',
    type: 'CREATE_DRAFT_REQUEST',
    status: 'PROPOSED',
    summary: 'Create a draft procurement request "Laptops".',
    details: [
      { field: 'Title', value: 'Laptops' },
      { field: 'Quantity', value: '10 units' },
    ],
    warnings: ['This creates a DRAFT request. It is not submitted for approval.'],
  };

  it('presents the proposal for review without claiming it ran', async () => {
    const answer = await compose([], { proposedAction: proposal });
    expect(answer.content).toMatch(/nothing has been created yet/i);
    expect(answer.content).toContain('Create a draft procurement request "Laptops".');
  });

  it('shows every field and every warning to the reviewer', async () => {
    const answer = await compose([], { proposedAction: proposal });
    expect(answer.content).toContain('Quantity: 10 units');
    expect(answer.content).toContain('not submitted for approval');
  });

  it('offers no follow-up questions on a confirmation prompt', async () => {
    const answer = await compose([], { proposedAction: proposal });
    expect(answer.suggestedQuestions).toEqual([]);
  });
});