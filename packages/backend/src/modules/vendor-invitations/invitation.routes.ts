import { Router } from '../../utils/router';
import {
  createInvitationHandler,
  getInvitationByTokenHandler,
  acceptInvitationHandler,
  revokeInvitationHandler,
  listInvitationsHandler,
  cleanupExpiredInvitationsHandler,
} from './invitation.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.use(authenticate);

router.post('/', createInvitationHandler);
router.get('/', listInvitationsHandler);
router.post('/cleanup-expired', cleanupExpiredInvitationsHandler);
router.get('/token/:token', getInvitationByTokenHandler);
router.post('/accept', acceptInvitationHandler);
router.patch('/:invitationId/revoke', revokeInvitationHandler);

export default router;