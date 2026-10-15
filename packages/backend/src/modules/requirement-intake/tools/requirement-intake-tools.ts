import { z } from 'zod';
import { defineTool, CopilotToolResult } from '../../copilot/tool-registry.js';
import { CopilotScope } from '../../copilot/copilot-access.js';
import { ForbiddenError, ValidationError } from '../../../utils/errors.js';
import { upsertRequirementDraft, answerClarification, confirmRequirementDraft, getActiveDraft, normalizeCategory, getCategoryFields } from '../requirement-intake.service.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { AuditAction } from '@navo/shared';

/**
 * Create or update a requirement draft from a user message.
 * This is a read-only tool from the copilot's perspective - the actual
 * write is handled by the service layer and audit trail.
 */
export const createRequirementDraftTool = defineTool({
  name: 'create_requirement_draft',
  description: 'Create or update a requirement draft from a natural language procurement request. Extracts structured information and identifies missing critical fields.',
  schema: z.object({
    message: z.string().min(1).describe('The user\'s procurement request in natural language'),
    conversationId: z.string().optional().describe('Existing copilot conversation ID to continue'),
    extractedData: z.record(z.unknown()).optional().describe('Pre-extracted structured data (optional)'),
  }),
  readOnly: true,
  allowedRoles: ['PLATFORM_ADMIN', 'COMPANY_ADMIN', 'PROCUREMENT_MANAGER', 'FINANCE_APPROVER', 'REQUESTER'],
  argHint: '{"message": "I need 20 laptops for my team", "conversationId": "optional-existing-conversation-id"}',
  execute: async (args, scope): Promise<CopilotToolResult> => {
    const { message, conversationId, extractedData } = args;

    const result = await upsertRequirementDraft({
      tenantId: scope.actor.tenantId,
      userId: scope.actor.userId,
      copilotConversationId: conversationId ?? `temp-${scope.actor.userId}-${Date.now()}`,
      message,
      extractedData,
    });

    await createAuditLog({
      userId: scope.actor.userId,
      action: AuditAction.COPILOT_QUERY_ANSWERED,
      entityType: 'RequirementDraft',
      entityId: result.draft.id,
      tenantId: scope.actor.tenantId,
      metadata: {
        tool: 'create_requirement_draft',
        state: result.draft.state,
        category: result.draft.category ?? 'unknown',
        missingFieldsCount: result.questions.length,
        isConfirmable: result.isConfirmable,
      },
    });

    const lines = [
      `Created requirement draft: ${result.draft.id}`,
      `Category: ${result.draft.category ?? 'Not determined yet'}`,
      `Item: ${result.draft.item ?? 'Not specified'}`,
      `State: ${result.draft.state}`,
      `Missing critical fields: ${result.questions.length}`,
    ];

    if (result.questions.length > 0) {
      lines.push('\nNext questions to ask:');
      result.questions.slice(0, 3).forEach((q, i) => {
        lines.push(`  ${i + 1}. ${q.question} (field: ${q.field})${q.suggestion ? ` — suggestion: ${q.suggestion}` : ''}`);
      });
      if (result.questions.length > 3) {
        lines.push(`  ... and ${result.questions.length - 3} more`);
      }
    }

    if (result.isConfirmable) {
      lines.push('\n✅ Draft has all critical fields and can be confirmed.');
    }

    return {
      kind: 'requirement_draft',
      lines,
      citations: [{
        entityType: 'RequirementDraft',
        entityId: result.draft.id,
        label: `Draft: ${result.draft.title ?? result.draft.item ?? 'Untitled'}`,
        href: `/requirements/${result.draft.id}`,
        status: result.draft.state,
      }],
      facts: {
        draftId: result.draft.id,
        state: result.draft.state,
        category: result.draft.category ?? 'unknown',
        missingFields: result.questions.length,
        isConfirmable: result.isConfirmable,
      },
      suggestedQuestions: result.questions.slice(0, 3).map(q => q.question),
    };
  },
});

/**
 * Answer a clarification question for a requirement draft.
 */
