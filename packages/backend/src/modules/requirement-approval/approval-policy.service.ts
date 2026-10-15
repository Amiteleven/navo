import { PrismaClient, Prisma, RequirementApprovalStatus, RequirementApprovalDecisionStatus, RequirementApprovalPolicy, RequirementApprovalRule, ProcurementRequest } from '@prisma/client';
import { UserRole, AuditAction } from '@navo/shared';
import { ForbiddenError, ValidationError, NotFoundError } from '../../utils/errors.js';
import { decimalToNumber } from '../../utils/money.js';
import { createAuditLog } from '../audit/audit.service.js';

const prisma = new PrismaClient();

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
  policySnapshot: Prisma.JsonValue;
  ruleSnapshot: Prisma.JsonValue | null;
}

export interface RequirementApprovalContext {
  actor: {
    userId: string;
    tenantId: string;
    role: UserRole;
  };
  requirement: {
    id: string;
    title: string;
    category: string | null;
    department: string | null;
    costCenter: string | null;
    estimatedBudget: number | null;
    currency: string;
    requesterId: string;
  };
}

/**
 * Resolves the applicable approval policy and rule for a requirement.
 * Returns the approval hierarchy (levels) and threshold information.
 * If no policy/rule matches or amount is below auto-approve threshold,
 * returns autoApproved: true with empty levels.
 */
