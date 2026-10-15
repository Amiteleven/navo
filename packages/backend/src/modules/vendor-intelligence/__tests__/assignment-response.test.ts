import { describe, expect, it, beforeEach, vi } from 'vitest';
import { UserRole } from '@navo/shared';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../utils/errors.js';
import {
  acceptAssignment,
  declineAssignment,
} from '../vendor-assignment.service.js';

interface Row { [key: string]: unknown }

const TENANT = 'tenant-a';
const TENANT_B = 'tenant-b';
const VENDOR_1 = 'vendor-1';
const VENDOR_2 = 'vendor-2';
const VENDOR_USER_1 = 'vendor-user-1';
const VENDOR_USER_2 = 'vendor-user-2';
const BUYER = 'buyer-1';
const ASSIGNMENT = 'assignment-1';
const REQUEST = 'req-1';

const { db, prismaMock } = vi.hoisted(() => {
  const state = {
    users: [] as Row[],
    assignments: [] as Row[],
    vendorEvents: [] as Row[],
  };

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const mock = {
    user: {
      findUnique: async ({ where }: { where: Row }) =>
        state.users.find((u) => matches(u, where)) ?? null,
    },
    vendorAssignment: {
      findFirst: async ({ where }: { where: Row }) =>
        state.assignments.find((a) => matches(a, where)) ?? null,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const a = state.assignments.find((x) => matches(x, where));
        if (!a) throw new Error('VendorAssignment not found');
        return Object.assign(a, data);
      },
    },
    vendorEvent: {
      create: async ({ data }: { data: Row }) => {
        state.vendorEvents.push(data);
        return data;
      },
    },
  };

  return { db: state, prismaMock: mock };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../../audit/audit.service.js', () => ({
  createAuditLog: vi.fn(async () => undefined),
}));

describe('Vendor assignment responses', () => {
  beforeEach(() => {
    db.users.length = 0;
    db.assignments.length = 0;
    db.vendorEvents.length = 0;

    db.users.push(
      { id: VENDOR_USER_1, tenantId: TENANT, role: UserRole.VENDOR, vendorId: VENDOR_1, isActive: true },
      { id: VENDOR_USER_2, tenantId: TENANT, role: UserRole.VENDOR, vendorId: VENDOR_2, isActive: true },
      { id: BUYER, tenantId: TENANT, role: UserRole.PROCUREMENT_MANAGER, vendorId: null, isActive: true },
      { id: 'vendor-user-b', tenantId: TENANT_B, role: UserRole.VENDOR, vendorId: VENDOR_1, isActive: true },
    );

    db.assignments.push({
      id: ASSIGNMENT,
      tenantId: TENANT,
      requestId: REQUEST,
      vendorId: VENDOR_1,
      assignedById: BUYER,
      acceptedAt: null,
      declinedAt: null,
      declineReason: null,
    });
  });

  it('vendor accepts an assignment addressed to them', async () => {
    const updated = await acceptAssignment(ASSIGNMENT, TENANT, VENDOR_USER_1);

    expect(updated.acceptedAt).toBeInstanceOf(Date);
    expect(db.assignments[0].acceptedAt).toBeInstanceOf(Date);
    // Event trail records the acceptance.
    expect(db.vendorEvents).toHaveLength(1);
    expect(db.vendorEvents[0].eventType).toBe('ACCEPTED');
    expect(db.vendorEvents[0].vendorId).toBe(VENDOR_1);
  });

  it('vendor cannot accept another vendor\'s assignment', async () => {
    await expect(acceptAssignment(ASSIGNMENT, TENANT, VENDOR_USER_2)).rejects.toThrow(ForbiddenError);
  });

  it('a buyer cannot accept an assignment as a vendor', async () => {
    await expect(acceptAssignment(ASSIGNMENT, TENANT, BUYER)).rejects.toThrow(ForbiddenError);
  });

  it('an assignment is not visible from another tenant', async () => {
    await expect(acceptAssignment(ASSIGNMENT, TENANT_B, 'vendor-user-b')).rejects.toThrow(NotFoundError);
  });

  it('an inactive vendor user cannot respond', async () => {
    db.users[0].isActive = false;
    await expect(acceptAssignment(ASSIGNMENT, TENANT, VENDOR_USER_1)).rejects.toThrow(ForbiddenError);
  });

  it('accepting twice is rejected', async () => {
    db.assignments[0].acceptedAt = new Date();
    await expect(acceptAssignment(ASSIGNMENT, TENANT, VENDOR_USER_1)).rejects.toThrow(ValidationError);
  });

  it('accepting a declined assignment is rejected', async () => {
    db.assignments[0].declinedAt = new Date();
    await expect(acceptAssignment(ASSIGNMENT, TENANT, VENDOR_USER_1)).rejects.toThrow(ValidationError);
  });

  it('vendor declines with a mandatory reason', async () => {
    const updated = await declineAssignment(ASSIGNMENT, TENANT, VENDOR_USER_1, 'No stock this quarter');

    expect(updated.declinedAt).toBeInstanceOf(Date);
    expect(updated.declineReason).toBe('No stock this quarter');
    expect(db.vendorEvents).toHaveLength(1);
    expect(db.vendorEvents[0].eventType).toBe('DECLINED');
  });

  it('declining an accepted assignment is rejected', async () => {
    db.assignments[0].acceptedAt = new Date();
    await expect(
      declineAssignment(ASSIGNMENT, TENANT, VENDOR_USER_1, 'too late')
    ).rejects.toThrow(ValidationError);
  });

  it('declining twice is rejected', async () => {
    db.assignments[0].declinedAt = new Date();
    await expect(
      declineAssignment(ASSIGNMENT, TENANT, VENDOR_USER_1, 'again')
    ).rejects.toThrow(ValidationError);
  });

  it('throws NotFoundError for an unknown assignment', async () => {
    await expect(acceptAssignment('unknown', TENANT, VENDOR_USER_1)).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError for an assignment in another tenant', async () => {
    await expect(acceptAssignment(ASSIGNMENT, TENANT_B, 'vendor-user-b')).rejects.toThrow(NotFoundError);
  });
});
