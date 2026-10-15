import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createTenant,
  getTenant,
  updateTenant,
  listTenants,
  getTenantStats,
  CreateTenantInput,
  UpdateTenantInput,
} from './tenant.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { UserRole } from '@navo/shared';

const createTenantSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required'),
    slug: z.string().min(2, 'Slug must be at least 2 characters').regex(/^[a-z0-9-]+$/),
    domain: z.string().optional(),
  }),
});

const updateTenantSchema = z.object({
  params: z.object({ tenantId: idSchema }),
  body: z.object({
    name: z.string().optional(),
    domain: z.string().optional(),
    logo: z.string().optional(),
    settings: z.record(z.unknown()).optional(),
    isActive: z.boolean().optional(),
  }),
});

const getTenantSchema = z.object({
  params: z.object({ tenantId: idSchema }),
});

export const createTenantHandler = [
  validate(createTenantSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateTenantInput = req.body;
    const result = await createTenant(input, req.user!.userId);
    res.status(201).json({ success: true, data: result });
  },
];

export const getTenantHandler = [
  validate(getTenantSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenant = await getTenant(req.params.tenantId);
    res.json({ success: true, data: tenant });
  },
];

export const updateTenantHandler = [
  validate(updateTenantSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: UpdateTenantInput = req.body;
    const tenant = await updateTenant(req.params.tenantId, input, req.user!.userId);
    res.json({ success: true, data: tenant });
  },
];

export const listTenantsHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (req.user!.role !== UserRole.PLATFORM_ADMIN) {
    res.status(403).json({ success: false, error: 'Unauthorized' });
    return;
  }
  
  const tenants = await listTenants(req.user!.userId, req.user!.role);
  res.json({ success: true, data: tenants });
};

export const getCurrentTenantHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const tenant = await getTenant(req.user!.tenantId);
  res.json({ success: true, data: tenant });
};

export const getTenantStatsHandler = [
  validate(getTenantSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const stats = await getTenantStats(req.params.tenantId);
    res.json({ success: true, data: stats });
  },
];