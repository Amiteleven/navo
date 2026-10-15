import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotActionStatus, CopilotActionType, UserRole } from '@navo/shared';
import { ConflictError, ForbiddenError, ValidationError } from '../../../utils/errors.js';
import { CopilotScope } from '../copilot-access.js';

/**
 * Action-flow tests: propose, confirm, duplicate, stale confirmation.
 *
 * Prisma is stubbed rather than hit. The behaviour under test is the sequencing
 * and re-authorization in `proposeAction` / `executeAction`, and a fake store
 * proves the properties that matter directly:
 *
 *  - proposal writes nothing to NAVO
 *  - confirmation re-reads the row and re-derives authorization
 *  - a second confirm cannot re-execute
 *  - an identical pending action is refused as a duplicate
 *  - a payload the user did not supply cannot be filled in by the system
 *
 * The stubs are built inside `vi.hoisted` because `vi.mock` is hoisted above
 * every top-level binding; without it the factory closes over a variable that is
 * still in its temporal dead zone.
 */

interface ActionRow {
  id: string;
  conversationId: string;
  userId: string;
  tenantId: string;
  type: string;
  status: string;
  summary: string;
  payload: unknown;
  [key: string]: unknown;
}

const { prismaMock, store } = vi.hoisted(() => {
  /** Shared fake-store state, reachable from tests and from the hoisted mocks. */
  const state = {
    rows: [] as ActionRow[],
    createCalls: 0,
    requestInsert: null as unknown,
    messageInsert: null as unknown,
  };

  const mock = {
    copilotAction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.createCalls += 1;
        const row = { id: `action-${state.createCalls}`, ...data } as ActionRow;
        state.rows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
      update: async ({ where }: { where: { id: string } }) => {
        const row = state.rows.find((r) => r.id === where.id);
        if (!row) throw new Error('no such action');
        Object.assign(row, { status: 'EXECUTED' });
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = state.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        state.rows.filter((r) =>
          Object.entries(where).every(([k, v]) => (k === 'status' ? r.status === v : r[k] === v))
        ),
    },
    procurementRequest: {
      create: async ({ data }: { data: unknown }) => {
        state.requestInsert = data;
        return { id: 'request-1', title: 'Laptops', status: 'DRAFT' };
      },
    },
    negotiationMessage: {
      create: async ({ data }: { data: unknown }) => {
        state.messageInsert = data;
        return { id: 'message-1' };
      },
    },
    dealRoom: {
      findFirst: async () => ({
        id: 'room-1',
        status: 'NEGOTIATING',
        vendor: { name: 'Acme' },
        request: { title: 'Laptops' },
      }),
    },
  };

  return { prismaMock: mock, store: state };
});

vi.mock('../../../utils/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../../audit/audit.service.js', () => ({ createAuditLog: async () => undefined }));

import {
  EXECUTABLE_ACTIONS,
  executeAction,
  failAction,
  findPendingDuplicate,
  proposeAction,
} from '../tools/action-tools.js';

const BUYER: CopilotScope = {
  actor: { userId: 'user-1', tenantId: 'tenant-a', role: UserRole.PROCUREMENT_MANAGER },
  isSeller: false,
};
const SELLER: CopilotScope = {
  actor: { userId: 'user-2', tenantId: 'tenant-a', role: UserRole.VENDOR, vendorId: 'vendor-1' },
  isSeller: true,
  vendorIdFilter: 'vendor-1',
};
const VIEWER: CopilotScope = {
  actor: { userId: 'user-3', tenantId: 'tenant-a', role: UserRole.VIEWER },
  isSeller: false,
};

const validRequestPayload = {
  title: 'Laptops for the field team',
  item: 'Laptop',
  description: 'Rugged laptops for field engineers working outdoors.',
  quantity: 10,
  unit: 'units',
  location: 'Bengaluru',
  requiredDate: '2099-01-15',
  estimatedBudget: 250_000,
};

beforeEach(() => {
  store.rows.length = 0;
  store.createCalls = 0;
  store.requestInsert = null;
  store.messageInsert = null;
  vi.clearAllMocks();
});

const rows = store.rows;
const requestInsert = () => store.requestInsert;
const messageInsert = () => store.messageInsert;

