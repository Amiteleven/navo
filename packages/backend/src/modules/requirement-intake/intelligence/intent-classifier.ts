/**
 * NAVO Requirement Intelligence Engine — Intent Classifier
 *
 * Deterministic and semantic intent classification layer.
 * Maps any buyer message to an explicit procurement intent.
 */

import { ProcurementIntentType, IntentClassificationResult } from './types.js';

export function classifyIntent(
  text: string,
  hasActiveDraft: boolean = false,
  pendingClarificationField?: string | null
): IntentClassificationResult {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Version History Queries: "What was the original quantity?", "What changed?", "Show history"
  if (
    /\b(what was|what were)\s+(the\s+)?(original|previous|initial|first)\s+(quantity|budget|price|location|date|spec|warranty)/.test(lower) ||
    /\b(show|view|check)\s+(version\s+history|revisions|changes|audit trail)\b/.test(lower) ||
    /\bwhat changed\b/.test(lower)
  ) {
    const fieldMatch = lower.match(/\b(quantity|budget|price|location|date|spec|warranty)\b/);
    return {
      intent: 'VIEW_VERSION_HISTORY',
      confidence: 0.95,
      entities: { field: fieldMatch ? fieldMatch[1] : undefined },
      reasoning: 'User is querying previous requirement version or change history',
    };
  }

  // 2. Natural Language Edits on existing requirement
  // e.g., "Actually make it 75 chairs", "Delivery should be Pune", "Add 5-year warranty", "Budget is 12 lakhs", "Remove the warranty requirement"
  if (hasActiveDraft) {
    const isEditPattern =
      /\b(actually|make it|change|update|set|modify|adjust|instead of|replace)\b/.test(lower) ||
      /\b(delivery should be|location should be|deliver to|ship to)\b/.test(lower) ||
      /\b(add|include|require)\s+.*(warranty|guarantee|spec|support|license)\b/.test(lower) ||
      /\b(remove|delete|drop|exclude)\s+.*(warranty|spec|requirement|budget)\b/.test(lower) ||
      /\b(budget is|budget should be|max budget)\b/.test(lower);

    if (isEditPattern) {
      return {
        intent: 'EDIT_REQUIREMENT',
        confidence: 0.92,
        entities: { rawText: trimmed },
        reasoning: 'User is updating parameters on the active requirement draft',
      };
    }
  }

  // 3. Approval Request
  if (
    /\b(send|submit|request|forward)\s+(for|to)\s+(department\s+)?approval\b/.test(lower) ||
    /\b(submit for approval|send for approval|ready for approval)\b/.test(lower)
  ) {
    return {
      intent: 'REQUEST_APPROVAL',
      confidence: 0.98,
      entities: {},
      reasoning: 'User is requesting internal department approval for the requirement',
    };
  }

  // 4. Confirmation
  if (
    /\b(confirm\s+(draft|requirement|details|request)|looks good|approve draft|confirm and proceed|create request)\b/.test(lower) &&
    !/\bnot\b/.test(lower)
  ) {
    return {
      intent: 'CONFIRM_REQUIREMENT',
      confidence: 0.95,
      entities: {},
      reasoning: 'User is confirming the requirement draft',
    };
  }

  // 5. Open Market Publishing
  if (
    /\b(publish|post|list)\s+(to|on)\s+(the\s+)?(open\s+market|marketplace|public)\b/.test(lower) ||
    /\bmake\s+(this\s+)?(requirement\s+)?public\b/.test(lower)
  ) {
    return {
      intent: 'PUBLISH_OPEN_MARKET',
      confidence: 0.95,
      entities: {},
      reasoning: 'User wants to publish requirement to the open market',
    };
  }

  // 6. Compare Quotes / Show Offers
  if (
    /\b(show|compare|view|list|review)\s+(me\s+)?(the\s+)?(quotes|offers|proposals|bids|commercials)\b/.test(lower) ||
    /\bcompare\s+(quotes|offers|vendors)\b/.test(lower)
  ) {
    return {
      intent: 'COMPARE_QUOTES',
      confidence: 0.94,
      entities: {},
      reasoning: 'User wants to view or compare vendor commercial offers',
    };
  }

  // 7. Negotiate
  if (
    /\b(negotiate|counteroffer|counter-offer|ask for discount|lower the price|counter)\b/.test(lower)
  ) {
    return {
      intent: 'NEGOTIATE',
      confidence: 0.92,
      entities: {},
      reasoning: 'User wants to negotiate terms or counteroffer a vendor proposal',
    };
  }

  // 8. Order Tracking & Checking
  if (
    /\b(what happened to|status of|where is|track)\s+(my\s+)?(order|purchase order|po|po-)\b/.test(lower) ||
    /\b(check|track)\s+(order|po)\b/.test(lower)
  ) {
    const poMatch = trimmed.match(/\b(PO-?[A-Z0-9-]+)\b/i);
    return {
      intent: 'CHECK_ORDER',
      confidence: 0.95,
      entities: { poNumber: poMatch ? poMatch[1] : undefined },
      reasoning: 'User is inquiring about purchase order status',
    };
  }

  // 9. Delivery Tracking
  if (
    /\b(when will|status of|track|where is)\s+(the\s+)?(delivery|shipment|dispatch|package|goods)\b/.test(lower) ||
    /\b(check\s+delivery|delivery\s+update)\b/.test(lower)
  ) {
    return {
      intent: 'CHECK_DELIVERY',
      confidence: 0.93,
      entities: {},
      reasoning: 'User is checking delivery or shipment status',
    };
  }

  // 10. Invoice Tracking
  if (
    /\b(show|check|status of|view|where is)\s+(the\s+)?(invoice|invoices|bill|payment)\b/.test(lower) ||
    /\b(invoice\s+discrepancy|unpaid\s+invoices)\b/.test(lower)
  ) {
    return {
      intent: 'CHECK_INVOICE',
      confidence: 0.93,
      entities: {},
      reasoning: 'User is checking invoice or payment status',
    };
  }

  // 11. Deal Status
  if (
    /\b(how is|status of|check)\s+(the\s+)?(deal|deal room|agreement)\b/.test(lower)
  ) {
    return {
      intent: 'CHECK_DEAL',
      confidence: 0.9,
      entities: {},
      reasoning: 'User is inquiring about commercial deal status',
    };
  }

  // 12. Requirement Status
  if (
    /\b(what is|status of|check)\s+(my\s+)?(requirement|request|draft)\b/.test(lower)
  ) {
    return {
      intent: 'CHECK_REQUIREMENT',
      confidence: 0.9,
      entities: {},
      reasoning: 'User is inquiring about requirement status',
    };
  }

  // 13. Direct Answer to an active clarification question
  if (hasActiveDraft && pendingClarificationField) {
    // If user provided a short direct answer like "10", "Mumbai", "Best business option", "Net 30"
    if (trimmed.length < 80 && !/\b(i need|we need|find a vendor)\b/.test(lower)) {
      return {
        intent: 'ANSWER_CLARIFICATION',
        confidence: 0.9,
        entities: {
          field: pendingClarificationField,
          answer: trimmed,
        },
        reasoning: `User is answering the clarification question for field "${pendingClarificationField}"`,
      };
    }
  }

  // 14. Find Vendor specifically
  if (
    /\b(find\s+(me\s+)?(three|two|\d+\s+)?(vendors?|suppliers?)|search\s+for\s+vendors?|identify\s+vendors?)\b/.test(lower) ||
    /\bfind\s+(me\s+)?a\s+(supplier|vendor)\s+in\b/.test(lower)
  ) {
    return {
      intent: 'FIND_VENDOR',
      confidence: 0.92,
      entities: { rawText: trimmed },
      reasoning: 'User wants to find or search vendors for a domain',
    };
  }

  // 15. Create Requirement (Primary Procurement Intake)
  // "I need an iPhone", "I need 50 office chairs", "We need cybersecurity services", "Find a packaging supplier", "I need 10,000 custom boxes"
  const isRequirementCreation =
    /\b(i need|we need|i want|we want|i require|we require|need to (buy|procure|purchase|source|hire)|want to (buy|procure|purchase|source|hire)|looking for|sourcing for)\b/.test(lower) ||
    /\b(find\s+(me\s+)?(a\s+|an\s+)?(supplier|vendor|company|provider|agency)\s+for)\b/.test(lower);

  if (isRequirementCreation) {
    return {
      intent: 'CREATE_REQUIREMENT',
      confidence: 0.95,
      entities: { rawText: trimmed },
      reasoning: 'User is expressing a new procurement need',
    };
  }

  // 16. Fallback if user mentions an item with quantity or action
  if (/\b\d+\s+(chairs?|laptops?|boxes?|phones?|desks?|licenses?|units?|servers?)\b/.test(lower)) {
    return {
      intent: hasActiveDraft ? 'EDIT_REQUIREMENT' : 'CREATE_REQUIREMENT',
      confidence: 0.85,
      entities: { rawText: trimmed },
      reasoning: 'Message contains quantifiable procurement items',
    };
  }

  // 17. General procurement query fallback
  return {
    intent: 'GENERAL_PROCUREMENT_QUERY',
    confidence: 0.7,
    entities: { rawText: trimmed },
    reasoning: 'General procurement message or conversational query',
  };
}
