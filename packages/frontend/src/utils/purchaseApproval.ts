import {
  ApprovalLevelConfig,
  PurchaseApprovalDecisionStatus,
  PurchaseApprovalStatus,
  ResolvedApprovalRoute,
  UserRole,
} from '../types';

/**
 * Presentation rules for the approval workflow.
 *
 * Kept as pure functions rather than inline JSX for two reasons: the wording of
 * an approval status is a product decision that must be identical in the inbox,
 * the buyer's panel and the notification, and a status label is exactly the sort
 * of thing a test should pin down rather than a snapshot of a component tree.
 */

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export interface StatusPresentation {
  label: string;
  tone: Tone;
  /**
   * What this status means for the purchase, in one line. `APPROVED` in
   * particular says "authorized, not bought", because collapsing that
   * distinction is how an approved request gets reported as a completed
   * purchase.
   */
  explanation: string;
}

export const APPROVAL_STATUS_PRESENTATION: Record<PurchaseApprovalStatus, StatusPresentation> = {
  PENDING_APPROVAL: {
    label: 'Pending approval',
    tone: 'warning',
    explanation: 'A manager must approve this before the purchase can be confirmed.',
  },
  CHANGES_REQUESTED: {
    label: 'Changes requested',
    tone: 'danger',
    explanation: 'An approver asked for changes. Submit a revised offer for approval again.',
  },
  REJECTED: {
    label: 'Rejected',
    tone: 'danger',
    explanation: 'This purchase was refused. A revised offer needs a new approval.',
  },
  APPROVED: {
    label: 'Approved',
    tone: 'success',
    explanation: 'Authorized, but not yet purchased. The buyer still has to confirm it.',
  },
  PURCHASE_CONFIRMED: {
    label: 'Purchase confirmed',
    tone: 'success',
    explanation: 'The buyer confirmed the purchase against the approved terms.',
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'neutral',
    explanation: 'This request was withdrawn before a decision was made.',
  },
  SUPERSEDED: {
    label: 'Superseded',
    tone: 'neutral',
    explanation: 'Replaced by a later revision, or invalidated by a change in terms.',
  },
};

export function presentApprovalStatus(status: PurchaseApprovalStatus): StatusPresentation {
  return (
    APPROVAL_STATUS_PRESENTATION[status] ?? {
      label: status,
      tone: 'neutral' as Tone,
      explanation: '',
    }
  );
}

export const DECISION_STATUS_PRESENTATION: Record<PurchaseApprovalDecisionStatus, StatusPresentation> = {
  PENDING: { label: 'Awaiting decision', tone: 'warning', explanation: '' },
  APPROVED: { label: 'Approved', tone: 'success', explanation: '' },
  REJECTED: { label: 'Rejected', tone: 'danger', explanation: '' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'danger', explanation: '' },
  SKIPPED: { label: 'Skipped', tone: 'neutral', explanation: '' },
};

export function presentDecisionStatus(status: PurchaseApprovalDecisionStatus): StatusPresentation {
  return (
    DECISION_STATUS_PRESENTATION[status] ?? {
      label: status,
      tone: 'neutral' as Tone,
      explanation: '',
    }
  );
}

/** `PROCUREMENT_MANAGER` -> `Procurement manager`. */
export function presentRole(role: string): string {
  const text = role.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The role that must act next, or null when nothing is outstanding. */
export function nextRequiredRole(
  decisions: Array<{ level: number; requiredRole: UserRole | string; status: PurchaseApprovalDecisionStatus }>,
  currentLevel: number,
): { level: number; requiredRole: string; label: string } | null {
  const level = decisions.find((d) => d.level === currentLevel);
  if (!level || level.status !== 'PENDING') return null;
  return {
    level: level.level,
    requiredRole: String(level.requiredRole),
    label: presentRole(String(level.requiredRole)),
  };
}

/** Levels still open, in order. */
export function pendingLevels<T extends { level: number; status: PurchaseApprovalDecisionStatus }>(
  decisions: T[],
): T[] {
  return decisions.filter((level) => level.status === 'PENDING').sort((a, b) => a.level - b.level);
}

/** True when the request sits with an approver, i.e. nothing for the buyer to do. */
export function isAwaitingApproval(status: PurchaseApprovalStatus): boolean {
  return status === 'PENDING_APPROVAL';
}

/**
 * Can the buyer confirm this purchase?
 *
 * Requires APPROVED specifically: a pending or returned request has nothing to
 * confirm, and a confirmed one is already done. Deriving the rule here rather
 * than in each screen keeps the button and the server from disagreeing.
 */
export function canConfirmPurchase(status: PurchaseApprovalStatus): boolean {
  return status === 'APPROVED';
}

/** Can the buyer still change the offer and resubmit? */
export function canRevise(status: PurchaseApprovalStatus): boolean {
  return (
    status === 'CHANGES_REQUESTED' ||
    status === 'REJECTED' ||
    status === 'APPROVED' ||
    status === 'PURCHASE_CONFIRMED'
  );
}

export function canCancel(status: PurchaseApprovalStatus): boolean {
  return status !== 'CANCELLED' && status !== 'SUPERSEDED' && status !== 'PURCHASE_CONFIRMED';
}

/** Approval is required unless the organization exempted this amount or matched a no-approval rule. */
export function requiresApproval(route: ResolvedApprovalRoute | undefined | null): boolean {
  return Boolean(route?.approvalRequired);
}

/**
 * Human summary of a resolved route, for the "why is this asking me to approve"
 * line. Names the rule, the figure it was measured against, and who must act.
 */
export function describeRoute(route: ResolvedApprovalRoute | undefined | null): string {
  if (!route) return 'Approval requirements are not configured for your organization yet.';

  if (!route.approvalRequired) {
    return route.reason || 'No manager approval is required for this purchase.';
  }

  const approvers = route.levels
    .map((level, index) =>
      index === 0
        ? `first ${level.label?.toLowerCase() ?? presentRole(level.requiredRole).toLowerCase()}`
        : `then ${level.label?.toLowerCase() ?? presentRole(level.requiredRole).toLowerCase()}`,
    )
    .join(', ');

  return (
    route.reason ||
    `This purchase needs ${route.levels.length} approval${route.levels.length === 1 ? '' : 's'} (${approvers}).`
  );
}

/** Format an amount with its currency, without assuming a symbol. */
export function formatApprovalAmount(amount: number | null | undefined, currency?: string): string {
  if (amount === null || amount === undefined) return '-';
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return currency ? `${formatted} ${currency}` : formatted;
}

/** Roles an approval level may be assigned to. Mirrors the server's assignable set. */
export const ASSIGNABLE_APPROVER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
];

/**
 * Normalize a level configuration into the shape the server accepts, dropping
 * anything that is not an assignable approver role.
 */
export function toLevelConfig(level: {
  level: number;
  requiredRole: string;
  label?: string;
  approverIds?: string[];
}): ApprovalLevelConfig {
  return {
    level: level.level,
    requiredRole: level.requiredRole as UserRole,
    label: level.label,
    approverIds: level.approverIds,
  };
}
