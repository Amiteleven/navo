import prisma from '../../utils/prisma';
import { NotFoundError, ForbiddenError, ValidationError } from '../../utils/errors.js';
import { AuditAction, UserRole } from '@navo/shared';
import { createAuditLog } from '../audit/audit.service.js';
import { recordVendorEvent } from './vendor-event.service.js';

export interface AssignVendorInput {
  vendorId: string;
  requestId: string;
  notes?: string;
}

export async function assignVendor(
  input: AssignVendorInput,
  tenantId: string,
  assignedById: string
): Promise<any> {
  const { vendorId, requestId, notes } = input;

  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId } });
  if (!vendor) throw new NotFoundError('Vendor');

  const request = await prisma.procurementRequest.findFirst({ where: { id: requestId, tenantId } });
  if (!request) throw new NotFoundError('ProcurementRequest');

  const assignment = await prisma.vendorAssignment.create({
    data: {
      vendorId,
      requestId,
      tenantId,
      assignedById,
      notes,
    },
  });

  await recordVendorEvent({
    vendorId,
    eventType: 'ASSIGNED',
    metadata: { requestId, assignmentId: assignment.id },
    tenantId,
    actorId: assignedById,
  });

  await createAuditLog({
    userId: assignedById,
    action: AuditAction.CREATED,
    entityType: 'VendorAssignment',
    entityId: assignment.id,
    tenantId,
    metadata: { vendorId, requestId, notes },
  });

  return assignment;
}

export async function getVendorAssignments(vendorId: string, tenantId: string) {
  await assertVendorExists(vendorId, tenantId);

  return prisma.vendorAssignment.findMany({
    where: { vendorId, tenantId },
    include: {
      request: { select: { id: true, title: true } },
      assignedBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { assignedAt: 'desc' },
  });
}

export async function listVendorAssignments(
  tenantId: string,
  filters: {
    requestId?: string;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };
  if (filters.requestId) where.requestId = filters.requestId;

  const limit = filters.limit ?? 100;

  return prisma.vendorAssignment.findMany({
    where,
    include: {
      vendor: { select: { id: true, name: true, vendorType: true } },
      request: { select: { id: true, title: true } },
      assignedBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { assignedAt: 'desc' },
    take: limit,
  });
}

export async function isVendorAssignedToRequest(vendorId: string, requestId: string, tenantId: string): Promise<boolean> {
  const assignment = await prisma.vendorAssignment.findFirst({
    where: { vendorId, requestId, tenantId },
  });
  return !!assignment;
}

export async function deactivateAssignment(assignmentId: string, tenantId: string, userId: string) {
  const assignment = await prisma.vendorAssignment.findFirst({
    where: { id: assignmentId, tenantId },
  });
  if (!assignment) throw new NotFoundError('VendorAssignment');

  const updated = await prisma.vendorAssignment.update({
    where: { id: assignmentId },
    data: { declinedAt: new Date(), declineReason: 'Deactivated by buyer' },
  });

  await recordVendorEvent({
    vendorId: assignment.vendorId,
    eventType: 'UNASSIGNED',
    metadata: { assignmentId, deassigneeById: userId },
    tenantId,
    actorId: userId,
  });

  return updated;
}

/**
 * Resolve the caller's vendor link from the database.
 *
 * The JWT role is a hint for the UI; authorization must re-read from
 * the database so a role or vendor-link change takes effect immediately.
 */
async function resolveVendorIdentity(userId: string, tenantId: string): Promise<{ vendorId: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, role: true, vendorId: true, isActive: true },
  });
  if (!user || !user.isActive) {
    throw new ForbiddenError('Your account is not active or no longer exists');
  }
  if (user.tenantId !== tenantId) {
    throw new ForbiddenError('Access denied: account belongs to another tenant');
  }
  if (user.role !== UserRole.VENDOR || !user.vendorId) {
    throw new ForbiddenError('Only vendors can respond to assignments');
  }
  return { vendorId: user.vendorId };
}

/**
 * Vendor accepts an assignment, unlocking the sourcing workflow
 * for this requirement. Idempotency is preserved: an already
 * accepted assignment is rejected rather than silently rewritten.
 */
export async function acceptAssignment(
  assignmentId: string,
  tenantId: string,
  userId: string
) {
  const { vendorId } = await resolveVendorIdentity(userId, tenantId);

  const assignment = await prisma.vendorAssignment.findFirst({
    where: { id: assignmentId, tenantId },
  });
  if (!assignment) throw new NotFoundError('VendorAssignment');
  if (assignment.vendorId !== vendorId) {
    throw new ForbiddenError('Access denied: this assignment belongs to another vendor');
  }
  if (assignment.declinedAt) {
    throw new ValidationError('This assignment was already declined');
  }
  if (assignment.acceptedAt) {
    throw new ValidationError('This assignment was already accepted');
  }

  const updated = await prisma.vendorAssignment.update({
    where: { id: assignmentId },
    data: { acceptedAt: new Date() },
  });

  await recordVendorEvent({
    vendorId,
    eventType: 'ACCEPTED',
    metadata: { assignmentId, requestId: assignment.requestId },
    tenantId,
    actorId: userId,
  });

  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'VendorAssignment',
    entityId: assignmentId,
    tenantId,
    metadata: { vendorId, requestId: assignment.requestId, accepted: true },
  });

  return updated;
}

/**
 * Vendor declines an assignment. A reason is mandatory so the
 * buyer understands why and can reassign; the decline is recorded
 * on the assignment and in the vendor event trail.
 */
export async function declineAssignment(
  assignmentId: string,
  tenantId: string,
  userId: string,
  reason: string
) {
  const { vendorId } = await resolveVendorIdentity(userId, tenantId);

  const assignment = await prisma.vendorAssignment.findFirst({
    where: { id: assignmentId, tenantId },
  });
  if (!assignment) throw new NotFoundError('VendorAssignment');
  if (assignment.vendorId !== vendorId) {
    throw new ForbiddenError('Access denied: this assignment belongs to another vendor');
  }
  if (assignment.acceptedAt) {
    throw new ValidationError('Cannot decline an assignment that was already accepted');
  }
  if (assignment.declinedAt) {
    throw new ValidationError('This assignment was already declined');
  }

  const updated = await prisma.vendorAssignment.update({
    where: { id: assignmentId },
    data: { declinedAt: new Date(), declineReason: reason },
  });

  await recordVendorEvent({
    vendorId,
    eventType: 'DECLINED',
    metadata: { assignmentId, requestId: assignment.requestId, reason },
    tenantId,
    actorId: userId,
  });

  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'VendorAssignment',
    entityId: assignmentId,
    tenantId,
    metadata: { vendorId, requestId: assignment.requestId, declined: true, reason },
  });

  return updated;
}

async function assertVendorExists(vendorId: string, tenantId: string): Promise<void> {
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId } });
  if (!vendor) throw new NotFoundError('Vendor');
}
