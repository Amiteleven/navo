import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  companyName: z.string().min(1, 'Company name is required'),
  companySlug: z.string().min(2, 'Company slug must be at least 2 characters').regex(/^[a-z0-9-]+$/, 'Company slug can only contain lowercase letters, numbers, and hyphens'),
});

export const createRequestSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title too long'),
  description: z.string().min(10, 'Description must be at least 10 characters'),
  categoryId: z.string().optional(),
  item: z.string().min(1, 'Item is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  unit: z.string().optional(),
  location: z.string().min(1, 'Location is required'),
  requiredDate: z.string().datetime('Invalid date format'),
  specifications: z.string().optional(),
  estimatedBudget: z.number().positive().optional(),
  priority: z.number().int().min(1).max(5).default(1),
});

export const extractRequirementSchema = z.object({
  naturalLanguage: z.string().min(10, 'Please provide more details about your requirement'),
});

export const createVendorSchema = z.object({
  name: z.string().min(1, 'Vendor name is required'),
  categoryId: z.string().optional(),
  contactPerson: z.string().optional(),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  products: z.string().optional(),
  notes: z.string().optional(),
});

export const createRFQSchema = z.object({
  requestId: z.string().uuid('Invalid request ID'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().min(10, 'Description must be at least 10 characters'),
  quantity: z.number().int().positive('Quantity must be positive'),
  specifications: z.string().optional(),
  deliveryLocation: z.string().min(1, 'Delivery location is required'),
  requiredDeliveryDate: z.string().datetime('Invalid date format'),
  submissionDeadline: z.string().datetime('Invalid date format'),
  vendorIds: z.array(z.string().uuid()).min(1, 'At least one vendor must be selected'),
});

export const submitQuoteSchema = z.object({
  rfqId: z.string().uuid('Invalid RFQ ID'),
  unitPrice: z.number().positive('Unit price must be positive'),
  quantity: z.number().int().positive('Quantity must be positive'),
  taxRate: z.number().min(0).max(100).default(0),
  freightAmount: z.number().min(0).default(0),
  installationAmount: z.number().min(0).default(0),
  warrantyMonths: z.number().int().positive().optional(),
  deliveryTimelineDays: z.number().int().positive().optional(),
  paymentTerms: z.string().optional(),
  validityDays: z.number().int().positive().optional(),
  otherCharges: z.number().min(0).default(0),
  otherChargesDetails: z.string().optional(),
  attachments: z.array(z.string().url()).default([]),
});

export const createApprovalSchema = z.object({
  requestId: z.string().uuid('Invalid request ID'),
  approverId: z.string().uuid('Invalid approver ID'),
});

export const decideApprovalSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  comments: z.string().optional(),
});

export const updateRequestStatusSchema = z.object({
  status: z.enum([
    'DRAFT',
    'SUBMITTED',
    'REQUIREMENT_EXTRACTED',
    'VENDORS_IDENTIFIED',
    'RFQ_CREATED',
    'RFQ_SENT',
    'QUOTES_RECEIVED',
    'COMPARISON_COMPLETED',
    'RECOMMENDATION_READY',
    'APPROVAL_PENDING',
    'APPROVED',
    'REJECTED',
    'CHANGES_REQUESTED',
    'PURCHASE_ORDER_CREATED',
    'COMPLETED',
    'CANCELLED',
  ]),
});

// ── Manager approval & purchase authorization ─────────────────────────────────

/**
 * Amounts arrive from forms as numbers but are stored as Decimal, so they are
 * validated as finite non-negative values and converted server-side. Nothing
 * here carries a default threshold: the amounts that matter are the
 * organization's, and they live in the approval policy.
 */
const amountSchema = z.number().finite().nonnegative();

const approvalLevelSchema = z.object({
  level: z.number().int().positive(),
  // Reusing the shared UserRole enum keeps the level definition inside the set
  // of roles the application's RBAC already understands.
  requiredRole: z.enum([
    'PLATFORM_ADMIN',
    'COMPANY_ADMIN',
    'PROCUREMENT_MANAGER',
    'FINANCE_APPROVER',
    'REQUESTER',
    'VIEWER',
    'VENDOR',
  ]),
  label: z.string().max(120).optional(),
  approverIds: z.array(z.string().min(1)).max(20).optional(),
});

