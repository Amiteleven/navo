import { Prisma } from '@prisma/client';
import { decimalToNumber } from './money.js';

/**
 * Response serialization for Phase 5 money fields.
 *
 * Prisma's `Decimal` serialises to JSON as a *string* to avoid precision loss.
 * That is correct for storage and comparison, but it leaves the API contract
 * inconsistent: derived values (PO summaries, payment totals, assistant
 * answers) are already numbers, so a client would have to coerce per-field
 * depending on which endpoint it called - and a string like "57906" + "10423.08"
 * concatenates silently instead of adding.
 *
 * Every monetary value therefore crosses the API as a JSON number. This is safe
 * because all money arithmetic happens server-side in Decimal space (money.ts);
 * clients only display or forward these values, never reconcile them.
 */

/**
 * Convert Decimal values to numbers throughout a response payload, recursing
 * through nested records and relation arrays so POs, invoices, payments and
 * verifications are all normalised by one call.
 */
export function serializeMoney<T>(value: T): T {
  if (value === null || value === undefined) return value;

  if (value instanceof Prisma.Decimal) {
    return decimalToNumber(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeMoney(item)) as unknown as T;
  }

  // Dates, Buffers and other non-plain objects are passed through untouched.
  if (typeof value !== 'object' || value instanceof Date || value instanceof Uint8Array) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = serializeMoney(inner);
  }
  return output as unknown as T;
}