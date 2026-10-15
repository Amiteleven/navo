import { UserRole } from '@navo/shared';
import { CopilotScope } from './copilot-access.js';
import { ToolInvocation } from './tool-registry.js';
import type { CopilotAnswer } from './copilot.service.js';

/**
 * Answer composition.
 *
 * The answer is assembled from tool results only. There is deliberately no
 * language model in this path: a model would be able to smooth over a missing
 * record or assert a relationship the data does not support, and the brief for
 * this feature is that the copilot must never invent a vendor, quote,
 * transaction, saving or delivery update.
 *
 * Each branch states what was found, cites the records, and names what is
 * absent. When nothing matched, it says so plainly instead of offering a
 * plausible guess.
 */

export interface ComposeInput {
  question: string;
  invocations: ToolInvocation[];
  failures: Array<{ tool: string; reason: string }>;
  proposedAction?: CopilotAnswer['proposedAction'];
  scope: CopilotScope;
  hasContext: boolean;
}

export async function composeAnswer(input: ComposeInput): Promise<CopilotAnswer> {
  const { question, invocations, failures, proposedAction, scope, hasContext } = input;

  const citations = dedupeCitations(invocations.flatMap((i) => i.result.citations));
  const suggested = invocations
    .flatMap((i) => i.result.suggestedQuestions ?? [])
    .filter((q, idx, all) => all.indexOf(q) === idx)
    .slice(0, 4);

  if (proposedAction) {
    return {
      content: [
        'I prepared a draft for your review. Nothing has been created yet.',
        '',
        proposedAction.summary,
        '',
        ...proposedAction.details.map((d) => `- ${d.field}: ${d.value}`),
        ...(proposedAction.warnings.length
          ? ['', ...proposedAction.warnings.map((w) => `- ${w}`)]
          : []),
      ].join('\n'),
      citations,
      suggestedQuestions: [],
      notAnswerable: false,
      toolsUsed: invocations.map((i) => i.name),
      proposedAction,
    };
  }

  if (invocations.length === 0) {
    return {
      content: refusalMessage(question, scope, failures),
      citations,
      suggestedQuestions: defaultSuggestions(scope),
      notAnswerable: true,
      toolsUsed: [],
    };
  }

  // A tool that ran but matched nothing is reported as "no records", not as a
  // refusal: the question was understood, the data simply is not there.
  const allEmpty = invocations.every((i) => i.result.empty);
  const sections = invocations.map((i) => i.result.lines.filter(Boolean));
  const body = sections.flat();

  const parts: string[] = [];

  if (allEmpty) {
    parts.push(noDataMessage(scope, invocations));
  } else {
    parts.push(...body);
  }

  if (failures.length > 0) {
    parts.push('');
    parts.push(
      `I could not complete ${failures.length} check(s): ${failures
        .map((f) => `${f.reason}`)
        .join('; ')}.`
    );
  }

  if (citations.length > 0) {
    parts.push('');
    parts.push('Open a record above to see the full detail.');
  }

  return {
    content: parts.join('\n').trim(),
    citations,
    suggestedQuestions: allEmpty ? defaultSuggestions(scope) : suggested,
    notAnswerable: allEmpty,
    toolsUsed: invocations.map((i) => i.name),
  };
}

function noDataMessage(scope: CopilotScope, invocations: ToolInvocation[]): string {
  const kinds = new Set(invocations.map((i) => i.result.kind));

  if (scope.isSeller) {
    if (kinds.has('purchase_order_list')) {
      return 'No purchase orders match that in your organisation. There is nothing outstanding for you on that filter.';
    }
    if (kinds.has('deal_list')) {
      return 'No deals are recorded for your organisation yet.';
    }
    return 'Nothing in your organisation matches that. I can only see your own records, so if you expected results from another supplier they are not visible to this account.';
  }

  const messages: string[] = [];
  if (kinds.has('request_list')) messages.push('no active procurement requests');
  if (kinds.has('purchase_order_list')) messages.push('no purchase orders');
  if (kinds.has('deal_list')) messages.push('no confirmed deals');
  if (kinds.has('invoice_discrepancy_list')) {
    messages.push('no invoices with unresolved discrepancies');
  }
  if (kinds.has('unconfirmed_delivery_list')) {
    messages.push('no purchase orders awaiting supplier confirmation');
  }
  if (kinds.has('quote_list') || kinds.has('quote_comparison')) {
    messages.push('no quotations to compare for that request');
  }
  if (kinds.has('savings_list')) messages.push('no verified savings recorded');
  // This fragment already scopes itself to the filter, so it must not also
  // receive the trailing "matching that" the other fragments get.
  if (kinds.has('vendor_list')) {
    return 'No suppliers in your organisation match that filter.';
  }

  return messages.length > 0
    ? `There ${messages.length === 1 ? 'is' : 'are'} ${messages.join(', ')} matching that in your organisation.`
    : 'Nothing in your scope matches that.';
}

function refusalMessage(
  question: string,
  scope: CopilotScope,
  failures: Array<{ tool: string; reason: string }>
): string {
  const denial = failures.find((f) => /not permitted|forbidden|access denied/i.test(f.reason));
  if (denial) {
    return `${denial.reason}. I will not work around an access restriction.`;
  }

  const scopeNote =
    scope.actor.role === UserRole.VENDOR
      ? ' I can only see your own organisation\'s opportunities, quotations, deals and orders.'
      : ' I can only see your own organisation\'s records.';

  return [
    'I could not match that to anything in your procurement data, so I will not guess.',
    `I answer from stored records only, and I never invent a vendor, quotation, transaction or delivery update.${scopeNote}`,
    '',
    'I can help with:',
    ...defaultSuggestions(scope).slice(0, 5).map((s) => `- ${s}`),
  ].join('\n');
}

function defaultSuggestions(scope: CopilotScope): string[] {
  return scope.actor.role === UserRole.VENDOR
    ? [
        'Show my open opportunities',
        'Which purchase orders await my confirmation?',
        'Show my deals',
      ]
    : [
        'Show my active procurement requests',
        'Which vendors are online now?',
        'Show pending purchase orders',
        'Which invoices have discrepancies?',
      ];
}

function dedupeCitations(
  citations: CopilotAnswer['citations']
): CopilotAnswer['citations'] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const key = `${c.entityType}:${c.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}