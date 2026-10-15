import prisma from '../../utils/prisma';
import { AuditAction } from '@navo/shared';
import { Prisma, AuditAction as PrismaAuditAction } from '@prisma/client';

export interface AuditLogInput {
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  previousStatus?: string;
  newStatus?: string;
  decision?: string;
  aiRecommendation?: string;
  metadata?: Prisma.InputJsonValue;
  tenantId: string;
}

export async function createAuditLog(input: AuditLogInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      ...input,
      // The shared and Prisma AuditAction enums declare identical literals but
      // are distinct nominal types; this is the single conversion point.
      action: input.action as unknown as PrismaAuditAction,
    },
  });
}

export async function getAuditLogs(
  tenantId: string,
  filters: {
    entityType?: string;
    entityId?: string;
    userId?: string;
    action?: AuditAction;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };
  
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.userId) where.userId = filters.userId;
  if (filters.action) where.action = filters.action;
  
  if (filters.startDate || filters.endDate) {
    where.createdAt = {};
    if (filters.startDate) (where.createdAt as Record<string, Date>).gte = filters.startDate;
    if (filters.endDate) (where.createdAt as Record<string, Date>).lte = filters.endDate;
  }
  
  const limit = filters.limit || 50;
  const page = Math.floor((filters.offset || 0) / limit) + 1;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: filters.offset || 0,
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { data: logs, total, page, limit, totalPages: Math.ceil(total / limit) };
}