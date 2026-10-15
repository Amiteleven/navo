import { Prisma } from '@prisma/client';

export interface RecordVendorEventParams {
  vendorId: string;
  eventType: string;
  metadata?: Record<string, unknown>;
  tenantId: string;
  actorId?: string;
}

export async function recordVendorEvent(params: RecordVendorEventParams) {
  const { vendorId, eventType, metadata, tenantId, actorId } = params;
  const { prisma } = await import('../../utils/prisma.js');
  return prisma.vendorEvent.create({
    data: {
      vendorId,
      eventType,
      description: metadata?.description as string || eventType,
      metadata: metadata as unknown as Prisma.InputJsonValue,
      tenantId,
      actorId,
    },
  });
}

export async function getVendorEvents(
  vendorId: string,
  tenantId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const { prisma } = await import('../../utils/prisma.js');
  const { NotFoundError } = await import('../../utils/errors.js');

  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, tenantId },
    select: { id: true },
  });
  if (!vendor) throw new NotFoundError('Vendor');

  const limit = opts.limit ?? 50;
  const skip = opts.offset ?? 0;

  return prisma.vendorEvent.findMany({
    where: { vendorId, tenantId },
    include: { actor: { select: { id: true, firstName: true, lastName: true, role: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip,
  });
}

export async function getAllVendorEvents(
  tenantId: string,
  opts: {
    vendorId?: string;
    eventType?: string;
    actorId?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  const { prisma } = await import('../../utils/prisma.js');

  const where: Record<string, unknown> = { tenantId };
  if (opts.vendorId) where.vendorId = opts.vendorId;
  if (opts.eventType) where.eventType = opts.eventType;
  if (opts.actorId) where.actorId = opts.actorId;

  const limit = opts.limit ?? 50;
  const skip = opts.offset ?? 0;

  const [events, total] = await Promise.all([
    prisma.vendorEvent.findMany({
      where,
      include: {
        vendor: { select: { id: true, name: true } },
        actor: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip,
    }),
    prisma.vendorEvent.count({ where }),
  ]);

  return { data: events, total, limit, skip };
}
