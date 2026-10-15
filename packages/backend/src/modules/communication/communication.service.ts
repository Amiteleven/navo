import { Prisma, VendorStatus } from '@prisma/client';
import { UserRole } from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';

/**
 * Seller communication eligibility and buyer-side moderation controls.
 *
 * The rule this module exists to enforce: **a seller may not contact a buyer
 * unless a permitted interaction already exists.** Permitted interactions are:
 *
 *   1. the seller expressed interest in an open-market requirement
 *   2. the buyer invited the seller (a connection exists)
 *   3. the buyer accepted a connection the seller requested
 *
 * Everything else - cold messages, cold connection requests, unsolicited
 * quotations - is refused. The check is a database query against the caller's
 * own records, never a client-supplied flag, and it is applied inside the
 * services that write, so hiding a button in the UI is never the control.
 */

export interface CommunicationActor {
  userId: string;
  tenantId: string;
  role: UserRole;
  /** Re-read from the database, never from the token. */
  vendorId?: string;
}

export type InteractionBasis =
  | 'MARKETPLACE_INTEREST'
  | 'BUYER_INVITED'
  | 'CONNECTION_ACCEPTED'
  | 'DEAL_PARTICIPANT'
  | 'NONE';

/**
 * Resolve a seller from the database.
 *
 * The vendor link is re-read here for the same reason `resolveSellerVendor` does
 * it in the purchase-order module: a JWT that claims a vendorId must not be
 * able to act on another supplier's behalf.
 */
export async function resolveSellerActor(userId: string, tenantId: string): Promise<CommunicationActor> {
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
  if (user.role !== UserRole.VENDOR) {
    throw new ForbiddenError('This action is restricted to supplier accounts');
  }
  if (!user.vendorId) {
    throw new ForbiddenError('Your account is not linked to a supplier');
  }

  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role as UserRole,
    vendorId: user.vendorId,
  };
}

/** True when the vendor is blacklisted, suspended, or unverified. */
export async function assertVendorCanParticipate(tenantId: string, vendorId: string): Promise<void> {
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, tenantId },
    select: { status: true, verificationStatus: true },
  });
  if (!vendor) throw new NotFoundError('Vendor');

  // BLACKLISTED was previously a dead enum value that nothing enforced. It now
  // blocks every marketplace and communication action.
  if (vendor.status === VendorStatus.BLACKLISTED) {
    throw new ForbiddenError('This supplier account is suspended and cannot participate');
  }
  if (vendor.status !== VendorStatus.ACTIVE) {
    throw new ForbiddenError('Your supplier account must be active to participate');
  }
}

/**
 * Has the buyer blocked or muted this seller?
 *
 * A block is permanent and asymmetric; a mute is time-boxed. Both are checked
 * on the seller side so a seller cannot reach around them, and again on the
 * buyer side so the buyer is not silently notified.
 */
export async function findRestriction(
  tenantId: string,
  buyerId: string,
  vendorId: string
): Promise<{ kind: 'BLOCK' | 'MUTE'; expiresAt: Date | null } | null> {
  const rows = await prisma.contactRestriction.findMany({
    where: { tenantId, buyerId, vendorId },
    orderBy: { createdAt: 'desc' },
  });

  const active = rows.find((r) => {
    if (r.kind === 'BLOCK') return true;
    return !r.expiresAt || r.expiresAt > new Date();
  });

  return active ? { kind: active.kind, expiresAt: active.expiresAt } : null;
}

/**
 * May this seller contact this buyer right now?
 *
 * Returns the basis on which contact is permitted, or `'NONE'`. Callers refuse
 * on `'NONE'`; the basis is recorded so an audit trail explains *why* a
 * message was allowed.
 */
export async function resolveInteractionBasis(
  tenantId: string,
  sellerUserId: string,
  buyerUserId: string
): Promise<InteractionBasis> {
  // A block or mute stops everything, including an otherwise valid interaction.
  const seller = await prisma.user.findUnique({
    where: { id: sellerUserId },
    select: { vendorId: true, tenantId: true },
  });
  if (!seller?.vendorId || seller.tenantId !== tenantId) return 'NONE';

  if (await findRestriction(tenantId, buyerUserId, seller.vendorId)) {
    return 'NONE';
  }

  // 1. Interest already expressed against a requirement this buyer owns.
  const interest = await prisma.marketplaceInterest.findFirst({
    where: {
      vendorId: seller.vendorId,
      tenantId,
      request: { requesterId: buyerUserId },
      status: { in: ['EXPRESSED', 'QUOTED', 'SHORTLISTED'] },
    },
    select: { id: true },
  });
  if (interest) return 'MARKETPLACE_INTEREST';

  // 2/3. A connection in either direction. PENDING means the buyer invited;
  //      ACCEPTED means both sides have agreed. Both are matched on the
  //      requirement's requester so a connection to a *different* buyer's
  //      requirement never authorizes contact with this one.
  const connection = await prisma.connection.findFirst({
    where: {
      tenantId,
      vendorId: seller.vendorId,
      OR: [{ request: { requesterId: buyerUserId } }, { dealRoom: { buyerId: buyerUserId } }],
    },
    select: { status: true, dealRoom: { select: { id: true } } },
    orderBy: { initiatedAt: 'desc' },
  });
  if (connection) {
    if (connection.status === 'ACCEPTED') return 'CONNECTION_ACCEPTED';
    if (connection.dealRoom) return 'DEAL_PARTICIPANT';
    return 'BUYER_INVITED';
  }

  return 'NONE';
}

/**
 * Backend-enforced gate for any seller→buyer communication.
 *
 * Throws `ForbiddenError` when no permitted interaction exists. The message is
 * deliberately explicit about why, because a seller needs to know the fix is
 * to submit a quotation or wait for an invitation, not to retry.
 */
