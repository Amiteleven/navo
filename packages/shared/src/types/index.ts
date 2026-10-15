export enum UserRole {
  PLATFORM_ADMIN = 'PLATFORM_ADMIN',
  COMPANY_ADMIN = 'COMPANY_ADMIN',
  PROCUREMENT_MANAGER = 'PROCUREMENT_MANAGER',
  FINANCE_APPROVER = 'FINANCE_APPROVER',
  REQUESTER = 'REQUESTER',
  VIEWER = 'VIEWER',
  VENDOR = 'VENDOR',
}

export enum RequestStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  REQUIREMENT_EXTRACTED = 'REQUIREMENT_EXTRACTED',
  VENDORS_IDENTIFIED = 'VENDORS_IDENTIFIED',
  RFQ_CREATED = 'RFQ_CREATED',
  RFQ_SENT = 'RFQ_SENT',
  QUOTES_RECEIVED = 'QUOTES_RECEIVED',
  COMPARISON_COMPLETED = 'COMPARISON_COMPLETED',
  RECOMMENDATION_READY = 'RECOMMENDATION_READY',
  APPROVAL_PENDING = 'APPROVAL_PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
  PURCHASE_ORDER_CREATED = 'PURCHASE_ORDER_CREATED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  REQUESTED = 'REQUESTED',
  REQUIREMENT_DRAFT = 'REQUIREMENT_DRAFT',
  PENDING_DEPARTMENT_APPROVAL = 'PENDING_DEPARTMENT_APPROVAL',
  APPROVED_FOR_SOURCING = 'APPROVED_FOR_SOURCING',
  REQUIREMENT_COMPLETION = 'REQUIREMENT_COMPLETION',
  VENDOR_MATCHING = 'VENDOR_MATCHING',
  VENDOR_INVITED = 'VENDOR_INVITED',
  OFFERS_RECEIVED = 'OFFERS_RECEIVED',
  COMMERCIAL_EVALUATION = 'COMMERCIAL_EVALUATION',
  NEGOTIATION_RECOMMENDED = 'NEGOTIATION_RECOMMENDED',
  NO_NEGOTIATION = 'NO_NEGOTIATION',
  NEGOTIATION = 'NEGOTIATION',
  FINAL_COMMERCIAL_SELECTION = 'FINAL_COMMERCIAL_SELECTION',
  PENDING_FINAL_APPROVAL = 'PENDING_FINAL_APPROVAL',
  DEAL_CONFIRMED = 'DEAL_CONFIRMED',
  EXECUTION = 'EXECUTION',
  SEND_BACK = 'SEND_BACK',
  EXPIRED = 'EXPIRED',
}

export enum RFQStatus {
  DRAFT = 'DRAFT',
  SENT = 'SENT',
  RESPONSES_RECEIVED = 'RESPONSES_RECEIVED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

export enum QuoteStatus {
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
}

export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
}

/**
 * Lifecycle of one purchase authorization request.
 *
 * Distinct from `ApprovalStatus`, which is a single approver's verdict on a
 * requirement. The separation is deliberate: APPROVED here means "authorized",
 * never "bought". Only PURCHASE_CONFIRMED, together with a raised purchase
 * order, represents a completed purchase.
 */
export enum PurchaseApprovalStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
  REJECTED = 'REJECTED',
  APPROVED = 'APPROVED',
  PURCHASE_CONFIRMED = 'PURCHASE_CONFIRMED',
  CANCELLED = 'CANCELLED',
  SUPERSEDED = 'SUPERSEDED',
}

/** Verdict on one approval level. */
export enum PurchaseApprovalDecisionStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
  SKIPPED = 'SKIPPED',
}

/** Commercial change that can force an already-approved purchase back for approval. */
export enum PurchaseApprovalChangeTrigger {
  PRICE_INCREASE = 'PRICE_INCREASE',
  PRICE_DECREASE = 'PRICE_DECREASE',
  QUANTITY_CHANGE = 'QUANTITY_CHANGE',
  DELIVERY_TERMS_CHANGE = 'DELIVERY_TERMS_CHANGE',
  PAYMENT_TERMS_CHANGE = 'PAYMENT_TERMS_CHANGE',
  OTHER_TERMS_CHANGE = 'OTHER_TERMS_CHANGE',
  POLICY_CHANGE = 'POLICY_CHANGE',
}

/**
 * Which commercial changes force reapproval of an approved purchase.
 *
 * Organizations differ: a price *decrease* is often welcome without a second
 * signature, while a longer delivery schedule is not. Stored on the policy as
 * JSON rather than as an enum-column set so a new trigger can be added without a
 * migration, and so the shape is readable in the policy editor.
 */
export interface ReapprovalRules {
  priceIncrease?: boolean;
  priceDecrease?: boolean;
  quantityChange?: boolean;
  deliveryTermsChange?: boolean;
  paymentTermsChange?: boolean;
  otherTermsChange?: boolean;
}

/** One level of an approval hierarchy, as configured on a rule. */
export interface ApprovalLevelConfig {
  level: number;
  requiredRole: UserRole;
  label?: string;
  /** Specific approvers for this level. Empty means any holder of the role. */
  approverIds?: string[];
}


export enum VendorStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  BLACKLISTED = 'BLACKLISTED',
}

export enum AuditAction {
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  DELETED = 'DELETED',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  STATUS_CHANGED = 'STATUS_CHANGED',
  VENDOR_INVITED = 'VENDOR_INVITED',
  QUOTE_RECEIVED = 'QUOTE_RECEIVED',
  RECOMMENDATION_GENERATED = 'RECOMMENDATION_GENERATED',
  RFQ_CREATED = 'RFQ_CREATED',
  RFQ_SENT = 'RFQ_SENT',
  CONNECTION_CREATED = 'CONNECTION_CREATED',
  CONNECTION_ACCEPTED = 'CONNECTION_ACCEPTED',
  CONNECTION_DECLINED = 'CONNECTION_DECLINED',
   OFFER_SUBMITTED = 'OFFER_SUBMITTED',
   OFFER_ACCEPTED = 'OFFER_ACCEPTED',
   DEAL_CLOSED = 'DEAL_CLOSED',
   DEAL_CREATED = 'DEAL_CREATED',
   QUOTE_ANALYZED = 'QUOTE_ANALYZED',
  NEGOTIATION_STARTED = 'NEGOTIATION_STARTED',
  COUNTEROFFER_SUBMITTED = 'COUNTEROFFER_SUBMITTED',
SAVINGS_RECORDED = 'SAVINGS_RECORDED',
  // Phase 5: purchase execution
  PO_CREATED = 'PO_CREATED',
  PO_SUBMITTED_FOR_APPROVAL = 'PO_SUBMITTED_FOR_APPROVAL',
  PO_APPROVAL_REQUESTED = 'PO_APPROVAL_REQUESTED',
  PO_APPROVED = 'PO_APPROVED',
  PO_ISSUED = 'PO_ISSUED',
  PO_CANCELLED = 'PO_CANCELLED',
  PO_CLOSED = 'PO_CLOSED',
  PO_AMENDED = 'PO_AMENDED',
  ORDER_CONFIRMED_BY_SUPPLIER = 'ORDER_CONFIRMED_BY_SUPPLIER',
  ORDER_REJECTED_BY_SUPPLIER = 'ORDER_REJECTED_BY_SUPPLIER',
  DELIVERY_EVENT_ADDED = 'DELIVERY_EVENT_ADDED',
  DELIVERY_EXCEPTION = 'DELIVERY_EXCEPTION',
  GOODS_RECEIVED = 'GOODS_RECEIVED',
  INVOICE_SUBMITTED = 'INVOICE_SUBMITTED',
  INVOICE_VERIFIED = 'INVOICE_VERIFIED',
  INVOICE_DISCREPANCY_FOUND = 'INVOICE_DISCREPANCY_FOUND',
  DISCREPANCY_RESOLVED = 'DISCREPANCY_RESOLVED',
  PAYMENT_RECORDED = 'PAYMENT_RECORDED',
  PAYMENT_STATUS_UPDATED = 'PAYMENT_STATUS_UPDATED',
  DOCUMENT_UPLOADED = 'DOCUMENT_UPLOADED',
  DOCUMENT_DOWNLOADED = 'DOCUMENT_DOWNLOADED',
  // Phase 6: copilot
  COPILOT_QUERY_ANSWERED = 'COPILOT_QUERY_ANSWERED',
  COPILOT_TOOL_DENIED = 'COPILOT_TOOL_DENIED',
  COPILOT_ACTION_PROPOSED = 'COPILOT_ACTION_PROPOSED',
  COPILOT_ACTION_EXECUTED = 'COPILOT_ACTION_EXECUTED',
  COPILOT_ACTION_FAILED = 'COPILOT_ACTION_FAILED',
  // Marketplace: open-market publication and seller interest
  REQUIREMENT_PUBLISHED = 'REQUIREMENT_PUBLISHED',
  REQUIREMENT_WITHDRAWN = 'REQUIREMENT_WITHDRAWN',
  REQUIREMENT_CLOSED = 'REQUIREMENT_CLOSED',
  MARKETPLACE_INTEREST_EXPRESSED = 'MARKETPLACE_INTEREST_EXPRESSED',
  MARKETPLACE_INTEREST_WITHDRAWN = 'MARKETPLACE_INTEREST_WITHDRAWN',
  QUOTE_SHORTLISTED = 'QUOTE_SHORTLISTED',
  QUOTE_REJECTED_BY_BUYER = 'QUOTE_REJECTED_BY_BUYER',
  // Communication control
  SELLER_MESSAGE_BLOCKED = 'SELLER_MESSAGE_BLOCKED',
  VENDOR_BLOCKED = 'VENDOR_BLOCKED',
  VENDOR_MUTED = 'VENDOR_MUTED',
  VENDOR_UNBLOCKED = 'VENDOR_UNBLOCKED',
  VENDOR_BLACKLISTED = 'VENDOR_BLACKLISTED',
  ABUSE_REPORT_FILED = 'ABUSE_REPORT_FILED',
  ABUSE_REPORT_RESOLVED = 'ABUSE_REPORT_RESOLVED',
  // Negotiation room
  NEGOTIATION_MESSAGE_BLOCKED = 'NEGOTIATION_MESSAGE_BLOCKED',
  MESSAGE_ATTACHMENT_ADDED = 'MESSAGE_ATTACHMENT_ADDED',
  NEGOTIATION_ROOM_CLOSED = 'NEGOTIATION_ROOM_CLOSED',
  EMAIL_DELIVERY_FAILED = 'EMAIL_DELIVERY_FAILED',