export const answerRequirementClarificationTool = defineTool({
  name: 'answer_requirement_clarification',
  description: 'Answer a clarification question for an active requirement draft. Updates the draft and returns remaining questions.',
  schema: z.object({
    draftId: z.string().min(1).describe('The requirement draft ID'),
    field: z.string().min(1).describe('The field being answered'),
    answer: z.string().describe('The user\'s answer'),
  }),
  readOnly: true,
  allowedRoles: ['PLATFORM_ADMIN', 'COMPANY_ADMIN', 'PROCUREMENT_MANAGER', 'FINANCE_APPROVER', 'REQUESTER'],
  argHint: '{"draftId": "abc123", "field": "quantity", "answer": "25"}',
  execute: async (args, scope): Promise<CopilotToolResult> => {
    const { draftId, field, answer } = args;

    const result = await answerClarification({
      draftId,
      field,
      answer,
      tenantId: scope.actor.tenantId,
      userId: scope.actor.userId,
    });

    await createAuditLog({
      userId: scope.actor.userId,
      action: AuditAction.COPILOT_QUERY_ANSWERED,
      entityType: 'RequirementDraft',
      entityId: draftId,
      tenantId: scope.actor.tenantId,
      metadata: {
        tool: 'answer_requirement_clarification',
        field,
        state: result.draft.state,
        isConfirmable: result.isConfirmable,
      },
    });

    const lines = [
      `Answer recorded for ${field}: "${answer}"`,
      `Draft state: ${result.draft.state}`,
      `Remaining questions: ${result.questions.length}`,
    ];

    if (result.questions.length > 0) {
      lines.push('\nNext questions:');
      result.questions.slice(0, 3).forEach((q, i) => {
        lines.push(`  ${i + 1}. ${q.question} (field: ${q.field})${q.suggestion ? ` — suggestion: ${q.suggestion}` : ''}`);
      });
    }

    if (result.isConfirmable) {
      lines.push('\n✅ Draft is now confirmable. You can say "confirm this requirement" to create the procurement request.');
    }

    return {
      kind: 'requirement_draft_update',
      lines,
      citations: [{
        entityType: 'RequirementDraft',
        entityId: result.draft.id,
        label: `Draft: ${result.draft.title ?? result.draft.item ?? 'Untitled'}`,
        href: `/requirements/${result.draft.id}`,
        status: result.draft.state,
      }],
      facts: {
        draftId: result.draft.id,
        state: result.draft.state,
        remainingQuestions: result.questions.length,
        isConfirmable: result.isConfirmable,
      },
      suggestedQuestions: result.questions.slice(0, 3).map(q => q.question),
    };
  },
});

/**
 * Confirm a requirement draft and create a ProcurementRequest.
 */
export const confirmRequirementDraftTool = defineTool({
  name: 'confirm_requirement_draft',
  description: 'Confirm a requirement draft and create a formal ProcurementRequest. Only works when all critical fields are filled.',
  schema: z.object({
    draftId: z.string().min(1).describe('The requirement draft ID to confirm'),
  }),
  readOnly: true,
  allowedRoles: ['PLATFORM_ADMIN', 'COMPANY_ADMIN', 'PROCUREMENT_MANAGER', 'FINANCE_APPROVER', 'REQUESTER'],
  argHint: '{"draftId": "abc123"}',
  execute: async (args, scope): Promise<CopilotToolResult> => {
    const { draftId } = args;

    const result = await confirmRequirementDraft({
      draftId,
      userId: scope.actor.userId,
      tenantId: scope.actor.tenantId,
    });

    await createAuditLog({
      userId: scope.actor.userId,
      action: AuditAction.COPILOT_QUERY_ANSWERED,
      entityType: 'RequirementDraft',
      entityId: draftId,
      tenantId: scope.actor.tenantId,
      metadata: {
        tool: 'confirm_requirement_draft',
        requestId: result.requestId,
      },
    });

    return {
      kind: 'requirement_confirmed',
      lines: [
        `✅ Requirement confirmed and ProcurementRequest created!`,
        `Request ID: ${result.requestId}`,
        `The requirement is now in the formal procurement workflow.`,
        `You can now proceed to vendor discovery, RFQ creation, or open market posting.`,
      ],
      citations: [{
        entityType: 'ProcurementRequest',
        entityId: result.requestId,
        label: `Procurement Request ${result.requestId.slice(0, 8)}`,
        href: `/requests/${result.requestId}`,
        status: 'REQUIREMENT_EXTRACTED',
      }],
      facts: {
        requestId: result.requestId,
        draftId,
      },
      suggestedQuestions: [
        'Find vendors for this request',
        'Create an RFQ for this request',
        'Post to open market',
      ],
    };
  },
});

/**
 * Get the active requirement draft for the current user.
 */
