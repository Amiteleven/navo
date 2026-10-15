/**
 * NAVO — Requirement Intelligence Engine Service
 *
 * Master coordinator for AI intent classification, dynamic attribute extraction,
 * progressive non-interrogating clarification, completeness scoring, version tracking,
 * and conversational requirement editing.
 */

import prisma from '../../utils/prisma.js';
import { classifyIntent } from './intelligence/intent-classifier.js';
import { extractRequirement, detectMultipleRequirements } from './intelligence/requirement-extractor.js';
import { evaluateCompleteness } from './intelligence/completeness-evaluator.js';
import {
  detectRequirementDiff,
  recordDraftVersion,
  getDraftVersionHistory,
  evaluatePostApprovalReapproval,
} from './intelligence/version-tracker.js';
import { answerVersionHistoryQuery } from './intelligence/conversation-memory.js';
import { IntentClassificationResult, CompletenessResult } from './intelligence/types.js';

export interface ProcessMessageResult {
  intent: IntentClassificationResult;
  replyMessage: string;
  draft: any;
  completeness: CompletenessResult;
  versionHistory?: any[];
  multipleRequirementsDetected?: boolean;
}

export async function processRequirementChatMessage(params: {
  tenantId: string;
  userId: string;
  copilotConversationId: string;
  message: string;
}): Promise<ProcessMessageResult> {
  const { tenantId, userId, copilotConversationId, message } = params;

  // 1. Fetch active draft for this conversation (or user's latest un-transitioned draft)
  let activeDraft = await prisma.requirementDraft.findFirst({
    where: {
      tenantId,
      userId,
      OR: [
        { copilotConversationId },
        { state: { in: ['NEW', 'UNDERSTANDING', 'CLARIFICATION', 'DRAFT'] } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    include: {
      clarifications: { orderBy: { order: 'asc' } },
      versions: { orderBy: { versionNumber: 'desc' } },
    },
  });

  // Find if there is an active pending clarification question
  const pendingQuestion = activeDraft?.clarifications.find((q) => !q.userAnswer);

  // 2. Classify Intent
  const intent = classifyIntent(message, !!activeDraft, pendingQuestion?.field);

  // 3. Handle specific non-creation intents:

  // --- A. Query Version History ---
  if (intent.intent === 'VIEW_VERSION_HISTORY' && activeDraft) {
    const historyReply = await answerVersionHistoryQuery(activeDraft.id, message);
    const completeness = evaluateCompleteness(activeDraft);
    const versions = await getDraftVersionHistory(activeDraft.id);

    return {
      intent,
      replyMessage: historyReply,
      draft: activeDraft,
      completeness,
      versionHistory: versions,
    };
  }

  // --- B. Answer clarification question ---
  if (intent.intent === 'ANSWER_CLARIFICATION' && activeDraft && pendingQuestion) {
    const field = pendingQuestion.field;
    const answer = intent.entities.answer || message.trim();

    // Update clarification record
    await prisma.clarificationQuestion.update({
      where: { id: pendingQuestion.id },
      data: { userAnswer: answer, answeredAt: new Date() },
    });

    // Update draft field
    const updatePayload: Record<string, any> = { updatedAt: new Date() };

    if (field === 'quantity') {
      const parsedNum = parseInt(answer.replace(/[^\d]/g, ''), 10);
      if (!isNaN(parsedNum)) updatePayload.quantity = parsedNum;
    } else if (field === 'location') {
      updatePayload.location = answer;
    } else if (field === 'estimatedBudget' || field === 'budget') {
      const parsedNum = parseFloat(answer.replace(/[^\d.]/g, ''));
      if (!isNaN(parsedNum)) updatePayload.budget = parsedNum;
    } else if (field === 'requiredDate' || field === 'requiredBy') {
      const parsedDate = new Date(answer);
      if (!isNaN(parsedDate.getTime())) updatePayload.requiredBy = parsedDate;
    } else if (field === 'specifications') {
      const existingSpecs: Record<string, any> = (activeDraft.specifications && typeof activeDraft.specifications === 'object' && !Array.isArray(activeDraft.specifications)) ? { ...(activeDraft.specifications as Record<string, any>) } : {};
      updatePayload.specifications = { ...existingSpecs, preference: answer };
    } else {
      updatePayload[field] = answer;
    }

    // Check diff & record version
    const updatedDraftMock = { ...activeDraft, ...updatePayload };
    const diff = detectRequirementDiff(activeDraft, updatedDraftMock);

    if (diff.hasChanges) {
      const nextVer = (activeDraft.version || 1) + 1;
      await prisma.requirementDraftVersion.create({
        data: {
          draftId: activeDraft.id,
          versionNumber: nextVer,
          changeSummary: diff.changeSummary,
          changedFields: diff.changedFields,
          snapshot: updatedDraftMock,
          changedById: userId,
        },
      });
      updatePayload.version = nextVer;
    }

    activeDraft = await prisma.requirementDraft.update({
      where: { id: activeDraft.id },
      data: updatePayload,
      include: {
        clarifications: { orderBy: { order: 'asc' } },
        versions: { orderBy: { versionNumber: 'desc' } },
      },
    });

    const completeness = evaluateCompleteness(activeDraft);

    let replyMessage = '';
    if (completeness.isSourcingReady) {
      replyMessage = `Got it. I now have enough information to prepare the requirement for department approval.`;
    } else if (completeness.nextQuestions.length > 0) {
      replyMessage = `Got it. ${completeness.nextQuestions[0].question}`;
    } else {
      replyMessage = `Noted. Your requirement has been updated.`;
    }

    return {
      intent,
      replyMessage,
      draft: activeDraft,
      completeness,
      versionHistory: activeDraft.versions,
    };
  }

  // --- C. Edit Existing Requirement ---
  if (intent.intent === 'EDIT_REQUIREMENT' && activeDraft) {
    const extracted = extractRequirement(message);
    const updatePayload: Record<string, any> = { updatedAt: new Date() };

    // Check for explicit removals: "Remove the warranty requirement"
    const isRemoval = /\b(remove|delete|drop|exclude)\b.*(warranty|guarantee)/i.test(message);
    const currentSpecs: Record<string, any> = (activeDraft.specifications && typeof activeDraft.specifications === 'object' && !Array.isArray(activeDraft.specifications)) ? { ...(activeDraft.specifications as Record<string, any>) } : {};

    if (isRemoval) {
      delete currentSpecs.warranty;
      updatePayload.specifications = currentSpecs;
    } else if (extracted.warranty) {
      currentSpecs.warranty = extracted.warranty;
      updatePayload.specifications = currentSpecs;
    }

    if (extracted.quantity !== undefined) updatePayload.quantity = extracted.quantity;
    if (extracted.deliveryLocation) updatePayload.location = extracted.deliveryLocation;
    if (extracted.estimatedBudget !== undefined) updatePayload.budget = extracted.estimatedBudget;
    if (extracted.currency) updatePayload.currency = extracted.currency;
    if (extracted.requiredDate) updatePayload.requiredBy = extracted.requiredDate;
    if (extracted.item && !activeDraft.item) updatePayload.item = extracted.item;

    const updatedDraftMock = { ...activeDraft, ...updatePayload };
    const diff = detectRequirementDiff(activeDraft, updatedDraftMock);

    if (diff.hasChanges) {
      const nextVer = (activeDraft.version || 1) + 1;
      await prisma.requirementDraftVersion.create({
        data: {
          draftId: activeDraft.id,
          versionNumber: nextVer,
          changeSummary: diff.changeSummary,
          changedFields: diff.changedFields,
          snapshot: updatedDraftMock,
          changedById: userId,
        },
      });
      updatePayload.version = nextVer;
    }

    activeDraft = await prisma.requirementDraft.update({
      where: { id: activeDraft.id },
      data: updatePayload,
      include: {
        clarifications: { orderBy: { order: 'asc' } },
        versions: { orderBy: { versionNumber: 'desc' } },
      },
    });

    const completeness = evaluateCompleteness(activeDraft);
    const replyMessage = `I've updated your requirement (${diff.changeSummary}, now Version ${activeDraft.version}).${completeness.isSourcingReady ? ' Everything looks ready for approval.' : ''}`;

    return {
      intent,
      replyMessage,
      draft: activeDraft,
      completeness,
      versionHistory: activeDraft.versions,
    };
  }

  // --- D. Multiple Requirements Detection ---
  const multiCheck = detectMultipleRequirements(message);

  // --- E. Create / Extract New Requirement ---
  const extracted = extractRequirement(message);

  let draftData: Record<string, any> = {
    tenantId,
    userId,
    copilotConversationId,
    item: extracted.item || 'Requirement',
    title: extracted.title || (extracted.item ? `${extracted.item} Requirement` : 'New Requirement'),
    category: extracted.category || 'Product',
    quantity: extracted.quantity,
    unit: extracted.unit || 'units',
    budget: extracted.estimatedBudget,
    currency: extracted.currency || 'INR',
    location: extracted.deliveryLocation,
    requiredBy: extracted.requiredDate,
    specifications: extracted.specifications || {},
    state: 'UNDERSTANDING',
    version: 1,
  };

  if (!activeDraft) {
    // Create new draft
    activeDraft = await prisma.requirementDraft.create({
      data: draftData as any,
      include: {
        clarifications: { orderBy: { order: 'asc' } },
        versions: { orderBy: { versionNumber: 'desc' } },
      },
    });

    // Record Version 1 snapshot
    await prisma.requirementDraftVersion.create({
      data: {
        draftId: activeDraft.id,
        versionNumber: 1,
        changeSummary: `Initial requirement created: ${activeDraft.item}${activeDraft.quantity ? ` (Quantity: ${activeDraft.quantity})` : ''}`,
        changedFields: ['initial'],
        snapshot: activeDraft,
        changedById: userId,
      },
    });
  } else {
    // Merge into active draft
    const updatePayload: Record<string, any> = {};
    if (extracted.item) updatePayload.item = extracted.item;
    if (extracted.category) updatePayload.category = extracted.category;
    if (extracted.quantity) updatePayload.quantity = extracted.quantity;
    if (extracted.unit) updatePayload.unit = extracted.unit;
    if (extracted.estimatedBudget) updatePayload.budget = extracted.estimatedBudget;
    if (extracted.deliveryLocation) updatePayload.location = extracted.deliveryLocation;
    if (extracted.requiredDate) updatePayload.requiredBy = extracted.requiredDate;

    activeDraft = await prisma.requirementDraft.update({
      where: { id: activeDraft.id },
      data: updatePayload,
      include: {
        clarifications: { orderBy: { order: 'asc' } },
        versions: { orderBy: { versionNumber: 'desc' } },
      },
    });
  }

  // 4. Completeness Evaluation & Progressive Questions
  const completeness = evaluateCompleteness(activeDraft);

  // Update draft state
  const newState = completeness.isSourcingReady ? 'DRAFT' : 'CLARIFICATION';
  if (activeDraft.state !== newState) {
    activeDraft = await prisma.requirementDraft.update({
      where: { id: activeDraft.id },
      data: { state: newState },
      include: {
        clarifications: { orderBy: { order: 'asc' } },
        versions: { orderBy: { versionNumber: 'desc' } },
      },
    });
  }

  // Save next clarification question to DB if any
  if (completeness.nextQuestions.length > 0) {
    const nextQ = completeness.nextQuestions[0];
    await prisma.clarificationQuestion.upsert({
      where: { draftId_field: { draftId: activeDraft.id, field: nextQ.field } },
      update: { question: nextQ.question, aiSuggestion: nextQ.suggestion },
      create: {
        draftId: activeDraft.id,
        field: nextQ.field,
        question: nextQ.question,
        aiSuggestion: nextQ.suggestion,
        order: 1,
      },
    });
  }

  // 5. Build intelligent, concise assistant reply
  let replyMessage = '';

  if (multiCheck.isMultiple) {
    replyMessage += `I noticed multiple requirements in your message. I've initialized this draft for **${activeDraft.item}** and will link the secondary item to this request.\n\n`;
  }

  if (completeness.isSourcingReady) {
    replyMessage += `I've structured your requirement for **${activeDraft.item}**. Everything needed to prepare this for department approval is in place.\n\nType **"send for approval"** to submit, or let me know if you would like to adjust any details.`;
  } else if (completeness.nextQuestions.length > 0) {
    const q = completeness.nextQuestions[0];
    replyMessage += `Understood. ${q.question}`;
  } else {
    replyMessage += `I've noted that requirement for **${activeDraft.item}**. Is there anything else you would like to specify?`;
  }

  const versions = await getDraftVersionHistory(activeDraft.id);

  return {
    intent,
    replyMessage,
    draft: activeDraft,
    completeness,
    versionHistory: versions,
    multipleRequirementsDetected: multiCheck.isMultiple,
  };
}
