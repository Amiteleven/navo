import { RequirementApprovalStatus, RequirementApprovalDecisionStatus, UserRole } from '../types';

export function presentRequirementApprovalStatus(status: RequirementApprovalStatus) {
  const map: Record<
    RequirementApprovalStatus,
    { label: string; explanation: string; tone: 'success' | 'danger' | 'warning' | 'neutral' | 'info' }
  > = {
    DRAFT: { label: 'Draft', explanation: 'The request is being prepared and has not been submitted.', tone: 'neutral' },
    PENDING_APPROVAL: { label: 'Pending approval', explanation: 'Waiting for a department head to approve the business need.', tone: 'warning' },
    APPROVED: { label: 'Approved', explanation: 'The department head approved the requirement. Vendor sourcing can begin.', tone: 'success' },
    REJECTED: { label: 'Rejected', explanation: 'The requirement was rejected by the approver.', tone: 'danger' },
    CHANGES_REQUESTED: { label: 'Changes requested', explanation: 'The approver requested changes before approval.', tone: 'warning' },
    SEND_BACK: { label: 'Sent back', explanation: 'The requirement was sent back to the requester for revision.', tone: 'warning' },
    CANCELLED: { label: 'Cancelled', explanation: 'The requester cancelled this approval request.', tone: 'neutral' },
    SUPERSEDED: { label: 'Superseded', explanation: 'A newer revision replaced this request.', tone: 'neutral' },
  };
  return map[status] ?? { label: status, explanation: '', tone: 'neutral' };
}

export function presentRequirementDecisionStatus(status: RequirementApprovalDecisionStatus) {
  const map: Record<
    RequirementApprovalDecisionStatus,
    { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' | 'info' }
  > = {
    PENDING: { label: 'Pending', tone: 'warning' },
    APPROVED: { label: 'Approved', tone: 'success' },
    REJECTED: { label: 'Rejected', tone: 'danger' },
    CHANGES_REQUESTED: { label: 'Changes requested', tone: 'warning' },
    SKIPPED: { label: 'Skipped', tone: 'neutral' },
  };
  return map[status] ?? { label: status, tone: 'neutral' };
}

export function presentRole(role: string): string {
  return role
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function nextRequiredRole(
  decisions: Array<{ level: number; requiredRole: UserRole; label?: string; status: RequirementApprovalDecisionStatus }>,
  currentLevel: number
): { level: number; label: string; requiredRole: UserRole } | null {
  const pending = decisions.find((d) => d.status === 'PENDING' && d.level >= currentLevel);
  if (!pending) return null;
  return { level: pending.level, label: pending.label ?? presentRole(pending.requiredRole), requiredRole: pending.requiredRole };
}

export function pendingLevels(
  decisions: Array<{ id: string; level: number; status: RequirementApprovalDecisionStatus }>
): Array<{ id: string; level: number }> {
  return decisions
    .filter((d) => d.status === 'PENDING')
    .map((d) => ({ id: d.id, level: d.level }))
    .sort((a, b) => a.level - b.level);
}

export function canApproveRequirement(
  status: RequirementApprovalStatus,
  decisions: Array<{ status: RequirementApprovalDecisionStatus; assignedApproverId?: string; requiredRole: UserRole }>,
  userId: string,
  userRole: UserRole
): boolean {
  if (status !== 'PENDING_APPROVAL') return false;
  const next = decisions.find((d) => d.status === 'PENDING');
  if (!next) return false;
  if (next.assignedApproverId) return next.assignedApproverId === userId;
  return next.requiredRole === userRole;
}

export function formatRequirementAmount(amount: number | null | undefined, currency = 'INR'): string {
  if (amount === null || amount === undefined) return '—';
  const formatted = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
  return formatted;
}