export const getActiveRequirementDraftTool = defineTool({
  name: 'get_active_requirement_draft',
  description: 'Get the currently active requirement draft for the user, including all clarification questions and confirmability status.',
  schema: z.object({
    conversationId: z.string().optional().describe('Specific copilot conversation ID (optional)'),
  }),
  readOnly: true,
  allowedRoles: ['PLATFORM_ADMIN', 'COMPANY_ADMIN', 'PROCUREMENT_MANAGER', 'FINANCE_APPROVER', 'REQUESTER'],
  argHint: '{"conversationId": "optional-conversation-id"}',
  execute: async (args, scope): Promise<CopilotToolResult> => {
    const { conversationId } = args;

    const draft = await getActiveDraft({
      tenantId: scope.actor.tenantId,
      userId: scope.actor.userId,
      copilotConversationId: conversationId,
    });

    if (!draft) {
      return {
        kind: 'requirement_draft_empty',
        lines: ['No active requirement draft found. Start by describing what you need to procure.'],
        citations: [],
        facts: { hasDraft: false },
        suggestedQuestions: [
          'I need to buy laptops for my team',
          'We need a housekeeping vendor for our office',
          'Find a software vendor for CRM implementation',
        ],
      };
    }

    const questions = await prisma.clarificationQuestion.findMany({
      where: { draftId: draft.id },
      orderBy: { order: 'asc' },
    });

    const confirmable = draft.state === 'DRAFT' || draft.state === 'CONFIRMED';

    const lines = [
      `Active requirement draft: ${draft.id}`,
      `Title: ${draft.title ?? 'Not set'}`,
      `Category: ${draft.category ?? 'Not determined'}`,
      `Item: ${draft.item ?? 'Not specified'}`,
      `State: ${draft.state}`,
      `Confirmable: ${confirmable ? 'Yes' : 'No'}`,
    ];

    if (questions.length > 0) {
      lines.push(`\nClarification questions (${questions.length}):`);
      questions.forEach((q, i) => {
        const answered = q.userAnswer ? ` ✅ Answered: ${q.userAnswer}` : ' ⏳ Pending';
        lines.push(`  ${i + 1}. ${q.question} (field: ${q.field})${answered}`);
      });
    }

    if (confirmable) {
      lines.push('\n✅ This draft has all critical fields and can be confirmed.');
    }

    return {
      kind: 'requirement_draft',
      lines,
      citations: [{
        entityType: 'RequirementDraft',
        entityId: draft.id,
        label: `Draft: ${draft.title ?? draft.item ?? 'Untitled'}`,
        href: `/requirements/${draft.id}`,
        status: draft.state,
      }],
      facts: {
        draftId: draft.id,
        state: draft.state,
        category: draft.category ?? 'unknown',
        questionCount: questions.length,
        confirmable,
      },
      suggestedQuestions: confirmable
        ? ['Confirm this requirement', 'Show me the full draft']
        : questions.slice(0, 3).map(q => q.question),
    };
  },
});

/**
 * Get category field definitions for clarification guidance.
 */
export const getRequirementCategoryFieldsTool = defineTool({
  name: 'get_requirement_category_fields',
  description: 'Get the critical and optional fields for a procurement category. Helps understand what information is needed.',
  schema: z.object({
    category: z.string().min(1).describe('The procurement category (e.g., Product, Service, Software)'),
  }),
  readOnly: true,
  allowedRoles: ['PLATFORM_ADMIN', 'COMPANY_ADMIN', 'PROCUREMENT_MANAGER', 'FINANCE_APPROVER', 'REQUESTER'],
  argHint: '{"category": "Product"}',
  execute: async (args, scope): Promise<CopilotToolResult> => {
    const { category } = args;
    const normalized = normalizeCategory(category);
    const { critical, optional } = getCategoryFields(normalized);

    return {
      kind: 'category_fields',
      lines: [
        `Category: ${normalized}`,
        `\nCritical fields (required before confirmation):`,
        ...critical.map(f => `  • ${f}`),
        `\nOptional fields (nice to have):`,
        ...optional.map(f => `  • ${f}`),
      ],
      citations: [],
      facts: {
        category: normalized,
        criticalCount: critical.length,
        optionalCount: optional.length,
      },
      suggestedQuestions: [
        `What are the critical fields for ${normalized}?`,
        `How do I fill in the ${critical[0] ?? 'first critical field'}?`,
      ],
    };
  },
});

/**
 * List all available procurement categories.
 */
export const listRequirementCategoriesTool = defineTool({
  name: 'list_requirement_categories',
  description: 'List all available procurement categories for requirement classification.',
  schema: z.object({}),
  readOnly: true,
  allowedRoles: ['PLATFORM_ADMIN', 'COMPANY_ADMIN', 'PROCUREMENT_MANAGER', 'FINANCE_APPROVER', 'REQUESTER'],
  argHint: '{}',
  execute: async (_args, scope): Promise<CopilotToolResult> => {
    const categories = [
      'Product', 'Service', 'Software', 'Professional Service',
      'Manufacturing', 'Raw Material', 'Logistics', 'Maintenance',
      'Facility Management', 'Marketing', 'IT', 'Consulting',
      'Travel', 'Event', 'Construction', 'Contracted Service', 'Other',
    ];

    return {
      kind: 'category_list',
      lines: [
        'Available procurement categories:',
        ...categories.map(c => `  • ${c}`),
      ],
      citations: [],
      facts: { count: categories.length },
      suggestedQuestions: [
        'What category would "office chairs" fall under?',
        'Which category for "software development services"?',
      ],
    };
  },
});

// Import prisma for the getActiveDraft function
import prisma from '../../../utils/prisma.js';