export async function resolveRequirementApprovalRoute(
  context: RequirementApprovalContext
): Promise<ResolvedRequirementRoute> {
  const { actor, requirement } = context;

  // Fetch active policy for tenant
  const policy = await prisma.requirementApprovalPolicy.findUnique({
    where: { tenantId: actor.tenantId },
    include: {
      rules: {
        where: { isActive: true },
        orderBy: { priority: 'asc' },
      },
    },
  });

  if (!policy || !policy.isActive) {
    return {
      rule: null,
      levels: [],
      thresholdAmount: 0,
      autoApproved: true,
      policyVersion: 0,
      appliedRuleId: null,
      policySnapshot: {},
      ruleSnapshot: null,
    };
  }

  // Check auto-approve threshold
  const estimatedAmount = requirement.estimatedBudget ?? 0;
  if (policy.autoApproveBelowAmount && estimatedAmount < decimalToNumber(policy.autoApproveBelowAmount)) {
    return {
      rule: null,
      levels: [],
      thresholdAmount: estimatedAmount,
      autoApproved: true,
      policyVersion: policy.version,
      appliedRuleId: null,
      policySnapshot: {
        autoApproveBelowAmount: decimalToNumber(policy.autoApproveBelowAmount),
        includeTaxesInThreshold: true,
        includeDeliveryChargesInThreshold: true,
        allowSelfApproval: policy.allowSelfApproval,
        reapprovalRules: policy.reapprovalRules,
      },
      ruleSnapshot: null,
    };
  }

  // Find matching rule - most specific active rule wins
  // Specificity = count of non-null scope attributes (department, category, costCenter, amount range)
  let matchedRule: RequirementApprovalRule | null = null;
  let highestSpecificity = -1;

  for (const rule of policy.rules) {
    let specificity = 0;
    let matches = true;

    // Check department scope
    if (rule.department) {
      specificity++;
      if (rule.department !== requirement.department) {
        matches = false;
      }
    }

    // Check category scope
    if (rule.categoryId) {
      specificity++;
      if (rule.categoryId !== requirement.category) {
        matches = false;
      }
    }

    // Check cost center scope
    if (rule.costCenter) {
      specificity++;
      if (rule.costCenter !== requirement.costCenter) {
        matches = false;
      }
    }

    // Check amount range
    if (rule.minAmount !== null) {
      specificity++;
      if (estimatedAmount < decimalToNumber(rule.minAmount)) {
        matches = false;
      }
    }
    if (rule.maxAmount !== null) {
      specificity++;
      if (estimatedAmount >= decimalToNumber(rule.maxAmount)) {
        matches = false;
      }
    }

    if (matches && specificity > highestSpecificity) {
      highestSpecificity = specificity;
      matchedRule = rule;
    }
  }

  // If no rule matches and requireApproval is true on fallback, route to default
  if (!matchedRule) {
    // Check if there's a fallback rule (no scope attributes)
    const fallbackRule = (policy as any).rules.find((r: RequirementApprovalRule) =>
      !r.department && !r.categoryId && !r.costCenter && r.minAmount === null && r.maxAmount === null
    );

    if (fallbackRule && fallbackRule.requireApproval) {
      matchedRule = fallbackRule;
    } else if (!fallbackRule || !fallbackRule.requireApproval) {
      // No approval required
      return {
        rule: null,
        levels: [],
        thresholdAmount: estimatedAmount,
        autoApproved: true,
        policyVersion: policy.version,
        appliedRuleId: null,
        policySnapshot: {
          autoApproveBelowAmount: policy.autoApproveBelowAmount ? decimalToNumber(policy.autoApproveBelowAmount) : null,
          includeTaxesInThreshold: true,
          includeDeliveryChargesInThreshold: true,
          allowSelfApproval: policy.allowSelfApproval,
          reapprovalRules: policy.reapprovalRules,
        },
        ruleSnapshot: null,
      };
    }
  }

  if (!matchedRule) {
    // No matching rule and no fallback - fail closed (require approval but no rule)
    // This should not happen in practice if a fallback is configured
    return {
      rule: null,
      levels: [],
      thresholdAmount: estimatedAmount,
      autoApproved: false,
      policyVersion: policy.version,
      appliedRuleId: null,
      policySnapshot: {
        autoApproveBelowAmount: policy.autoApproveBelowAmount ? decimalToNumber(policy.autoApproveBelowAmount) : null,
        includeTaxesInThreshold: true,
        includeDeliveryChargesInThreshold: true,
        allowSelfApproval: policy.allowSelfApproval,
        reapprovalRules: policy.reapprovalRules,
      },
      ruleSnapshot: null,
    };
  }

  // Parse levels from rule
  const levels = (matchedRule.levels as Array<{
    level: number;
    requiredRole: UserRole;
    label: string;
    approverIds?: string[];
  }> ?? []).map(l => ({
    level: l.level,
    requiredRole: l.requiredRole,
    label: l.label ?? l.requiredRole.replace(/_/g, ' '),
    approverIds: l.approverIds ?? [],
  })).sort((a, b) => a.level - b.level);

  return {
    rule: matchedRule,
    levels,
    thresholdAmount: estimatedAmount,
    autoApproved: false,
    policyVersion: policy.version,
    appliedRuleId: matchedRule.id,
    policySnapshot: {
      autoApproveBelowAmount: policy.autoApproveBelowAmount ? decimalToNumber(policy.autoApproveBelowAmount) : null,
      includeTaxesInThreshold: true,
      includeDeliveryChargesInThreshold: true,
      allowSelfApproval: policy.allowSelfApproval,
      reapprovalRules: policy.reapprovalRules,
    },
    ruleSnapshot: {
      id: matchedRule.id,
      name: matchedRule.name,
      priority: matchedRule.priority,
      minAmount: matchedRule.minAmount ? decimalToNumber(matchedRule.minAmount) : null,
      maxAmount: matchedRule.maxAmount ? decimalToNumber(matchedRule.maxAmount) : null,
      department: matchedRule.department,
      categoryId: matchedRule.categoryId,
      costCenter: matchedRule.costCenter,
      requireApproval: matchedRule.requireApproval,
      levels: matchedRule.levels,
    },
  };
}

/**
 * Resolves the specific approver for a given level.
 * If the rule specifies approverIds, uses those. Otherwise, finds any active user
 * with the required role in the tenant.
 */
export async function resolveRequirementApprover(
  tenantId: string,
  level: { requiredRole: UserRole; approverIds: string[] },
  requesterId: string
): Promise<string | null> {
  if (level.approverIds.length > 0) {
    // Find first active approver from the list who is not the requester
    const approver = await prisma.user.findFirst({
      where: {
        id: { in: level.approverIds },
        tenantId,
        isActive: true,
        role: level.requiredRole,
        NOT: { id: requesterId },
      },
    });
    return approver?.id ?? null;
  }

  // Find any active user with the required role in the tenant
  const approver = await prisma.user.findFirst({
    where: {
      tenantId,
      isActive: true,
      role: level.requiredRole,
      NOT: { id: requesterId },
    },
  });

  return approver?.id ?? null;
}

