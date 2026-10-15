import { UserRole } from '@navo/shared';
import { ForbiddenError } from '../../utils/errors.js';

/**
 * Organization-level roles for manager approval and purchase authorization.
 *
 * NAVO already separates buyer-side and approver-side authority in
 * `purchase-orders/po-access.ts`, so this reuses those same `UserRole` values
 * rather than inventing a parallel role system. An organization gets the three
 * responsibilities it needs - buyer, approver, administrator - from the roles it
 * already assigns, and a rule names a role per approval level.
 */

/** Roles that may raise and confirm purchases. */
export const APPROVAL_BUYER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
  UserRole.REQUESTER,
];

/**
 * Roles that may decide an approval level.
 *
 * A COMPANY_ADMIN satisfies any level, so an organization is never stuck with a
 * purchase that nobody can authorize; the same escalation the purchase-order
 * path already uses.
 */
export const APPROVER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
];

/** Roles that may configure policy, thresholds, rules and approver assignments. */
export const APPROVAL_ADMIN_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
];

/** Roles that may view every approval in the tenant, not only their own. */
export const APPROVAL_AUDIT_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
];

export interface ApprovalActor {
  userId: string;
  tenantId: string;
  role: UserRole;
}

/**
 * May this actor decide an approval level that calls for `requiredRole`?
 *
 * Mirrors `po-approval-policy.canDecideLevel`, but reads the role from live
 * authorization rather than from a role stored on the level row at submission
 * time - a decision must reflect the authority the actor actually holds now.
 */
export function canDecideApprovalLevel(actorRole: string, requiredRole: string): boolean {
  if (actorRole === UserRole.PLATFORM_ADMIN) return true;
  if (requiredRole === UserRole.COMPANY_ADMIN) {
    return actorRole === UserRole.COMPANY_ADMIN;
  }
  return actorRole === requiredRole || actorRole === UserRole.COMPANY_ADMIN;
}

export function isApprovalAdmin(role: string): boolean {
  return APPROVAL_ADMIN_ROLES.includes(role as UserRole);
}

export function isApprover(role: string): boolean {
  return APPROVER_ROLES.includes(role as UserRole);
}

export function isApprovalBuyer(role: string): boolean {
  return APPROVAL_BUYER_ROLES.includes(role as UserRole);
}

export function isApprovalAuditor(role: string): boolean {
  return APPROVAL_AUDIT_ROLES.includes(role as UserRole);
}

/** Require buyer-side authority; suppliers can never submit or confirm a purchase. */
export function assertApprovalBuyer(actor: ApprovalActor): void {
  if (actor.role === UserRole.VENDOR) {
    throw new ForbiddenError('Supplier accounts cannot raise or confirm purchases');
  }
  if (!APPROVAL_BUYER_ROLES.includes(actor.role)) {
    throw new ForbiddenError('Insufficient permissions for purchase approvals');
  }
}

/** Require approver-side authority before anything that touches a decision. */
export function assertApprover(actor: ApprovalActor): void {
  if (!APPROVER_ROLES.includes(actor.role)) {
    throw new ForbiddenError(
      'Only a procurement manager, finance approver or administrator can decide approvals',
    );
  }
}
