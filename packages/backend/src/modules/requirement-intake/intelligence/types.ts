/**
 * NAVO Requirement Intelligence Engine — Types
 */

export type ProcurementIntentType =
  | 'CREATE_REQUIREMENT'
  | 'EDIT_REQUIREMENT'
  | 'FIND_VENDOR'
  | 'PUBLISH_OPEN_MARKET'
  | 'COMPARE_QUOTES'
  | 'NEGOTIATE'
  | 'CHECK_REQUIREMENT'
  | 'CHECK_DEAL'
  | 'CHECK_ORDER'
  | 'CHECK_DELIVERY'
  | 'CHECK_INVOICE'
  | 'REQUEST_APPROVAL'
  | 'VIEW_VERSION_HISTORY'
  | 'ANSWER_CLARIFICATION'
  | 'CONFIRM_REQUIREMENT'
  | 'GENERAL_PROCUREMENT_QUERY';

export type RequirementType =
  | 'PRODUCT'
  | 'SERVICE'
  | 'SOFTWARE'
  | 'RAW_MATERIAL'
  | 'LOGISTICS'
  | 'MAINTENANCE'
  | 'CONSULTING'
  | 'FACILITY'
  | 'OTHER';

export interface ExtractedRequirementData {
  item?: string;
  category?: string;
  requirementType?: RequirementType;
  title?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  estimatedBudget?: number;
  currency?: string;
  deliveryLocation?: string;
  requiredDate?: Date;
  businessPurpose?: string;
  specifications?: Record<string, any>;
  brandPreference?: string;
  model?: string;
  warranty?: string;
  serviceDuration?: string;
  contractDuration?: string;
  scope?: string;
  sla?: string;
  users?: number;
  deployment?: string;
  certifications?: string;
  qualityRequirements?: string;
  complianceRequirements?: string;
  paymentExpectations?: string;
  deliveryExpectations?: string;
  rawText?: string;
}

export interface IntentClassificationResult {
  intent: ProcurementIntentType;
  confidence: number;
  entities: Record<string, any>;
  reasoning: string;
}

export interface KnownFieldItem {
  field: string;
  label: string;
  value: any;
  formattedValue: string;
}

export interface MissingFieldItem {
  field: string;
  label: string;
  isCritical: boolean;
  question: string;
  suggestion?: string;
}

export interface CompletenessResult {
  score: number; // 0 to 100
  isSourcingReady: boolean;
  statusLabel: 'NEEDS_INFO' | 'READY_FOR_APPROVAL' | 'SUBMITTED_FOR_APPROVAL' | 'APPROVED_FOR_SOURCING';
  knownFields: KnownFieldItem[];
  missingFields: MissingFieldItem[];
  nextQuestions: Array<{ field: string; question: string; suggestion?: string }>;
}

export interface MaterialChangeEvaluation {
  isMaterial: boolean;
  requiresReapproval: boolean;
  reason?: string;
  changes: Array<{
    field: string;
    oldValue: any;
    newValue: any;
    isMaterial: boolean;
  }>;
}

export interface VersionSnapshot {
  versionNumber: number;
  changeSummary: string;
  changedFields: string[];
  snapshot: Record<string, any>;
  changedById?: string;
  createdAt: Date;
}