const approvalRuleSchema = z
  .object({
    name: z.string().min(1, 'Rule name is required').max(120),
    priority: z.number().int().min(0).max(10_000).default(100),
    isActive: z.boolean().default(true),
    minAmount: amountSchema.optional(),
    maxAmount: amountSchema.optional(),
    department: z.string().max(120).optional(),
    categoryId: z.string().min(1).optional(),
    costCenter: z.string().max(120).optional(),
    requireApproval: z.boolean().default(true),
    levels: z.array(approvalLevelSchema).min(1, 'At least one approval level is required').max(10),
  })
  .refine((rule) => rule.minAmount === undefined || rule.maxAmount === undefined || rule.minAmount < rule.maxAmount, {
    message: 'minAmount must be lower than maxAmount',
    path: ['minAmount'],
  })
  .refine((rule) => rule.requireApproval === false || rule.levels.length > 0, {
    message: 'A rule that requires approval must define at least one level',
    path: ['levels'],
  });

export const upsertApprovalPolicySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
    /** Uppercase ISO code. Thresholds on this policy are expressed in it. */
    currency: z
      .string()
      .trim()
      .length(3, 'Currency must be a 3-letter code')
      .regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter code')
      .transform((value) => value.toUpperCase())
      .optional(),
    isActive: z.boolean().optional(),
    includeTaxesInThreshold: z.boolean().optional(),
    includeDeliveryChargesInThreshold: z.boolean().optional(),
    autoApproveBelowAmount: amountSchema.nullable().optional(),
    allowSelfApproval: z.boolean().optional(),
    /**
     * Self-approval is a documented exception, never a bare flag: an
     * organization that permits it has to say why, and that reason is copied
     * into the audit trail of every decision taken under the policy.
     */
    selfApprovalJustification: z.string().trim().min(20, 'Record why self-approval is permitted').max(1000).optional(),
    reapprovalRules: z
      .object({
        priceIncrease: z.boolean().optional(),
        priceDecrease: z.boolean().optional(),
        quantityChange: z.boolean().optional(),
        deliveryTermsChange: z.boolean().optional(),
        paymentTermsChange: z.boolean().optional(),
        otherTermsChange: z.boolean().optional(),
      })
      .optional(),
    splitGuardEnabled: z.boolean().optional(),
    splitGuardWindowDays: z.number().int().min(0).max(365).optional(),
    rules: z.array(approvalRuleSchema).max(50).optional(),
  })
  .refine(
    (policy) => !(policy.allowSelfApproval === true && !policy.selfApprovalJustification),
    {
      message: 'Enabling self-approval requires a written justification',
      path: ['selfApprovalJustification'],
    },
  );

export const upsertApprovalRuleSchema = approvalRuleSchema;

export const submitPurchaseApprovalSchema = z.object({
  /** The negotiated offer being authorized. */
  offerId: z.string().min(1, 'An offer must be selected'),
  requesterComment: z.string().trim().max(2000).optional(),
});

export const decidePurchaseApprovalSchema = z
  .object({
    status: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
    comments: z.string().trim().max(2000).optional(),
  })
  .refine(
    // A rejection or a return without a reason is unactionable for the buyer,
    // so the comment is required rather than merely encouraged.
    (decision) =>
      decision.status === 'APPROVED' ||
      (typeof decision.comments === 'string' && decision.comments.length > 0),
    {
      message: 'A comment is required when rejecting or requesting changes',
      path: ['comments'],
    },
  );

export const reassignPurchaseApprovalSchema = z.object({
  approverId: z.string().min(1, 'An approver is required'),
  reason: z.string().trim().min(3, 'Record why this approval is being reassigned').max(500),
});

