import { Prisma } from '@prisma/client';
import {
  ApprovalLevelConfig,
  AuditAction,
  PurchaseApprovalChangeTrigger,
  ReapprovalRules,
  ResolvedApprovalLevel,
  ResolvedApprovalRoute,
  UserRole,
} from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { computeTotals, decimalToNumber, roundMoney, toDecimal } from '../../utils/money.js';
import { createAuditLog } from '../audit/audit.service.js';
import {
  APPROVAL_ADMIN_ROLES,
  APPROVAL_BUYER_ROLES,
  APPROVER_ROLES,
  isApprovalAdmin,
} from './approval-roles.js';

/**
 * Organization-level approval configuration and the rule engine that turns it
 * into one approval route per purchase.
 *
 * Two properties matter more than anything else here.
 *
 * **Thresholds belong to the organization, not to this file.** There are no
 * illustrative amounts anywhere in NAVO's approval path. An organization that
 * wants single-level sign-off under a million and two levels above it configures
 * exactly that, in its own currency, and the numbers live in the database.
 *
 * **The applied rule is retained, not recomputed.** Every submitted request
 * stores the policy version, the resolved rule and the hierarchy that was
 * derived from them. Editing the policy afterwards changes what *future*
 * submissions do and cannot retroactively rewrite what an approval in 2026
 * meant.
 */

/** Roles that may be named as the approver of an approval level. */
const ASSIGNABLE_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
];

export interface PolicyActor {
  userId: string;
  tenantId: string;
  role: UserRole;
}

/** The commercial facts a rule is evaluated against. */
export interface ApprovalSubject {
  currency: string;
  unitPrice: Prisma.Decimal;
  quantity: number;
  taxRate: Prisma.Decimal;
  freightAmount: Prisma.Decimal;
  installationAmount: Prisma.Decimal;
  otherCharges: Prisma.Decimal;
  /** Department the purchase is charged to, from the requirement. */
  department?: string | null;
  categoryId?: string | null;
  costCenter?: string | null;
}

// ── Threshold arithmetic ─────────────────────────────────────────────────────

/**
 * How a policy's inclusion flags combine into the single figure compared
 * against thresholds. Stated once here so the number an approver sees, the
 * number a rule is evaluated against, and the number stored on the request can
 * never disagree.
 *
 *  threshold amount = subtotal
 *                    + taxAmount                (if includeTaxesInThreshold)
 *                    + freight                  (if includeDeliveryChargesInThreshold)
 *                    + installation             (if includeDeliveryChargesInThreshold)
 *                    + otherCharges             (if includeDeliveryChargesInThreshold)
 *
 * It is deliberately not the total. `totalAmount` is what the buyer pays and
 * stays on the request for the record; the threshold amount is the policy's
 * chosen basis for authorization, which an organization may legitimately want
 * to base on net spend rather than cash out of the door.
 */
export function computeThresholdAmount(
  totals: {
    subtotal: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    freight: Prisma.Decimal;
    installation: Prisma.Decimal;
    other: Prisma.Decimal;
  },
  policy: { includeTaxesInThreshold: boolean; includeDeliveryChargesInThreshold: boolean },
): Prisma.Decimal {
  let amount = totals.subtotal;
  if (policy.includeTaxesInThreshold) amount = amount.plus(totals.taxAmount);
  if (policy.includeDeliveryChargesInThreshold) {
    amount = amount.plus(totals.freight).plus(totals.installation).plus(totals.other);
  }
  return roundMoney(amount);
}

/** Convenience: totals for an offer, then the threshold figure for a policy. */
export function priceForPolicy(
  subject: Omit<ApprovalSubject, 'department' | 'categoryId' | 'costCenter'>,
  policy: { includeTaxesInThreshold: boolean; includeDeliveryChargesInThreshold: boolean },
) {
  const totals = computeTotals({
    quantity: subject.quantity,
    unitPrice: subject.unitPrice,
    taxRate: subject.taxRate,
    freightAmount: subject.freightAmount,
    installationAmount: subject.installationAmount,
    otherCharges: subject.otherCharges,
  });

  return {
    ...totals,
    thresholdAmount: computeThresholdAmount(totals, policy),
  };
}