/**
 * Creates the initial approval decisions (levels) for a requirement approval request.
 * Returns the created decisions with resolved approvers.
 */
export async function createRequirementApprovalDecisions(
  requestId: string,
  levels: Array<{ level: number; requiredRole: UserRole; label: string; approverIds: string[] }>,
  tenantId: string,
  requesterId: string
) {
  const decisions = [];

  for (const level of levels) {
    const approverId = await resolveRequirementApprover(tenantId, level, requesterId);

    const decision = await prisma.requirementApprovalDecision.create({
      data: {
        tenantId,
        requirementApprovalRequestId: requestId,
        level: level.level,
        requiredRole: level.requiredRole,
        label: level.label,
        status: 'PENDING',
        assignedApproverId: approverId,
      },
    });

    decisions.push(decision);
  }

  return decisions;
}

/**
 * Gets the next pending decision for a requirement approval request.
 * Returns null if all levels are decided.
 */
export async function getNextPendingDecision(requestId: string) {
  return prisma.requirementApprovalDecision.findFirst({
    where: {
      requirementApprovalRequestId: requestId,
      status: 'PENDING',
    },
    orderBy: { level: 'asc' },
  });
}

/**
 * Checks if a requirement approval request is fully approved.
 */
export async function isRequirementApprovalFullyApproved(requestId: string): Promise<boolean> {
  const pendingCount = await prisma.requirementApprovalDecision.count({
    where: {
      requirementApprovalRequestId: requestId,
      status: 'PENDING',
    },
  });
  return pendingCount === 0;
}

/**
 * Checks if a requirement approval request has been rejected or sent back.
 */
export async function getRequirementApprovalTerminalStatus(requestId: string): Promise<RequirementApprovalStatus | null> {
  const request = await prisma.requirementApprovalRequest.findUnique({
    where: { id: requestId },
    select: { status: true },
  });
  return request?.status ?? null;
}

/**
 * Determines if a requirement change is material enough to trigger reapproval.
 * This mirrors the purchase approval change trigger logic but for requirements.
 */
export function isMaterialRequirementChange(
  previousReq: ProcurementRequest,
  updatedReq: Partial<ProcurementRequest>,
  reapprovalRules: Prisma.JsonValue | null
): boolean {
  if (!reapprovalRules) return false;

  const rules = reapprovalRules as Record<string, boolean>;
  if (!rules || Object.keys(rules).length === 0) return false;

  // Check each trigger
  if (rules.priceIncrease && updatedReq.estimatedBudget !== undefined && updatedReq.estimatedBudget !== null && previousReq.estimatedBudget !== null && previousReq.estimatedBudget !== undefined) {
    if (updatedReq.estimatedBudget > previousReq.estimatedBudget) return true;
  }

  if (rules.priceDecrease && updatedReq.estimatedBudget !== undefined && updatedReq.estimatedBudget !== null && previousReq.estimatedBudget !== null && previousReq.estimatedBudget !== undefined) {
    if (updatedReq.estimatedBudget < previousReq.estimatedBudget) return true;
  }

  if (rules.quantityChange && updatedReq.quantity !== undefined && updatedReq.quantity !== previousReq.quantity) return true;

  if (rules.deliveryTermsChange && updatedReq.requiredDate !== undefined && updatedReq.requiredDate !== previousReq.requiredDate) return true;

  if (rules.otherTermsChange) {
    // Check for changes in specifications, category, etc.
    if (updatedReq.specifications !== undefined && updatedReq.specifications !== previousReq.specifications) return true;
    if (updatedReq.categoryId !== undefined && updatedReq.categoryId !== previousReq.categoryId) return true;
  }

  return false;
}

/**
 * Checks if a user can self-approve a requirement.
 */
export function canSelfApproveRequirement(
  policy: RequirementApprovalPolicy | null,
  requesterId: string,
  approverId: string
): boolean {
  if (!policy?.allowSelfApproval) return false;
  return requesterId === approverId;
}

/**
 * Validates self-approval justification.
 */
export function validateSelfApprovalJustification(
  policy: RequirementApprovalPolicy | null,
  justification: string
): { valid: boolean; error?: string } {
  if (!policy?.allowSelfApproval) {
    return { valid: false, error: 'Self-approval is not permitted by policy' };
  }
  if (!justification || justification.trim().length < 20) {
    return { valid: false, error: 'Self-approval requires a justification of at least 20 characters' };
  }
  return { valid: true };
}