export const cancelPurchaseApprovalSchema = z.object({
  reason: z.string().trim().min(3, 'Record why this request is being cancelled').max(500),
});

export const confirmPurchaseSchema = z.object({
  /** Confirmed that the order reflects exactly the approved commercial terms. */
  confirmTermsMatch: z.literal(true, {
    errorMap: () => ({ message: 'Confirm that the purchase matches the approved terms' }),
  }),
});

export const listPurchaseApprovalsQuerySchema = z.object({
  /** `assigned` = approvals waiting on me, `requested` = I submitted these. */
  scope: z.enum(['assigned', 'requested', 'all']).default('all'),
  status: z
    .enum(['PENDING_APPROVAL', 'CHANGES_REQUESTED', 'REJECTED', 'APPROVED', 'PURCHASE_CONFIRMED', 'CANCELLED', 'SUPERSEDED'])
    .optional(),
  requesterId: z.string().min(1).optional(),
  vendorId: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  minAmount: z.coerce.number().finite().optional(),
  maxAmount: z.coerce.number().finite().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type UpsertApprovalPolicyInput = z.infer<typeof upsertApprovalPolicySchema>;
export type UpsertApprovalRuleInput = z.infer<typeof upsertApprovalRuleSchema>;
export type SubmitPurchaseApprovalInput = z.infer<typeof submitPurchaseApprovalSchema>;
export type DecidePurchaseApprovalInput = z.infer<typeof decidePurchaseApprovalSchema>;
export type ReassignPurchaseApprovalInput = z.infer<typeof reassignPurchaseApprovalSchema>;
export type CancelPurchaseApprovalInput = z.infer<typeof cancelPurchaseApprovalSchema>;
export type ConfirmPurchaseInput = z.infer<typeof confirmPurchaseSchema>;
export type ListPurchaseApprovalsQuery = z.infer<typeof listPurchaseApprovalsQuerySchema>;
export type ApprovalRuleInput = z.infer<typeof approvalRuleSchema>;

// ── Deal execution ───────────────────────────────────────────────────────────

/**
 * When a buyer has selected the winning submission from the 4-offer commercial
 * engine and is ready to route it through final approval.
 */
export const selectFinalOfferSchema = z.object({
  submissionId: z.string().min(1, 'A submission must be selected'),
  requesterComment: z.string().trim().max(2000).optional(),
});

export type SelectFinalOfferInput = z.infer<typeof selectFinalOfferSchema>;

/**
 * Recording a supplier confirmation or advancing execution to the next status.
 */
export const advanceExecutionSchema = z.object({
  status: z.enum([
    'SUPPLIER_CONFIRMED',
    'IN_PROGRESS',
    'FULFILLED',
    'CLOSED',
    'CANCELLED',
  ]),
  /** Required when cancelling execution. */
  cancellationReason: z.string().trim().max(500).optional(),
});

export type AdvanceExecutionInput = z.infer<typeof advanceExecutionSchema>;

/**
 * Attaching an execution artifact (e.g. delivery receipt reference, milestone proof).
 */
export const recordExecutionEventSchema = z.object({
  type: z.enum([
    'SUPPLIER_CONFIRMED',
    'PURCHASE_ORDER_RAISED',
    'GOODS_RECEIVED',
    'MILESTONE_COMPLETED',
    'DELIVERABLE_ACCEPTED',
    'SUBSCRIPTION_REGISTERED',
    'EXECUTION_STATUS_ADVANCED',
  ]),
  description: z.string().trim().max(1000),
  /** Arbitrary context (e.g. PO number, milestone index, receipt reference). */
  metadata: z.record(z.unknown()).optional(),
});

export type RecordExecutionEventInput = z.infer<typeof recordExecutionEventSchema>;

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type ExtractRequirementInput = z.infer<typeof extractRequirementSchema>;
export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type CreateRFQInput = z.infer<typeof createRFQSchema>;
export type SubmitQuoteInput = z.infer<typeof submitQuoteSchema>;
export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;
export type UpdateRequestStatusInput = z.infer<typeof updateRequestStatusSchema>;