export async function assertSellerMayContact(
  tenantId: string,
  sellerUserId: string,
  buyerUserId: string
): Promise<InteractionBasis> {
  if (sellerUserId === buyerUserId) return 'DEAL_PARTICIPANT';

  const basis = await resolveInteractionBasis(tenantId, sellerUserId, buyerUserId);
  if (basis === 'NONE') {
    throw new ForbiddenError(
      'You cannot contact this buyer directly. Submit a quotation against an open requirement or wait for an invitation.'
    );
  }
  return basis;
}

/** Buyer-side actions available on a vendor record. */
export interface ModerationInput {
  tenantId: string;
  buyerId: string;
  vendorId: string;
  kind: 'BLOCK' | 'MUTE';
  reason?: string;
  /** Mutes only; ignored for blocks, which do not expire. */
  expiresAt?: Date;
}

export async function setRestriction(input: ModerationInput): Promise<{ kind: string; expiresAt: Date | null }> {
  if (input.kind === 'BLOCK') {
    // A block replaces any mute so the strongest control wins.
    await prisma.contactRestriction.deleteMany({
      where: { tenantId: input.tenantId, buyerId: input.buyerId, vendorId: input.vendorId },
    });
  }

  const created = await prisma.contactRestriction.create({
    data: {
      tenantId: input.tenantId,
      buyerId: input.buyerId,
      vendorId: input.vendorId,
      kind: input.kind,
      reason: input.reason ?? null,
      expiresAt: input.kind === 'MUTE' ? input.expiresAt ?? null : null,
    },
    select: { kind: true, expiresAt: true },
  });

  return created;
}

export async function clearRestriction(
  tenantId: string,
  buyerId: string,
  vendorId: string
): Promise<number> {
  const result = await prisma.contactRestriction.deleteMany({
    where: { tenantId, buyerId, vendorId },
  });
  return result.count;
}

/** Vendors this buyer has blocked or muted. */
export async function listRestrictedVendors(tenantId: string, buyerId: string) {
  return prisma.contactRestriction.findMany({
    where: { tenantId, buyerId },
    include: {
      vendor: { select: { id: true, name: true, city: true, state: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Suppress a seller from contacting buyers outside a permitted interaction.
 *
 * Used by the connection-request path, which is the other route by which a
 * seller could otherwise reach a buyer.
 */
export async function assertSellerMayRequestConnection(
  tenantId: string,
  sellerUserId: string,
  buyerUserId: string,
  requestId: string
): Promise<InteractionBasis> {
  const seller = await prisma.user.findUnique({
    where: { id: sellerUserId },
    select: { vendorId: true, tenantId: true },
  });
  if (!seller?.vendorId || seller.tenantId !== tenantId) {
    throw new ForbiddenError('Your account is not linked to a supplier');
  }

  await assertVendorCanParticipate(tenantId, seller.vendorId);

  if (await findRestriction(tenantId, buyerUserId, seller.vendorId)) {
    throw new ForbiddenError('This buyer is not accepting contact from you');
  }

  // Interest against the very requirement being requested is a valid basis.
  const interest = await prisma.marketplaceInterest.findFirst({
    where: {
      vendorId: seller.vendorId,
      tenantId,
      request: { id: requestId, requesterId: buyerUserId },
      status: { in: ['EXPRESSED', 'QUOTED', 'SHORTLISTED'] },
    },
    select: { id: true },
  });
  if (interest) return 'MARKETPLACE_INTEREST';

  return resolveInteractionBasis(tenantId, sellerUserId, buyerUserId);
}

/**
 * Validate the visibility a requirement may be published with.
 *
 * A private requirement can never carry a market deadline, because the deadline
 * only means something to sellers who can see it.
 */
export function assertPublishableVisibility(input: {
  visibility: 'PRIVATE' | 'OPEN_MARKET';
  status: string;
  quotationDeadline?: Date | null;
}): void {
  if (input.visibility === 'OPEN_MARKET') {
    if (input.status === 'DRAFT' || input.status === 'CANCELLED' || input.status === 'COMPLETED') {
      throw new ValidationError('A requirement must be submitted before it can be published');
    }
  }
  if (input.visibility === 'PRIVATE' && input.quotationDeadline) {
    throw new ValidationError('A quotation deadline only applies to an open-market requirement');
  }
}

/**
 * The Prisma where-fragment for a seller browsing the open market.
 *
 * Only PUBLISHED, OPEN_MARKET requirements, never past their deadline, and
 * never those whose buyer has blocked this vendor. Confidential fields are
 * removed at the projection step, not here - see the route.
 /**
 * The Prisma where-fragment for a seller browsing the open market.
 *
 * `vendorId` is optional so the filter can be omitted in contexts where the
 * caller has already established there is no vendor identity to exclude; it is
 * a defence-in-depth narrowing, never the primary authorization, which is the
 * route-level projection that strips confidential fields.
 */
export function openMarketWhere(
  tenantId: string,
  vendorId?: string,
  now = new Date()
): Prisma.ProcurementRequestWhereInput {
  return {
    tenantId,
    visibility: 'OPEN_MARKET',
    status: { in: ['SUBMITTED', 'RFQ_SENT', 'QUOTES_RECEIVED', 'APPROVED'] },
    publishedAt: { not: null },
    OR: [{ quotationDeadline: null }, { quotationDeadline: { gt: now } }],
    ...(vendorId
      ? {
          // `requester` is a User; the restrictions it holds against this
          // vendor hide the requirement from that vendor only.
          requester: { restrictionsAsBuyer: { none: { vendorId } } },
        }
      : {}),
  };
}