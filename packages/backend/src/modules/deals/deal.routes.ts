import { Router } from '../../utils/router';
import {
  createConnectionHandler,
  getConnectionHandler,
  listConnectionsHandler,
  respondToConnectionHandler,
  createOfferHandler,
  getDealRoomHandler,
  getMessagesHandler,
  addMessageHandler,
  acceptOfferHandler,
  updateDealStatusHandler,
  getDealHandler,
  listDealsHandler,
  getVendorAvailabilityHandler,
  updateVendorAvailabilityHandler,
  getOnlineVendorsHandler,
  calculateOfferTotalHandler,
} from './deal.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Connections
router.post('/connections', createConnectionHandler);
router.get('/connections', listConnectionsHandler);
router.get('/connections/:connectionId', getConnectionHandler);
router.post('/connections/:connectionId/respond', respondToConnectionHandler);

// Deal Rooms
router.get('/deal-rooms/:dealRoomId', getDealRoomHandler);
router.get('/deal-rooms/:dealRoomId/messages', getMessagesHandler);
router.post('/deal-rooms/:dealRoomId/messages', addMessageHandler);

// Offers
router.post('/offers', createOfferHandler);
router.post('/offers/accept', acceptOfferHandler);

// Deals
router.get('/deals', listDealsHandler);
router.get('/deals/:dealId', getDealHandler);
router.patch('/deals/:dealId/status', updateDealStatusHandler);

// Vendor Availability
router.get('/vendors/:vendorId/availability', getVendorAvailabilityHandler);
router.patch('/vendors/:vendorId/availability', updateVendorAvailabilityHandler);
router.get('/vendors/online', getOnlineVendorsHandler);

// Utilities
router.get('/offers/calculate-total', calculateOfferTotalHandler);

export default router;