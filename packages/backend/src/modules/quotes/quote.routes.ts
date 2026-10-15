import { Router } from '../../utils/router';
import {
  submitQuoteHandler,
  getQuoteHandler,
  listQuotesHandler,
  updateQuoteHandler,
  reviewQuoteHandler,
  createComparisonHandler,
  getComparisonHandler,
  getRFQComparisonHandler,
} from './quote.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.post('/', authenticate, submitQuoteHandler);
router.get('/', authenticate, listQuotesHandler);
router.get('/rfq/:rfqId/comparison', authenticate, getRFQComparisonHandler);
router.get('/:quoteId', authenticate, getQuoteHandler);
router.get('/:quoteId/comparison', authenticate, getComparisonHandler);
router.patch('/:quoteId', authenticate, updateQuoteHandler);
router.post('/:quoteId/review', authenticate, reviewQuoteHandler);
router.post('/:quoteId/comparison', authenticate, createComparisonHandler);

export default router;