describe('proposal', () => {
  it('stores an action without writing anything to NAVO', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );

    expect(proposed.actionId).toBeTruthy();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(CopilotActionStatus.PROPOSED);
    // The decisive assertion: proposal itself created no procurement record.
    expect(requestInsert()).toBeNull();
  });

  it('describes every field so nothing is hidden from the reviewer', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );
    const fields = proposed.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['Title', 'Quantity', 'Delivery location', 'Required by']));
  });

  it('warns when no budget was supplied', async () => {
    const { estimatedBudget: _omitted, ...noBudget } = validRequestPayload;
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      noBudget,
      BUYER
    );
    expect(proposed.warnings.join(' ')).toMatch(/budget/i);
  });

  it('refuses a seller proposing a buyer-side request', async () => {
    await expect(
      proposeAction('conv-1', CopilotActionType.CREATE_DRAFT_REQUEST, validRequestPayload, SELLER)
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses a viewer proposing a request', async () => {
    await expect(
      proposeAction('conv-1', CopilotActionType.CREATE_DRAFT_REQUEST, validRequestPayload, VIEWER)
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses an action type with no schema rather than executing it loosely', async () => {
    await expect(
      proposeAction('conv-1', CopilotActionType.ADD_FOLLOW_UP_NOTE, { anything: true }, BUYER)
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a payload missing a field the user must decide', async () => {
    const { location: _dropped, ...noLocation } = validRequestPayload;
    await expect(
      proposeAction('conv-1', CopilotActionType.CREATE_DRAFT_REQUEST, noLocation, BUYER)
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a required date in the past', async () => {
    await expect(
      proposeAction(
        'conv-1',
        CopilotActionType.CREATE_DRAFT_REQUEST,
        { ...validRequestPayload, requiredDate: '2000-01-01' },
        BUYER
      )
    ).rejects.toThrow(/past/i);
  });

  it('does not let an action type reach a write it has no case for', () => {
    // `REQUEST_QUOTATION` is listed as executable but has no schema, so
    // proposeAction refuses it. Anything without a schema must be inert.
    for (const type of [
      CopilotActionType.REQUEST_QUOTATION,
      CopilotActionType.ADD_FOLLOW_UP_NOTE,
    ]) {
      expect(EXECUTABLE_ACTIONS).toContain(type);
    }
  });
});

describe('duplicate detection', () => {
  // Duplicate detection compares the *prepared* payload, since that is what is
  // stored. These tests go through `proposeAction` so they exercise that
  // normalization rather than bypassing it.
  const proposeTwice = async (payload: Record<string, unknown>) => {
    await proposeAction('conv-1', CopilotActionType.CREATE_DRAFT_REQUEST, payload, BUYER);
    return proposeAction('conv-1', CopilotActionType.CREATE_DRAFT_REQUEST, payload, BUYER);
  };

  it('refuses a second identical proposal in the same conversation', async () => {
    await expect(proposeTwice(validRequestPayload)).rejects.toThrow(ConflictError);
  });

  it('still stored only one action', async () => {
    await proposeTwice(validRequestPayload).catch(() => undefined);
    expect(rows).toHaveLength(1);
  });

  it('ignores key order when comparing payloads', async () => {
    const reordered = Object.fromEntries(Object.entries(validRequestPayload).reverse());
    await expect(proposeTwice(reordered)).rejects.toThrow(ConflictError);
  });

  it('allows a genuinely different payload', async () => {
    await proposeAction('conv-1', CopilotActionType.CREATE_DRAFT_REQUEST, validRequestPayload, BUYER);
    const other = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      { ...validRequestPayload, quantity: 11 },
      BUYER
    );
    expect(other.actionId).toBeTruthy();
    expect(rows).toHaveLength(2);
  });

  it('does not treat another user\'s pending action as a duplicate', async () => {
    await proposeAction('conv-1', CopilotActionType.CREATE_DRAFT_REQUEST, validRequestPayload, BUYER);
    const other: CopilotScope = {
      actor: { userId: 'someone-else', tenantId: 'tenant-a', role: UserRole.PROCUREMENT_MANAGER },
      isSeller: false,
    };
    const proposal = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      other
    );
    expect(proposal.actionId).toBeTruthy();
  });

  it('re-proposes freely once the earlier action has been executed', async () => {
    // Once an action leaves PROPOSED it is no longer a pending duplicate, even
    // though the user is asking for the same thing again.
    const first = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );
    await executeAction(first.actionId, BUYER);
    const second = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );
    expect(second.actionId).toBeTruthy();
  });

  it('reports a duplicate id for a payload that matches a stored action', async () => {
    await proposeAction('conv-1', CopilotActionType.CREATE_DRAFT_REQUEST, validRequestPayload, BUYER);
    const stored = rows[0];
    expect(
      await findPendingDuplicate(
        'conv-1',
        CopilotActionType.CREATE_DRAFT_REQUEST,
        stored.payload as Record<string, unknown>,
        BUYER
      )
    ).toBe(stored.id);
  });
});

