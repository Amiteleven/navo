import prisma from '../../utils/prisma';
import { NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction, ConnectionStatus, DealRoomStatus, DealOfferStatus, DealStatus, UserRole } from '@navo/shared';

export interface CreateConnectionInput {
  requestId: string;
  vendorId: string;
}

export interface CreateOfferInput {
  dealRoomId: string;
  unitPrice: number;
  quantity: number;
  gst?: number;
  freightAmount?: number;
  installationAmount?: number;
  warrantyMonths?: number;
  deliveryTimelineDays?: number;
  paymentTerms?: string;
  validityDays?: number;
  otherCharges?: number;
  otherChargesDetails?: string;
}

export async function createConnection(
  input: CreateConnectionInput,
  buyerId: string,
  tenantId: string
) {
  const request = await prisma.procurementRequest.findFirst({
    where: { id: input.requestId, tenantId },
    include: { connections: { where: { vendorId: input.vendorId } } },
  });

  if (!request) {
    throw new NotFoundError('Procurement Request');
  }

  if (request.requesterId !== buyerId) {
    throw new ForbiddenError('Only the requester can initiate connections');
  }

  if (request.status === 'CANCELLED' || request.status === 'COMPLETED') {
    throw new ValidationError('Cannot create connection for cancelled or completed requests');
  }

  const connectionInclude = {
    request: { include: { category: true } },
    vendor: true,
    buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
    dealRoom: true,
  };

  const existingConnection = await prisma.connection.findFirst({
    where: { requestId: input.requestId, vendorId: input.vendorId },
  });

  if (existingConnection) {
    if (existingConnection.status === ConnectionStatus.PENDING || existingConnection.status === ConnectionStatus.ACCEPTED) {
      throw new ValidationError('An active connection already exists with this vendor');
    }

    const existingRoom = await prisma.dealRoom.findUnique({
      where: { connectionId: existingConnection.id },
      select: { id: true },
    });

    await prisma.connection.update({
      where: { id: existingConnection.id },
      data: { status: ConnectionStatus.PENDING, respondedAt: null },
    });

    if (existingRoom) {
      await prisma.dealRoom.update({
        where: { id: existingRoom.id },
        data: { status: DealRoomStatus.ACTIVE },
      });
    }

    await createAuditLog({
      userId: buyerId,
      action: AuditAction.CONNECTION_CREATED,
      entityType: 'Connection',
      entityId: existingConnection.id,
      tenantId,
      metadata: { vendorId: input.vendorId, requestId: input.requestId, reopened: true },
    });

    return prisma.connection.findUniqueOrThrow({
      where: { id: existingConnection.id },
      include: connectionInclude,
    });
  }

  const connection = await prisma.connection.create({
    data: {
      requestId: input.requestId,
      buyerId,
      vendorId: input.vendorId,
      tenantId,
      status: ConnectionStatus.PENDING,
    },
    include: {
      request: { include: { category: true } },
      vendor: true,
      buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  await prisma.dealRoom.create({
    data: {
      connectionId: connection.id,
      requestId: input.requestId,
      buyerId,
      vendorId: input.vendorId,
      tenantId,
      status: DealRoomStatus.ACTIVE,
    },
  });

  await createAuditLog({
    userId: buyerId,
    action: AuditAction.CONNECTION_CREATED,
    entityType: 'Connection',
    entityId: connection.id,
    tenantId,
    metadata: { vendorId: input.vendorId, requestId: input.requestId },
  });

  return prisma.connection.findUniqueOrThrow({
    where: { id: connection.id },
    include: connectionInclude,
  });
}

export async function getConnection(connectionId: string, tenantId: string) {
  const connection = await prisma.connection.findFirst({
    where: { id: connectionId, tenantId },
    include: {
      request: { include: { category: true } },
      vendor: true,
      buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
      dealRoom: true,
    },
  });

  if (!connection) {
    throw new NotFoundError('Connection');
  }

  return connection;
}

export async function listConnections(
  tenantId: string,
  userId: string,
  role: UserRole,
  filters: {
    status?: ConnectionStatus;
    requestId?: string;
    vendorId?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };

  if (filters.status) where.status = filters.status;
  if (filters.requestId) where.requestId = filters.requestId;
  if (filters.vendorId) where.vendorId = filters.vendorId;

  // Filter by buyer for procurement managers/requesters
  if (role === UserRole.REQUESTER || role === UserRole.PROCUREMENT_MANAGER) {
    where.buyerId = userId;
  }

  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const [connections, total] = await Promise.all([
    prisma.connection.findMany({
      where,
      include: {
        request: { include: { category: true } },
        vendor: true,
        buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
        dealRoom: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.connection.count({ where }),
  ]);

  return { data: connections, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function respondToConnection(
  connectionId: string,
  vendorId: string,
  tenantId: string,
  accept: boolean
) {
  const connection = await prisma.connection.findFirst({
    where: { id: connectionId, tenantId, vendorId },
  });

  if (!connection) {
    throw new NotFoundError('Connection');
  }

  if (connection.status !== ConnectionStatus.PENDING) {
    throw new ValidationError('Connection has already been responded to');
  }

  const newStatus = accept ? ConnectionStatus.ACCEPTED : ConnectionStatus.DECLINED;

  const updated = await prisma.connection.update({
    where: { id: connectionId },
    data: {
      status: newStatus,
      respondedAt: new Date(),
    },
    include: {
      request: { include: { category: true } },
      vendor: true,
      buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
      dealRoom: true,
    },
  });

  if (accept) {
    await prisma.dealRoom.update({
      where: { connectionId },
      data: { status: DealRoomStatus.NEGOTIATING },
    });
  } else {
    await prisma.dealRoom.update({
      where: { connectionId },
      data: { status: DealRoomStatus.EXPIRED },
    });
  }

  await createAuditLog({
    userId: vendorId,
    action: accept ? AuditAction.CONNECTION_ACCEPTED : AuditAction.CONNECTION_DECLINED,
    entityType: 'Connection',
    entityId: connectionId,
    tenantId,
    metadata: { vendorId, accept },
  });

  return updated;
}

export async function createOffer(
  input: CreateOfferInput,
  submittedById: string,
  submittedByRole: string,
  tenantId: string
) {
  const dealRoom = await prisma.dealRoom.findFirst({
    where: { id: input.dealRoomId, tenantId },
    include: { connection: true },
  });

  if (!dealRoom) {
    throw new NotFoundError('Deal Room');
  }

  if (dealRoom.status !== DealRoomStatus.ACTIVE && dealRoom.status !== DealRoomStatus.NEGOTIATING) {
    throw new ValidationError('Cannot submit offer to closed or expired deal room');
  }

  const isBuyer = dealRoom.buyerId === submittedById;
  const isVendor = dealRoom.vendorId === submittedById;

  if (!isBuyer && !isVendor) {
    throw new ForbiddenError('Not authorized to submit offer in this deal room');
  }

  const existingActiveOffer = await prisma.dealOffer.findFirst({
    where: { dealRoomId: input.dealRoomId, status: DealOfferStatus.ACTIVE },
  });

  if (existingActiveOffer) {
    await prisma.dealOffer.update({
      where: { id: existingActiveOffer.id },
      data: { status: DealOfferStatus.SUPERSEDED },
    });
  }

  const offer = await prisma.dealOffer.create({
    data: {
      dealRoomId: input.dealRoomId,
      submittedById,
      submittedByRole,
      unitPrice: input.unitPrice,
      quantity: input.quantity,
      gst: input.gst || 0,
      freightAmount: input.freightAmount || 0,
      installationAmount: input.installationAmount || 0,
      warrantyMonths: input.warrantyMonths,
      deliveryTimelineDays: input.deliveryTimelineDays,
      paymentTerms: input.paymentTerms,
      validityDays: input.validityDays,
      otherCharges: input.otherCharges || 0,
      otherChargesDetails: input.otherChargesDetails,
      status: DealOfferStatus.ACTIVE,
    },
  });

  await prisma.dealRoom.update({
    where: { id: input.dealRoomId },
    data: { status: DealRoomStatus.NEGOTIATING },
  });

  await createAuditLog({
    userId: submittedById,
    action: AuditAction.OFFER_SUBMITTED,
    entityType: 'DealOffer',
    entityId: offer.id,
    tenantId,
    metadata: { dealRoomId: input.dealRoomId, unitPrice: input.unitPrice, quantity: input.quantity },
  });

  return offer;
}

export async function getDealRoom(dealRoomId: string, tenantId: string) {
  const dealRoom = await prisma.dealRoom.findFirst({
    where: { id: dealRoomId, tenantId },
    include: {
      connection: { include: { vendor: true, buyer: { select: { id: true, firstName: true, lastName: true, email: true } } } },
      request: { include: { category: true } },
      buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
      vendor: true,
      messages: { orderBy: { createdAt: 'asc' } },
      offers: { orderBy: { createdAt: 'desc' } },
      deal: true,
    },
  });

  if (!dealRoom) {
    throw new NotFoundError('Deal Room');
  }

  return dealRoom;
}

export async function getMessages(dealRoomId: string, tenantId: string) {
  return prisma.dealMessage.findMany({
    where: { dealRoomId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function addMessage(
  dealRoomId: string,
  senderId: string,
  senderRole: string,
  content: string,
  tenantId: string
) {
  const dealRoom = await prisma.dealRoom.findFirst({
    where: { id: dealRoomId, tenantId },
  });

  if (!dealRoom) {
    throw new NotFoundError('Deal Room');
  }

  // Participant authorization. This check was missing entirely: any
  // authenticated tenant member who guessed or leaked a dealRoomId could post
  // into someone else's negotiation. A seller account is also refused unless it
  // is the vendor *for this room*, so a supplier cannot reach a buyer through a
  // room they have no part in.
  const sellerVendorId = await prisma.user
    .findFirst({
      where: { id: senderId, tenantId },
      select: { vendorId: true, role: true },
    })
    .then((u) => (u?.role === 'VENDOR' ? u.vendorId : undefined));

  const isBuyer = dealRoom.buyerId === senderId;
  const isVendor = sellerVendorId != null && dealRoom.vendorId === sellerVendorId;

  if (!isBuyer && !isVendor) {
    throw new ForbiddenError('Not authorized to send messages in this deal room');
  }

  if (dealRoom.status === DealRoomStatus.CLOSED || dealRoom.status === DealRoomStatus.EXPIRED) {
    throw new ValidationError('Cannot add messages to a closed or expired deal room');
  }

  const message = await prisma.dealMessage.create({
    data: {
      dealRoomId,
      senderId,
      senderRole,
      content,
    },
  });

  return message;
}

export async function acceptOffer(
  offerId: string,
  buyerId: string,
  tenantId: string
) {
  const offer = await prisma.dealOffer.findFirst({
    where: { id: offerId },
    include: { dealRoom: { include: { connection: true } } },
  });

  if (!offer) {
    throw new NotFoundError('Offer');
  }

  if (offer.dealRoom.buyerId !== buyerId) {
    throw new ForbiddenError('Only the buyer can accept offers');
  }

  if (offer.status !== DealOfferStatus.ACTIVE) {
    throw new ValidationError('Offer is not active');
  }

  const dealNumber = `DEAL-${Date.now().toString(36).toUpperCase()}`;

  const dealResult = await prisma.$transaction(async (tx) => {
    const updatedOffer = await tx.dealOffer.update({
      where: { id: offerId },
      data: { status: DealOfferStatus.ACCEPTED },
    });

    const dealRecord = await tx.deal.create({
      data: {
        dealNumber,
        dealRoomId: offer.dealRoomId,
        requestId: offer.dealRoom.requestId,
        buyerId: offer.dealRoom.buyerId,
        vendorId: offer.dealRoom.vendorId,
        tenantId,
        status: DealStatus.ACCEPTED,
        acceptedOfferId: offerId,
      },
    });

    await tx.dealRoom.update({
      where: { id: offer.dealRoomId },
      data: { status: DealRoomStatus.CLOSED, dealId: dealRecord.id, closedAt: new Date() },
    });

    await tx.connection.update({
      where: { id: offer.dealRoom.connectionId },
      data: { status: ConnectionStatus.ACCEPTED },
    });

    return { deal: dealRecord, updatedOffer };
  });

  await createAuditLog({
    userId: buyerId,
    action: AuditAction.OFFER_ACCEPTED,
    entityType: 'DealOffer',
    entityId: offerId,
    tenantId,
    metadata: { dealNumber, offerId },
  });

  await createAuditLog({
    userId: buyerId,
    action: AuditAction.DEAL_CLOSED,
    entityType: 'Deal',
    entityId: dealResult.deal.id,
    tenantId,
    metadata: { dealNumber, offerId },
  });

  return dealResult;
  }

  export async function updateDealStatus(
  dealId: string,
  status: DealStatus,
  userId: string,
  tenantId: string
) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  const updated = await prisma.deal.update({
    where: { id: dealId },
    data: { status },
  });

  await createAuditLog({
    userId,
    action: AuditAction.STATUS_CHANGED,
    entityType: 'Deal',
    entityId: dealId,
    tenantId,
    metadata: { status },
  });

  return updated;
}

export async function getDeal(dealId: string, tenantId: string) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId },
    include: {
      dealRoom: { include: { messages: true, offers: true } },
      request: { include: { category: true } },
      buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
      vendor: true,
      acceptedOffer: true,
    },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  return deal;
}

export async function listDeals(
  tenantId: string,
  userId: string,
  role: UserRole,
  filters: {
    status?: DealStatus;
    requestId?: string;
    vendorId?: string;
    page?: number;
    limit?: number;
  } = {}
) {
  const where: Record<string, unknown> = { tenantId };

  if (filters.status) where.status = filters.status;
  if (filters.requestId) where.requestId = filters.requestId;
  if (filters.vendorId) where.vendorId = filters.vendorId;

  if (role === UserRole.REQUESTER || role === UserRole.PROCUREMENT_MANAGER) {
    where.buyerId = userId;
  }

  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const [deals, total] = await Promise.all([
    prisma.deal.findMany({
      where,
      include: {
        request: { include: { category: true } },
        buyer: { select: { id: true, firstName: true, lastName: true, email: true } },
        vendor: true,
        acceptedOffer: true,
        // Lets callers detect that a purchase order was already raised, so the
        // UI can link to it instead of offering a duplicate.
        purchaseOrder: { select: { id: true, poNumber: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.deal.count({ where }),
  ]);

  return { data: deals, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getVendorAvailability(vendorId: string) {
  const availability = await prisma.vendorAvailability.findUnique({
    where: { vendorId },
  });

  return availability || { vendorId, isOnline: false, isBusy: false, lastSeenAt: new Date() };
}

export async function updateVendorAvailability(
  vendorId: string,
  isOnline: boolean,
  isBusy: boolean,
  tenantId: string
) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError('Vendor');

  const availability = await prisma.vendorAvailability.upsert({
    where: { vendorId },
    create: { vendorId, tenantId: vendor.tenantId, isOnline, isBusy, lastSeenAt: new Date() },
    update: { isOnline, isBusy, lastSeenAt: new Date() },
  });

  return availability;
}

export async function getOnlineVendors(tenantId: string, categoryId?: string) {
  const where: Record<string, unknown> = {
    tenantId,
    status: 'ACTIVE',
    availability: { isOnline: true },
  };

  if (categoryId) {
    where.categoryId = categoryId;
  }

  return prisma.vendor.findMany({
    where,
    include: { availability: true, category: true },
  });
}

export async function calculateOfferTotal(offer: {
  unitPrice: number;
  quantity: number;
  gst?: number;
  freightAmount?: number;
  installationAmount?: number;
  otherCharges?: number;
}) {
  const subtotal = offer.unitPrice * offer.quantity;
  const gstAmount = subtotal * ((offer.gst || 0) / 100);
  const total = subtotal + gstAmount + (offer.freightAmount || 0) + (offer.installationAmount || 0) + (offer.otherCharges || 0);

  return {
    subtotal,
    gstAmount,
    total,
  };
}