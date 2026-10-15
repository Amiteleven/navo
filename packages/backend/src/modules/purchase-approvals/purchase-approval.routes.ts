import { Router } from '../../utils/router.js';
import { authenticate } from '../../middleware/auth.js';
import {
  cancelHandler,
  confirmHandler,
  decideHandler,
  deleteRuleHandler,
  getHandler,
  getPolicyHandler,
  listHandler,
  overviewHandler,
  previewRouteHandler,
  reassignHandler,
  requestHistoryHandler,
  submitHandler,
  upsertPolicyHandler,
  upsertRuleHandler,
} from './purchase-approval.controller.js';

/**
 * Manager approval and purchase authorization.
 *
 * Mounted at `/api/purchase-approvals`, behind the global `authenticate`
 * middleware, so every route here starts from a verified session. Authorization
 * is enforced per action inside the services: hiding an action in the UI is a
 * convenience, not a control.
 *
 * Static paths are declared before `/:approvalId` so `policy`, `inbox` and
 * `overview` are not read as an approval id.
 */
const router = Router();

/** Configuration. Reading the policy is any buyer; writing it is admin-only. */
router.get('/policy', authenticate, getPolicyHandler);
router.put('/policy', authenticate, upsertPolicyHandler);
router.put('/rules/:ruleId', authenticate, upsertRuleHandler);
router.delete('/rules/:ruleId', authenticate, deleteRuleHandler);

/** The approver's inbox, and the buyer's own submitted requests. */
router.get('/', authenticate, listHandler);

/** What will happen if this offer is submitted, before it is submitted. */
router.get('/preview/:offerId', authenticate, previewRouteHandler);

/** Administrative overview, computed from stored rows. */
router.get('/overview', authenticate, overviewHandler);

/** Approval history attached to a requirement. */
router.get('/request/:requestId/history', authenticate, requestHistoryHandler);

/** Submitting a negotiated offer for authorization. */
router.post('/submit', authenticate, submitHandler);

router.get('/:approvalId', authenticate, getHandler);
router.post('/:approvalId/cancel', authenticate, cancelHandler);
router.post('/:approvalId/confirm', authenticate, confirmHandler);

router.post('/decisions/:decisionId/decide', authenticate, decideHandler);
router.post('/decisions/:decisionId/reassign', authenticate, reassignHandler);

export default router;
