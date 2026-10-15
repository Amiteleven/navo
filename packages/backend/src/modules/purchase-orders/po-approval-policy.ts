import { UserRole } from '@navo/shared';

/**
 * Purchase order approval policy.
 *
 * A PO's required approval chain is derived deterministically from its total
 * amount, so a high-value order cannot skip finance review simply because it was
 * raised by a senior user. Thresholds are configuration constants rather than
 * database rows: Phase 5 does not expose a policy editor, and keeping them in
 * code makes the rule that gated each order fully reproducible from the
 * repository alone.
 *
 * Levels are always evaluated in ascending order. A level cannot be decided
 * until every lower level is APPROVED, which prevents an out-of-order finance
 * approval from unlocking issuance while procurement review is still pending.
 */

export interface ApprovalThreshold {
  /** Inclusive lower bound on the PO total. */
  minAmount: number;
  /** Role that must approve at this level. */
  role: UserRole;
  /** Label shown in the UI and audit trail. */
  label: string;
}

/**
 * Ascending by minAmount. The first entry whose `minAmount` the total meets or
 * exceeds supplies level 1; every later entry adds a further level.
 */
export const APPROVAL_THRESHOLDS: ApprovalThreshold[] = [
  { minAmount: 0, role: UserRole.PROCUREMENT_MANAGER, label: 'Procurement review' },
  { minAmount: 100_000, role: UserRole.FINANCE_APPROVER, label: 'Finance review' },
  { minAmount: 1_000_000, role: UserRole.COMPANY_ADMIN, label: 'Executive approval' },
];

/** One resolved approval level for a specific PO total. */
export interface ApprovalChainEntry {
  level: number;
  requiredRole: UserRole;
  label: string;
  /** Threshold that triggered this level. */
  minAmount: number;
}

/**
 * Build the ordered approval chain for a PO total.
 * Returns one entry per threshold the total reaches, numbered from 1.
 */
export function buildApprovalChain(totalAmount: number): ApprovalChainEntry[] {
  const total = Number.isFinite(totalAmount) ? Math.abs(totalAmount) : 0;

  return APPROVAL_THRESHOLDS.filter((t) => total >= t.minAmount).map((threshold, index) => ({
    level: index + 1,
    requiredRole: threshold.role,
    label: threshold.label,
    minAmount: threshold.minAmount,
  }));
}

/**
 * Roles allowed to decide an approval at a given level.
 *
 * Typed as plain strings: values read back from the database arrive as Prisma
 * enum members, which are nominally distinct from the shared enum despite
 * identical literals.
 */
export function rolesAllowedForLevel(requiredRole: string): string[] {
  // A COMPANY_ADMIN can satisfy any level; otherwise the level's own role.
  return requiredRole === UserRole.COMPANY_ADMIN
    ? [UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN]
    : [requiredRole, UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN];
}

export function canDecideLevel(actorRole: string, requiredRole: string): boolean {
  return rolesAllowedForLevel(requiredRole).includes(actorRole);
}

/** Human-readable description of why a given total needs N approvals. */
export function describeChain(totalAmount: number): string {
  const chain = buildApprovalChain(totalAmount);
  if (chain.length === 0) return 'No approval required';
  return chain.map((level) => `L${level.level} ${level.label}`).join(' -> ');
}