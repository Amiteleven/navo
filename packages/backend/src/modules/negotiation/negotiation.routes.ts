import { Router } from '../../utils/router';
import {
  getDealRoomHandler,
  addNegotiationMessageHandler,
  getNegotiationMessagesHandler,
  submitCounterOfferHandler,
  getDealRoomOffersHandler,
  generateNegotiationDraftHandler,
  acceptOfferHandler,
  updateNegotiationStatusHandler,
  calculateOfferTotalHandler,
  getNegotiationWorthinessHandler,
} from './negotiation.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/deal-rooms/:dealRoomId', getDealRoomHandler);
router.post('/deal-rooms/:dealRoomId/messages', addNegotiationMessageHandler);
router.get('/deal-rooms/:dealRoomId/messages', getNegotiationMessagesHandler);
router.post('/deal-rooms/:dealRoomId/offers', submitCounterOfferHandler);
router.get('/deal-rooms/:dealRoomId/offers', getDealRoomOffersHandler);
router.post('/deal-rooms/:dealRoomId/negotiation-draft', generateNegotiationDraftHandler);
router.post('/offers/accept', acceptOfferHandler);
router.patch('/deal-rooms/:dealRoomId/status', updateNegotiationStatusHandler);
router.get('/offers/calculate-total', calculateOfferTotalHandler);
router.get('/deal-rooms/:dealRoomId/worthiness', getNegotiationWorthinessHandler);

export default router;