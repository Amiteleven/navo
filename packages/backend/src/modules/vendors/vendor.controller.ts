import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createVendor,
  getVendor,
  listVendors,
  updateVendor,
  deleteVendor,
  getVendorsByCategory,
  searchVendors,
  CreateVendorInput,
  UpdateVendorInput,
} from './vendor.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { VendorStatus } from '@navo/shared';

const createVendorSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required'),
    categoryId: idSchema.optional(),
    contactPerson: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    phone: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    postalCode: z.string().optional(),
    products: z.string().optional(),
    notes: z.string().optional(),
  }),
});

const updateVendorSchema = z.object({
  params: z.object({ vendorId: idSchema }),
  body: z.object({
    name: z.string().min(1).optional(),
    categoryId: idSchema.optional(),
    contactPerson: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    phone: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    postalCode: z.string().optional(),
    products: z.string().optional(),
    status: z.nativeEnum(VendorStatus).optional(),
    notes: z.string().optional(),
  }),
});

const vendorIdSchema = z.object({
  params: z.object({ vendorId: idSchema }),
});

const listVendorsSchema = z.object({
  query: z.object({
    status: z.nativeEnum(VendorStatus).optional(),
    categoryId: idSchema.optional(),
    search: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

const searchVendorsSchema = z.object({
  query: z.object({
    q: z.string().min(1),
  }),
});

export const createVendorHandler = [
  validate(createVendorSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateVendorInput = req.body;
    const vendor = await createVendor(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: vendor });
  },
];

export const getVendorHandler = [
  validate(vendorIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const vendor = await getVendor(req.params.vendorId, req.user!.tenantId);
    res.json({ success: true, data: vendor });
  },
];

export const listVendorsHandler = [
  validate(listVendorsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await listVendors(req.user!.tenantId, req.query as Record<string, string>);
    res.json({ success: true, data: result });
  },
];

export const updateVendorHandler = [
  validate(updateVendorSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: UpdateVendorInput = req.body;
    const vendor = await updateVendor(req.params.vendorId, req.user!.tenantId, input, req.user!.userId);
    res.json({ success: true, data: vendor });
  },
];

export const deleteVendorHandler = [
  validate(vendorIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await deleteVendor(req.params.vendorId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, message: 'Vendor deleted' });
  },
];

export const getVendorsByCategoryHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { categoryId } = req.params;
  const vendors = await getVendorsByCategory(req.user!.tenantId, categoryId);
  res.json({ success: true, data: vendors });
};

export const searchVendorsHandler = [
  validate(searchVendorsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const vendors = await searchVendors(req.user!.tenantId, req.query.q as string);
    res.json({ success: true, data: vendors });
  },
];