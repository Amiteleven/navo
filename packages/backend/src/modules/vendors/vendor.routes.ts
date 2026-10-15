import { Router } from '../../utils/router';
import {
  createVendorHandler,
  getVendorHandler,
  listVendorsHandler,
  updateVendorHandler,
  deleteVendorHandler,
  getVendorsByCategoryHandler,
  searchVendorsHandler,
} from './vendor.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.post('/', authenticate, createVendorHandler);
router.get('/', authenticate, listVendorsHandler);
router.get('/search', authenticate, searchVendorsHandler);
router.get('/category/:categoryId', authenticate, getVendorsByCategoryHandler);
router.get('/:vendorId', authenticate, getVendorHandler);
router.patch('/:vendorId', authenticate, updateVendorHandler);
router.delete('/:vendorId', authenticate, deleteVendorHandler);

export default router;