  // Manager approval & purchase authorization. Every submission, decision,
  // reassignment, invalidation and purchase confirmation writes one of these.
  APPROVAL_POLICY_UPDATED = 'APPROVAL_POLICY_UPDATED',
  APPROVAL_RULE_UPDATED = 'APPROVAL_RULE_UPDATED',
  PURCHASE_APPROVAL_SUBMITTED = 'PURCHASE_APPROVAL_SUBMITTED',
  PURCHASE_APPROVAL_AUTO_APPROVED = 'PURCHASE_APPROVAL_AUTO_APPROVED',
  PURCHASE_APPROVAL_APPROVED = 'PURCHASE_APPROVAL_APPROVED',
  PURCHASE_APPROVAL_REJECTED = 'PURCHASE_APPROVAL_REJECTED',
  PURCHASE_APPROVAL_CHANGES_REQUESTED = 'PURCHASE_APPROVAL_CHANGES_REQUESTED',
  PURCHASE_APPROVAL_REASSIGNED = 'PURCHASE_APPROVAL_REASSIGNED',
  PURCHASE_APPROVAL_INVALIDATED = 'PURCHASE_APPROVAL_INVALIDATED',
  PURCHASE_APPROVAL_CANCELLED = 'PURCHASE_APPROVAL_CANCELLED',
  PURCHASE_CONFIRMED = 'PURCHASE_CONFIRMED',

  // First approval checkpoint (requirement approval). Invalidations
  // are recorded when an approved requirement is materially changed.
  REQUIREMENT_APPROVAL_INVALIDATED = 'REQUIREMENT_APPROVAL_INVALIDATED',
}

/** Mirror of the Prisma `NotificationType` enum, extended for Phase 7. */
export enum NotificationEventType {
  VENDOR_INVITATION = 'VENDOR_INVITATION',
  INVITATION_ACCEPTED = 'INVITATION_ACCEPTED',
  NEW_OPPORTUNITY = 'NEW_OPPORTUNITY',
  CONNECTION_REQUEST = 'CONNECTION_REQUEST',
  QUOTE_RESPONSE = 'QUOTE_RESPONSE',
  DEAL_STATUS_CHANGE = 'DEAL_STATUS_CHANGE',
  AVAILABILITY_CHANGE = 'AVAILABILITY_CHANGE',
  VENDOR_FEEDBACK = 'VENDOR_FEEDBACK',
  REQUIREMENT_PUBLISHED = 'REQUIREMENT_PUBLISHED',
  MARKETPLACE_INTEREST = 'MARKETPLACE_INTEREST',
  NEGOTIATION_MESSAGE = 'NEGOTIATION_MESSAGE',
  COUNTEROFFER = 'COUNTEROFFER',
  OFFER_ACCEPTED = 'OFFER_ACCEPTED',
  DEAL_CLOSED = 'DEAL_CLOSED',
  DEAL_CREATED = 'DEAL_CREATED',
  APPROVAL_ASSIGNED = 'APPROVAL_ASSIGNED',
  APPROVAL_APPROVED = 'APPROVAL_APPROVED',
  APPROVAL_REJECTED = 'APPROVAL_REJECTED',
  APPROVAL_CHANGES_REQUESTED = 'APPROVAL_CHANGES_REQUESTED',
  PURCHASE_CONFIRMED = 'PURCHASE_CONFIRMED',
}

export enum NotificationFrequency {
  IMMEDIATE = 'IMMEDIATE',
  DIGEST = 'DIGEST',
  OFF = 'OFF',
}

/** Mirror of the Prisma `RequestVisibility` enum. */
export enum RequestVisibility {
  PRIVATE = 'PRIVATE',
  OPEN_MARKET = 'OPEN_MARKET',
}

/** Mirror of the Prisma `InterestStatus` enum. */
export enum InterestStatus {
  EXPRESSED = 'EXPRESSED',
  QUOTED = 'QUOTED',
  SHORTLISTED = 'SHORTLISTED',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
}

/** Mirror of the Prisma `RestrictionKind` enum. */
export enum RestrictionKind {
  BLOCK = 'BLOCK',
  MUTE = 'MUTE',
}

export enum ReportReason {
  UNSOLICITED_CONTACT = 'UNSOLICITED_CONTACT',
  SPAM = 'SPAM',
  OFF_PLATFORM_PAYMENT = 'OFF_PLATFORM_PAYMENT',
  MISREPRESENTED_SUPPLIER = 'MISREPRESENTED_SUPPLIER',
  INAPPROPRIATE_CONTENT = 'INAPPROPRIATE_CONTENT',
  FRAUD = 'FRAUD',
  OTHER = 'OTHER',
}

export enum ReportStatus {
  OPEN = 'OPEN',
  REVIEWING = 'REVIEWING',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
}

/** Mirror of the Prisma `CopilotActionType` enum. */
export enum CopilotActionType {
  CREATE_DRAFT_REQUEST = 'CREATE_DRAFT_REQUEST',
  DRAFT_NEGOTIATION_MESSAGE = 'DRAFT_NEGOTIATION_MESSAGE',
  DRAFT_PURCHASE_ORDER = 'DRAFT_PURCHASE_ORDER',
  REQUEST_QUOTATION = 'REQUEST_QUOTATION',
  ADD_FOLLOW_UP_NOTE = 'ADD_FOLLOW_UP_NOTE',
  OPEN_DEAL_ROOM = 'OPEN_DEAL_ROOM',
}

/** Mirror of the Prisma `CopilotActionStatus` enum. */
export enum CopilotActionStatus {
  PROPOSED = 'PROPOSED',
  CONFIRMED = 'CONFIRMED',
  EXECUTED = 'EXECUTED',
  FAILED = 'FAILED',
  REJECTED_DUPLICATE = 'REJECTED_DUPLICATE',
  EXPIRED = 'EXPIRED',
}

export enum ConnectionStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  EXPIRED = 'EXPIRED',
}

export enum DealRoomStatus {
  ACTIVE = 'ACTIVE',
  NEGOTIATING = 'NEGOTIATING',
  CLOSED = 'CLOSED',
  EXPIRED = 'EXPIRED',
}

