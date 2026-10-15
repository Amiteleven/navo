import prisma from '../../utils/prisma';
import { NotFoundError } from '../../utils/errors.js';

export interface CategoryTreeNode {
  id: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
  children: CategoryTreeNode[];
  vendorCount: number;
}

export async function getCategoryHierarchy(tenantId: string): Promise<CategoryTreeNode[]> {
  const categories = await prisma.category.findMany({
    where: { tenantId },
    select: { id: true, name: true, description: true, parentId: true },
  });

  const nodeMap = new Map<string, CategoryTreeNode>();
  const roots: CategoryTreeNode[] = [];

  for (const cat of categories) {
    nodeMap.set(cat.id, {
      id: cat.id,
      name: cat.name,
      description: cat.description,
      parentId: cat.parentId,
      children: [],
      vendorCount: 0,
    });
  }

  for (const cat of categories) {
    const node = nodeMap.get(cat.id)!;
    if (cat.parentId && nodeMap.has(cat.parentId)) {
      nodeMap.get(cat.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const vendorCounts = await prisma.vendor.groupBy({
    by: ['categoryId'],
    where: { tenantId },
    _count: { _all: true },
  });

  const countMap = new Map(vendorCounts.map((v) => [v.categoryId, v._count._all]));

  for (const node of nodeMap.values()) {
    const count = countMap.get(node.id);
    if (count) {
      node.vendorCount = count;
      let parent = node.parentId ? nodeMap.get(node.parentId) : undefined;
      while (parent) {
        parent.vendorCount += count;
        parent = parent.parentId ? nodeMap.get(parent.parentId) : undefined;
      }
    }
  }

  return roots;
}

export async function getCategoryTree(categoryId: string, tenantId: string): Promise<CategoryTreeNode | null> {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, tenantId },
    select: { id: true, name: true, description: true, parentId: true },
  });

  if (!category) return null;

  async function buildNode(cat: { id: string; name: string; description: string | null; parentId: string | null }): Promise<CategoryTreeNode> {
    const children = await prisma.category.findMany({
      where: { parentId: cat.id, tenantId },
      select: { id: true, name: true, description: true, parentId: true },
    });

    const childNodes: CategoryTreeNode[] = [];
    for (const child of children) {
      childNodes.push(await buildNode(child));
    }

    const vendorCount = await prisma.vendor.count({
      where: { categoryId: cat.id, tenantId },
    });

    return {
      id: cat.id,
      name: cat.name,
      description: cat.description,
      parentId: cat.parentId,
      children: childNodes,
      vendorCount,
    };
  }

  return buildNode(category);
}

export async function getCategoryPath(categoryId: string, tenantId: string): Promise<CategoryTreeNode[]> {
  const path: CategoryTreeNode[] = [];
  let currentId: string | null = categoryId;

  while (currentId) {
    const catInfo: { id: string; name: string; description: string | null; parentId: string | null } | null =
      await prisma.category.findFirst({
        where: { id: currentId, tenantId },
        select: { id: true, name: true, description: true, parentId: true },
      });

    if (!catInfo) break;

    const vendorCount = await prisma.vendor.count({
      where: { categoryId: catInfo.id, tenantId },
    });

    path.unshift({
      id: catInfo.id,
      name: catInfo.name,
      description: catInfo.description,
      parentId: catInfo.parentId,
      children: [],
      vendorCount,
    });

    currentId = catInfo.parentId;
  }

  return path;
}
