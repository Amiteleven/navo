import { Prisma } from '@prisma/client';
import { UserRole } from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ForbiddenError } from '../../utils/errors.js';

/**
 * Copilot access control.
 *
 * The copilot may read and act on exactly the records the signed-in user could
 * reach through the normal REST API, and no more. Two rules make that hold:
 *
 *  1. Authorization is enforced here, in backend code, before any data is read.
 *     Prompt text, tool arguments and model output are all treated as
 *     untrusted input; none of them can widen `CopilotScope`.
 *  2. Every tool re-derives its own `where` clause from this scope. A tool is
 *     never handed a bare record id and asked to "check" it afterwards.
 *
 * Sellers and buyers are separated here as well as in the Phase 5 purchase-order
 * services, because a copilot answer can otherwise become a side channel: the
 * Copilot would happily summarize a record the REST API would have refused.
 */

/** A caller, resolved once per request. */
export interface CopilotActor {
  userId: string;
  tenantId: string;
  role: UserRole;
  /** Present only for supplier accounts. */
  vendorId?: string;
}

/** The set of records a caller may read. Built once, then passed to tools. */
export interface CopilotScope {
  actor: CopilotActor;
  isSeller: boolean;
  /**
   * Restrict to a single vendor. Set for sellers (their own vendor) and for
   * buyers who have narrowed to one supplier in conversation context.
   */
  vendorIdFilter?: string;
  /**
   * Restrict to a single buyer user. Set for non-admin buyers, who may only see
   * their own requests and deals, matching `listRequests` / `listDeals`.
   */
  requesterIdFilter?: string;
}

/** Roles that may see every request and deal in their tenant. */
const TENANT_WIDE_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
];

export async function resolveCopilotActor(
  userId: string,
  tenantId: string,
  role: UserRole
): Promise<CopilotActor> {
  // The vendor link is re-read from the database rather than taken from the JWT,
  // matching `resolveSellerVendor` in the purchase-order module. A token
  // claiming a vendorId must not be able to widen a seller's scope.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tenantId: true, role: true, vendorId: true, isActive: true },
  });

  if (!user || !user.isActive) {
    throw new ForbiddenError('Your account is not active');
  }
  if (user.tenantId !== tenantId) {
    throw new ForbiddenError('Access denied: account belongs to another tenant');
  }

  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role as UserRole,
    vendorId: user.vendorId ?? undefined,
  };
}

/**
 * Build the read scope for this caller.
 *
 * `focusVendorId` is honoured only for a tenant-wide buyer role. A seller
 * cannot switch vendor, and a non-admin buyer cannot widen past their own
 * records, so a hostile argument here is ignored rather than trusted.
 */
export function buildScope(actor: CopilotActor, focusVendorId?: string): CopilotScope {
  if (actor.role === UserRole.VENDOR) {
    if (!actor.vendorId) {
      throw new ForbiddenError('This account is not linked to a supplier');
    }
    return { actor, isSeller: true, vendorIdFilter: actor.vendorId };
  }

  const scope: CopilotScope = { actor, isSeller: false };
  if (focusVendorId && TENANT_WIDE_ROLES.includes(actor.role)) {
    scope.vendorIdFilter = focusVendorId;
  }
  if (!TENANT_WIDE_ROLES.includes(actor.role)) {
    scope.requesterIdFilter = actor.userId;
  }
  return scope;
}

/**
 * Visibility for procurement requests.
 *
 * A request has no vendor column until a connection exists, so a supplier sees
 * requests through the connections opened on them rather than directly.
 */
export function requestVisibility(scope: CopilotScope): Prisma.ProcurementRequestWhereInput {
  const where: Prisma.ProcurementRequestWhereInput = { tenantId: scope.actor.tenantId };
  if (scope.isSeller) {
    where.connections = { some: { vendorId: scope.vendorIdFilter } };
    return where;
  }
  if (scope.requesterIdFilter) where.requesterId = scope.requesterIdFilter;
  if (scope.vendorIdFilter) {
    where.connections = { some: { vendorId: scope.vendorIdFilter } };
  }
  return where;
}

