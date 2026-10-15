import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  submitQuote,
  getQuote,
  listQuotes,
  updateQuote,
  reviewQuote,
  createComparison,
  getComparison,
  getRFQComparison,
  SubmitQuoteInput,
  UpdateQuoteInput,
} from './quote.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { QuoteStatus } from '@navo/shared';

const submitQuoteSchema = z.object({
  body: z.object({
    rfqId: idSchema,
    vendorId: idSchema,
    unitPrice: z.number().positive(),
    quantity: z.number().int().positive(),
    taxRate: z.number().min(0).max(100).default(0),
    freightAmount: z.number().min(0).default(0),
    installationAmount: z.number().min(0).default(0),
    warrantyMonths: z.number().int().positive().optional(),
    deliveryTimelineDays: z.number().int().positive().optional(),
    paymentTerms: z.string().optional(),
    validityDays: z.number().int().positive().optional(),
    otherCharges: z.number().min(0).default(0),
    otherChargesDetails: z.string().optional(),
    attachments: z.array(z.string().url()).default([]),
  }),
});

const quoteIdSchema = z.object({
  params: z.object({ quoteId: z.string().min(1, 'Invalid quote ID') }),
});

const rfqIdSchema = z.object({
  params: z.object({ rfqId: z.string().min(1, 'Invalid RFQ ID') }),
});

const listQuotesSchema = z.object({
  query: z.object({
    rfqId: idSchema.optional(),
    vendorId: idSchema.optional(),
    status: z.nativeEnum(QuoteStatus).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  }),
});

const updateQuoteSchema = z.object({
  params: z.object({ quoteId: idSchema }),
  body: z.object({
    unitPrice: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    taxRate: z.number().min(0).max(100).optional(),
    freightAmount: z.number().min(0).optional(),
    installationAmount: z.number().min(0).optional(),
    warrantyMonths: z.number().int().positive().optional(),
    deliveryTimelineDays: z.number().int().positive().optional(),
    paymentTerms: z.string().optional(),
    validityDays: z.number().int().positive().optional(),
    otherCharges: z.number().min(0).optional(),
    otherChargesDetails: z.string().optional(),
    attachments: z.array(z.string().url()).optional(),
  }),
});

export const submitQuoteHandler = [
  validate(submitQuoteSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: SubmitQuoteInput = req.body;
    const quote = await submitQuote(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: quote });
  },
];

export const getQuoteHandler = [
  validate(quoteIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const quote = await getQuote(req.params.quoteId, req.user!.tenantId);
    res.json({ success: true, data: quote });
  },
];

export const listQuotesHandler = [
  validate(listQuotesSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await listQuotes(req.user!.tenantId, req.query as Record<string, string>);
    res.json({ success: true, data: result });
  },
];

export const updateQuoteHandler = [
  validate(updateQuoteSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: UpdateQuoteInput = req.body;
    const quote = await updateQuote(req.params.quoteId, req.user!.tenantId, input, req.user!.userId);
    res.json({ success: true, data: quote });
  },
];

export const reviewQuoteHandler = [
  validate(quoteIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const quote = await reviewQuote(req.params.quoteId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: quote });
  },
];

export const createComparisonHandler = [
  validate(quoteIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const comparison = await createComparison(req.params.quoteId, req.user!.tenantId, req.user!.userId);
    res.status(201).json({ success: true, data: comparison });
  },
];

export const getComparisonHandler = [
  validate(quoteIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const comparison = await getComparison(req.params.quoteId, req.user!.tenantId);
    res.json({ success: true, data: comparison });
  },
];

export const getRFQComparisonHandler = [
  validate(rfqIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const quotes = await getRFQComparison(req.params.rfqId, req.user!.tenantId);
    res.json({ success: true, data: quotes });
  },
];