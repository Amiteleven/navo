import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, InvitationStatus, UserRole } from '@navo/shared';
import crypto from 'crypto';

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

export async function createInvitation(
  input: CreateInvitationInput,
  invitedById: string,
  tenantId: string
) {
  const existing = await prisma.vendorInvitation.findFirst({
    where: { email: input.email.toLowerCase(), tenantId, status: InvitationStatus.PENDING },
  });

  if (existing) {
    throw new ValidationError('A pending invitation already exists for this email');
  }

  const existingVendor = await prisma.vendor.findFirst({
    where: { email: input.email.toLowerCase(), tenantId },
  });

  if (existingVendor) {
    throw new ValidationError('A vendor with this email already exists');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (input.expiresInDays || 7));

  const invitation = await prisma.vendorInvitation.create({
    data: {
      email: input.email.toLowerCase(),
      token,
      invitedById,
      role: input.role,
      expiresAt,
      tenantId,
      status: InvitationStatus.PENDING,
    },
    include: {
      invitedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  await createAuditLog({
    userId: invitedById,
    action: AuditAction.VENDOR_INVITED,
    entityType: 'VendorInvitation',
    entityId: invitation.id,
    tenantId,
    metadata: { email: input.email, role: input.role },
  });

  return invitation;
}

export async function getInvitationByToken(token: string) {
  const invitation = await prisma.vendorInvitation.findUnique({
    where: { token },
    include: {
      invitedBy: { select: { id: true, firstName: true, lastName: true, email: true, tenantId: true } },
      vendor: { select: { id: true, name: true, email: true } },
      tenant: { select: { id: true, name: true, slug: true } },
    },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation');
  }

  return invitation;
}

export async function acceptInvitation(
  token: string,
  vendorData: AcceptInvitationInput['vendorData']
) {
  const invitation = await getInvitationByToken(token);

  if (invitation.status !== InvitationStatus.PENDING) {
    throw new ValidationError(`Invitation is ${invitation.status.toLowerCase()}`);
  }

  if (invitation.expiresAt < new Date()) {
    await prisma.vendorInvitation.update({
      where: { id: invitation.id },
      data: { status: InvitationStatus.EXPIRED },
    });
    throw new ValidationError('Invitation has expired');
  }

  let vendor = invitation.vendorId
    ? await prisma.vendor.findUnique({ where: { id: invitation.vendorId } })
    : null;

  if (!vendor && vendorData) {
    vendor = await prisma.vendor.create({
      data: {
        ...vendorData,
        email: invitation.email,
        tenantId: invitation.tenantId,
        status: 'ACTIVE',
        verificationStatus: 'PENDING',
        invitedById: invitation.invitedById,
        invitedAt: new Date(),
        invitationToken: invitation.token,
      },
    });

    await prisma.vendorInvitation.update({
      where: { id: invitation.id },
      data: { vendorId: vendor.id, status: InvitationStatus.ACCEPTED, acceptedAt: new Date() },
    });

    await prisma.vendorAvailability.create({
      data: { vendorId: vendor.id, tenantId: invitation.tenantId, isOnline: true, isBusy: false },
    });

    for (let i = 0; i < 7; i++) {
      await prisma.vendorWorkingHours.create({
        data: {
          vendorId: vendor.id,
          dayOfWeek: i,
          openTime: '09:00',
          closeTime: '18:00',
          isClosed: i === 0 || i === 6,
          timeZone: 'Asia/Kolkata',
          tenantId: invitation.tenantId,
        },
      });
    }
  } else if (!vendor) {
    throw new ValidationError('Vendor data is required to accept invitation');
  } else {
    await prisma.vendorInvitation.update({
      where: { id: invitation.id },
      data: { status: InvitationStatus.ACCEPTED, acceptedAt: new Date() },
    });
  }

  await createAuditLog({
    userId: invitation.invitedById,
    action: AuditAction.VENDOR_INVITED,
    entityType: 'VendorInvitation',
    entityId: invitation.id,
    tenantId: invitation.tenantId,
    metadata: { email: invitation.email, accepted: true },
  });

  return { invitation: { ...invitation, status: InvitationStatus.ACCEPTED }, vendor };
}

export async function revokeInvitation(invitationId: string, tenantId: string, userId: string) {
  const invitation = await prisma.vendorInvitation.findFirst({
    where: { id: invitationId, tenantId },
  });

  if (!invitation) {
    throw new NotFoundError('Invitation');
  }

  if (invitation.invitedById !== userId) {
    throw new ForbiddenError('Only the inviter can revoke this invitation');
  }

  if (invitation.status !== InvitationStatus.PENDING) {
    throw new ValidationError('Only pending invitations can be revoked');
  }

  const updated = await prisma.vendorInvitation.update({
    where: { id: invitationId },
    data: { status: InvitationStatus.REVOKED },
  });

  await createAuditLog({
    userId,
    action: AuditAction.VENDOR_INVITED,
    entityType: 'VendorInvitation',
    entityId: invitationId,
    tenantId,
    metadata: { revoked: true },
  });

  return updated;
}

export async function listInvitations(
  tenantId: string,
  userId: string,
  role: UserRole,
  filters: {
    status?: InvitationStatus;
    page?: number;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };

  if (filters.status) where.status = filters.status;

  if (role !== UserRole.PLATFORM_ADMIN && role !== UserRole.COMPANY_ADMIN) {
    where.invitedById = userId;
  }

  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const [invitations, total] = await Promise.all([
    prisma.vendorInvitation.findMany({
      where,
      include: {
        invitedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        vendor: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.vendorInvitation.count({ where }),
  ]);

  return { data: invitations, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function cleanupExpiredInvitations(tenantId: string) {
  const result = await prisma.vendorInvitation.updateMany({
    where: {
      tenantId,
      status: InvitationStatus.PENDING,
      expiresAt: { lt: new Date() },
    },
    data: { status: InvitationStatus.EXPIRED },
  });

  return result.count;
}