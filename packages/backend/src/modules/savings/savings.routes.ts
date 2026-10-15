import { Router } from '../../utils/router';
import {
  createSavingsRecordHandler,
  getSavingsRecordHandler,
  listSavingsRecordsHandler,
  updateSavingsRecordHandler,
  getSavingsSummaryHandler,
  getTopSavingsVendorsHandler,
} from './savings.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.use(authenticate);

router.post('/', createSavingsRecordHandler);
router.get('/', listSavingsRecordsHandler);
router.get('/summary', getSavingsSummaryHandler);
router.get('/top-vendors', getTopSavingsVendorsHandler);
router.get('/:savingsRecordId', getSavingsRecordHandler);
router.patch('/:savingsRecordId', updateSavingsRecordHandler);

export default router;