// ── Rule matching ─────────────────────────────────────────────────────────────

/**
 * How specific a rule is. Higher wins.
 *
 * Specificity is the count of scope attributes the rule actually names, so a
 * rule for "Engineering spend over X" beats a rule for "spend over X" and both
 * beat the organization-wide fallback. Amount bounds are counted because a
 * bounded rule is deliberately narrower than an unbounded one.
 */
function specificity(rule: RuleScope): number {
  let score = 0;
  if (rule.minAmount !== null) score += 1;
  if (rule.maxAmount !== null) score += 1;
  if (rule.department !== null) score += 1;
  if (rule.categoryId !== null) score += 1;
  if (rule.costCenter !== null) score += 1;
  return score;
}

/**
 * Does a rule apply to this purchase?
 *
 * A null attribute on the rule matches anything; a non-null attribute must equal
 * the purchase's value. Amount bounds are inclusive at the bottom and exclusive
 * at the top, so consecutive bands tile without overlapping.
 */
export function ruleMatches(rule: RuleScope, subject: ApprovalSubject, amount: Prisma.Decimal): boolean {
  if (rule.minAmount !== null && amount.lt(rule.minAmount)) return false;
  if (rule.maxAmount !== null && amount.gte(rule.maxAmount)) return false;
  if (rule.department !== null && normalizeScope(rule.department) !== normalizeScope(subject.department)) {
    return false;
  }
  if (rule.costCenter !== null && normalizeScope(rule.costCenter) !== normalizeScope(subject.costCenter)) {
    return false;
  }
  if (rule.categoryId !== null && rule.categoryId !== (subject.categoryId ?? null)) return false;
  return true;
}

