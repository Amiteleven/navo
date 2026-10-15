import { Prisma, PrismaClient } from '@prisma/client';
import { UserRole } from '@navo/shared';

const prisma = new PrismaClient();

/**
 * Category-specific field requirements for dynamic clarification.
 * Each category defines which fields are "critical" (must have before confirmation)
 * and which are "optional" (nice to have).
 */
const CATEGORY_FIELD_MAP: Record<string, { critical: string[]; optional: string[] }> = {
  Product: {
    critical: ['item', 'quantity', 'unit', 'specifications', 'budget', 'location', 'requiredBy'],
    optional: ['brandPreference', 'model', 'qualityRequirements', 'certifications', 'deliveryExpectations', 'paymentExpectations'],
  },
  Service: {
    critical: ['item', 'description', 'location', 'serviceDuration', 'requiredBy', 'budget'],
    optional: ['scopeOfService', 'frequency', 'contractDuration', 'qualityRequirements', 'complianceRequirements', 'certifications', 'paymentExpectations'],
  },
  Software: {
    critical: ['item', 'description', 'quantity', 'unit', 'budget', 'contractDuration'],
    optional: ['currentSystem', 'integrationRequirements', 'implementationTimeline', 'userCount', 'requiredFeatures', 'complianceRequirements', 'paymentExpectations'],
  },
  'Professional Service': {
    critical: ['item', 'description', 'location', 'budget', 'requiredBy'],
    optional: ['scope', 'deliverables', 'jurisdiction', 'timeline', 'requiredExperience', 'complianceRequirements', 'certifications', 'paymentExpectations'],
  },
  Logistics: {
    critical: ['item', 'quantity', 'unit', 'location', 'requiredBy', 'budget'],
    optional: ['pickupLocation', 'deliveryLocation', 'cargoType', 'frequency', 'vehicleRequirements', 'deliveryExpectations', 'paymentExpectations'],
  },
  Manufacturing: {
    critical: ['item', 'quantity', 'unit', 'specifications', 'budget', 'location', 'requiredBy'],
    optional: ['materialGrade', 'tolerances', 'qualityRequirements', 'certifications', 'deliveryExpectations', 'paymentExpectations'],
  },
  'Raw Material': {
    critical: ['item', 'quantity', 'unit', 'specifications', 'budget', 'location', 'requiredBy'],
    optional: ['materialGrade', 'qualityRequirements', 'certifications', 'deliveryExpectations', 'paymentExpectations'],
  },
  Maintenance: {
    critical: ['item', 'description', 'location', 'requiredBy', 'budget'],
    optional: ['scopeOfWork', 'frequency', 'contractDuration', 'responseTimeSLA', 'certifications', 'paymentExpectations'],
  },
  'Facility Management': {
    critical: ['item', 'description', 'location', 'serviceDuration', 'budget'],
    optional: ['scopeOfService', 'frequency', 'contractDuration', 'complianceRequirements', 'paymentExpectations'],
  },
  Marketing: {
    critical: ['item', 'description', 'budget', 'requiredBy'],
    optional: ['targetAudience', 'channels', 'campaignDuration', 'deliverables', 'paymentExpectations'],
  },
  IT: {
    critical: ['item', 'description', 'budget', 'requiredBy'],
    optional: ['specifications', 'integrationRequirements', 'implementationTimeline', 'certifications', 'paymentExpectations'],
  },
  Consulting: {
    critical: ['item', 'description', 'budget', 'requiredBy'],
    optional: ['scope', 'deliverables', 'timeline', 'requiredExperience', 'jurisdiction', 'paymentExpectations'],
  },
  Travel: {
    critical: ['item', 'description', 'location', 'requiredBy', 'budget'],
    optional: ['destination', 'duration', 'travelMode', 'accommodation', 'paymentExpectations'],
  },
  Event: {
    critical: ['item', 'description', 'location', 'requiredBy', 'budget'],
    optional: ['attendeeCount', 'eventDate', 'duration', 'scopeOfService', 'vendorType', 'paymentExpectations'],
  },
  Construction: {
    critical: ['item', 'description', 'location', 'budget', 'requiredBy'],
    optional: ['scopeOfWork', 'specifications', 'contractDuration', 'complianceRequirements', 'certifications', 'paymentExpectations'],
  },
  'Contracted Service': {
    critical: ['item', 'description', 'location', 'contractDuration', 'budget'],
    optional: ['scopeOfService', 'frequency', 'SLA', 'complianceRequirements', 'paymentExpectations'],
  },
  Other: {
    critical: ['item', 'description', 'budget', 'requiredBy'],
    optional: ['specifications', 'quantity', 'unit', 'location', 'deliveryExpectations', 'paymentExpectations'],
  },
};

