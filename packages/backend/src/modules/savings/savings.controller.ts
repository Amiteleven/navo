import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createSavingsRecord,
  getSavingsRecord,
  listSavingsRecords,
  updateSavingsRecord,
  getSavingsSummary,
  getTopSavingsVendors,
  CreateSavingsRecordInput,
  UpdateSavingsRecordInput,
} from './savings.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { SavingsType, UserRole } from '@navo/shared';

const createSavingsRecordSchema = z.object({
  body: z.object({
    dealId: z.string().min(1, 'Deal ID is required'),
    type: z.nativeEnum(SavingsType),
    baselineAmount: z.number().positive('Baseline amount must be positive'),
    baselineSource: z.string().min(1, 'Baseline source is required'),
    baselinePeriodStart: z.coerce.date().optional(),
    baselinePeriodEnd: z.coerce.date().optional(),
    calculationMethod: z.string().min(1, 'Calculation method is required'),
    evidence: z.record(z.unknown()).optional(),
  }),
});

const updateSavingsRecordSchema = z.object({
  body: z.object({
    type: z.nativeEnum(SavingsType).optional(),
    verifiedAt: z.coerce.date().optional(),
    verifiedBy: z.string().optional(),
    evidence: z.record(z.unknown()).optional(),
  }),
});

const listSavingsRecordsSchema = z.object({
  query: z.object({
    type: z.nativeEnum(SavingsType).optional(),
    dealId: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
    vendorId: z.string().min(1).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

const savingsRecordIdSchema = z.object({
  params: z.object({ savingsRecordId: z.string().min(1, 'Savings record ID is required') }),
});

export const createSavingsRecordHandler = [
  validate(createSavingsRecordSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateSavingsRecordInput = req.body;
    const record = await createSavingsRecord(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: record });
  },
];

export const getSavingsRecordHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { savingsRecordId } = req.params;
  const record = await getSavingsRecord(savingsRecordId, req.user!.tenantId);
  res.json({ success: true, data: record });
};

export const listSavingsRecordsHandler = [
  validate(listSavingsRecordsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { type, dealId, requestId, vendorId, page, limit } = req.query;
    const filters: Record<string, unknown> = {};
    if (type) filters.type = type;
    if (dealId) filters.dealId = dealId;
    if (requestId) filters.requestId = requestId;
    if (vendorId) filters.vendorId = vendorId;
    if (page) filters.page = parseInt(page as string, 10);
    if (limit) filters.limit = parseInt(limit as string, 10);

    const result = await listSavingsRecords(
      req.user!.tenantId,
      req.user!.userId,
      req.user!.role,
      filters
    );
    res.json({ success: true, data: result });
  },
];

export const updateSavingsRecordHandler = [
  validate(savingsRecordIdSchema),
  validate(updateSavingsRecordSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { savingsRecordId } = req.params;
    const input: UpdateSavingsRecordInput = req.body;
    const record = await updateSavingsRecord(savingsRecordId, input, req.user!.userId, req.user!.tenantId);
    res.json({ success: true, data: record });
  },
];

export const getSavingsSummaryHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const summary = await getSavingsSummary(req.user!.tenantId, req.user!.userId, req.user!.role);
  res.json({ success: true, data: summary });
};

export const getTopSavingsVendorsHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { limit } = req.query;
  const vendors = await getTopSavingsVendors(
    req.user!.tenantId,
    req.user!.userId,
    req.user!.role,
    limit ? parseInt(limit as string, 10) : 5
  );
  res.json({ success: true, data: vendors });
};