/** Scope attributes are free text, so comparison ignores case and surrounding space. */
function normalizeScope(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/** The shape a rule must have to be matched against a purchase. */
interface RuleScope {
  minAmount: Prisma.Decimal | null;
  maxAmount: Prisma.Decimal | null;
  department: string | null;
  categoryId: string | null;
  costCenter: string | null;
}

/** Order candidate rules: most specific first, then explicit priority, then name. */
function orderRules<T extends RuleScope & { priority: number; name: string }>(
  rules: T[],
  subject: ApprovalSubject,
  amount: Prisma.Decimal,
): T[] {
  return rules
    .filter((rule) => ruleMatches(rule, subject, amount))
    .sort((a, b) => {
      const diff = specificity(b) - specificity(a);
      if (diff !== 0) return diff;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.name.localeCompare(b.name);
    });
}

// ── Policy loading ────────────────────────────────────────────────────────────

const POLICY_INCLUDE = { rules: { orderBy: { priority: 'asc' as const } } };

/**
 * The organization's active policy, or null when none is configured.
 *
 * A null policy is a real, supported state: the organization has not turned on
 * manager approval, so purchases are not routed for authorization. Callers must
 * handle it explicitly rather than defaulting to some implicit hierarchy.
 */
export async function loadActivePolicy(tenantId: string) {
  return prisma.purchaseApprovalPolicy.findFirst({
    where: { tenantId, isActive: true },
    include: POLICY_INCLUDE,
  });
}

export async function getPolicy(tenantId: string) {
  return prisma.purchaseApprovalPolicy.findFirst({
    where: { tenantId },
    include: POLICY_INCLUDE,
  });
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve the approval route for one purchase.
 *
 * Pure with respect to configuration: it reads the policy and its rules and
 * returns what must happen. Callers that want to tell the buyer *before* they
 * submit use it directly; submission uses it to build the decision rows and
 * stores the result for audit.
 */
export async function resolveApprovalRoute(
  tenantId: string,
  subject: ApprovalSubject,
): Promise<ResolvedApprovalRoute> {
  const policy = await loadActivePolicy(tenantId);

  if (!policy) {
    const priced = priceForPolicy(subject, {
      includeTaxesInThreshold: true,
      includeDeliveryChargesInThreshold: true,
    });
    return {
      approvalRequired: false,
      reason: 'Your organization has not enabled manager approval for purchases.',
      thresholdAmount: decimalToNumber(priced.thresholdAmount),
      currency: subject.currency,
      levels: [],
    };
  }

  const priced = priceForPolicy(subject, policy);

  // Currency-aware: thresholds are only meaningful in the policy's currency and
  // NAVO performs no implicit FX conversion, so a mismatch is refused rather
  // than compared as if the numbers were equivalent.
  if (policy.currency !== subject.currency) {
    throw new ValidationError(
      `Purchase is in ${subject.currency} but your approval policy thresholds are in ${policy.currency}. ` +
        'Convert the purchase or change the policy currency before submitting.',
    );
  }

  // Small-purchase allowance, checked before any rule: a rule cannot opt a
  // purchase back into approval that the organization already exempted.
  if (
    policy.autoApproveBelowAmount !== null &&
    priced.thresholdAmount.lt(policy.autoApproveBelowAmount)
  ) {
    return {
      approvalRequired: false,
      reason:
        'Purchases below your organization\'s approval threshold need no manager sign-off.',
      policyId: policy.id,
      policyVersion: policy.version,
      thresholdAmount: decimalToNumber(priced.thresholdAmount),
      currency: policy.currency,
      autoApprovedBelowThreshold: decimalToNumber(policy.autoApproveBelowAmount),
      levels: [],
    };
  }

  const rules = orderRules(policy.rules.filter((rule) => rule.isActive), subject, priced.thresholdAmount);
  const rule = rules[0];

  if (!rule) {
    // No rule covers this purchase. Failing closed is the only safe reading:
    // a gap in configuration must not become a free pass for company funds.
    throw new ValidationError(
      'No approval rule in your organization\'s policy covers this purchase. ' +
        'Ask an administrator to configure a rule for it.',
    );
  }

  if (!rule.requireApproval) {
    return {
      approvalRequired: false,
      reason: `Rule "${rule.name}" does not require manager approval for this purchase.`,
      policyId: policy.id,
      policyVersion: policy.version,
      ruleId: rule.id,
      ruleName: rule.name,
      thresholdAmount: decimalToNumber(priced.thresholdAmount),
      currency: policy.currency,
      levels: [],
    };
  }

  const levels = normalizeLevels(rule.levels);
  if (levels.length === 0) {
    throw new ValidationError(`Approval rule "${rule.name}" defines no approval levels.`);
  }

  const assignees = await resolveAssignees(tenantId, levels);

  return {
    approvalRequired: true,
    reason:
      `Rule "${rule.name}" applies to this purchase, so it needs ` +
      `${levels.length} approval${levels.length === 1 ? '' : 's'} before funds are committed.`,
    policyId: policy.id,
    policyVersion: policy.version,
    ruleId: rule.id,
    ruleName: rule.name,
    thresholdAmount: decimalToNumber(priced.thresholdAmount),
    currency: policy.currency,
    levels: levels.map((level) => {
      const assignee = assignees.get(level.level);
      return {
        level: level.level,
        requiredRole: level.requiredRole,
        label: level.label,
        approverId: assignee?.id,
        approverName: assignee ? `${assignee.firstName} ${assignee.lastName}`.trim() : undefined,
      } satisfies ResolvedApprovalLevel;
    }),
  };
}

/**
 * Normalize a stored hierarchy: sorted, contiguously numbered from 1.
 *
 * Gaps and out-of-order levels would break the "a level cannot be decided
 * before every lower level is approved" rule, so they are corrected rather than
 * trusted.
 */
export function normalizeLevels(raw: unknown): ApprovalLevelConfig[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<number>();
  const levels: ApprovalLevelConfig[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const requiredRole = value.requiredRole as UserRole;
    if (!ASSIGNABLE_ROLES.includes(requiredRole)) continue;
    if (seen.has(value.level as number)) continue;
    seen.add(value.level as number);

    levels.push({
      level: value.level as number,
      requiredRole,
      label: typeof value.label === 'string' ? value.label : undefined,
      approverIds: Array.isArray(value.approverIds)
        ? value.approverIds.filter((id): id is string => typeof id === 'string')
        : undefined,
    });
  }

  levels.sort((a, b) => a.level - b.level);
  return levels.map((level, index) => ({ ...level, level: index + 1 }));
}

/**
 * Pick the named approver for each level.
 *
 * A level that names approvers routes to the first active holder among them. A
 * level that names none stays unassigned, which leaves it open to any active
 * user holding the required role - decided at decision time against live
 * authorization rather than frozen here against a roster that may change.
 */
async function resolveAssignees(tenantId: string, levels: ApprovalLevelConfig[]) {
  const named = levels.flatMap((level) => level.approverIds ?? []);
  const result = new Map<number, { id: string; firstName: string; lastName: string }>();
  if (named.length === 0) return result;

  const users = await prisma.user.findMany({
    where: { id: { in: named }, tenantId, isActive: true },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(users.map((user) => [user.id, user]));

  for (const level of levels) {
    for (const id of level.approverIds ?? []) {
      const user = byId.get(id);
      if (user) {
        result.set(level.level, user);
        break;
      }
    }
  }

  return result;
}

// ── Reapproval ────────────────────────────────────────────────────────────────

/** The commercial snapshot a reapproval check compares against. */
export interface ApprovedCommercials {
  unitPrice: number;
  quantity: number;
  paymentTerms?: string | null;
  deliveryTimelineDays?: number | null;
  warrantyMonths?: number | null;
  otherChargesDetails?: string | null;
}

/**
 * Which commercial changes between an approved snapshot and the current offer
 * require the approval to be given again.
 *
 * Only triggers the organization has switched on are returned. A price *drop* is
 * commonly accepted without a second signature while a longer delivery schedule
 * is not, and that difference is configuration rather than a rule baked into
 * the product.
 */
export function detectMaterialChanges(
  reapprovalRules: ReapprovalRules | null | undefined,
  approved: ApprovedCommercials,
  current: ApprovedCommercials,
): PurchaseApprovalChangeTrigger[] {
  const rules: Required<ReapprovalRules> = {
    priceIncrease: reapprovalRules?.priceIncrease ?? true,
    // A lower price never needs reauthorizing by default: it is in the buyer's
    // interest and cannot be a way to spend more company money.
    priceDecrease: reapprovalRules?.priceDecrease ?? false,
    quantityChange: reapprovalRules?.quantityChange ?? true,
    deliveryTermsChange: reapprovalRules?.deliveryTermsChange ?? true,
    paymentTermsChange: reapprovalRules?.paymentTermsChange ?? true,
    otherTermsChange: reapprovalRules?.otherTermsChange ?? false,
  };

  const triggers: PurchaseApprovalChangeTrigger[] = [];

  const approvedTotal = new Prisma.Decimal(approved.unitPrice).times(approved.quantity);
  const currentTotal = new Prisma.Decimal(current.unitPrice).times(current.quantity);

  if (!currentTotal.equals(approvedTotal)) {
    triggers.push(
      currentTotal.gt(approvedTotal)
        ? PurchaseApprovalChangeTrigger.PRICE_INCREASE
        : PurchaseApprovalChangeTrigger.PRICE_DECREASE,
    );
  }

  if (current.quantity !== approved.quantity) {
    triggers.push(PurchaseApprovalChangeTrigger.QUANTITY_CHANGE);
  }

  if (
    (current.deliveryTimelineDays ?? null) !== (approved.deliveryTimelineDays ?? null) ||
    (current.warrantyMonths ?? null) !== (approved.warrantyMonths ?? null)
  ) {
    triggers.push(PurchaseApprovalChangeTrigger.DELIVERY_TERMS_CHANGE);
  }

  if (!sameText(current.paymentTerms, approved.paymentTerms)) {
    triggers.push(PurchaseApprovalChangeTrigger.PAYMENT_TERMS_CHANGE);
  }

  if (!sameText(current.otherChargesDetails, approved.otherChargesDetails)) {
    triggers.push(PurchaseApprovalChangeTrigger.OTHER_TERMS_CHANGE);
  }

  return triggers.filter((trigger) => {
    switch (trigger) {
      case PurchaseApprovalChangeTrigger.PRICE_INCREASE:
        return rules.priceIncrease;
      case PurchaseApprovalChangeTrigger.PRICE_DECREASE:
        return rules.priceDecrease;
      case PurchaseApprovalChangeTrigger.QUANTITY_CHANGE:
        return rules.quantityChange;
      case PurchaseApprovalChangeTrigger.DELIVERY_TERMS_CHANGE:
        return rules.deliveryTermsChange;
      case PurchaseApprovalChangeTrigger.PAYMENT_TERMS_CHANGE:
        return rules.paymentTermsChange;
      default:
        return rules.otherTermsChange;
    }
  });
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  const right = (b ?? '').trim().toLowerCase();
  return left === right;
}

/**
 * Suspend approvals that a material change has invalidated.
 *
 * The row is kept and marked SUPERSEDED rather than deleted or overwritten, so
 * the decision that was given, and the figures it was given against, remain
 * readable. Called from the negotiation path when a counteroffer revises terms
 * that were already approved.
 */
export async function suspendApprovalsForMaterialChange(input: {
  tenantId: string;
  dealRoomId: string;
  offerId: string;
  current: ApprovedCommercials;
  actorId: string;
}): Promise<{ suspended: Array<{ id: string; reference: string; triggers: PurchaseApprovalChangeTrigger[] }> }> {
  const { tenantId, dealRoomId, offerId, current, actorId } = input;
  const suspended: Array<{ id: string; reference: string; triggers: PurchaseApprovalChangeTrigger[] }> = [];

  const live = await prisma.purchaseApprovalRequest.findMany({
    where: {
      tenantId,
      dealRoomId,
      offerId: { not: offerId },
      status: { in: ['APPROVED', 'PURCHASE_CONFIRMED'] },
    },
  });
  if (live.length === 0) return { suspended };

  const policy = await loadActivePolicy(tenantId);
  const reapprovalRules = (policy?.reapprovalRules ?? null) as ReapprovalRules | null;

  for (const approval of live) {
    const triggers = detectMaterialChanges(
      reapprovalRules,
      {
        unitPrice: decimalToNumber(approval.unitPrice),
        quantity: approval.quantity,
        paymentTerms: approval.paymentTerms,
        deliveryTimelineDays: approval.deliveryTimelineDays,
        warrantyMonths: approval.warrantyMonths,
        otherChargesDetails: approval.otherChargesDetails,
      },
      current,
    );
    if (triggers.length === 0) continue;

    await prisma.purchaseApprovalRequest.update({
      where: { id: approval.id },
      data: {
        status: 'SUPERSEDED',
        supersededAt: new Date(),
        supersedeReason: `Commercial terms changed after approval (${triggers.join(', ')})`,
      },
    });

    await createAuditLog({
      userId: actorId,
      action: AuditAction.PURCHASE_APPROVAL_INVALIDATED,
      entityType: 'PurchaseApprovalRequest',
      entityId: approval.id,
      previousStatus: approval.status,
      newStatus: 'SUPERSEDED',
      tenantId,
      decision: `Reapproval required: ${triggers.join(', ')}`,
      metadata: {
        reference: approval.reference,
        approvedTotalAmount: approval.totalAmount.toString(),
        triggers,
        offerId,
      },
    });

    suspended.push({ id: approval.id, reference: approval.reference, triggers });
  }

  return { suspended };
}

// ── Finalization gate ─────────────────────────────────────────────────────────

/** Statuses that release funds: the authorization has been given and used. */
const AUTHORIZING_STATUSES: Prisma.PurchaseApprovalRequestWhereInput['status'] = {
  in: ['APPROVED', 'PURCHASE_CONFIRMED'],
};

export interface AuthorizationCheck {
  approvalRequired: boolean;
  /** The authorization that releases this offer, when one exists. */
  approvalId?: string;
  status?: string;
  reference?: string;
}

/**
 * May this offer be finalized into a deal?
 *
 * Called by the negotiation path. An organization with no active policy has not
 * asked for authorization and is not blocked; once a policy is active, an offer
 * cannot be closed without an authorization that has actually been given.
 * APPROVED is deliberately sufficient: confirmation is the buyer's separate,
 * subsequent step, and refusing to close the deal before it would leave an
 * approved purchase with no deal to raise an order from.
 *
 * Lives here rather than in the purchase-approval service so the negotiation
 * module depends only on configuration and never on the workflow that depends
 * back on it.
 */
export async function checkOfferAuthorization(
  tenantId: string,
  offerId: string,
): Promise<AuthorizationCheck> {
  const policy = await loadActivePolicy(tenantId);
  if (!policy) return { approvalRequired: false };

  const approval = await prisma.purchaseApprovalRequest.findFirst({
    where: { tenantId, offerId, status: AUTHORIZING_STATUSES },
    select: { id: true, status: true, reference: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!approval) {
    return { approvalRequired: true };
  }

  return {
    approvalRequired: true,
    approvalId: approval.id,
    status: approval.status,
    reference: approval.reference,
  };
}

/**
 * Throw unless the offer carries an authorization.
 *
 * The message names what to do next, because this is the one place a buyer
 * discovers their organization requires approval mid-negotiation.
 */
export async function assertOfferAuthorized(tenantId: string, offerId: string): Promise<void> {
  const check = await checkOfferAuthorization(tenantId, offerId);
  if (!check.approvalRequired) return;

  if (check.approvalId) return;

  throw new ValidationError(
    'This purchase needs manager approval before it can be confirmed. ' +
      'Submit the offer for approval from the negotiation room.',
  );
}

// ── Authorization for configuration ───────────────────────────────────────────

/** Configuring thresholds and hierarchies is an administrator action. */
export function assertCanConfigurePolicy(actor: PolicyActor): void {
  if (!isApprovalAdmin(actor.role)) {
    throw new ForbiddenError(
      'Only a company administrator can configure purchase approval policy',
    );
  }
}

// ── Policy administration ─────────────────────────────────────────────────────

export interface ApprovalRuleInput {
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
}

export interface UpsertPolicyInput {
  name?: string;
  description?: string;
  currency?: string;
  isActive?: boolean;
  includeTaxesInThreshold?: boolean;
  includeDeliveryChargesInThreshold?: boolean;
  autoApproveBelowAmount?: number | null;
  allowSelfApproval?: boolean;
  selfApprovalJustification?: string;
  reapprovalRules?: ReapprovalRules;
  splitGuardEnabled?: boolean;
  splitGuardWindowDays?: number;
  rules?: ApprovalRuleInput[];
}

/**
 * Shared row payload for a rule.
 *
 * Amounts are converted through `toDecimal` so a configured `12345.67` is
 * stored as the decimal the administrator typed rather than a re-derived binary
 * float, and levels are normalized once so a stored hierarchy is always
 * contiguously numbered.
 */
function ruleRowData(tenantId: string, rule: ApprovalRuleInput) {
  return {
    tenantId,
    name: rule.name,
    priority: rule.priority,
    isActive: rule.isActive,
    minAmount: rule.minAmount === undefined ? null : toDecimal(rule.minAmount, 'minAmount'),
    maxAmount: rule.maxAmount === undefined ? null : toDecimal(rule.maxAmount, 'maxAmount'),
    department: rule.department ?? null,
    categoryId: rule.categoryId ?? null,
    costCenter: rule.costCenter ?? null,
    requireApproval: rule.requireApproval,
    levels: normalizeLevels(rule.levels) as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Create or replace an organization's policy.
 *
 * Rules are replaced wholesale rather than diffed: an administrator editing
 * thresholds is stating the whole hierarchy, and a partial merge would leave
 * rules they believed they had removed in force. Every version is archived onto
 * the requests that used it, so history stays reconstructable.
 */
export async function upsertPolicy(tenantId: string, input: UpsertPolicyInput, actor: PolicyActor) {
  assertCanConfigurePolicy(actor);

  const currency = input.currency ?? (await getPolicy(tenantId))?.currency ?? 'INR';

  if (input.allowSelfApproval && !input.selfApprovalJustification) {
    throw new ValidationError('Enabling self-approval requires a written justification');
  }
  if (input.autoApproveBelowAmount !== undefined && input.autoApproveBelowAmount !== null) {
    if (input.autoApproveBelowAmount < 0) {
      throw new ValidationError('The small-purchase threshold cannot be negative');
    }
  }

  const existing = await prisma.purchaseApprovalPolicy.findUnique({
    where: { tenantId },
    include: POLICY_INCLUDE,
  });

  const data = {
    name: input.name ?? existing?.name ?? 'Purchase approval policy',
    description: input.description ?? existing?.description ?? undefined,
    currency,
    isActive: input.isActive ?? existing?.isActive ?? true,
    includeTaxesInThreshold: input.includeTaxesInThreshold ?? existing?.includeTaxesInThreshold ?? true,
    includeDeliveryChargesInThreshold:
      input.includeDeliveryChargesInThreshold ?? existing?.includeDeliveryChargesInThreshold ?? true,
    autoApproveBelowAmount:
      input.autoApproveBelowAmount === undefined
        ? existing?.autoApproveBelowAmount ?? null
        : input.autoApproveBelowAmount === null
          ? null
          : toDecimal(input.autoApproveBelowAmount, 'autoApproveBelowAmount'),
    allowSelfApproval: input.allowSelfApproval ?? existing?.allowSelfApproval ?? false,
    selfApprovalJustification:
      input.selfApprovalJustification ?? existing?.selfApprovalJustification ?? undefined,
    reapprovalRules:
      (input.reapprovalRules as Prisma.InputJsonValue | undefined) ??
      (existing?.reapprovalRules === null || existing?.reapprovalRules === undefined
        ? Prisma.JsonNull
        : (existing.reapprovalRules as unknown as Prisma.InputJsonValue)),
    splitGuardEnabled: input.splitGuardEnabled ?? existing?.splitGuardEnabled ?? true,
    splitGuardWindowDays: input.splitGuardWindowDays ?? existing?.splitGuardWindowDays ?? 30,
    updatedById: actor.userId,
  };

  const policy = existing
    ? await prisma.purchaseApprovalPolicy.update({
        where: { id: existing.id },
        data: {
          ...data,
          // A changed policy is a new version. Requests already in flight keep
          // pointing at the version they were routed under.
          version: { increment: 1 },
          rules: input.rules
            ? {
                deleteMany: {},
                create: input.rules.map((rule) => ruleRowData(tenantId, rule)),
              }
            : undefined,
        },
        include: POLICY_INCLUDE,
      })
    : await prisma.purchaseApprovalPolicy.create({
        data: {
          ...data,
          tenantId,
          rules: {
            create: (input.rules ?? []).map((rule) => ruleRowData(tenantId, rule)),
          },
        },
        include: POLICY_INCLUDE,
      });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.APPROVAL_POLICY_UPDATED,
    entityType: 'PurchaseApprovalPolicy',
    entityId: policy.id,
    previousStatus: existing ? `v${existing.version}` : undefined,
    newStatus: `v${policy.version}`,
    tenantId,
    decision: input.allowSelfApproval ? 'Self-approval permitted' : undefined,
    metadata: {
      version: policy.version,
      currency: policy.currency,
      ruleCount: policy.rules.length,
      autoApproveBelowAmount: policy.autoApproveBelowAmount?.toString() ?? null,
      includeTaxesInThreshold: policy.includeTaxesInThreshold,
      includeDeliveryChargesInThreshold: policy.includeDeliveryChargesInThreshold,
      allowSelfApproval: policy.allowSelfApproval,
      selfApprovalJustification: policy.selfApprovalJustification ?? undefined,
      reapprovalRules: (input.reapprovalRules ?? undefined) as Prisma.InputJsonValue | undefined,
      splitGuardEnabled: policy.splitGuardEnabled,
      splitGuardWindowDays: policy.splitGuardWindowDays,
    },
  });

  return policy;
}

export async function upsertRule(
  tenantId: string,
  ruleId: string,
  input: ApprovalRuleInput,
  actor: PolicyActor,
) {
  assertCanConfigurePolicy(actor);

  const policy = await prisma.purchaseApprovalPolicy.findUnique({ where: { tenantId } });
  if (!policy) {
    throw new NotFoundError('Purchase approval policy - configure the policy before adding rules');
  }

  if (input.requireApproval && normalizeLevels(input.levels).length === 0) {
    throw new ValidationError('A rule that requires approval must define at least one level');
  }

  const payload = ruleRowData(tenantId, input);

  const rule = await prisma.purchaseApprovalRule.upsert({
    where: { id: ruleId },
    create: { ...payload, policyId: policy.id },
    update: payload,
  });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.APPROVAL_RULE_UPDATED,
    entityType: 'PurchaseApprovalRule',
    entityId: rule.id,
    tenantId,
    metadata: {
      policyId: policy.id,
      name: rule.name,
      priority: rule.priority,
      isActive: rule.isActive,
      minAmount: rule.minAmount?.toString() ?? null,
      maxAmount: rule.maxAmount?.toString() ?? null,
      department: rule.department ?? undefined,
      categoryId: rule.categoryId ?? undefined,
      costCenter: rule.costCenter ?? undefined,
      levels: normalizeLevels(rule.levels) as unknown as Prisma.InputJsonValue,
    },
  });

  return rule;
}

export async function deleteRule(tenantId: string, ruleId: string, actor: PolicyActor): Promise<void> {
  assertCanConfigurePolicy(actor);
  const rule = await prisma.purchaseApprovalRule.findFirst({ where: { id: ruleId, tenantId } });
  if (!rule) throw new NotFoundError('Approval rule');

  await prisma.purchaseApprovalRule.delete({ where: { id: ruleId } });

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.APPROVAL_RULE_UPDATED,
    entityType: 'PurchaseApprovalRule',
    entityId: ruleId,
    previousStatus: 'ACTIVE',
    newStatus: 'DELETED',
    tenantId,
    metadata: { name: rule.name, policyId: rule.policyId },
  });
}

// ── Self-approval ─────────────────────────────────────────────────────────────

/**
 * May this actor decide an approval they submitted themselves?
 *
 * No, unless the organization has explicitly permitted it *and* written down
 * why. The justification is returned so the caller can record it on the
 * decision's audit entry - a bare flag would leave an unexplained exception in
 * the trail.
 */
export function assertMaySelfApprove(
  policy: { allowSelfApproval: boolean; selfApprovalJustification: string | null } | null,
  submittedById: string,
  actorId: string,
  decisionRole: UserRole,
): string | undefined {
  if (submittedById !== actorId) return undefined;
  if (!policy || !policy.allowSelfApproval) {
    throw new ForbiddenError('You cannot approve a purchase you submitted yourself');
  }
  // An organization that permits self-approval has still not granted it to the
  // roles it uses for external review.
  if (!APPROVER_ROLES.includes(decisionRole) && !APPROVAL_ADMIN_ROLES.includes(decisionRole)) {
    throw new ForbiddenError('Your role cannot approve purchases, including your own');
  }
  return policy.selfApprovalJustification ?? undefined;
}

// ── Which roles may view or decide ────────────────────────────────────────────

export function assertCanViewApprovals(actor: PolicyActor): void {
  if (!APPROVAL_BUYER_ROLES.includes(actor.role)) {
    throw new ForbiddenError('You do not have access to purchase approvals');
  }
}
