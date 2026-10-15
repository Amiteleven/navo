import { Router } from '../../utils/router';
import {
  createCategoryHandler,
  getCategoryHandler,
  listCategoriesHandler,
  updateCategoryHandler,
  deleteCategoryHandler,
} from './category.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.post('/', authenticate, createCategoryHandler);
router.get('/', authenticate, listCategoriesHandler);
router.get('/:categoryId', authenticate, getCategoryHandler);
router.patch('/:categoryId', authenticate, updateCategoryHandler);
router.delete('/:categoryId', authenticate, deleteCategoryHandler);

export default router;