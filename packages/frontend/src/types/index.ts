export * from '@navo/shared';
import { 
  UserRole, 
  RequestStatus,
  RFQStatus,
  QuoteStatus,
  ApprovalStatus,
  VendorStatus,
  AuditAction,
  ConnectionStatus,
  DealRoomStatus,
  DealOfferStatus,
  DealStatus,
  NegotiationStatus,
  SavingsType,
  QuoteAnalysisType,
  PurchaseOrderStatus,
  ProcurementRequest,
  Vendor,
  InterestStatus,
  RestrictionKind,
  ReportReason,
  NotificationFrequency,
   PurchaseApprovalStatus,
   PurchaseApprovalRequestDetail,
   RequirementDraftState,
   RequirementCategory,
   DealExecutionStatus,
   DealExecutionType,
   DealExecutionEventType,
 } from '@navo/shared';

export {
  UserRole,
  RequestStatus,
  RFQStatus,
  QuoteStatus,
  ApprovalStatus,
  VendorStatus,
  AuditAction,
  ConnectionStatus,
  DealRoomStatus,
  DealOfferStatus,
  DealStatus,
  NegotiationStatus,
  SavingsType,
  QuoteAnalysisType,
  PurchaseOrderStatus,
  RequirementDraftState,
  RequirementCategory,
  DealExecutionStatus,
  DealExecutionType,
  DealExecutionEventType,
};

// API Response types
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  details?: Record<string, string[]>;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
  tenantName?: string;
  companySlug?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: {
    userId: string;
    tenantId: string;
    email: string;
    role: UserRole;
  };
}

// Input types for API
export interface CreateRequestData {
  title: string;
  description: string;
  categoryId?: string;
  item: string;
  quantity: number;
  unit?: string;
  location: string;
  requiredDate: string;
  specifications?: string;
  estimatedBudget?: number;
  priority?: number;
}

export interface CreateVendorData {
  name: string;
  categoryId?: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  products?: string;
  notes?: string;
}

export interface CreateRFQData {
  requestId: string;
  title: string;
  description: string;
  quantity: number;
  specifications?: string;
  deliveryLocation: string;
  requiredDeliveryDate: string;
  submissionDeadline: string;
  vendorIds: string[];
}

export interface SubmitQuoteData {
  rfqId: string;
  vendorId: string;
  unitPrice: number;
  quantity: number;
  taxRate?: number;
  freightAmount?: number;
  installationAmount?: number;
  warrantyMonths?: number;
  deliveryTimelineDays?: number;
  paymentTerms?: string;
  validityDays?: number;
  otherCharges?: number;
  otherChargesDetails?: string;
  attachments?: string[];
}

// Connection & Deal types
export interface Connection {
  id: string;
  requestId: string;
  buyerId: string;
  vendorId: string;
  status: ConnectionStatus;
  initiatedAt: string;
  respondedAt?: string;
  tenantId: string;
  dealRoom?: DealRoom | null;
  request?: ProcurementRequest;
  vendor?: Vendor;
  createdAt: string;
  updatedAt: string;
}

export interface DealRoom {
  id: string;
  connectionId: string;
  requestId: string;
  buyerId: string;
  vendorId: string;
  status: DealRoomStatus;
  closedAt?: string;
  dealId?: string;
  tenantId: string;
  request?: ProcurementRequest;
  vendor?: Vendor;
  createdAt: string;
  updatedAt: string;
}

export interface DealRoomDetail extends DealRoom {
  connection?: Connection;
  deal?: Deal | null;
  offers?: DealOffer[];
  messages?: DealMessage[];
  negotiationMessages?: NegotiationMessage[];
}

export interface DealMessage {
  id: string;
  dealRoomId: string;
  senderId: string;
  senderRole: string;
  content: string;
  messageType: string;
  createdAt: string;
}

