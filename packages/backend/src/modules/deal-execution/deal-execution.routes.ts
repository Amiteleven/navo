import { Router } from '../../utils/router.js';
import { authenticate } from '../../middleware/auth.js';
import {
  advanceExecutionHandler,
  createExecutionRecordHandler,
  getDealExecutionDetailHandler,
  listDealExecutionsHandler,
  recordExecutionEventHandler,
  selectFinalOfferHandler,
  submitForFinalApprovalHandler,
} from './deal-execution.controller.js';

/**
 * Final Approval & Deal Execution Engine.
 *
 * Mounted at `/api/deals/execution`, behind the global `authenticate` middleware.
 *
 * The routes bridge the 4-offer CommercialOfferSubmission engine to the purchase-
 * authorization pipeline, then manage the category-specific execution phase that
 * follows deal creation.
 */
const router = Router();

/** Select the winning submission from the 4-offer comparison. */
router.post('/final-offer/:submissionId/select', authenticate, selectFinalOfferHandler);

/** Submit the selected submission for final approval. */
router.post('/final-offer/:submissionId/submit', authenticate, submitForFinalApprovalHandler);

/** List deals in the execution phase. */
router.get('/', authenticate, listDealExecutionsHandler);

/** Deal execution detail (events, approval, PO link). */
router.get('/:dealId', authenticate, getDealExecutionDetailHandler);

/** Advance execution status (e.g. to Cancelled, Closed, In Progress). */
router.post('/:dealId/advance', authenticate, advanceExecutionHandler);

/** Record a discrete execution event (goods received, milestone, etc.). */
router.post('/:dealId/events', authenticate, recordExecutionEventHandler);

/** Create a category-specific execution record (PO, service start, subscription, milestone). */
router.post('/:dealId/execution-record', authenticate, createExecutionRecordHandler);

export default router;
