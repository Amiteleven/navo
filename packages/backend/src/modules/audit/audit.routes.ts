import { Router } from '../../utils/router';
import { getAuditLogsHandler } from './audit.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.get('/', authenticate, getAuditLogsHandler);

export default router;