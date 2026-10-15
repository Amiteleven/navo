import { Router } from '../../utils/router';
import {
  createTenantHandler,
  getTenantHandler,
  updateTenantHandler,
  listTenantsHandler,
  getCurrentTenantHandler,
  getTenantStatsHandler,
} from './tenant.controller';
import { authenticate, requireRole } from '../../middleware/auth';
import { UserRole } from '@navo/shared';

const router = Router();

router.post('/', authenticate, requireRole(UserRole.PLATFORM_ADMIN), createTenantHandler);
router.get('/', authenticate, requireRole(UserRole.PLATFORM_ADMIN), listTenantsHandler);
router.get('/current', authenticate, getCurrentTenantHandler);
router.get('/:tenantId', authenticate, getTenantHandler);
router.get('/:tenantId/stats', authenticate, getTenantStatsHandler);
router.patch('/:tenantId', authenticate, updateTenantHandler);

export default router;