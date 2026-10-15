import { Router } from '../../utils/router';
import {
  createApprovalHandler,
  getApprovalHandler,
  listApprovalsHandler,
  decideApprovalHandler,
  generateRecommendationHandler,
  getRecommendationHandler,
} from './approval.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.post('/', authenticate, createApprovalHandler);
router.get('/', authenticate, listApprovalsHandler);
router.get('/:approvalId', authenticate, getApprovalHandler);
router.post('/:approvalId/decide', authenticate, decideApprovalHandler);
router.post('/request/:requestId/recommendation', authenticate, generateRecommendationHandler);
router.get('/request/:requestId/recommendation', authenticate, getRecommendationHandler);

export default router;