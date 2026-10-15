import { Router } from '../../utils/router';
import {
  createRFQHandler,
  getRFQHandler,
  listRFQsHandler,
  sendRFQHandler,
  closeRFQHandler,
  getRFQVendorsHandler,
} from './rfq.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.post('/', authenticate, createRFQHandler);
router.get('/', authenticate, listRFQsHandler);
router.get('/:rfqId', authenticate, getRFQHandler);
router.get('/:rfqId/vendors', authenticate, getRFQVendorsHandler);
router.post('/:rfqId/send', authenticate, sendRFQHandler);
router.post('/:rfqId/close', authenticate, closeRFQHandler);

export default router;