/**
 * Normalize a category name to one of our known categories.
 */
export function normalizeCategory(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  const mapping: Record<string, string> = {
    product: 'Product',
    goods: 'Product',
    hardware: 'Product',
    equipment: 'Product',
    material: 'Raw Material',
    'raw material': 'Raw Material',
    supply: 'Product',
    service: 'Service',
    services: 'Service',
    software: 'Software',
    saas: 'Software',
    application: 'Software',
    app: 'Software',
    platform: 'Software',
    'professional service': 'Professional Service',
    consulting: 'Consulting',
    consultant: 'Consulting',
    legal: 'Professional Service',
    accounting: 'Professional Service',
    audit: 'Professional Service',
    logistics: 'Logistics',
    transport: 'Logistics',
    transportation: 'Logistics',
    shipping: 'Logistics',
    freight: 'Logistics',
    manufacturing: 'Manufacturing',
    fabrication: 'Manufacturing',
    production: 'Manufacturing',
    maintenance: 'Maintenance',
    repair: 'Maintenance',
    'facility management': 'Facility Management',
    facilities: 'Facility Management',
    housekeeping: 'Service',
    cleaning: 'Service',
    security: 'Service',
    marketing: 'Marketing',
    advertising: 'Marketing',
    digital: 'Marketing',
    it: 'IT',
    technology: 'IT',
    infrastructure: 'IT',
    travel: 'Travel',
    event: 'Event',
    events: 'Event',
    conference: 'Event',
    construction: 'Construction',
    renovation: 'Construction',
    build: 'Construction',
    contracted: 'Contracted Service',
    contract: 'Contracted Service',
    outsourcing: 'Contracted Service',
  };
  return mapping[normalized] ?? 'Other';
}

/**
 * Get critical and optional fields for a category.
 */
export function getCategoryFields(category: string): { critical: string[]; optional: string[] } {
  return CATEGORY_FIELD_MAP[category] ?? CATEGORY_FIELD_MAP.Other;
}

/**
 * Extract missing critical fields from a draft.
 */
export function getMissingCriticalFields(draft: {
  category?: string;
  [key: string]: unknown;
}): string[] {
  const cat = draft.category ?? 'Other';
  const { critical } = getCategoryFields(cat);
  return critical.filter((field) => {
    const value = draft[field];
    return value === undefined || value === null || value === '';
  });
}

import { evaluateCompleteness } from './intelligence/completeness-evaluator.js';

/**
 * Check if a draft has enough information to be confirmed.
 * A draft is confirmable when all critical fields are filled or when it meets sourcing readiness.
 */
export function isDraftConfirmable(draft: {
  category?: string;
  [key: string]: unknown;
}): boolean {
  if (draft.item) {
    const completeness = evaluateCompleteness({
      item: (draft.item as string) ?? null,
      requirementType: (draft.requirementType as any) ?? ((draft.category === 'Service' || draft.category === 'Consulting' || draft.category === 'Contracted Service') ? 'SERVICE' : 'PRODUCT'),
      category: (draft.category as string) ?? null,
      quantity: typeof draft.quantity === 'number' ? draft.quantity : null,
      unit: (draft.unit as string) ?? null,
      deliveryLocation: (draft.location as string) ?? null,
      requiredDate: draft.requiredBy ? String(draft.requiredBy) : null,
      estimatedBudget: draft.budget ? Number(draft.budget) : null,
      currency: (draft.currency as string) ?? 'INR',
      specifications: (draft.specifications as any) ?? null,
    });
    if (completeness.isSourcingReady) {
      return true;
    }
  }
  return getMissingCriticalFields(draft).length === 0;
}

/**
 * Generate clarification questions for missing critical fields.
 * Returns questions in priority order.
 */
