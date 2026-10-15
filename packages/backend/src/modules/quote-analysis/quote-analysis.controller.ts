import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  analyzeQuoteService,
  getQuoteAnalysis,
  getQuoteAnalyses,
  compareQuotes,
} from './quote-analysis.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';

const analyzeQuoteSchema = z.object({
  params: z.object({ quoteId: z.string().min(1, 'Invalid quote ID') }),
});

const compareQuotesSchema = z.object({
  params: z.object({ rfqId: z.string().min(1, 'Invalid RFQ ID') }),
});

export const analyzeQuoteHandler = [
  validate(analyzeQuoteSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { quoteId } = req.params;
    const analysis = await analyzeQuoteService(quoteId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: analysis });
  },
];

export const getQuoteAnalysisHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { quoteId } = req.params;
  const analysis = await getQuoteAnalysis(quoteId, req.user!.tenantId);
  res.json({ success: true, data: analysis });
};

export const getQuoteAnalysesHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { quoteId } = req.params;
  const analyses = await getQuoteAnalyses(quoteId, req.user!.tenantId);
  res.json({ success: true, data: analyses });
};

export const compareQuotesHandler = [
  validate(compareQuotesSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { rfqId } = req.params;
    const comparison = await compareQuotes(rfqId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, data: comparison });
  },
];