export function dealVisibility(scope: CopilotScope): Prisma.DealWhereInput {
  const where: Prisma.DealWhereInput = { tenantId: scope.actor.tenantId };
  if (scope.isSeller) {
    where.vendorId = scope.vendorIdFilter;
  } else if (scope.requesterIdFilter) {
    where.buyerId = scope.requesterIdFilter;
  } else if (scope.vendorIdFilter) {
    // A tenant-wide buyer focused on one supplier sees that supplier's deals.
    where.vendorId = scope.vendorIdFilter;
  }
  return where;
}

export function dealRoomVisibility(scope: CopilotScope): Prisma.DealRoomWhereInput {
  const where: Prisma.DealRoomWhereInput = { tenantId: scope.actor.tenantId };
  if (scope.isSeller) {
    where.vendorId = scope.vendorIdFilter;
  } else if (scope.requesterIdFilter) {
    where.buyerId = scope.requesterIdFilter;
  } else if (scope.vendorIdFilter) {
    where.vendorId = scope.vendorIdFilter;
  }
  return where;
}

/**
 * Purchase orders, mirroring `listPurchaseOrders`: admins see the tenant, a
 * plain buyer sees their own, a seller sees their vendor's.
 */
export function purchaseOrderVisibility(scope: CopilotScope): Prisma.PurchaseOrderWhereInput {
  const where: Prisma.PurchaseOrderWhereInput = { tenantId: scope.actor.tenantId };
  if (scope.isSeller) {
    where.vendorId = scope.vendorIdFilter;
  } else if (scope.requesterIdFilter) {
    where.buyerId = scope.requesterIdFilter;
  } else if (scope.vendorIdFilter) {
    where.vendorId = scope.vendorIdFilter;
  }
  return where;
}

export function invoiceVisibility(scope: CopilotScope): Prisma.InvoiceWhereInput {
  return { po: purchaseOrderVisibility(scope) };
}

export function paymentVisibility(scope: CopilotScope): Prisma.PaymentWhereInput {
  return { po: purchaseOrderVisibility(scope) };
}

/**
 * Quotations are the most sensitive surface: a buyer may see the quotes on
 * their own requests, and a supplier may only ever see its own quote. This is
 * what stops one supplier's price from reaching another through the Copilot.
 */
export function quoteVisibility(scope: CopilotScope): Prisma.QuoteWhereInput {
  const where: Prisma.QuoteWhereInput = { tenantId: scope.actor.tenantId };
  if (scope.isSeller) {
    where.vendorId = scope.vendorIdFilter;
  } else if (scope.requesterIdFilter) {
    where.rfq = { request: { requesterId: scope.requesterIdFilter } };
  }
  return where;
}

export function rfqVisibility(scope: CopilotScope): Prisma.RFQWhereInput {
  const where: Prisma.RFQWhereInput = { tenantId: scope.actor.tenantId };
  if (scope.isSeller) {
    // A supplier only sees an RFQ it has actually been invited to quote on.
    where.vendors = { some: { vendorId: scope.vendorIdFilter } };
  } else if (scope.requesterIdFilter) {
    // RFQ has no requesterId; the request it belongs to carries it.
    where.request = { requesterId: scope.requesterIdFilter };
  }
  return where;
}

/**
 * Vendors. A seller may see only itself, and must never learn who else supplies
 * the buyer. Buyers see verified suppliers in their own tenant.
 */
export function vendorVisibility(scope: CopilotScope): Prisma.VendorWhereInput {
  if (scope.isSeller) {
    return { id: scope.vendorIdFilter! };
  }
  return { tenantId: scope.actor.tenantId };
}

/** True when the actor may create procurement records. Sellers may not. */
export function canCreateRequests(scope: CopilotScope): boolean {
  return !scope.isSeller;
}

/** True when the actor may open a deal room. Suppliers use their own room. */
export function canOpenDealRooms(scope: CopilotScope): boolean {
  return !scope.isSeller;
}

/** True when the actor may draft a negotiation message as a buyer. */
export function canDraftNegotiation(scope: CopilotScope): boolean {
  return !scope.isSeller;
}