export function generateClarificationQuestions(draft: {
  category?: string;
  [key: string]: unknown;
}): Array<{ field: string; question: string; suggestion?: string }> {
  const missing = getMissingCriticalFields(draft);
  const cat = draft.category ?? 'Other';
  const { optional } = getCategoryFields(cat);

  const fieldQuestions: Record<string, { question: string; suggestion?: string }> = {
    item: { question: 'What specifically do you need to procure?' },
    title: { question: 'What would you like to call this requirement?' },
    category: { question: 'What type of procurement is this? (e.g., Product, Service, Software, Professional Service)' },
    quantity: { question: 'How many units do you need?', suggestion: 'Enter a number (e.g., 20)' },
    unit: { question: 'What is the unit of measure?', suggestion: 'e.g., units, kg, boxes, hours, licenses' },
    specifications: { question: 'What are the key specifications or requirements?' },
    description: { question: 'Can you describe the requirement in more detail?' },
    budget: { question: 'What is your budget (total or per unit)?', suggestion: 'e.g., ₹60,000 per unit or ₹12,00,000 total' },
    currency: { question: 'What currency is the budget in?', suggestion: 'INR' },
    location: { question: 'Where should this be delivered or performed?' },
    requiredBy: { question: 'When do you need this by?', suggestion: 'e.g., 2026-01-15, next month, in 30 days' },
    serviceDuration: { question: 'What is the service duration or frequency?', suggestion: 'e.g., monthly, annually, project-based, one-time' },
    contractDuration: { question: 'What is the contract duration?', suggestion: 'e.g., 12 months, 3 years' },
    qualityRequirements: { question: 'Are there specific quality standards or certifications required?' },
    brandPreference: { question: 'Do you have a preferred brand or model?' },
    model: { question: 'Is there a specific model number or variant?' },
    complianceRequirements: { question: 'Are there regulatory or compliance requirements?' },
    certifications: { question: 'Do vendors need specific certifications?' },
    paymentExpectations: { question: 'What are your payment terms expectations?', suggestion: 'e.g., Net 30, advance 50%, milestone-based' },
    deliveryExpectations: { question: 'Any specific delivery requirements?', suggestion: 'e.g., door delivery, installed, configured' },
    scopeOfService: { question: 'What is the scope of the service?' },
    frequency: { question: 'How often is this service needed?' },
    currentSystem: { question: 'What system are you currently using (if replacing)?' },
    integrationRequirements: { question: 'What integrations are required?' },
    implementationTimeline: { question: 'What is the expected implementation timeline?' },
    userCount: { question: 'How many users/licenses are needed?' },
    requiredFeatures: { question: 'What key features are required?' },
    scope: { question: 'What is the scope of work?' },
    deliverables: { question: 'What are the expected deliverables?' },
    jurisdiction: { question: 'What jurisdiction or location applies?' },
    timeline: { question: 'What is the project timeline?' },
    requiredExperience: { question: 'What experience level is required?' },
    pickupLocation: { question: 'Where is the pickup location?' },
    deliveryLocation: { question: 'Where is the delivery location?' },
    cargoType: { question: 'What type of cargo/goods?' },
    vehicleRequirements: { question: 'Any specific vehicle requirements?' },
    materialGrade: { question: 'What material grade or specification?' },
    tolerances: { question: 'What are the manufacturing tolerances?' },
    responseTimeSLA: { question: 'What response time SLA is required?' },
    targetAudience: { question: 'Who is the target audience?' },
    channels: { question: 'Which marketing channels?' },
    campaignDuration: { question: 'What is the campaign duration?' },
    attendeeCount: { question: 'How many attendees are expected?' },
    eventDate: { question: 'When is the event date?' },
    vendorType: { question: 'What type of vendor are you looking for?' },
    scopeOfWork: { question: 'What is the scope of work?' },
    SLA: { question: 'What service level agreement (SLA) is required?' },
  };

  return missing
    .map((field) => {
      const fq = fieldQuestions[field] ?? { question: `Please provide the ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}.` };
      return { field, question: fq.question, suggestion: fq.suggestion };
    })
    .concat(
      optional
        .filter((f) => !draft[f] || draft[f] === '')
        .map((field) => {
          const fq = fieldQuestions[field] ?? { question: `Please provide the ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}.` };
          return { field, question: fq.question, suggestion: fq.suggestion };
        })
    );
}

/**
 * Create or update a requirement draft from a conversation message.
 */