export interface DealOffer {
  id: string;
  dealRoomId: string;
  submittedById: string;
  submittedByRole: string;
  unitPrice: number;
  quantity: number;
  gst: number;
  freightAmount: number;
  installationAmount: number;
  warrantyMonths?: number;
  deliveryTimelineDays?: number;
  paymentTerms?: string;
  validityDays?: number;
  otherCharges: number;
  otherChargesDetails?: string;
  status: DealOfferStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Deal {
  id: string;
  dealNumber: string;
  dealRoomId: string;
  requestId: string;
  buyerId: string;
  vendorId: string;
  status: DealStatus;
  acceptedOfferId?: string;
  /** Present once a purchase order has been raised from the accepted offer. */
  purchaseOrder?: { id: string; poNumber: string; status: PurchaseOrderStatus } | null;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  executionStatus: DealExecutionStatus;
  executionType?: DealExecutionType | null;
  selectedSubmissionId?: string | null;
  commercialSnapshot?: Record<string, unknown> | null;
  supplierConfirmedAt?: string | null;
  executionEvents?: DealExecutionEvent[];
}

/** Audit trail entry for a deal execution-phase event. */
export interface DealExecutionEvent {
  id: string;
  dealId: string;
  tenantId: string;
  type: DealExecutionEventType;
  description: string;
  actorId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ListDealExecutionsResponse {
  deals: Array<{
    id: string;
    dealNumber: string;
    executionStatus: DealExecutionStatus;
    executionType: DealExecutionType | null;
    status: DealStatus;
    requestId: string;
    vendorId: string;
    createdAt: string;
  }>;
  total: number;
}

export interface DealExecutionDetail {
  deal: {
    id: string;
    dealNumber: string;
    status: DealStatus;
    executionStatus: DealExecutionStatus;
    executionType: DealExecutionType | null;
    commercialSnapshot: Record<string, unknown> | null;
    supplierConfirmedAt: string | null;
  };
  request: { id: string; title: string; item: string; quantity: number; unit: string | null; status: RequestStatus };
  vendor: { id: string; name: string };
  approval: {
    id: string;
    reference: string;
    status: string;
    isPurchaseComplete: boolean;
    decisions: Array<{
      level: number;
      status: string;
      assignedApprover: { id: string; firstName: string; lastName: string } | null;
      decidedBy: { id: string; firstName: string; lastName: string } | null;
      createdAt: string;
      decidedAt: string | null;
    }>;
  } | null;
  purchaseOrder: { id: string; poNumber: string; status: PurchaseOrderStatus } | null;
  executionEvents: DealExecutionEvent[];
}

export interface VendorAvailability {
  id: string;
  vendorId: string;
  tenantId: string;
  isOnline: boolean;
  isBusy: boolean;
  lastSeenAt: string;
  updatedAt: string;
}

export interface NegotiationMessage {
  id: string;
  dealRoomId: string;
  senderId: string;
  senderRole: string;
  content: string;
  messageType: string;
  metadata?: Record<string, unknown>;
  targetPrice?: number;
  status: NegotiationStatus;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteAnalysis {
  id: string;
  quoteId: string;
  type: QuoteAnalysisType;
  content: {
    commercialSummary: string;
    priceBenchmark: {
      currentQuote: number;
      minPrice?: number;
      avgPrice?: number;
      maxPrice?: number;
      historicalComparison?: string;
      dataSource?: string;
      sampleSize?: number;
      confidence: number;
    };
    differences: Array<{
      field: string;
      current: string | number;
      comparison: string | number;
      difference: string | number;
      impact: 'high' | 'medium' | 'low';
    }>;
    tradeoffs: Array<{
      supplier: string;
      pros: string[];
      cons: string[];
    }>;
    negotiationStrategy?: {
      targetPrice: number;
      approach: string;
      keyPoints: string[];
      draftMessage: string;
      tradeoffs: string[];
    };
    savingsEstimation?: {
      potentialSavings: number;
      savingsPercentage: number;
      baseline: number;
      baselineSource: string;
      confidence: number;
    };
    missingInfo: string[];
    warnings: string[];
  };
  confidence: number;
  evidence?: Record<string, unknown>;
  generatedBy?: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavingsRecord {
  id: string;
  dealId?: string;
  requestId: string;
  buyerId: string;
  vendorId: string;
  type: SavingsType;
  originalQuoteAmount: number;
  finalAcceptedAmount: number;
  baselineAmount?: number;
  baselineSource?: string;
  baselinePeriodStart?: string;
  baselinePeriodEnd?: string;
  savingsAmount: number;
  savingsPercentage: number;
  calculationMethod: string;
  evidence?: Record<string, unknown>;
  verifiedAt?: string;
  verifiedBy?: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

// Connection input types
export interface CreateConnectionInput {
  requestId: string;
  vendorId: string;
}

// Offer input types
export interface CreateOfferInput {
  dealRoomId: string;
  unitPrice: number;
  quantity: number;
  gst?: number;
  freightAmount?: number;
  installationAmount?: number;
  warrantyMonths?: number;
  deliveryTimelineDays?: number;
  paymentTerms?: string;
  validityDays?: number;
  otherCharges?: number;
  otherChargesDetails?: string;
}

// Message input
export interface CreateMessageInput {
  content: string;
}

// Offer acceptance
export interface AcceptOfferInput {
  offerId: string;
}

// Deal status update
export interface UpdateDealStatusInput {
  status: DealStatus;
}

// Vendor availability update
export interface UpdateVendorAvailabilityInput {
  isOnline: boolean;
  isBusy: boolean;
}

// Vendor Invitation types
export interface CreateInvitationInput {
  email: string;
  role?: string;
  expiresInDays?: number;
}

export interface AcceptInvitationInput {
  token: string;
  vendorData?: {
    name: string;
    contactPerson?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
    products?: string;
    gstin?: string;
  };
}

// Offer total calculation
export interface OfferTotal {
  subtotal: number;
  gstAmount: number;
  total: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace and controlled communication
//
// The enums (RequestVisibility, InterestStatus, RestrictionKind, ReportReason,
// NotificationFrequency) are re-exported from @navo/shared above, so they are not
// redeclared here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A requirement as a seller is allowed to see it.
 *
 * The omission of `estimatedBudget`, `description`, `requesterId` and
 * attachments is the security control, not an oversight: the seller's view never
 * contains the buyer's confidential fields, so they cannot be recovered from a
 * cached response either.
 */
export interface MarketRequirement {
  id: string;
  title: string;
  item: string;
  quantity: number;
  unit: string;
  location: string | null;
  requiredDate: string | null;
  quotationDeadline: string | null;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  status: string;
  createdAt: string;
}

export interface MarketRequirementDetail extends MarketRequirement {
  /** This seller's own interest, if any. */
  interests: Array<{
    id: string;
    status: InterestStatus;
    quoteId: string | null;
    createdAt: string;
  }>;
}

export interface MarketplaceInterest {
  id: string;
  status: InterestStatus;
  createdAt: string;
  request: { id: string; title: string; status: string; quotationDeadline: string | null };
  quote: { id: string; unitPrice: number; quantity: number; status: string } | null;
}

/** A buyer's block or mute of one supplier. */
export interface ContactRestriction {
  id: string;
  vendorId: string;
  kind: RestrictionKind;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  vendor?: { id: string; name: string; status: string } | null;
}

export interface AbuseReport {
  id: string;
  vendorId: string;
  reason: ReportReason;
  details: string | null;
  status: string;
  createdAt: string;
  vendor?: { id: string; name: string } | null;
}

/**
 * Why a seller may or may not contact a buyer.
 *
 * Shown in the UI instead of a bare refusal, so the seller is told what action
 * would create a permitted interaction.
 */
export type InteractionBasis =
  | 'NONE'
  | 'MARKETPLACE_INTEREST'
  | 'BUYER_INVITED'
  | 'CONNECTION_ACCEPTED'
  | 'ACTIVE_DEAL';

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationItem {
  id: string;
  type: string;
  priority: string;
  title: string;
  message: string;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
  data: { linkPath?: string; [key: string]: unknown } | null;
}

export interface NotificationPreference {
  id: string;
  userId: string;
  eventType: string;
  frequency: NotificationFrequency;
}

/** Deal-room read state, kept per reader so participants never share it. */
export interface RoomUnreadState {
  dealRoomId: string;
  unread: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manager approval & purchase authorization
//
// The enums, the policy and rule shapes, and the request DTOs come from
// @navo/shared (re-exported above) so the client cannot drift from the server's
// validation. Only the shapes the backend assembles for the UI live here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The administrative overview.
 *
 * Every figure is derived from stored rows. `sampleSize` is not decoration: it
 * states how many decided requests the turnaround numbers were computed from, so
 * a mean over two approvals is never read as an organization-wide measurement.
 */
export interface ApprovalOverview {
  /** Decided requests the turnaround figures were computed from. */
  sampleSize: number;
  pendingCount: number;
  byStatus: Partial<Record<PurchaseApprovalStatus, number>>;
  averageTurnaroundHours: number | null;
  medianTurnaroundHours: number | null;
  longestPendingDays: number;
  pending: Array<{
    id: string;
    reference: string;
    totalAmount: number;
    currency: string;
    currentLevel: number;
    submittedBy: { id: string; firstName: string; lastName: string } | null;
    vendor: { id: string; name: string } | null;
    waitingDays: number;
  }>;
  returnedOrRejected: Array<{
    id: string;
    reference: string;
    status: PurchaseApprovalStatus;
    totalAmount: number;
    currency: string;
    submittedBy: { id: string; firstName: string; lastName: string } | null;
    vendor: { id: string; name: string } | null;
    comments: string | null;
    decidedBy: { firstName: string; lastName: string } | null;
  }>;
  history?: {
    requests: PurchaseApprovalRequestDetail[];
    decisions: Array<{
      id: string;
      purchaseApprovalRequestId: string;
      level: number;
      requiredRole: string;
      status: string;
      comments: string | null;
      decidedAt: string | null;
      assignedApprover?: { id: string; firstName: string; lastName: string; email: string } | null;
      decidedBy?: { id: string; firstName: string; lastName: string; email: string } | null;
      assignments: Array<{
        id: string;
        fromApproverId: string | null;
        toApproverId: string;
        reason: string;
        createdAt: string;
        toApprover?: { id: string; firstName: string; lastName: string; email: string } | null;
        createdBy?: { id: string; firstName: string; lastName: string; email: string } | null;
      }>;
    }>;
    auditTrail: Array<{
      id: string;
      userId: string;
      action: string;
      entityType: string;
      entityId: string;
      previousStatus: string | null;
      newStatus: string | null;
      decision: string | null;
      createdAt: string;
      user: { id: string; firstName: string; lastName: string; email: string } | null;
    }>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal AI Requirement Intake
//
// Types for the chat-first requirement capture flow that guides buyers from
// natural-language need through clarification, confirmation, and into the
// formal ProcurementRequest workflow.
// ─────────────────────────────────────────────────────────────────────────────

export interface ClarificationQuestion {
  id: string;
  field: string;
  question: string;
  suggestion?: string;
  userAnswer?: string;
  order: number;
}

export interface RequirementDraft {
  id: string;
  tenantId: string;
  userId: string;
  copilotConversationId?: string;
  category: RequirementCategory | null;
  title: string | null;
  item: string | null;
  quantity: string | null;
  unit: string | null;
  location: string | null;
  requiredDate: string | null;
  specifications: string | null;
  estimatedBudget: string | null;
  currency: string;
  priority: number;
  departmentId: string | null;
  costCenterId: string | null;
  state: RequirementDraftState;
  extractedData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  questions: ClarificationQuestion[];
  confirmedAt?: string;
  procurementRequestId?: string;
  version?: number;
  completeness?: {
    score: number;
    isSourcingReady: boolean;
    statusLabel: string;
    knownFields: Array<{ field: string; label: string; formattedValue: string }>;
    missingFields: Array<{ field: string; label: string; isCritical: boolean; question: string }>;
    nextQuestions: Array<{ field: string; question: string; suggestion?: string }>;
  };
  versionHistory?: Array<{
    versionNumber: number;
    changeSummary: string;
    changedFields: string[];
    createdAt: string;
  }>;
}

export interface RequirementDraftDetail extends RequirementDraft {
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  procurementRequest?: {
    id: string;
    reference: string;
    status: RequestStatus;
  } | null;
}

export interface CreateRequirementDraftInput {
  message: string;
  conversationId?: string;
  extractedData?: Record<string, unknown>;
}

export interface AnswerClarificationInput {
  draftId: string;
  field: string;
  answer: string;
}

export interface ConfirmRequirementDraftInput {
  draftId: string;
}

export interface RequirementCategoryFields {
  critical: string[];
  optional: string[];
}

export interface RequirementIntakeListParams {
  state?: RequirementDraftState;
  page?: number;
  limit?: number;
}

export interface PaginatedRequirementDrafts {
  data: RequirementDraft[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}