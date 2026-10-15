import { describe, expect, it } from 'vitest';
import { UserRole } from '@navo/shared';
import { ForbiddenError } from '../../../utils/errors.js';
import {
  CopilotActor,
  buildScope,
  dealRoomVisibility,
  dealVisibility,
  invoiceVisibility,
  paymentVisibility,
  purchaseOrderVisibility,
  quoteVisibility,
  requestVisibility,
  rfqVisibility,
  vendorVisibility,
  canCreateRequests,
  canDraftNegotiation,
  canOpenDealRooms,
} from '../copilot-access.js';

/**
 * Authorization tests for the copilot.
 *
 * These assert on the *where clauses* the copilot builds rather than on
 * database rows, because the guarantee that matters is structural: every
 * visibility helper pins `tenantId` and constrains the seller/buyer axes. A test
 * that seeded two tenants and counted rows would pass for the wrong reason if a
 * helper silently dropped a filter.
 */

const BUYER_MANAGER: CopilotActor = {
  userId: 'user-manager',
  tenantId: 'tenant-a',
  role: UserRole.PROCUREMENT_MANAGER,
};

const PLAIN_BUYER: CopilotActor = {
  userId: 'user-requester',
  tenantId: 'tenant-a',
  role: UserRole.REQUESTER,
};

const SELLER: CopilotActor = {
  userId: 'user-seller',
  tenantId: 'tenant-a',
  role: UserRole.VENDOR,
  vendorId: 'vendor-1',
};

describe('buildScope', () => {
  it('gives a tenant-wide buyer no requester restriction', () => {
    const scope = buildScope(BUYER_MANAGER);
    expect(scope.isSeller).toBe(false);
    expect(scope.requesterIdFilter).toBeUndefined();
    expect(scope.vendorIdFilter).toBeUndefined();
  });

  it('confines a plain buyer to their own records', () => {
    const scope = buildScope(PLAIN_BUYER);
    expect(scope.requesterIdFilter).toBe('user-requester');
  });

  it('pins a seller to their own vendor and never lets them switch it', () => {
    const scope = buildScope(SELLER, 'vendor-other');
    expect(scope.isSeller).toBe(true);
    // The attacker-supplied focus is discarded, not merged.
    expect(scope.vendorIdFilter).toBe('vendor-1');
  });

  it('ignores a focus vendor from a role that cannot narrow', () => {
    const scope = buildScope(PLAIN_BUYER, 'vendor-other');
    expect(scope.vendorIdFilter).toBeUndefined();
  });

  it('honours a focus vendor for a tenant-wide buyer', () => {
    const scope = buildScope(BUYER_MANAGER, 'vendor-other');
    expect(scope.vendorIdFilter).toBe('vendor-other');
  });

  it('refuses a seller account that is not linked to a vendor', () => {
    expect(() => buildScope({ ...SELLER, vendorId: undefined })).toThrow(ForbiddenError);
  });
});

describe('tenant isolation', () => {
  const helpers = [
    ['requestVisibility', requestVisibility],
    ['dealVisibility', dealVisibility],
    ['dealRoomVisibility', dealRoomVisibility],
    ['purchaseOrderVisibility', purchaseOrderVisibility],
    ['quoteVisibility', quoteVisibility],
    ['rfqVisibility', rfqVisibility],
  ] as const;

  for (const [name, helper] of helpers) {
    it(`${name} always pins the caller's tenant`, () => {
      for (const actor of [BUYER_MANAGER, PLAIN_BUYER, SELLER]) {
        expect(helper(buildScope(actor)).tenantId).toBe('tenant-a');
      }
    });
  }

  it('invoice and payment visibility inherit the purchase-order tenant filter', () => {
    const scope = buildScope(SELLER);
    expect(invoiceVisibility(scope).po).toEqual(purchaseOrderVisibility(scope));
    expect(paymentVisibility(scope).po).toEqual(purchaseOrderVisibility(scope));
  });

  it('vendorVisibility confines a seller to its own row', () => {
    expect(vendorVisibility(buildScope(SELLER))).toEqual({ id: 'vendor-1' });
  });

  it('vendorVisibility scopes a buyer to the tenant instead', () => {
    expect(vendorVisibility(buildScope(BUYER_MANAGER))).toEqual({ tenantId: 'tenant-a' });
  });
});

describe('seller restrictions', () => {
  it('shows a seller only requests connected to its vendor', () => {
    expect(requestVisibility(buildScope(SELLER))).toEqual({
      tenantId: 'tenant-a',
      connections: { some: { vendorId: 'vendor-1' } },
    });
  });

  it('shows a seller only its own deals, orders and quotes', () => {
    expect(dealVisibility(buildScope(SELLER))).toMatchObject({ vendorId: 'vendor-1' });
    expect(dealRoomVisibility(buildScope(SELLER))).toMatchObject({ vendorId: 'vendor-1' });
    expect(purchaseOrderVisibility(buildScope(SELLER))).toMatchObject({ vendorId: 'vendor-1' });
    expect(quoteVisibility(buildScope(SELLER))).toMatchObject({ vendorId: 'vendor-1' });
  });

  it('shows a seller only RFQs it was invited to quote on', () => {
    expect(rfqVisibility(buildScope(SELLER))).toMatchObject({
      vendors: { some: { vendorId: 'vendor-1' } },
    });
  });

  it('never scopes a seller by another vendor id', () => {
    const scope = buildScope(SELLER, 'vendor-attacker-chosen');
    for (const where of [
      requestVisibility(scope),
      dealVisibility(scope),
      dealRoomVisibility(scope),
      purchaseOrderVisibility(scope),
      quoteVisibility(scope),
      rfqVisibility(scope),
    ]) {
      expect(JSON.stringify(where)).not.toContain('vendor-attacker-chosen');
    }
  });
});

describe('non-admin buyer restrictions', () => {
  it('scopes requests and deals by requester', () => {
    const scope = buildScope(PLAIN_BUYER);
    expect(requestVisibility(scope)).toMatchObject({ requesterId: 'user-requester' });
    expect(dealVisibility(scope)).toMatchObject({ buyerId: 'user-requester' });
  });

  it('reaches quotes and RFQs through the owning request', () => {
    const scope = buildScope(PLAIN_BUYER);
    expect(quoteVisibility(scope)).toMatchObject({
      rfq: { request: { requesterId: 'user-requester' } },
    });
    expect(rfqVisibility(scope)).toMatchObject({ request: { requesterId: 'user-requester' } });
  });
});

describe('role capabilities', () => {
  it('lets managers and requesters raise requests', () => {
    expect(canCreateRequests(buildScope(BUYER_MANAGER))).toBe(true);
    expect(canCreateRequests(buildScope(PLAIN_BUYER))).toBe(true);
  });

  it('never lets a seller raise a buyer-side request', () => {
    expect(canCreateRequests(buildScope(SELLER))).toBe(false);
  });

  it('does not let a seller draft negotiation messages', () => {
    // The negotiation service itself permits a supplier to reply in its own room,
    // but the copilot deliberately does not offer to write on a seller's behalf:
    // `draft_negotiation` is buyer-only. Authorization is enforced in two places
    // here - `allowedRoles: BUYER_AND_ADMIN` on the tool and this guard - so a
    // seller reaching the copilot for a drafted counteroffer is refused.
    expect(canDraftNegotiation(buildScope(SELLER))).toBe(false);
  });

  it('does not let a seller open a buyer-side deal room', () => {
    expect(canOpenDealRooms(buildScope(SELLER))).toBe(false);
  });
});