export async function upsertRequirementDraft(params: {
  tenantId: string;
  userId: string;
  copilotConversationId: string;
  message: string;
  extractedData?: Record<string, unknown>;
}): Promise<{
  draft: any;
  questions: Array<{ field: string; question: string; suggestion?: string }>;
  isConfirmable: boolean;
}> {
  const { tenantId, userId, copilotConversationId, message, extractedData = {} } = params;

  // Find existing draft for this conversation
  let draft = await prisma.requirementDraft.findUnique({
    where: { copilotConversationId },
  });

  // Merge extracted data with existing draft
  const mergedData: Record<string, unknown> = {
    ...(draft ? {
      title: draft.title ?? undefined,
      category: draft.category ?? undefined,
      item: draft.item ?? undefined,
      description: draft.description ?? undefined,
      specifications: draft.specifications ?? undefined,
      quantity: draft.quantity ?? undefined,
      unit: draft.unit ?? undefined,
      budget: draft.budget?.toString() ?? undefined,
      currency: draft.currency ?? undefined,
      location: draft.location ?? undefined,
      requiredBy: draft.requiredBy?.toISOString() ?? undefined,
      serviceDuration: draft.serviceDuration ?? undefined,
      contractDuration: draft.contractDuration ?? undefined,
      qualityRequirements: draft.qualityRequirements ?? undefined,
      brandPreference: draft.brandPreference ?? undefined,
      model: draft.model ?? undefined,
      complianceRequirements: draft.complianceRequirements ?? undefined,
      certifications: draft.certifications ?? undefined,
      paymentExpectations: draft.paymentExpectations ?? undefined,
      deliveryExpectations: draft.deliveryExpectations ?? undefined,
      otherRequirements: draft.otherRequirements ?? undefined,
      missingFields: draft.missingFields ?? [],
    } : {}),
    ...extractedData,
  };

  // Determine category if not set
  let category: string | undefined = mergedData.category as string | undefined;
  if (!category && mergedData.item) {
    category = inferCategoryFromItem(mergedData.item as string, message);
    mergedData.category = category;
  }

  // Get missing critical fields
  const missingFields = getMissingCriticalFields({ ...mergedData, category });

  if (draft) {
    // Update existing draft
    draft = await prisma.requirementDraft.update({
      where: { id: draft.id },
      data: {
        ...mergedData,
        category: category ?? draft.category ?? 'Other',
        missingFields,
        state: missingFields.length > 0 ? 'CLARIFICATION' : 'DRAFT',
        updatedAt: new Date(),
      },
    });
  } else {
    // Create new draft
    draft = await prisma.requirementDraft.create({
      data: {
        tenantId,
        userId,
        copilotConversationId,
        ...mergedData,
        category: category ?? 'Other',
        missingFields,
        state: missingFields.length > 0 ? 'UNDERSTANDING' : 'DRAFT',
      },
    });
  }

  // Generate clarification questions
  const questions = generateClarificationQuestions({
    ...mergedData,
    category,
  });

  // Store questions as ClarificationQuestion records
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    await prisma.clarificationQuestion.upsert({
      where: {
        draftId_field: { draftId: draft.id, field: q.field },
      },
      update: { question: q.question, aiSuggestion: q.suggestion, order: i },
      create: {
        draftId: draft.id,
        field: q.field,
        question: q.question,
        aiSuggestion: q.suggestion,
        order: i,
      },
    });
  }

  return {
    draft,
    questions,
    isConfirmable: isDraftConfirmable({ ...mergedData, category }),
  };
}

/**
 * Infer category from item name and message context.
 */
function inferCategoryFromItem(item: string, message: string): string {
  const text = `${item} ${message}`.toLowerCase();

  if (/\b(laptop|computer|desktop|monitor|phone|tablet|printer|server|hardware|equipment|device|machine)\b/.test(text)) return 'Product';
  if (/\b(software|saas|application|app|platform|license|subscription|cloud)\b/.test(text)) return 'Software';
  if (/\b(consulting|consultant|legal|accounting|audit|advisory|lawyer|ca|cs)\b/.test(text)) return 'Professional Service';
  if (/\b(logistics|transport|shipping|freight|delivery|courier)\b/.test(text)) return 'Logistics';
  if (/\b(maintenance|repair|servicing|amc|annual maintenance)\b/.test(text)) return 'Maintenance';
  if (/\b(housekeeping|cleaning|security|facility|facilities|janitorial)\b/.test(text)) return 'Facility Management';
  if (/\b(marketing|advertising|digital marketing|seo|social media)\b/.test(text)) return 'Marketing';
  if (/\b(it|technology|infrastructure|devops|cloud|hosting)\b/.test(text)) return 'IT';
  if (/\b(travel|flight|hotel|accommodation|visa)\b/.test(text)) return 'Travel';
  if (/\b(event|conference|exhibition|seminar|workshop)\b/.test(text)) return 'Event';
  if (/\b(construction|renovation|building|civil|interior)\b/.test(text)) return 'Construction';
  if (/\b(manufacturing|fabrication|production|assembly)\b/.test(text)) return 'Manufacturing';
  if (/\b(raw material|steel|cement|chemical|plastic|polymer)\b/.test(text)) return 'Raw Material';
  if (/\b(contracted|outsourcing|contract staff|manpower)\b/.test(text)) return 'Contracted Service';

  return 'Other';
}

