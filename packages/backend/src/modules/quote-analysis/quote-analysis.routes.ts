import { Router } from '../../utils/router';
import {
  analyzeQuoteHandler,
  getQuoteAnalysisHandler,
  getQuoteAnalysesHandler,
  compareQuotesHandler,
} from './quote-analysis.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.use(authenticate);

router.post('/quotes/:quoteId/analyze', analyzeQuoteHandler);
router.get('/quotes/:quoteId/analysis', getQuoteAnalysisHandler);
router.get('/quotes/:quoteId/analyses', getQuoteAnalysesHandler);
router.post('/rfqs/:rfqId/compare', compareQuotesHandler);

export default router;