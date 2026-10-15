import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createCategory,
  getCategory,
  listCategories,
  updateCategory,
  deleteCategory,
  CreateCategoryInput,
  UpdateCategoryInput,
} from './category.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';

const createCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100),
    description: z.string().optional(),
  }),
});

const updateCategorySchema = z.object({
  params: z.object({ categoryId: idSchema }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
  }),
});

const categoryIdSchema = z.object({
  params: z.object({ categoryId: idSchema }),
});

export const createCategoryHandler = [
  validate(createCategorySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: CreateCategoryInput = req.body;
    const category = await createCategory(input, req.user!.userId, req.user!.tenantId);
    res.status(201).json({ success: true, data: category });
  },
];

export const getCategoryHandler = [
  validate(categoryIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const category = await getCategory(req.params.categoryId, req.user!.tenantId);
    res.json({ success: true, data: category });
  },
];

export const listCategoriesHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const categories = await listCategories(req.user!.tenantId);
  res.json({ success: true, data: categories });
};

export const updateCategoryHandler = [
  validate(updateCategorySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: UpdateCategoryInput = req.body;
    const category = await updateCategory(req.params.categoryId, req.user!.tenantId, input, req.user!.userId);
    res.json({ success: true, data: category });
  },
];

export const deleteCategoryHandler = [
  validate(categoryIdSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await deleteCategory(req.params.categoryId, req.user!.tenantId, req.user!.userId);
    res.json({ success: true, message: 'Category deleted' });
  },
];