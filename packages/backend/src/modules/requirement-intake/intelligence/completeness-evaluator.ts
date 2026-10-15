/**
 * NAVO Requirement Intelligence Engine — Completeness Evaluator
 *
 * Evaluates requirement completeness (0–100%), determines sourcing readiness,
 * and generates progressive, non-interrogating clarification questions.
 */

import { CompletenessResult, KnownFieldItem, MissingFieldItem } from './types.js';

interface FieldSpec {
  field: string;
  label: string;
  weight: number;
  isCommodityCritical: boolean;
  isServiceCritical: boolean;
  question: string;
  suggestion?: string;
}

const FIELD_EVALUATION_SPECS: FieldSpec[] = [
  {
    field: 'item',
    label: 'Item / Scope',
    weight: 25,
    isCommodityCritical: true,
    isServiceCritical: true,
    question: 'What specifically do you need to procure?',
  },
  {
    field: 'quantity',
    label: 'Quantity',
    weight: 25,
    isCommodityCritical: true,
    isServiceCritical: false,
    question: 'How many units do you need?',
    suggestion: 'e.g., 10, 50, 100',
  },
  {
    field: 'location',
    label: 'Delivery Location',
    weight: 20,
    isCommodityCritical: true,
    isServiceCritical: true,
    question: 'Where should this be delivered or performed?',
    suggestion: 'e.g., Mumbai, Bangalore, Pune, Germany',
  },
  {
    field: 'requiredDate',
    label: 'Required By Date',
    weight: 15,
    isCommodityCritical: false,
    isServiceCritical: true,
    question: 'When do you need this delivered or completed by?',
    suggestion: 'e.g., end of month, in 2 weeks, by 15 Dec',
  },
  {
    field: 'specifications',
    label: 'Preferred Specifications',
    weight: 10,
    isCommodityCritical: false,
    isServiceCritical: false,
    question: 'Any specific model, brand, or specifications, or should I find the best business option?',
    suggestion: 'e.g., "Best business option", "Ergonomic mesh", "iPhone 15"',
  },
  {
    field: 'estimatedBudget',
    label: 'Target Budget',
    weight: 5,
    isCommodityCritical: false,
    isServiceCritical: false,
    question: 'Do you have an estimated budget in mind?',
    suggestion: 'e.g., ₹12 Lakhs, under $15,000, or "Open to market pricing"',
  },
  {
    field: 'serviceDuration',
    label: 'Service Duration / Scope',
    weight: 15,
    isCommodityCritical: false,
    isServiceCritical: true,
    question: 'What is the duration or frequency for this service?',
    suggestion: 'e.g., monthly, 12 months, project-based',
  },
  {
    field: 'warranty',
    label: 'Warranty Requirement',
    weight: 5,
    isCommodityCritical: false,
    isServiceCritical: false,
    question: 'Do you require a specific warranty period?',
    suggestion: 'e.g., 1 year, 3 years, standard manufacturer warranty',
  },
];

export function evaluateCompleteness(draft: Record<string, any>): CompletenessResult {
  const isService =
    draft.requirementType === 'SERVICE' ||
    draft.requirementType === 'CONSULTING' ||
    draft.requirementType === 'MAINTENANCE' ||
    /\b(service|consulting|maintenance|transport)\b/i.test(draft.category || '');

  const knownFields: KnownFieldItem[] = [];
  const missingFields: MissingFieldItem[] = [];

  let earnedScore = 0;
  let totalWeight = 0;

  for (const spec of FIELD_EVALUATION_SPECS) {
    // Only evaluate serviceDuration for services
    if (spec.field === 'serviceDuration' && !isService) continue;
    // Only evaluate quantity as critical for products
    if (spec.field === 'quantity' && isService && !draft.quantity) continue;

    const value = getDraftFieldValue(draft, spec.field);
    const hasValue = value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

    const isCritical = isService ? spec.isServiceCritical : spec.isCommodityCritical;
    totalWeight += spec.weight;

    if (hasValue) {
      earnedScore += spec.weight;
      knownFields.push({
        field: spec.field,
        label: spec.label,
        value,
        formattedValue: formatValue(spec.field, value, draft.currency),
      });
    } else {
      missingFields.push({
        field: spec.field,
        label: spec.label,
        isCritical,
        question: spec.question,
        suggestion: spec.suggestion,
      });
    }
  }

  const score = Math.min(100, Math.round((earnedScore / totalWeight) * 100));

  // Determine Sourcing Readiness:
  // For Product commodity: Item + Quantity + Delivery Location is enough to prepare for approval!
  // For Service: Item + Location/Duration + Scope is enough to prepare for approval!
  let isSourcingReady = false;
  if (!isService) {
    const hasItem = !!getDraftFieldValue(draft, 'item');
    const hasQuantity = !!getDraftFieldValue(draft, 'quantity');
    const hasLocation = !!getDraftFieldValue(draft, 'location');
    isSourcingReady = hasItem && hasQuantity && hasLocation;
  } else {
    const hasItem = !!getDraftFieldValue(draft, 'item');
    const hasLocationOrDuration = !!getDraftFieldValue(draft, 'location') || !!getDraftFieldValue(draft, 'serviceDuration');
    isSourcingReady = hasItem && hasLocationOrDuration;
  }

  // Next progressive questions: Pick only the single most important missing question!
  // We NEVER ask multiple questions at once.
  const criticalMissing = missingFields.filter((m) => m.isCritical);
  const nextCandidates = criticalMissing.length > 0 ? criticalMissing : missingFields;

  const nextQuestions = nextCandidates.slice(0, 1).map((m) => ({
    field: m.field,
    question: m.question,
    suggestion: m.suggestion,
  }));

  const statusLabel = isSourcingReady ? 'READY_FOR_APPROVAL' : 'NEEDS_INFO';

  return {
    score,
    isSourcingReady,
    statusLabel,
    knownFields,
    missingFields,
    nextQuestions,
  };
}

function getDraftFieldValue(draft: Record<string, any>, field: string): any {
  if (draft[field] !== undefined && draft[field] !== null) {
    return draft[field];
  }
  if (field === 'location' && draft.deliveryLocation) {
    return draft.deliveryLocation;
  }
  if (field === 'estimatedBudget' && draft.budget) {
    return draft.budget;
  }
  if (field === 'requiredDate' && draft.requiredBy) {
    return draft.requiredBy;
  }
  if (field === 'warranty' && draft.specifications?.warranty) {
    return draft.specifications.warranty;
  }
  if (field === 'specifications' && draft.specifications && Object.keys(draft.specifications).length > 0) {
    return draft.specifications;
  }
  return undefined;
}

function formatValue(field: string, val: any, currency = 'INR'): string {
  if (field === 'estimatedBudget') {
    const num = Number(val);
    if (isNaN(num)) return String(val);
    const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₹';
    if (num >= 10000000) return `${sym}${(num / 10000000).toFixed(1)} Cr`;
    if (num >= 100000) return `${sym}${(num / 100000).toFixed(1)} Lakhs`;
    return `${sym}${num.toLocaleString()}`;
  }
  if (field === 'requiredDate' && val instanceof Date) {
    return val.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  if (field === 'specifications' && typeof val === 'object') {
    return Object.entries(val)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
  }
  return String(val);
}
