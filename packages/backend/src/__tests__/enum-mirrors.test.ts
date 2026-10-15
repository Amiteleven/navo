import { describe, expect, it } from 'vitest';
import * as PrismaEnums from '@prisma/client';
import {
  AuditAction,
  NotificationEventType,
  NotificationPriority,
  RequestVisibility,
  InterestStatus,
  RestrictionKind,
  ReportReason,
  NotificationFrequency,
  VendorStatus,
} from '@navo/shared';

/**
 * Enum mirror tests.
 *
 * `@navo/shared` re-declares several Prisma enums so the frontend can use them
 * without a Prisma dependency. That duplication is safe only while the two stay
 * in step, and drift is invisible until a write fails at runtime with
 * "Invalid value for argument" - after the record it was meant to record has
 * already been created, so the caller sees a 500 for an action that succeeded.
 *
 * These tests are the guard. They cost nothing at runtime and they fail on the
 * PR that introduces a new value in one place and not the other.
 */

type EnumRecord = Record<string, string>;

function values(enumObject: object): string[] {
  return Object.values(enumObject as EnumRecord);
}

/** Every member, sorted, so the diff message names only what differs. */
function sorted(list: string[]): string[] {
  return [...list].sort();
}

function compareMirror(
  label: string,
  prismaEnum: object,
  sharedEnum: object,
  options: { subset?: boolean } = {}
): void {
  const prismaValues = sorted(values(prismaEnum));
  const sharedValues = sorted(values(sharedEnum));

  if (options.subset) {
    // The shared enum may be narrower, but must never name a value Prisma
    // rejects: every shared value must exist in Prisma.
    const unknownToPrisma = sharedValues.filter((value) => !prismaValues.includes(value));
    expect(
      unknownToPrisma,
      `${label}: shared enum has values Prisma does not accept`
    ).toEqual([]);
    return;
  }

  const missingFromShared = prismaValues.filter((v) => !sharedValues.includes(v));
  const missingFromPrisma = sharedValues.filter((v) => !prismaValues.includes(v));

  expect(missingFromShared, `${label}: Prisma values absent from @navo/shared`).toEqual([]);
  expect(missingFromPrisma, `${label}: @navo/shared values absent from Prisma`).toEqual([]);
}

describe('AuditAction mirrors Prisma', () => {
  it('every audit action the code can write is a valid Prisma value', () => {
    compareMirror('AuditAction', PrismaEnums.AuditAction, AuditAction, { subset: true });
  });

  it('covers the marketplace and communication actions', () => {
    // These were added to the shared enum first and were missing from the
    // schema, which made every publish, block and interest write fail.
    const prismaValues = values(PrismaEnums.AuditAction);
    for (const action of [
      AuditAction.REQUIREMENT_PUBLISHED,
      AuditAction.REQUIREMENT_WITHDRAWN,
      AuditAction.MARKETPLACE_INTEREST_EXPRESSED,
      AuditAction.MARKETPLACE_INTEREST_WITHDRAWN,
      AuditAction.VENDOR_BLOCKED,
      AuditAction.VENDOR_MUTED,
      AuditAction.VENDOR_UNBLOCKED,
      AuditAction.ABUSE_REPORT_FILED,
      AuditAction.SELLER_MESSAGE_BLOCKED,
      AuditAction.NEGOTIATION_MESSAGE_BLOCKED,
      AuditAction.MESSAGE_ATTACHMENT_ADDED,
      AuditAction.EMAIL_DELIVERY_FAILED,
    ]) {
      expect(prismaValues, `${action} missing from Prisma AuditAction`).toContain(action);
    }
  });
});

describe('NotificationType mirrors Prisma', () => {
  it('every notification event is a valid Prisma value', () => {
    compareMirror('NotificationEventType', PrismaEnums.NotificationType, NotificationEventType, {
      subset: true,
    });
  });

  it('covers the phase 7 events', () => {
    const prismaValues = values(PrismaEnums.NotificationType);
    for (const event of [
      NotificationEventType.REQUIREMENT_PUBLISHED,
      NotificationEventType.MARKETPLACE_INTEREST,
      NotificationEventType.NEGOTIATION_MESSAGE,
      NotificationEventType.COUNTEROFFER,
      NotificationEventType.OFFER_ACCEPTED,
      NotificationEventType.DEAL_CLOSED,
    ]) {
      expect(prismaValues, `${event} missing from Prisma NotificationType`).toContain(event);
    }
  });

  it('notification priority mirrors Prisma', () => {
    compareMirror('NotificationPriority', PrismaEnums.NotificationPriority, NotificationPriority);
  });
});

describe('marketplace enums mirror Prisma', () => {
  it('request visibility', () => {
    compareMirror('RequestVisibility', PrismaEnums.RequestVisibility, RequestVisibility);
  });

  it('interest status', () => {
    compareMirror('InterestStatus', PrismaEnums.InterestStatus, InterestStatus);
  });

  it('restriction kind', () => {
    compareMirror('RestrictionKind', PrismaEnums.RestrictionKind, RestrictionKind);
  });

  it('report reason', () => {
    compareMirror('ReportReason', PrismaEnums.ReportReason, ReportReason);
  });

  it('email delivery status has no shared mirror, but the values are named', () => {
    // `EmailDeliveryStatus` is imported straight from Prisma by the
    // notification service, so there is no second declaration to drift. What
    // matters is that the statuses the service writes and branches on are the
    // ones the column actually accepts.
    const prismaValues = values(PrismaEnums.EmailDeliveryStatus);
    for (const status of [
      'PENDING',
      'SENT',
      'FAILED',
      'PERMANENTLY_FAILED',
      'SUPPRESSED',
    ]) {
      expect(prismaValues, `${status} missing from Prisma EmailDeliveryStatus`).toContain(status);
    }
  });

  it('vendor status', () => {
    compareMirror('VendorStatus', PrismaEnums.VendorStatus, VendorStatus);
  });

  it('notification frequency has no database enum to drift from', () => {
    // Frequency is stored as a column value, not a Postgres enum, so the
    // assertion is simply that the set is what the service branches on.
    expect(sorted(values(NotificationFrequency))).toEqual(['DIGEST', 'IMMEDIATE', 'OFF']);
  });
});

describe('prerequisite behaviour', () => {
  it('reports drift instead of silently passing when Prisma lacks a value', () => {
    // Proves the assertions above are meaningful: a deliberately wrong mirror
    // must fail, otherwise the suite would pass on any two enums.
    const wrongMirror = { A: 'A', GHOST: 'GHOST' };
    expect(() =>
      compareMirror('WrongMirror', { A: 'A' }, wrongMirror)
    ).toThrow(/WrongMirror/);
  });
});