export enum DealOfferStatus {
  ACTIVE = 'ACTIVE',
  /**
   * Selected by a buyer and awaiting purchase authorization. Not a commitment:
   * a deal cannot be closed from an offer in this state.
   */
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  SUPERSEDED = 'SUPERSEDED',
  WITHDRAWN = 'WITHDRAWN',
}

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

export enum VerificationStatus {
  UNVERIFIED = 'UNVERIFIED',
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export enum NotificationType {
  VENDOR_INVITATION = 'VENDOR_INVITATION',
  INVITATION_ACCEPTED = 'INVITATION_ACCEPTED',
  NEW_OPPORTUNITY = 'NEW_OPPORTUNITY',
  CONNECTION_REQUEST = 'CONNECTION_REQUEST',
  QUOTE_RESPONSE = 'QUOTE_RESPONSE',
  DEAL_STATUS_CHANGE = 'DEAL_STATUS_CHANGE',
  AVAILABILITY_CHANGE = 'AVAILABILITY_CHANGE',
  VENDOR_FEEDBACK = 'VENDOR_FEEDBACK',
}

export enum NotificationPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum DealStatus {
  ACCEPTED = 'ACCEPTED',
  ORDERED = 'ORDERED',
  DELIVERED = 'DELIVERED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/** Phase of the deal lifecycle after final approval; drives category-specific fulfillment. */
export enum DealExecutionStatus {
  PENDING_EXECUTION = 'PENDING_EXECUTION',
  SUPPLIER_CONFIRMED = 'SUPPLIER_CONFIRMED',
  IN_PROGRESS = 'IN_PROGRESS',
  FULFILLED = 'FULFILLED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

/** How the underlying requirement is fulfilled, derived from the selected offer type. */
export enum DealExecutionType {
  PRODUCTS = 'PRODUCTS',
  SERVICES = 'SERVICES',
  SAAS_SUBSCRIPTION = 'SAAS_SUBSCRIPTION',
  PROJECT = 'PROJECT',
}

/** Event types for the deal execution audit trail. */
export enum DealExecutionEventType {
  DEAL_CREATED = 'DEAL_CREATED',
  SUPPLIER_CONFIRMED = 'SUPPLIER_CONFIRMED',
  PURCHASE_ORDER_RAISED = 'PURCHASE_ORDER_RAISED',
  GOODS_RECEIVED = 'GOODS_RECEIVED',
  MILESTONE_COMPLETED = 'MILESTONE_COMPLETED',
  DELIVERABLE_ACCEPTED = 'DELIVERABLE_ACCEPTED',
  SUBSCRIPTION_REGISTERED = 'SUBSCRIPTION_REGISTERED',
  EXECUTION_STATUS_ADVANCED = 'EXECUTION_STATUS_ADVANCED',
  EXECUTION_CANCELLED = 'EXECUTION_CANCELLED',
}

export enum NegotiationStatus {
  ACTIVE = 'ACTIVE',
  COUNTEROFFER_PENDING = 'COUNTEROFFER_PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  EXPIRED = 'EXPIRED',
  CLOSED = 'CLOSED',
}

export enum SavingsType {
  VERIFIED = 'VERIFIED',
  POTENTIAL = 'POTENTIAL',
  REALIZED = 'REALIZED',
}

export enum QuoteAnalysisType {
  COMMERCIAL_SUMMARY = 'COMMERCIAL_SUMMARY',
  PRICE_BENCHMARK = 'PRICE_BENCHMARK',
  HISTORICAL_COMPARISON = 'HISTORICAL_COMPARISON',
  NEGOTIATION_STRATEGY = 'NEGOTIATION_STRATEGY',
  SAVINGS_ESTIMATION = 'SAVINGS_ESTIMATION',
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  domain?: string;
  logo?: string;
  settings?: Record<string, unknown>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatar?: string;
role: UserRole;
  isActive: boolean;
/** Set only for VENDOR users. Links the login to the Vendor record it may act as. */
  vendorId?: string | null;
  lastLoginAt?: Date;
  /** Organizational attributes an approval rule can scope to. */
  department?: string | null;
  costCenter?: string | null;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Category {
  id: string;
  name: string;
  description?: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Vendor {
  id: string;
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
  status: VendorStatus;
  approvedAt?: Date;
  approvedBy?: string;
  notes?: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
  gstin?: string | null;
  verificationStatus: VerificationStatus;
  verificationNotes?: string | null;
  verifiedAt?: Date | null;
  verifiedBy?: string | null;
  timeZone: string;
  invitedById?: string | null;
  invitedAt?: Date | null;
  invitationToken?: string | null;
  isPublic: boolean;
  vendorType?: VendorType | null;
  onboardingStatus?: VendorOnboardingStatus | null;
}

export interface VendorPerformance {
  id: string;
  vendorId: string;
  totalOrders: number;
  onTimeDelivery: number;
  qualityRating: number;
  responsiveness: number;
  lastOrderDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProcurementRequest {
  id: string;
  title: string;
  description: string;
  categoryId?: string;
  item: string;
  quantity: number;
  unit?: string;
  location: string;
  requiredDate: Date;
  specifications?: string;
  estimatedBudget?: number;
  priority: number;
  status: RequestStatus;
  /** Department the purchase is charged to. Approval rules scope on this. */
  department?: string | null;
  /** Cost centre the purchase is charged to. Approval rules scope on this. */
  costCenter?: string | null;
  /**
   * Marketplace exposure. PRIVATE is the default; OPEN_MARKET makes the
   * requirement discoverable by every approved supplier while budget,
   * description and attachments stay private.
   */
  visibility?: RequestVisibility;
  /** When quotations stop being accepted; only meaningful while published. */
  quotationDeadline?: Date | null;
  publishedAt?: Date | null;
  requesterId: string;
  assigneeId?: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExtractedRequirement {
  id: string;
  requestId: string;
  category?: string;
  item?: string;
  quantity?: number;
  unit?: string;
  location?: string;
  requiredDate?: Date;
  specifications?: string;
  budget?: number;
  missingFields: string[];
  confidence: number;
  rawResponse?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RFQ {
  id: string;
  rfqNumber: string;
  requestId: string;
  title: string;
  description: string;
  quantity: number;
  specifications?: string;
  deliveryLocation: string;
  requiredDeliveryDate: Date;
  submissionDeadline: Date;
  status: RFQStatus;
  createdById: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RFQVendor {
  id: string;
  rfqId: string;
  vendorId: string;
  invitedAt: Date;
  respondedAt?: Date;
  status: string;
}

export interface Quote {
  id: string;
  rfqId: string;
  vendorId: string;
  unitPrice: number;
  quantity: number;
  taxRate: number;
  taxAmount: number;
  freightAmount: number;
  installationAmount: number;
  warrantyMonths?: number;
  deliveryTimelineDays?: number;
  paymentTerms?: string;
  validityDays?: number;
  otherCharges: number;
  otherChargesDetails?: string;
  attachments: string[];
  status: QuoteStatus;
  submittedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuoteComparison {
  id: string;
  quoteId: string;
  basePrice: number;
  taxAmount: number;
  freightAmount: number;
  installationAmount: number;
  otherCharges: number;
  totalLandedCost: number;
  deliveryDays?: number;
  paymentTerms?: string;
  warrantyMonths?: number;
  validityDays?: number;
  score?: number;
  rank?: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Recommendation {
  id: string;
  requestId: string;
  recommendedQuoteId?: string;
  reasoning: string;
  factors: Record<string, unknown>;
  commercialValue: number;
  deliveryScore: number;
  specificationScore: number;
  vendorStatusScore: number;
  historicalScore: number;
  benchmarkScore: number;
  paymentTermsScore: number;
  warrantyScore: number;
  riskScore: number;
  totalScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Approval {
  id: string;
  requestId: string;
  approverId: string;
  status: ApprovalStatus;
  comments?: string;
  decidedAt?: Date;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Policy {
  id: string;
  name: string;
  description?: string;
  rules: Record<string, unknown>;
  tenantId: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One organization's manager-approval configuration.
 *
 * Monetary thresholds live here and only here - never as constants in code - so
 * an organization sets its own numbers and the rule that gated each historical
 * purchase can be replayed from the row.
 */
export interface PurchaseApprovalPolicy {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  currency: string;
  isActive: boolean;
  version: number;
  /** Whether taxes count toward the amount compared against thresholds. */
  includeTaxesInThreshold: boolean;
  /** Whether freight, installation and other charges count toward thresholds. */
  includeDeliveryChargesInThreshold: boolean;
  /** Purchases below this amount need no manager decision. Null = no exemption. */
  autoApproveBelowAmount?: number;
  /** Off by default. Enabling it requires a written justification. */
  allowSelfApproval: boolean;
  selfApprovalJustification?: string;
  reapprovalRules?: ReapprovalRules;
  splitGuardEnabled: boolean;
  splitGuardWindowDays: number;
  rules?: PurchaseApprovalRule[];
  updatedById?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseApprovalRule {
  id: string;
  tenantId: string;
  policyId: string;
  name: string;
  priority: number;
  isActive: boolean;
  minAmount?: number;
  maxAmount?: number;
  department?: string;
  categoryId?: string;
  costCenter?: string;
  requireApproval: boolean;
  levels: ApprovalLevelConfig[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The result of applying an organization's policy to one purchase.
 *
 * Returned before submission as well as stored on the request, so the buyer is
 * told up front why approval is needed and who must give it.
 */
export interface ResolvedApprovalRoute {
  approvalRequired: boolean;
  /** Present when the organization has no active policy. */
  reason: string;
  policyId?: string;
  policyVersion?: number;
  ruleId?: string;
  ruleName?: string;
  /** The figure compared against thresholds, after the policy's inclusion flags. */
  thresholdAmount: number;
  currency: string;
  levels: ResolvedApprovalLevel[];
  /** Set when the amount fell under the configured small-purchase allowance. */
  autoApprovedBelowThreshold?: number;
}

export interface ResolvedApprovalLevel {
  level: number;
  requiredRole: UserRole;
  label?: string;
  /** The specific approver this level routes to, if the rule named one. */
  approverId?: string;
  approverName?: string;
}

/** One approval level of a purchase authorization request. */
export interface PurchaseApprovalDecision {
  id: string;
  tenantId: string;
  purchaseApprovalRequestId: string;
  level: number;
  requiredRole: UserRole;
  label?: string;
  status: PurchaseApprovalDecisionStatus;
  assignedApproverId?: string;
  delegatedFromApproverId?: string;
  delegationReason?: string;
  decidedById?: string;
  comments?: string;
  decidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  assignedApprover?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email' | 'role'>;
  decidedBy?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email' | 'role'>;
}

/** Permanent record of an approval level being reassigned or delegated. */
export interface PurchaseApprovalAssignment {
  id: string;
  decisionId: string;
  fromApproverId?: string;
  toApproverId: string;
  reason: string;
  createdById: string;
  createdAt: Date;
  toApprover?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'>;
  createdBy?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'>;
}

/**
 * One purchase authorization request: a buyer asking a manager to release
 * company funds for a specific negotiated offer.
 *
 * The commercial block is an immutable snapshot of the offer as submitted; a
 * changed offer becomes a new revision rather than an edit.
 */
export interface PurchaseApprovalRequest {
  id: string;
  reference: string;
  tenantId: string;
  requestId: string;
  vendorId: string;
  dealRoomId?: string;
  dealId?: string;
   offerId: string;
   quoteId?: string;
   selectedSubmissionId?: string | null;
   submittedById: string;
  status: PurchaseApprovalStatus;

  currency: string;
  unitPrice: number;
  quantity: number;
  taxRate: number;
  taxAmount: number;
  freightAmount: number;
  installationAmount: number;
  otherCharges: number;
  subtotal: number;
  totalAmount: number;
  /** The figure compared against thresholds, per the policy's inclusion flags. */
  thresholdAmount: number;

  paymentTerms?: string;
  deliveryTimelineDays?: number;
  warrantyMonths?: number;
  deliverySchedule?: string;
  otherChargesDetails?: string;
  documents?: string[];

  policyId?: string;
  policyVersion?: number;
  appliedRuleId?: string;
  requesterComment?: string;

  currentLevel: number;
  revision: number;
  parentRequestId?: string;
  supersededById?: string;
  supersedeReason?: string;

  decidedAt?: Date;
  purchaseConfirmedAt?: Date;
  purchaseConfirmedById?: string;
  purchaseOrderId?: string;
  cancelledAt?: Date;
  cancelReason?: string;
  dueAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A purchase authorization request as the approval inbox and the buyer's
 * approval panel render it: the request plus everything a decision depends on.
 */
export interface PurchaseApprovalRequestDetail extends PurchaseApprovalRequest {
  vendor?: Pick<Vendor, 'id' | 'name' | 'email'>;
  request?: Pick<ProcurementRequest, 'id' | 'title' | 'item' | 'quantity' | 'department' | 'costCenter'>;
  submittedBy?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email' | 'role' | 'department'>;
  decisions: PurchaseApprovalDecision[];
  assignments: PurchaseApprovalAssignment[];
  /** What the organization's policy said at the moment of submission. */
  route?: ResolvedApprovalRoute;
  /** Deal-room history captured at submission, so the approver sees it as it stood. */
  negotiationSnapshot?: NegotiationSnapshot;
  /** Populated only once a purchase order exists. */
  purchaseOrder?: { id: string; poNumber: string; status: string };
  /**
   * True only when the purchase is genuinely complete: confirmed against the
   * approved terms *and* raised as a purchase order. Approval alone is not a
   * completed purchase.
   */
  isPurchaseComplete: boolean;
}

/** Compact negotiation record stored on an approval request. */
export interface NegotiationSnapshot {
  dealRoomId: string;
  vendorName: string;
  messageCount: number;
  offerCount: number;
  offers: Array<{
    id: string;
    unitPrice: number;
    quantity: number;
    totalAmount: number;
    status: string;
    submittedByRole: string;
    createdAt: string;
  }>;
  lastMessageAt?: string;
}


export interface AuditLog {
  id: string;
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  previousStatus?: string;
  newStatus?: string;
  decision?: string;
  aiRecommendation?: string;
  metadata?: Record<string, unknown>;
  tenantId: string;
  createdAt: Date;
}

export interface Connection {
  id: string;
  requestId: string;
  buyerId: string;
  vendorId: string;
  status: ConnectionStatus;
  initiatedAt: Date;
  respondedAt?: Date;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DealRoom {
  id: string;
  connectionId: string;
  requestId: string;
  buyerId: string;
  vendorId: string;
  status: DealRoomStatus;
  closedAt?: Date;
  dealId?: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DealMessage {
  id: string;
  dealRoomId: string;
  senderId: string;
  senderRole: string;
  content: string;
  messageType: string;
  createdAt: Date;
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
  createdAt: Date;
  updatedAt: Date;
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
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
  executionStatus: DealExecutionStatus;
  executionType?: DealExecutionType | null;
  selectedSubmissionId?: string | null;
  commercialSnapshot?: Record<string, unknown> | null;
  supplierConfirmedAt?: Date | null;
  supplierConfirmedById?: string | null;
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
  createdAt: Date;
}

export interface VendorAvailability {
  id: string;
  vendorId: string;
  tenantId: string;
  isOnline: boolean;
  isBusy: boolean;
  lastSeenAt: Date;
  updatedAt: Date;
}

export interface VendorInvitation {
  id: string;
  vendorId?: string;
  invitedById: string;
  email: string;
  token: string;
  status: InvitationStatus;
  role?: string;
  expiresAt: Date;
  acceptedAt?: Date;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VendorWorkingHours {
  id: string;
  vendorId: string;
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
  timeZone: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VendorProfile {
  id: string;
  vendorId: string;
  companyName?: string;
  registrationNo?: string;
  gstin?: string;
  panNumber?: string;
  msmeNumber?: string;
  website?: string;
  description?: string;
  certifications?: string;
  capabilities?: Record<string, unknown>;
  deliveryLocations?: Record<string, unknown>;
  paymentTerms?: string;
  bankDetails?: Record<string, unknown>;
  documents?: Record<string, unknown>;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VendorRating {
  id: string;
  vendorId: string;
  buyerId: string;
  rating: number;
  feedback?: string;
  categories?: Record<string, unknown>;
  isVerified: boolean;
  verifiedAt?: Date;
  verifiedBy?: string;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Vendor Intelligence & Onboarding Engine types ──────────────────────────────

/** Mirror of the Prisma `VendorType` enum. */
export enum VendorType {
  MANUFACTURER = 'MANUFACTURER',
  DISTRIBUTOR = 'DISTRIBUTOR',
  WHOLESALE = 'WHOLESALE',
  RETAILER = 'RETAILER',
  SERVICE_PROVIDER = 'SERVICE_PROVIDER',
  CONSULTING_FIRM = 'CONSULTING_FIRM',
  SYSTEM_INTEGRATOR = 'SYSTEM_INTEGRATOR',
  SAAS_PROVIDER = 'SAAS_PROVIDER',
  LOGISTICS_PROVIDER = 'LOGISTICS_PROVIDER',
  CONTRACT_MANUFACTURER = 'CONTRACT_MANUFACTURER',
  PROFESSIONAL_SERVICES = 'PROFESSIONAL_SERVICES',
  MARKETPLACE_RESELLER = 'MARKETPLACE_RESELLER',
  OTHER = 'OTHER',
}

/** Mirror of the Prisma `VendorOnboardingStatus` enum. */
export enum VendorOnboardingStatus {
  INVITED = 'INVITED',
  APPLICATION_STARTED = 'APPLICATION_STARTED',
  APPLICATION_SUBMITTED = 'APPLICATION_SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  VERIFICATION_REQUIRED = 'VERIFICATION_REQUIRED',
  VERIFIED = 'VERIFIED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
  ARCHIVED = 'ARCHIVED',
}

/** Mirror of the Prisma `VendorCertificationStatus` enum. */
export enum VendorCertificationStatus {
  SELF_DECLARED = 'SELF_DECLARED',
  VERIFIED = 'VERIFIED',
  EXPIRED = 'EXPIRED',
  REJECTED = 'REJECTED',
}

/** Mirror of the Prisma `VendorDocumentType` enum. */
export enum VendorDocumentType {
  COMPANY_REGISTRATION = 'COMPANY_REGISTRATION',
  TAX_DOCUMENT = 'TAX_DOCUMENT',
  CERTIFICATION = 'CERTIFICATION',
  INSURANCE = 'INSURANCE',
  SECURITY_CERTIFICATION = 'SECURITY_CERTIFICATION',
  QUALITY_CERTIFICATE = 'QUALITY_CERTIFICATE',
  BANK_DETAILS = 'BANK_DETAILS',
  CONTRACT = 'CONTRACT',
  OTHER = 'OTHER',
}

/** Mirror of the Prisma `VendorMatchingFactor` enum. */
export enum VendorMatchingFactor {
  CAPABILITY = 'CAPABILITY',
  GEOGRAPHY = 'GEOGRAPHY',
  CERTIFICATION = 'CERTIFICATION',
  INDUSTRY_EXPERIENCE = 'INDUSTRY_EXPERIENCE',
  AVAILABILITY = 'AVAILABILITY',
  CAPACITY = 'CAPACITY',
  HISTORICAL_PERFORMANCE = 'HISTORICAL_PERFORMANCE',
  COMMERCIAL_HISTORY = 'COMMERCIAL_HISTORY',
  VENDOR_STATUS = 'VENDOR_STATUS',
  PRODUCT_SERVICE_FIT = 'PRODUCT_SERVICE_FIT',
}

/** Mirror of the Prisma `VendorDuplicateConfidence` enum. */
export enum VendorDuplicateConfidence {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  EXACT = 'EXACT',
}

/** Structured capability of a vendor — used for matching. */
export interface VendorCapability {
  id: string;
  vendorId: string;
  name?: string;
  description?: string;
  category?: string;
  proficiencyLevel?: string;
  matchingFactors?: string[];
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A certification held by a vendor, with verification status. */
export interface VendorCertification {
  id: string;
  vendorId: string;
  name: string;
  issuingBody?: string;
  issueDate?: Date;
  expiryDate?: Date;
  status: VendorCertificationStatus;
  documentId?: string | null;
  document?: VendorDocument;
  matchingFactors?: string[];
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A document uploaded for or by a vendor. */
export interface VendorDocument {
  id: string;
  vendorId: string;
  documentType: VendorDocumentType;
  fileName: string;
  url?: string;
  mimeType?: string;
  fileSize?: number;
  uploadedById?: string | null;
  uploadedBy?: Pick<User, 'id' | 'firstName' | 'lastName'>;
  isVerified: boolean;
  verifiedById?: string | null;
  verifiedBy?: Pick<User, 'id' | 'firstName' | 'lastName'>;
  verifiedAt?: Date | null;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
  certificationsAsDoc?: VendorCertification[];
}

/** Workflow state for a vendor's onboarding journey. */
export interface VendorOnboarding {
  id: string;
  vendorId: string;
  tenantId: string;
  status: VendorOnboardingStatus;
  progress?: Record<string, unknown>;
  requiredDocs?: Record<string, unknown>;
  missingDocs: string[];
  aiOnboardedData?: Record<string, unknown>;
  startedAt?: Date;
  submittedAt?: Date;
  reviewedAt?: Date;
  verifiedAt?: Date;
  approvedAt?: Date;
  rejectedAt?: Date;
  rejectedReason?: string;
  createdAt: Date;
  updatedAt: Date;
  events?: VendorEvent[];
}

/** A single matching factor score within a VendorMatchingResult. */
export interface VendorFactorScore {
  factor: VendorMatchingFactor;
  score: number;
  weight: number;
  detail?: string;
}

/** Result of matching a vendor against a procurement requirement. */
export interface VendorMatchingResult {
  id: string;
  vendorId: string;
  vendor?: Pick<Vendor, 'id' | 'name' | 'vendorType' | 'verificationStatus'>;
  requestId?: string | null;
  matchScore: number;
  factorScores: VendorFactorScore[];
  matchedAt: Date;
  matchedById?: string | null;
  matchedBy?: Pick<User, 'id' | 'firstName' | 'lastName'>;
  tenantId: string;
}

/** Configurable weights for matching factors, stored on the tenant or policy. */
export interface VendorMatchingWeights {
  capability: number;
  geography: number;
  certification: number;
  industryExperience: number;
  availability: number;
  capacity: number;
  historicalPerformance: number;
  commercialHistory: number;
  vendorStatus: number;
  productServiceFit: number;
}

/** Assignment of a private vendor to a buyer, department, or requirement. */
export interface VendorAssignment {
  id: string;
  vendorId: string;
  requestId: string;
  tenantId: string;
  assignedById?: string | null;
  assignedAt: Date;
  acceptedAt?: Date | null;
  declinedAt?: Date | null;
  declineReason?: string | null;
  hasQuoted: boolean;
  notes?: string;
  offersSubmitted: number;
  finalOfferSubmitted: boolean;
  commercialRound: number;
  deadlineExtendedAt?: Date | null;
  deadlineExtensionReason?: string | null;
  currency?: string | null;
  createdAt: Date;
  updatedAt: Date;
  vendor?: Pick<Vendor, 'id' | 'name'>;
  request?: Pick<ProcurementRequest, 'id' | 'title'>;
  assignedBy?: Pick<User, 'id' | 'firstName' | 'lastName'>;
}

/** Internal commercial transaction history for a vendor. */
export interface VendorCommercialHistory {
  id: string;
  vendorId: string;
  requestId?: string | null;
  poNumber?: string | null;
  amount: {
    raw: string;
    formatted: string;
  };
  currency: string;
  orderDate: Date;
  deliveryDate?: Date | null;
  paymentDate?: Date | null;
  status: string;
  notes?: string;
  tenantId: string;
  createdAt: Date;
}

/** A potential vendor duplicate detected by the deduplication engine. */
export interface VendorDuplicate {
  id: string;
  tenantId: string;
  primaryVendorId: string;
  duplicateVendorId: string;
  confidence: VendorDuplicateConfidence;
  detectionMethod: string;
  fieldsMatched: string[];
  confirmed: boolean;
  confirmedById?: string | null;
  confirmedBy?: Pick<User, 'id' | 'firstName' | 'lastName'>;
  confirmedAt?: Date | null;
  createdAt: Date;
  primaryVendor?: Pick<Vendor, 'id' | 'name'>;
  duplicateVendor?: Pick<Vendor, 'id' | 'name'>;
}

/** An audit event for a vendor (status change, document upload, assignment, etc.). */
export interface VendorEvent {
  id: string;
  vendorId: string;
  eventType: string;
  actorId?: string | null;
  actor?: Pick<User, 'id' | 'firstName' | 'lastName' | 'role'>;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  tenantId: string;
  createdAt: Date;
}

/** A node in the category hierarchy tree. */
export interface CategoryHierarchyNode {
  id: string;
  name: string;
  description?: string;
  parentId?: string | null;
  tenantId: string;
  children?: CategoryHierarchyNode[];
  vendorCount?: number;
}

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  readAt?: Date;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}
// ── Phase 5: Purchase execution ──────────────────────────────────────────────

export enum PurchaseOrderStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ISSUED = 'ISSUED',
  SUPPLIER_CONFIRMED = 'SUPPLIER_CONFIRMED',
  IN_PROGRESS = 'IN_PROGRESS',
  PARTIALLY_DELIVERED = 'PARTIALLY_DELIVERED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  CLOSED = 'CLOSED',
}

export enum DeliveryEventType {
  CONFIRMED = 'CONFIRMED',
  PREPARATION = 'PREPARATION',
  DISPATCH = 'DISPATCH',
  IN_TRANSIT = 'IN_TRANSIT',
  PARTIALLY_DELIVERED = 'PARTIALLY_DELIVERED',
  DELIVERED = 'DELIVERED',
  EXCEPTION = 'EXCEPTION',
}

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  VERIFIED = 'VERIFIED',
  DISCREPANCIES_FOUND = 'DISCREPANCIES_FOUND',
  REJECTED = 'REJECTED',
  DISPUTED = 'DISPUTED',
}

export enum InvoiceMatchStatus {
  NOT_STARTED = 'NOT_STARTED',
  MATCHED = 'MATCHED',
  DISCREPANCIES = 'DISCREPANCIES',
}

export enum DiscrepancyType {
  DUPLICATE_INVOICE = 'DUPLICATE_INVOICE',
  QUANTITY_MISMATCH = 'QUANTITY_MISMATCH',
  UNIT_PRICE_VARIATION = 'UNIT_PRICE_VARIATION',
  TAX_MISMATCH = 'TAX_MISMATCH',
  TOTAL_MISMATCH = 'TOTAL_MISMATCH',
  UNEXPECTED_CHARGE = 'UNEXPECTED_CHARGE',
  MISSING_GOODS_RECEIPT = 'MISSING_GOODS_RECEIPT',
  UNVERIFIED_TAX_DETAILS = 'UNVERIFIED_TAX_DETAILS',
}

export enum DiscrepancySeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

export enum DiscrepancyResolution {
  OPEN = 'OPEN',
  ACCEPTED = 'ACCEPTED',
  WAIVED = 'WAIVED',
  REJECTED = 'REJECTED',
}

export enum PaymentStatus {
  NOT_DUE = 'NOT_DUE',
  DUE = 'DUE',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  ON_HOLD = 'ON_HOLD',
  DISPUTED = 'DISPUTED',
}

export enum DocumentCategory {
  PURCHASE_ORDER = 'PURCHASE_ORDER',
  DELIVERY_NOTE = 'DELIVERY_NOTE',
  PROOF_OF_DELIVERY = 'PROOF_OF_DELIVERY',
  INVOICE = 'INVOICE',
  TAX_INVOICE = 'TAX_INVOICE',
  SUPPORTING = 'SUPPORTING',
  RECEIPT = 'RECEIPT',
}

/** A single flagged mismatch produced by the deterministic three-way match. */
export interface Discrepancy {
  type: DiscrepancyType;
  severity: DiscrepancySeverity;
  field: string;
  message: string;
  expected?: string;
  actual?: string;
  difference?: string;
  resolution: DiscrepancyResolution;
  resolutionNote?: string;
  resolvedById?: string;
  resolvedAt?: string;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  dealId: string;
  requestId: string;
  buyerId: string;
  vendorId: string;
  status: PurchaseOrderStatus;
  currency: string;
  itemName: string;
  description?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  freightAmount: number;
  installationAmount: number;
  otherCharges: number;
  otherChargesDetails?: string;
  subtotal: number;
  totalAmount: number;
  acceptedOfferId: string;
  deliveryAddress?: string;
  expectedDeliveryDate?: string;
  actualDeliveryDate?: string;
  paymentTerms?: string;
  warrantyMonths?: number;
  notes?: string;
  terms?: string;
  issuedAt?: string;
  supplierConfirmedAt?: string;
  supplierConfirmedDeliveryDate?: string;
  closedAt?: string;
  cancelledAt?: string;
  rejectionReason?: string;
  dispatchTrackingRef?: string;
  dispatchNotes?: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderApproval {
  id: string;
  poId: string;
  level: number;
  requiredRole: UserRole;
  approverId?: string;
  status: ApprovalStatus;
  comments?: string;
  decidedAt?: string;
  decidedById?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryEvent {
  id: string;
  poId: string;
  type: DeliveryEventType;
  notes?: string;
  location?: string;
  carrierName?: string;
  trackingRef?: string;
  estimatedDeliveryDate?: string;
  occurredAt: string;
  actorId: string;
  documentIds: string[];
  createdAt: string;
}

export interface GoodsReceipt {
  id: string;
  receiptNumber: string;
  poId: string;
  orderedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  receiptDate: string;
  receivedById: string;
  conditionNotes?: string;
  discrepancies?: Record<string, unknown>[];
  documentIds: string[];
  createdAt: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  poId: string;
  vendorId: string;
  status: InvoiceStatus;
  currency: string;
  invoiceDate: string;
  dueDate?: string;
  subtotal: number;
  taxRate?: number;
  taxAmount: number;
  freightAmount: number;
  otherCharges: number;
  otherChargesDetails?: string;
  totalAmount: number;
  description?: string;
  /** Machine-extracted values. Not verified - shown separately in the UI. */
  extractedData?: Record<string, unknown>;
  extractionMethod?: string;
  extractedAt?: string;
  documentIds: string[];
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceVerification {
  id: string;
  invoiceId: string;
  poId: string;
  status: InvoiceMatchStatus;
  matched: boolean;
  discrepancies?: Discrepancy[];
  checkedFields?: Record<string, unknown>;
  toleranceAmount: number;
  verifiedById?: string;
  verifiedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  poId: string;
  invoiceId?: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  paidAmount: number;
  reference?: string;
  paymentMethod?: string;
  paidAt?: string;
  dueDate?: string;
  notes?: string;
  recordedById: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentMeta {
  id: string;
  poId?: string;
  invoiceId?: string;
  category: DocumentCategory;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedById: string;
  createdAt: string;
}

/** A chronological entry in the purchase transaction history. */
export interface TransactionTimelineEntry {
  at: string;
  stage: 'DEAL' | 'PO' | 'APPROVAL' | 'SUPPLIER' | 'DELIVERY' | 'RECEIPT' | 'INVOICE' | 'VERIFICATION' | 'PAYMENT' | 'CLOSURE';
  title: string;
  detail?: string;
  actorId?: string;
  actorName?: string;
  status?: string;
  source: 'application_data' | 'audit_log';
}

export interface PurchaseOrderSummary {
  poNumber: string;
  status: PurchaseOrderStatus;
  supplierName: string;
  totalAmount: number;
  currency: string;
  expectedDeliveryDate?: string;
  /** Days past the expected delivery date, when overdue. */
  daysDelayed?: number;
  orderedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
invoicedAmount: number;
  verifiedAmount: number;
  paidAmount: number;
  /** Order total minus everything paid so far. */
  outstandingAmount: number;
  rejectedQuantity: number;
  openDiscrepancies: number;
  missingDocuments: string[];
narrative: string;
  /** True when the summary could not be fully derived from stored data. */
  incomplete: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Phase 6: copilot
 * Mirrors the HTTP surface of `packages/backend/src/modules/copilot`. The
 * backend is the authority on all of these; the frontend renders them and never
 * derives an answer or a permitted action locally.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Mirror of the Prisma `CopilotContextType` enum. */
export type CopilotContextType =
  | 'REQUEST'
  | 'VENDOR'
  | 'RFQ'
  | 'QUOTE'
  | 'DEAL'
  | 'DEAL_ROOM'
  | 'PURCHASE_ORDER'
  | 'INVOICE';

/** A stored record the answer refers to, rendered as a NAVO link. */
export interface CopilotCitation {
  entityType: string;
  entityId: string;
  label: string;
  /** Route within the SPA. */
  href: string;
  status?: string;
  date?: string;
}

/** An action prepared for the user to confirm. Nothing has been written yet. */
export interface CopilotProposedAction {
  actionId: string;
  summary: string;
  details: Array<{ field: string; value: string }>;
  warnings: string[];
}

/** The assistant's answer to one question. */
export interface CopilotAnswer {
  content: string;
  citations: CopilotCitation[];
  suggestedQuestions: string[];
  /** True when no stored data could answer the question. */
  notAnswerable: boolean;
  /** Which read tools ran, for the "answered from" disclosure. */
  toolsUsed: string[];
  proposedAction?: CopilotProposedAction;
}

export interface CopilotAskResult extends CopilotAnswer {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface CopilotToolCallRecord {
  tool: string;
  args?: Record<string, unknown>;
  kind?: string;
  recordCount?: number;
}

export interface CopilotMessage {
  id: string;
  conversationId: string;
  role: 'USER' | 'ASSISTANT' | string;
  content: string;
  toolCalls?: CopilotToolCallRecord[] | null;
  citations?: CopilotCitation[] | null;
  requiresConfirmation?: boolean;
  createdAt: string;
}

export interface CopilotAction {
  id: string;
  conversationId: string;
  type: CopilotActionType;
  status: CopilotActionStatus;
  summary: string;
  resultEntityType?: string | null;
  resultEntityId?: string | null;
  resultSummary?: string | null;
  error?: string | null;
  createdAt: string;
  confirmedAt?: string | null;
  executedAt?: string | null;
}

/** An executed action, with the route back into NAVO for whatever it created. */
export interface CopilotExecutedAction {
  actionId: string;
  type: CopilotActionType;
  status: CopilotActionStatus;
  summary: string;
  entityType?: string;
  entityId?: string;
  href?: string;
}

/** A conversation as listed in the sidebar of the copilot page. */
export interface CopilotConversationSummary {
  id: string;
  title?: string | null;
  contextType?: CopilotContextType | null;
  contextId?: string | null;
  contextLabel?: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { messages: number };
}

export interface CopilotConversation extends CopilotConversationSummary {
  messages: CopilotMessage[];
  actions: CopilotAction[];
}

/** Capabilities and starter prompts for the current caller. */
export interface CopilotDescribe {
  role: UserRole;
  isSeller: boolean;
  tools: Array<{ name: string; description: string; argumentHint: string }>;
  suggestedQuestions: string[];
}

export interface CopilotContext {
  entityType?: CopilotContextType;
  entityId?: string;
  entityLabel?: string;
}

/**
 * State of a requirement draft in the universal AI intake flow.
 *
 * NEW → UNDERSTANDING → CLARIFICATION → DRAFT → CONFIRMED → SOURCING → TRANSITIONED
 *                                                    → ABANDONED (at any point)
 */
export enum RequirementDraftState {
  NEW = 'NEW',
  UNDERSTANDING = 'UNDERSTANDING',
  CLARIFICATION = 'CLARIFICATION',
  DRAFT = 'DRAFT',
  CONFIRMED = 'CONFIRMED',
  SOURCING = 'SOURCING',
  TRANSITIONED = 'TRANSITIONED',
  ABANDONED = 'ABANDONED',
}

/**
 * Procurement categories that the intake flow recognizes.
 *
 * These map 1:1 to the category field map in `requirement-intake.service.ts`.
 * Adding a new category requires updating both the enum and the service map.
 */
export enum RequirementCategory {
  PRODUCT = 'Product',
  SERVICE = 'Service',
  SOFTWARE = 'Software',
  PROFESSIONAL_SERVICE = 'Professional Service',
  MANUFACTURING = 'Manufacturing',
  RAW_MATERIAL = 'Raw Material',
  LOGISTICS = 'Logistics',
  MAINTENANCE = 'Maintenance',
  FACILITY_MANAGEMENT = 'Facility Management',
  MARKETING = 'Marketing',
  IT = 'IT',
  CONSULTING = 'Consulting',
  TRAVEL = 'Travel',
  EVENT = 'Event',
  CONSTRUCTION = 'Construction',
  CONTRACTED_SERVICE = 'Contracted Service',
  OTHER = 'Other',
}

/**
 * Department-approval lifecycle for a procurement requirement.
 *
 * This is the FIRST approval checkpoint - before vendor sourcing begins.
 * Distinct from PurchaseApprovalStatus which is the SECOND checkpoint after negotiation.
 */
export enum RequirementApprovalStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
  SEND_BACK = 'SEND_BACK',
  CANCELLED = 'CANCELLED',
  SUPERSEDED = 'SUPERSEDED',
}

/** Verdict on one department approval level. */
export enum RequirementApprovalDecisionStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CHANGES_REQUESTED = 'CHANGES_REQUESTED',
  SKIPPED = 'SKIPPED',
}

/** One level of a requirement approval hierarchy, as configured on a rule. */
export interface RequirementApprovalLevelConfig {
  level: number;
  requiredRole: UserRole;
  label?: string;
  approverIds?: string[];
}

/** One organization's department-approval configuration for requirements. */
export interface RequirementApprovalPolicy {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  currency: string;
  isActive: boolean;
  version: number;
  autoApproveBelowAmount?: number;
  allowSelfApproval: boolean;
  selfApprovalJustification?: string;
  reapprovalRules?: {
    priceIncrease?: boolean;
    priceDecrease?: boolean;
    quantityChange?: boolean;
    deliveryTermsChange?: boolean;
    paymentTermsChange?: boolean;
    otherTermsChange?: boolean;
  };
  updatedById?: string;
  createdAt: Date;
  updatedAt: Date;
  rules?: RequirementApprovalRule[];
}

/** A scoped condition plus the approval hierarchy it requires for requirements. */
export interface RequirementApprovalRule {
  id: string;
  tenantId: string;
  policyId: string;
  name: string;
  priority: number;
  isActive: boolean;
  minAmount?: number;
  maxAmount?: number;
  department?: string;
  categoryId?: string;
  costCenter?: string;
  requireApproval: boolean;
  levels: RequirementApprovalLevelConfig[];
  createdAt: Date;
  updatedAt: Date;
}

/** The result of applying an organization's department-approval policy to one requirement. */
export interface ResolvedRequirementRoute {
  rule: RequirementApprovalRule | null;
  levels: Array<{
    level: number;
    requiredRole: UserRole;
    label: string;
    approverIds: string[];
  }>;
  thresholdAmount: number;
  autoApproved: boolean;
  policyVersion: number;
  appliedRuleId: string | null;
  policySnapshot: Record<string, unknown>;
  ruleSnapshot: Record<string, unknown> | null;
}

/** One approval level of a requirement approval request. */
export interface RequirementApprovalDecision {
  id: string;
  tenantId: string;
  requirementApprovalRequestId: string;
  level: number;
  requiredRole: UserRole;
  label?: string;
  status: RequirementApprovalDecisionStatus;
  assignedApproverId?: string;
  delegatedFromApproverId?: string;
  delegationReason?: string;
  decidedById?: string;
  comments?: string;
  decidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  assignedApprover?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email' | 'role'>;
  decidedBy?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email' | 'role'>;
}

/** Permanent record of a requirement approval level being reassigned or delegated. */
export interface RequirementApprovalAssignment {
  id: string;
  decisionId: string;
  fromApproverId?: string;
  toApproverId: string;
  reason: string;
  createdById: string;
  createdAt: Date;
  toApprover?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'>;
  createdBy?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'>;
}

/**
 * One department approval request: a buyer asking their Department Head to
 * approve the business need before vendor sourcing begins.
 */
export interface RequirementApprovalRequest {
  id: string;
  reference: string;
  tenantId: string;
  requestId: string;
  submittedById: string;
  status: RequirementApprovalStatus;
  currency: string;
  estimatedAmount: number;
  thresholdAmount: number;
  policyId?: string;
  policyVersion?: number;
  appliedRuleId?: string;
  policySnapshot?: Record<string, unknown>;
  ruleSnapshot?: Record<string, unknown>;
  requesterComment?: string;
  requirementSnapshot?: Record<string, unknown>;
  currentLevel: number;
  revision: number;
  parentRequestId?: string;
  supersededById?: string;
  supersedeReason?: string;
  supersededAt?: Date;
  decidedAt?: Date;
  approvedAt?: Date;
  approvedById?: string;
  cancelledAt?: Date;
  cancelReason?: string;
  dueAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** A requirement approval request as the approval inbox and the buyer's approval panel render it. */
export interface RequirementApprovalRequestDetail extends RequirementApprovalRequest {
  request?: Pick<ProcurementRequest, 'id' | 'title' | 'item' | 'quantity' | 'unit' | 'estimatedBudget' | 'department' | 'costCenter' | 'location' | 'requiredDate' | 'description' | 'specifications' | 'requesterId'>;
  submittedBy?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email' | 'role' | 'department'>;
  decisions: RequirementApprovalDecision[];
  assignments: RequirementApprovalAssignment[];
  route?: ResolvedRequirementRoute;
}

/// ─────────────────────────────────────────────────────────────────────────────
/// Quotation & Four-Offer Commercial Engine types
/// ────────────────────────────────────────────────────────────────────────────

/** Mirror of the Prisma `OfferType` enum. */
export enum OfferType {
  PRODUCT = 'PRODUCT',
  SERVICE = 'SERVICE',
  SOFTWARE_SUBSCRIPTION = 'SOFTWARE_SUBSCRIPTION',
}

/** Mirror of the Prisma `OfferStatus` enum. */
export enum OfferStatus {
  VENDOR_INVITED = 'VENDOR_INVITED',
  VENDOR_ACCEPTED = 'VENDOR_ACCEPTED',
  OFFER_DRAFT = 'OFFER_DRAFT',
  OFFER_SUBMITTED = 'OFFER_SUBMITTED',
  OFFER_UNDER_REVIEW = 'OFFER_UNDER_REVIEW',
  OFFER_REVISED = 'OFFER_REVISED',
  FINAL_OFFER_SUBMITTED = 'FINAL_OFFER_SUBMITTED',
  DECLINED = 'DECLINED',
  WITHDRAWN = 'WITHDRAWN',
  EXPIRED = 'EXPIRED',
  REJECTED_AS_NONCOMPLIANT = 'REJECTED_AS_NONCOMPLIANT',
  COMMERCIAL_PROCESS_REOPENED = 'COMMERCIAL_PROCESS_REOPENED',
}

/** Mirror of the Prisma `OfferComplianceStatus` enum. */
export enum OfferComplianceStatus {
  COMPLIANT = 'COMPLIANT',
  PARTIALLY_COMPLIANT = 'PARTIALLY_COMPLIANT',
  NON_COMPLIANT = 'NON_COMPLIANT',
  REQUIRES_REVIEW = 'REQUIRES_REVIEW',
}

/** Mirror of the Prisma `OfferEventType` enum. */
export enum OfferEventType {
  OFFER_DRAFT_CREATED = 'OFFER_DRAFT_CREATED',
  OFFER_DRAFT_UPDATED = 'OFFER_DRAFT_UPDATED',
  OFFER_SUBMITTED = 'OFFER_SUBMITTED',
  OFFER_REVISED = 'OFFER_REVISED',
  OFFER_REVIEWED = 'OFFER_REVIEWED',
  OFFER_WITHDRAWN = 'OFFER_WITHDRAWN',
  OFFER_DECLINED = 'OFFER_DECLINED',
  OFFER_EXPIRED = 'OFFER_EXPIRED',
  REJECTED_AS_NONCOMPLIANT = 'REJECTED_AS_NONCOMPLIANT',
  COMPLIANCE_EVALUATED = 'COMPLIANCE_EVALUATED',
  COMMERCIAL_PROCESS_REOPENED = 'COMMERCIAL_PROCESS_REOPENED',
  CLARIFICATION_REQUESTED = 'CLARIFICATION_REQUESTED',
  CLARIFICATION_ANSWERED = 'CLARIFICATION_ANSWERED',
  DEADLINE_EXTENDED = 'DEADLINE_EXTENDED',
}

/** An immutable snapshot of one commercial submission (each of the 4 offers). */
export interface CommercialOfferSubmission {
  id: string;
  commercialOfferId: string;
  tenantId: string;
  submissionNumber: number;
  previousSubmissionId?: string | null;
  offerType: OfferType;
  currency: string;
  subTotal: string;
  taxAmount: string;
  totalAmount: string;
  discountAmount?: string | null;
  discountPercentage?: number | null;
  unitPrice?: string | null;
  quantity?: number | null;
  contractDuration?: string | null;
  milestones?: Record<string, unknown> | null;
  deliverables?: Record<string, unknown> | null;
  serviceLevels?: Record<string, unknown> | null;
  staffingAssumptions?: string | null;
  numberOfLicenses?: number | null;
  billingFrequency?: string | null;
  subscriptionTerm?: string | null;
  renewalTerms?: string | null;
  implementationFees?: string | null;
  recurringFees?: string | null;
  oneTimeFees?: string | null;
  deliveryDate?: Date | null;
  paymentTerms?: string | null;
  offerValidityDays?: number | null;
  offerValidityDate?: Date | null;
  commercialConditions?: string | null;
  scope?: string | null;
  exclusions?: string | null;
  supportingDocuments: string[];
  complianceStatus: OfferComplianceStatus;
  complianceDetails?: Record<string, unknown> | null;
  submittedAt?: Date | null;
  submittedById?: string | null;
  isFinal: boolean;
  idempotencyKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The parent lifecycle entity for a vendor's commercial response. */
export interface CommercialOffer {
  id: string;
  tenantId: string;
  requestId: string;
  vendorAssignmentId: string;
  vendorId: string;
  currentSubmissionNumber: number;
  status: OfferStatus;
  offerType: OfferType;
  submissionsInRound: number;
  finalOfferSubmitted: boolean;
  commercialRound: number;
  currency: string;
  deadline?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  submissions?: CommercialOfferSubmission[];
  latestSubmission?: CommercialOfferSubmission | null;
  events?: OfferEvent[];
}

/** A full commercial offer view with requirement and vendor context. */
export interface CommercialOfferDetail extends CommercialOffer {
  request?: Pick<ProcurementRequest, 'id' | 'title' | 'item' | 'quantity' | 'unit' | 'specifications' | 'location' | 'requiredDate'>;
  vendor?: Pick<Vendor, 'id' | 'name' | 'email' | 'vendorType' | 'verificationStatus'>;
  submissions: CommercialOfferSubmission[];
  latestSubmission: CommercialOfferSubmission | null;
  events: OfferEvent[];
  assignment?: Pick<VendorAssignment, 'id' | 'offersSubmitted' | 'finalOfferSubmitted'>;
}

/** Audit event for a commercial offer action. */
export interface OfferEvent {
  id: string;
  tenantId: string;
  commercialOfferId: string;
  submissionId?: string | null;
  eventType: OfferEventType;
  description: string;
  actorId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

/** Input for creating or updating an offer draft. */
export interface UpsertOfferDraftInput {
  requestId: string;
  vendorAssignmentId: string;
  offerType: OfferType;
  currency: string;
  subTotal: number;
  taxAmount?: number;
  totalAmount: number;
  discountAmount?: number;
  discountPercentage?: number;
  unitPrice?: number;
  quantity?: number;
  contractDuration?: string;
  milestones?: Record<string, unknown>[];
  deliverables?: Record<string, unknown>[];
  serviceLevels?: Record<string, unknown>[];
  staffingAssumptions?: string;
  numberOfLicenses?: number;
  billingFrequency?: string;
  subscriptionTerm?: string;
  renewalTerms?: string;
  implementationFees?: number;
  recurringFees?: number;
  oneTimeFees?: number;
  deliveryDate?: string;
  paymentTerms?: string;
  offerValidityDays?: number;
  offerValidityDate?: string;
  commercialConditions?: string;
  scope?: string;
  exclusions?: string;
  supportingDocuments?: string[];
  idempotencyKey?: string;
}

/** Input for submitting a new commercial submission (revision). */
export interface SubmitOfferInput {
  vendorAssignmentId: string;
  requestId: string;
  offerType: OfferType;
  currency: string;
  subTotal: number;
  taxAmount?: number;
  totalAmount: number;
  discountAmount?: number;
  discountPercentage?: number;
  unitPrice?: number;
  quantity?: number;
  contractDuration?: string;
  milestones?: Record<string, unknown>[];
  deliverables?: Record<string, unknown>[];
  serviceLevels?: Record<string, unknown>[];
  staffingAssumptions?: string;
  numberOfLicenses?: number;
  billingFrequency?: string;
  subscriptionTerm?: string;
  renewalTerms?: string;
  implementationFees?: number;
  recurringFees?: number;
  oneTimeFees?: number;
  deliveryDate?: string;
  paymentTerms?: string;
  offerValidityDays?: number;
  offerValidityDate?: string;
  commercialConditions?: string;
  scope?: string;
  exclusions?: string;
  supportingDocuments?: string[];
  idempotencyKey: string;
}

/** Input for a clarification message (does not consume an offer slot). */
export interface OfferClarificationInput {
  vendorAssignmentId: string;
  content: string;
}

/** Input for reopening the commercial process. */
export interface ReopenCommercialInput {
  vendorAssignmentId: string;
  reason: string;
}
