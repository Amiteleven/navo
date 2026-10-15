import { Router } from '../../utils/router';
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  profileHandler,
  changePasswordHandler,
  logoutHandler,
} from './auth.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.post('/register', ...registerHandler);
router.post('/login', ...loginHandler);
router.post('/refresh', refreshHandler);
router.post('/logout', authenticate, logoutHandler);
router.get('/profile', authenticate, profileHandler);
router.post('/change-password', authenticate, changePasswordHandler);

export default router;