/**
 * Confirm a requirement draft and create a ProcurementRequest.
 */
export async function confirmRequirementDraft(params: {
  draftId: string;
  userId: string;
  tenantId: string;
}): Promise<{ requestId: string }> {
  const { draftId, userId, tenantId } = params;

  const draft = await prisma.requirementDraft.findFirst({
    where: { id: draftId, tenantId, userId },
    include: { clarifications: true },
  });

  if (!draft) {
    throw new Error('Requirement draft not found');
  }

  if (!isDraftConfirmable({ ...draft, category: draft.category ?? undefined })) {
    throw new Error('Draft is missing critical fields and cannot be confirmed');
  }

  // Create the ProcurementRequest from the draft
  const request = await prisma.procurementRequest.create({
    data: {
      tenantId,
      requesterId: userId,
      title: draft.title ?? draft.item ?? 'Procurement Requirement',
      description: draft.description ?? `AI-generated requirement for ${draft.item}`,
      item: draft.item ?? 'To be determined',
      quantity: draft.quantity ?? 1,
      unit: draft.unit ?? 'units',
      location: draft.location ?? 'Not specified',
      requiredDate: draft.requiredBy ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      specifications: draft.specifications ? JSON.stringify(draft.specifications) : undefined,
      estimatedBudget: draft.budget ? Number(draft.budget) : undefined,
      status: 'REQUIREMENT_DRAFT',
      department: draft.specifications && typeof draft.specifications === 'object' && 'department' in draft.specifications
        ? String(draft.specifications.department)
        : undefined,
      costCenter: draft.specifications && typeof draft.specifications === 'object' && 'costCenter' in draft.specifications
        ? String(draft.specifications.costCenter)
        : undefined,
    },
  });

  // Update draft as confirmed and linked
  await prisma.requirementDraft.update({
    where: { id: draftId },
    data: {
      state: 'TRANSITIONED',
      confirmedAt: new Date(),
      confirmedById: userId,
      requestId: request.id,
    },
  });

  return { requestId: request.id };
}

/**
 * Get the active requirement draft for a user/conversation.
 */
export async function getActiveDraft(params: {
  tenantId: string;
  userId: string;
  copilotConversationId?: string;
}): Promise<any | null> {
  const { tenantId, userId, copilotConversationId } = params;

  if (copilotConversationId) {
    return prisma.requirementDraft.findUnique({
      where: { copilotConversationId },
      include: { clarifications: { orderBy: { order: 'asc' } } },
    });
  }

  // Get the most recent non-transitioned draft
  return prisma.requirementDraft.findFirst({
    where: {
      tenantId,
      userId,
      state: { notIn: ['TRANSITIONED', 'ABANDONED'] },
    },
    orderBy: { updatedAt: 'desc' },
    include: { clarifications: { orderBy: { order: 'asc' } } },
  });
}

/**
 * Update draft with user's answer to a clarification question.
 */
export async function answerClarification(params: {
  draftId: string;
  field: string;
  answer: string;
  tenantId: string;
  userId: string;
}): Promise<{
  draft: any;
  questions: Array<{ field: string; question: string; suggestion?: string }>;
  isConfirmable: boolean;
}> {
  const { draftId, field, answer, tenantId, userId } = params;

  const draft = await prisma.requirementDraft.findFirst({
    where: { id: draftId, tenantId, userId },
  });

  if (!draft) {
    throw new Error('Requirement draft not found');
  }

  // Update the draft with the answer
  const updatedDraft = await prisma.requirementDraft.update({
    where: { id: draftId },
    data: {
      [field]: answer,
      missingFields: draft.missingFields.filter((f) => f !== field),
      state: draft.missingFields.length <= 1 ? 'DRAFT' : 'CLARIFICATION',
      updatedAt: new Date(),
    },
  });

  // Update the clarification question record
  await prisma.clarificationQuestion.updateMany({
    where: { draftId, field },
    data: { userAnswer: answer, answeredAt: new Date() },
  });

  // Generate remaining questions
  const mergedData = {
    ...updatedDraft,
    category: updatedDraft.category ?? undefined,
    [field]: answer,
  };

  const questions = generateClarificationQuestions(mergedData);

  return {
    draft: updatedDraft,
    questions,
    isConfirmable: isDraftConfirmable(mergedData),
  };
}