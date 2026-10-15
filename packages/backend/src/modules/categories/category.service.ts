import prisma from '../../utils/prisma';
import { NotFoundError, ConflictError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction } from '@navo/shared';
import { Prisma } from '@prisma/client';

export interface CreateCategoryInput {
  name: string;
  description?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  description?: string;
}

export async function createCategory(input: CreateCategoryInput, userId: string, tenantId: string) {
  const existing = await prisma.category.findFirst({
    where: { name: input.name, tenantId },
  });
  
  if (existing) {
    throw new ConflictError('Category with this name already exists');
  }
  
  const category = await prisma.category.create({
    data: {
      ...input,
      tenantId,
    },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.CREATED,
    entityType: 'Category',
    entityId: category.id,
    tenantId,
    metadata: input as unknown as Prisma.InputJsonValue,
  });
  
  return category;
}

export async function getCategory(categoryId: string, tenantId: string) {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, tenantId },
  });
  
  if (!category) {
    throw new NotFoundError('Category');
  }
  
  return category;
}

export async function listCategories(tenantId: string) {
  return prisma.category.findMany({
    where: { tenantId },
    orderBy: { name: 'asc' },
  });
}

export async function updateCategory(categoryId: string, tenantId: string, input: UpdateCategoryInput, userId: string) {
  const existing = await prisma.category.findFirst({
    where: { id: categoryId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Category');
  }
  
  if (input.name && input.name !== existing.name) {
    const duplicate = await prisma.category.findFirst({
      where: { name: input.name, tenantId, NOT: { id: categoryId } },
    });
    if (duplicate) {
      throw new ConflictError('Category with this name already exists');
    }
  }
  
  const updated = await prisma.category.update({
    where: { id: categoryId },
    data: input,
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'Category',
    entityId: categoryId,
    tenantId,
    metadata: input as Prisma.InputJsonValue,
  });
  
  return updated;
}

export async function deleteCategory(categoryId: string, tenantId: string, userId: string) {
  const existing = await prisma.category.findFirst({
    where: { id: categoryId, tenantId },
  });
  
  if (!existing) {
    throw new NotFoundError('Category');
  }
  
  // Check if category is in use
  const inUse = await prisma.procurementRequest.findFirst({
    where: { categoryId },
  });
  
  if (inUse) {
    throw new ConflictError('Category is in use by procurement requests');
  }
  
  await prisma.category.delete({ where: { id: categoryId } });
  
  await createAuditLog({
    userId,
    action: AuditAction.DELETED,
    entityType: 'Category',
    entityId: categoryId,
    tenantId,
    metadata: { name: existing.name },
  });
}