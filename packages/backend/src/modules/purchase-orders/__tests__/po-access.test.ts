import { describe, expect, it, beforeEach, vi } from 'vitest';
import { UserRole } from '@navo/shared';
import { ForbiddenError, NotFoundError } from '../../../utils/errors.js';
import { loadAccessiblePo, requireSeller } from '../po-access.js';
import { buildPoSummary } from '../timeline.service.js';

interface Row { [key: string]: unknown }

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const VENDOR_1 = 'vendor-1';
const VENDOR_2 = 'vendor-2';
const USER_SELLER_1 = 'user-seller-1';
const USER_SELLER_2 = 'user-seller-2';
const USER_BUYER = 'user-buyer';
const USER_BUYER_OTHER = 'user-buyer-other';
const PO_1 = 'po-1';
const PO_2 = 'po-2';

const { db, prismaMock } = vi.hoisted(() => {
  const state = {
    users: [] as Row[],
    purchaseOrders: [] as Row[],
  };

  const mock = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.users.find((u) => u.id === where.id) ?? null,
    },
    purchaseOrder: {
      findUnique: async ({ where, include }: { where: Row; include?: Record<string, unknown> }) => {
        const p = state.purchaseOrders.find((po) => po.id === where.id) ?? null;
        if (!p) return null;
        if (!include) return p;
        const result = { ...p };
        if (include.vendor) result.vendor = { name: 'Test Vendor' };
        if (include.goodsReceipts) result.goodsReceipts = [];
        if (include.invoices) result.invoices = [];
        if (include.payments) result.payments = [];
        if (include.deliveryEvents) result.deliveryEvents = [];
        if (include.documents) result.documents = [];
        return result;
      },
      findFirst: async ({ where }: { where: Row }) =>
        state.purchaseOrders.find((p) => {
          for (const [k, v] of Object.entries(where)) {
            if (p[k] !== v) return false;
          }
          return true;
        }) ?? null,
    },
  } as Record<string, unknown>;

  return { db: state, prismaMock: mock };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));

describe('Security: PO Access Control', () => {
  beforeEach(() => {
    db.users.length = 0;
    db.purchaseOrders.length = 0;

    db.users.push(
      { id: USER_SELLER_1, tenantId: TENANT_A, role: UserRole.VENDOR, vendorId: VENDOR_1, isActive: true },
      { id: USER_SELLER_2, tenantId: TENANT_A, role: UserRole.VENDOR, vendorId: VENDOR_2, isActive: true },
      { id: USER_BUYER, tenantId: TENANT_A, role: UserRole.PROCUREMENT_MANAGER, vendorId: null, isActive: true },
      { id: USER_BUYER_OTHER, tenantId: TENANT_B, role: UserRole.PROCUREMENT_MANAGER, vendorId: null, isActive: true },
    );

    db.purchaseOrders.push(
      { id: PO_1, tenantId: TENANT_A, vendorId: VENDOR_1, status: 'APPROVED' },
      { id: PO_2, tenantId: TENANT_A, vendorId: VENDOR_2, status: 'APPROVED' },
      { id: 'po-other-tenant', tenantId: TENANT_B, vendorId: VENDOR_2, status: 'APPROVED' },
    );
  });

  it('seller 1 cannot access PO belonging to vendor 2', async () => {
    await expect(
      loadAccessiblePo(PO_2, { userId: USER_SELLER_1, tenantId: TENANT_A, role: UserRole.VENDOR })
    ).rejects.toThrow(ForbiddenError);
  });

  it('seller 2 cannot access PO belonging to vendor 1', async () => {
    await expect(
      loadAccessiblePo(PO_1, { userId: USER_SELLER_2, tenantId: TENANT_A, role: UserRole.VENDOR })
    ).rejects.toThrow(ForbiddenError);
  });

  it('seller from tenant B cannot access PO in tenant A', async () => {
    await expect(
      loadAccessiblePo(PO_1, { userId: USER_SELLER_2, tenantId: TENANT_B, role: UserRole.VENDOR })
    ).rejects.toThrow(ForbiddenError);
  });

  it('buyer from tenant B cannot access PO in tenant A', async () => {
    await expect(
      loadAccessiblePo(PO_1, { userId: USER_BUYER_OTHER, tenantId: TENANT_B, role: UserRole.PROCUREMENT_MANAGER })
    ).rejects.toThrow(ForbiddenError);
  });

  it('non-existent PO throws NotFoundError', async () => {
    await expect(
      loadAccessiblePo('nonexistent', { userId: USER_BUYER, tenantId: TENANT_A, role: UserRole.PROCUREMENT_MANAGER })
    ).rejects.toThrow(NotFoundError);
  });

  it('requireSeller throws ForbiddenError for non-vendor role', async () => {
    await expect(requireSeller(USER_BUYER, TENANT_A)).rejects.toThrow(ForbiddenError);
  });

  it('seller 1 can access their own PO', async () => {
    const po = await loadAccessiblePo(PO_1, { userId: USER_SELLER_1, tenantId: TENANT_A, role: UserRole.VENDOR });
    expect(po.id).toBe(PO_1);
  });
});

describe('Security: buildPoSummary tenant/vendor isolation', () => {
  beforeEach(() => {
    db.users.length = 0;
    db.purchaseOrders.length = 0;

    db.users.push(
      { id: USER_SELLER_1, tenantId: TENANT_A, role: UserRole.VENDOR, vendorId: VENDOR_1, isActive: true },
      { id: USER_SELLER_2, tenantId: TENANT_A, role: UserRole.VENDOR, vendorId: VENDOR_2, isActive: true },
    );

    db.purchaseOrders.push(
      { id: PO_1, tenantId: TENANT_A, vendorId: VENDOR_1, status: 'APPROVED' },
      { id: PO_2, tenantId: TENANT_A, vendorId: VENDOR_2, status: 'APPROVED' },
    );
  });

  it('buildPoSummary rejects cross-vendor access (seller 1 accessing vendor 2 PO)', async () => {
    await expect(
      buildPoSummary(PO_2, { userId: USER_SELLER_1, tenantId: TENANT_A, role: UserRole.VENDOR })
    ).rejects.toThrow(ForbiddenError);
  });

  it('buildPoSummary rejects cross-tenant access (seller 1 from tenant B)', async () => {
    await expect(
      buildPoSummary(PO_1, { userId: USER_SELLER_2, tenantId: TENANT_B, role: UserRole.VENDOR })
    ).rejects.toThrow(ForbiddenError);
  });
});
