import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import prisma from '../../utils/prisma';
import {
  createInvitation,
  getInvitationByToken,
  acceptInvitation,
  revokeInvitation,
  listInvitations,
  CreateInvitationInput,
  AcceptInvitationInput,
} from './invitation.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { InvitationStatus, UserRole } from '@navo/shared';

const createInvitationSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.string().optional(),
  expiresInDays: z.number().int().positive().max(30).optional(),
});

const acceptInvitationSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  vendorData: z.object({
    name: z.string().min(1, 'Vendor name is required'),
    contactPerson: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    postalCode: z.string().optional(),
    products: z.string().optional(),
    gstin: z.string().optional(),
  }).optional(),
});

const revokeInvitationSchema = z.object({
  params: z.object({ invitationId: idSchema }),
});

const listInvitationsSchema = z.object({
  query: z.object({
    status: z.nativeEnum(InvitationStatus).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

export const createInvitationHandler = [
  validate(createInvitationSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateInvitationInput = req.body;
    const invitation = await createInvitation(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: invitation });
  },
];

export const getInvitationByTokenHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { token } = req.params;
  const invitation = await getInvitationByToken(token);
  res.json({ success: true, data: invitation });
};

export const acceptInvitationHandler = [
  validate(acceptInvitationSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { token, vendorData } = req.body;
    const result = await acceptInvitation(token, vendorData);
    res.json({ success: true, data: result });
  },
];

export const revokeInvitationHandler = [
  validate(revokeInvitationSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { invitationId } = req.params;
    const invitation = await revokeInvitation(invitationId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: invitation });
  },
];

export const listInvitationsHandler = [
  validate(listInvitationsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { status, page, limit } = req.query;
    const filters: Record<string, unknown> = {};
    if (status) filters.status = status;
    if (page) filters.page = parseInt(page as string, 10);
    if (limit) filters.limit = parseInt(limit as string, 10);

    const result = await listInvitations(
      req.user!.tenantId,
      req.user!.userId,
      req.user!.role as UserRole,
      filters
    );
    res.json({ success: true, data: result });
  },
];

export const cleanupExpiredInvitationsHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const count = await prisma.vendorInvitation.updateMany({
    where: {
      tenantId: req.user!.tenantId,
      status: 'PENDING',
      expiresAt: { lt: new Date() },
    },
    data: { status: 'EXPIRED' },
  });
  res.json({ success: true, data: { updated: count } });
};