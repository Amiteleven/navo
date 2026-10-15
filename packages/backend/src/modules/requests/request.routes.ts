import { Router } from '../../utils/router';
import {
  createRequestHandler,
  getRequestHandler,
  listRequestsHandler,
  updateRequestHandler,
  submitRequestHandler,
  extractRequirementsHandler,
  updateRequestStatusHandler,
  deleteRequestHandler,
  getRequestStatsHandler,
} from './request.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.get('/stats', authenticate, getRequestStatsHandler);
router.post('/', authenticate, createRequestHandler);
router.get('/', authenticate, listRequestsHandler);
router.get('/:requestId', authenticate, getRequestHandler);
router.patch('/:requestId', authenticate, updateRequestHandler);
router.post('/:requestId/submit', authenticate, submitRequestHandler);
router.post('/:requestId/extract', authenticate, extractRequirementsHandler);
router.patch('/:requestId/status', authenticate, updateRequestStatusHandler);
router.delete('/:requestId', authenticate, deleteRequestHandler);

export default router;