/**
 * Supersedes requirement approvals that were granted against terms that
 * have since changed materially.
 *
 * Mirrors the purchase-approval gate: an approval that was given against
 * one set of terms cannot authorize sourcing against different terms. The
 * superseded approval stays readable, and the requirement returns to
 * PENDING_DEPARTMENT_APPROVAL so it must be re-submitted and re-approved.
 */
export async function suspendRequirementApprovalsForMaterialChange(input: {
  tenantId: string;
  requestId: string;
  previousReq: ProcurementRequest;
  updatedReq: Partial<ProcurementRequest>;
  actorId: string;
}): Promise<{ superseded: Array<{ id: string; reference: string; triggers: string[] }> }> {
  const { tenantId, requestId, previousReq, updatedReq, actorId } = input;
  const superseded: Array<{ id: string; reference: string; triggers: string[] }> = [];

  // Load the tenant policy to read the configured reapproval rules.
  const policy = await prisma.requirementApprovalPolicy.findUnique({
    where: { tenantId },
    select: { reapprovalRules: true },
  });
  const reapprovalRules = policy?.reapprovalRules ?? null;

  const live = await prisma.requirementApprovalRequest.findMany({
    where: {
      tenantId,
      requestId,
      status: { in: ['APPROVED', 'PENDING_APPROVAL'] },
    },
  });
  if (live.length === 0) return { superseded };

  const triggers: string[] = [];
  if (isMaterialRequirementChange(previousReq, updatedReq, reapprovalRules)) {
    // Identify which triggers fired for the audit record.
    const rules = (reapprovalRules as Record<string, boolean>) ?? {};
    if (rules.priceIncrease && updatedReq.estimatedBudget !== undefined && updatedReq.estimatedBudget !== null && previousReq.estimatedBudget !== null && previousReq.estimatedBudget !== undefined && updatedReq.estimatedBudget > previousReq.estimatedBudget) {
      triggers.push('priceIncrease');
    }
    if (rules.priceDecrease && updatedReq.estimatedBudget !== undefined && updatedReq.estimatedBudget !== null && previousReq.estimatedBudget !== null && previousReq.estimatedBudget !== undefined && updatedReq.estimatedBudget < previousReq.estimatedBudget) {
      triggers.push('priceDecrease');
    }
    if (rules.quantityChange && updatedReq.quantity !== undefined && updatedReq.quantity !== previousReq.quantity) {
      triggers.push('quantityChange');
    }
    if (rules.deliveryTermsChange && updatedReq.requiredDate !== undefined && updatedReq.requiredDate !== previousReq.requiredDate) {
      triggers.push('deliveryTermsChange');
    }
    if (rules.otherTermsChange) {
      if (updatedReq.specifications !== undefined && updatedReq.specifications !== previousReq.specifications) triggers.push('specificationsChange');
      if (updatedReq.categoryId !== undefined && updatedReq.categoryId !== previousReq.categoryId) triggers.push('categoryChange');
    }
  }
  if (triggers.length === 0) return { superseded };

  for (const approval of live) {
    await prisma.requirementApprovalRequest.update({
      where: { id: approval.id },
      data: {
        status: 'SUPERSEDED',
        supersededAt: new Date(),
        supersedeReason: `Requirement changed materially after approval (${triggers.join(', ')})`,
      },
    });

    await createAuditLog({
      userId: actorId,
      action: AuditAction.REQUIREMENT_APPROVAL_INVALIDATED,
      entityType: 'RequirementApprovalRequest',
      entityId: approval.id,
      previousStatus: approval.status,
      newStatus: 'SUPERSEDED',
      tenantId,
      decision: `Reapproval required: ${triggers.join(', ')}`,
      metadata: {
        reference: approval.reference,
        requestId,
        triggers,
      },
    });

    superseded.push({ id: approval.id, reference: approval.reference, triggers });
  }

  // Return the requirement to the approval queue so the changed terms
  // must be re-submitted and re-approved before sourcing proceeds.
  await prisma.procurementRequest.update({
    where: { id: requestId },
    data: { status: 'PENDING_DEPARTMENT_APPROVAL' },
  });

  return { superseded };
}