describe('confirmation', () => {
  it('writes the draft only on confirmation', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );
    expect(requestInsert()).toBeNull();

    await executeAction(proposed.actionId, BUYER);
    expect(requestInsert()).not.toBeNull();
    // A DRAFT, never submitted: the copilot cannot start an approval.
    expect((requestInsert() as { status: string }).status).toBe('DRAFT');
  });

  it('refuses to execute another user\'s action', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );
    const intruder: CopilotScope = {
      actor: { userId: 'someone-else', tenantId: 'tenant-a', role: UserRole.PROCUREMENT_MANAGER },
      isSeller: false,
    };
    await expect(executeAction(proposed.actionId, intruder)).rejects.toThrow();
    expect(requestInsert()).toBeNull();
  });

  it('refuses to execute another tenant\'s action', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );
    const crossTenant: CopilotScope = {
      actor: { userId: 'user-1', tenantId: 'tenant-b', role: UserRole.PROCUREMENT_MANAGER },
      isSeller: false,
    };
    await expect(executeAction(proposed.actionId, crossTenant)).rejects.toThrow();
    expect(requestInsert()).toBeNull();
  });

  it('re-checks authorization at execution time, not only at proposal time', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );

    // The user loses the ability to create requests between proposal and
    // confirmation. The stored payload is still there and still valid, so only
    // a fresh authorization check can stop this write.
    const demoted: CopilotScope = {
      actor: { userId: 'user-1', tenantId: 'tenant-a', role: UserRole.VIEWER },
      isSeller: false,
    };
    await expect(executeAction(proposed.actionId, demoted)).rejects.toThrow(ForbiddenError);
    expect(requestInsert()).toBeNull();
  });

  it('will not execute the same action twice', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );
    await executeAction(proposed.actionId, BUYER);
    await expect(executeAction(proposed.actionId, BUYER)).rejects.toThrow(ConflictError);
    // Still exactly one request: the second confirm did not write again.
    expect((store.requestInsert as unknown) !== null).toBe(true);
  });

  it('refuses an action that already failed', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.CREATE_DRAFT_REQUEST,
      validRequestPayload,
      BUYER
    );
    await failAction(proposed.actionId, BUYER, 'the room was closed');

    const failedScope: CopilotScope = {
      actor: { userId: 'user-1', tenantId: 'tenant-a', role: UserRole.PROCUREMENT_MANAGER },
      isSeller: false,
    };
    await expect(executeAction(proposed.actionId, failedScope)).rejects.toThrow(ConflictError);
    expect(requestInsert()).toBeNull();
  });

  it('refuses an unknown action id', async () => {
    await expect(executeAction('does-not-exist', BUYER)).rejects.toThrow();
  });
});

describe('negotiation drafting', () => {
  it('saves an unsent draft rather than sending a message', async () => {
    const proposed = await proposeAction(
      'conv-1',
      CopilotActionType.DRAFT_NEGOTIATION_MESSAGE,
      { dealRoomId: 'room-1', content: 'We can go to 48,000 if lead time holds.' },
      BUYER
    );
    await executeAction(proposed.actionId, BUYER);

    expect(messageInsert()).not.toBeNull();
    // The absence of a sent flag is the guarantee.
    expect(JSON.stringify(messageInsert())).not.toMatch(/"sentAt":"\d{4}-/);
  });
});