import { Prisma } from '@prisma/client';
import { UserRole } from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';

/**
 * Seller (VENDOR) authorization.
 *
 * A seller may only ever act on purchase orders belonging to the vendor record
 * linked to their own user row. The `vendorId` is deliberately read from the
 * database rather than trusted from the JWT, because the access token does not
 * carry a vendor claim; relying on a client-supplied vendor id would let any
 * seller act on any other seller's orders.
 */

/** Buyer-side roles allowed to create, approve and manage purchase orders. */
export const BUYER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
  UserRole.REQUESTER,
  UserRole.VIEWER,
];

/** Roles allowed to view every PO in the tenant (not just their own). */
export const PO_ADMIN_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
];

/** Roles that may approve purchase orders. */
export const PO_APPROVER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
];

export interface ActorContext {
  userId: string;
  tenantId: string;
  role: UserRole;
}

export interface SellerContext extends ActorContext {
  vendorId: string;
}

/** A seller resolved from the authenticated user, including its vendor link. */
export interface ResolvedSeller {
  id: string;
  tenantId: string;
  role: UserRole;
  vendorId: string;
}

/**
 * Resolve the acting seller to their vendor record.
 * Returns null when the user has no vendor link (not a seller, or unlinked).
 */
export async function resolveSellerVendor(userId: string): Promise<ResolvedSeller | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tenantId: true, role: true, vendorId: true, isActive: true },
  });

  if (!user || !user.isActive || !user.vendorId) return null;
  // The Prisma enum and the shared enum share identical string values; the cast
  // keeps a single canonical UserRole at the application boundary.
  return { id: user.id, tenantId: user.tenantId, role: user.role as UserRole, vendorId: user.vendorId };
}

/**
 * Require a seller context for actions that only suppliers may perform.
 * Throws rather than returning null so callers cannot accidentally continue.
 */
export async function requireSeller(userId: string, tenantId: string): Promise<SellerContext> {
  const seller = await resolveSellerVendor(userId);
  if (!seller || seller.role !== UserRole.VENDOR) {
    throw new ForbiddenError('This action is restricted to supplier accounts');
  }
  if (seller.tenantId !== tenantId) {
    throw new ForbiddenError('Access denied: account belongs to another tenant');
  }
  return { userId, tenantId, role: seller.role, vendorId: seller.vendorId };
}

/**
 * Load a PO the actor is allowed to see, enforcing both tenant isolation and
 * seller/vendor scoping. Buyers see POs in their tenant; sellers see only POs
 * for their own vendor.
 *
 * `Include` is threaded into Prisma's payload type so callers keep full typing
 * of their relations rather than receiving a bare base model.
 */
export async function loadAccessiblePo<Include extends Prisma.PurchaseOrderInclude = never>(
  poId: string,
  actor: ActorContext,
  options: { include?: Include } = {},
): Promise<Prisma.PurchaseOrderGetPayload<{ include: Include }>> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId },
    ...(options.include ? { include: options.include } : {}),
  });

  if (!po) {
    throw new NotFoundError('Purchase Order');
  }

  if (po.tenantId !== actor.tenantId) {
    throw new ForbiddenError('Access denied: purchase order belongs to another tenant');
  }

  if (actor.role === UserRole.VENDOR) {
    const seller = await resolveSellerVendor(actor.userId);
    if (!seller || seller.vendorId !== po.vendorId) {
      throw new ForbiddenError('Access denied: purchase order belongs to another supplier');
    }
    return po as Prisma.PurchaseOrderGetPayload<{ include: Include }>;
  }

  if (!BUYER_ROLES.includes(actor.role)) {
    throw new ForbiddenError('Insufficient permissions for purchase orders');
  }

  return po as Prisma.PurchaseOrderGetPayload<{ include: Include }>;
}

/**
 * Assert the actor may modify the PO. Sellers are limited to the supplier-side
 * statuses; buyers may act on anything that is not yet closed or cancelled.
 */
export async function assertCanModify<Include extends Prisma.PurchaseOrderInclude = never>(
  poId: string,
  actor: ActorContext,
  options: { include?: Include } = {},
): Promise<Prisma.PurchaseOrderGetPayload<{ include: Include }>> {
  const po = await loadAccessiblePo(poId, actor, options);

  if (actor.role === UserRole.VENDOR) {
    // Suppliers may only act while the order is with them, never after closure.
    if (['CLOSED', 'CANCELLED'].includes(po.status)) {
      throw new ForbiddenError(`Purchase order is ${po.status.toLowerCase()} and can no longer be changed`);
    }
    return po;
  }

  if (['CLOSED', 'CANCELLED', 'DELIVERED'].includes(po.status)) {
    throw new ForbiddenError(`Purchase order is ${po.status.toLowerCase()} and can no longer be changed`);
  }

  return po;
}

/** True when the actor holds a role that may view all tenant purchase orders. */
export function isPoViewer(actor: ActorContext): boolean {
  return PO_ADMIN_ROLES.includes(actor.role);
}