import { Prisma } from '@prisma/client';
import { ValidationError } from './errors.js';

/**
 * Money helpers for Phase 5.
 *
 * All persisted monetary values use Prisma `Decimal`. Legacy Phase 1-4 columns
 * are `Float`, so conversion in both directions is required. The rule applied
 * throughout: never do arithmetic in JavaScript `number` for money, because
 * binary floating point silently corrupts values like 0.1 + 0.2 and produces
 * mismatches in three-way invoice matching.
 *
 * Decimal -> number conversion uses the *shortest round-trip string
 * representation* (`toString()`), not `toNumber()`. `toString()` yields the
 * exact literal the user typed ("1040.50"), whereas `toNumber()` re-derives a
 * binary float and can render "1040.4999999999999" in JSON.
 */

/** Monetary scale used for storage and comparison. */
export const MONEY_SCALE = 4;

/** Human-facing display scale (2 dp) - used for PDF text only. */
export const DISPLAY_SCALE = 2;

/** Convert an incoming value to Decimal without ever passing through a float. */
export function toDecimal(value: unknown, field = 'amount'): Prisma.Decimal {
  if (value === null || value === undefined || value === '') {
    return new Prisma.Decimal(0);
  }
  if (value instanceof Prisma.Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${field} must be a finite number`);
    }
    // Route through the shortest string form so 19.99 does not become
    // 19.989999999999998 when Decimal re-parses it.
    return new Prisma.Decimal(value.toString());
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new ValidationError(`${field} must be a decimal number`);
    }
    return new Prisma.Decimal(trimmed);
  }
  if (typeof value === 'bigint') return new Prisma.Decimal(value.toString());
  throw new ValidationError(`${field} is not a valid amount`);
}

/**
 * Convert a Decimal to a JSON-safe number for API responses.
 * Uses the shortest round-trip string form, which is exact for values the
 * user entered and stable across repeated requests.
 */
export function decimalToNumber(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(new Prisma.Decimal(value).toString());
}

/** Round to the storage scale using Decimal's own rounding (half-even). */
export function roundMoney(value: Prisma.Decimal | number | string, scale = MONEY_SCALE): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_EVEN);
}

/** Round a value for 2dp display in printed documents. */
export function roundDisplay(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(DISPLAY_SCALE, Prisma.Decimal.ROUND_HALF_EVEN);
}

/**
 * Compare two amounts, returning true when they are equal *within tolerance*.
 * The comparison is done in Decimal space after rounding both sides to the
 * storage scale, so "100.0000" and "100" compare equal and 0.1+0.2 style drift
 * never registers as a discrepancy.
 */
export function amountsEqual(
  a: Prisma.Decimal | number | string,
  b: Prisma.Decimal | number | string,
  tolerance: Prisma.Decimal | number | string = 0,
): boolean {
  const left = roundMoney(a);
  const right = roundMoney(b);
  const allowed = roundMoney(tolerance).abs();
  return left.minus(right).abs().lte(allowed);
}

/** Exact difference `a - b`, rounded to the storage scale. */
export function difference(a: Prisma.Decimal | number | string, b: Prisma.Decimal | number | string): Prisma.Decimal {
  return roundMoney(new Prisma.Decimal(a).minus(new Prisma.Decimal(b)));
}

/** `quantity * unitPrice`, rounded to the storage scale. */
export function multiplyQuantity(quantity: number, unitPrice: Prisma.Decimal | number | string): Prisma.Decimal {
  return roundMoney(new Prisma.Decimal(quantity).times(new Prisma.Decimal(unitPrice)));
}

/**
 * Derive subtotal, tax, and total from the component amounts. Keeping this in
 * one place means the PO, invoice, and match paths cannot disagree about how a
 * total is composed.
 */
export function computeTotals(input: {
  quantity: number;
  unitPrice: Prisma.Decimal | number | string;
  taxRate: Prisma.Decimal | number | string;
  freightAmount?: Prisma.Decimal | number | string;
  installationAmount?: Prisma.Decimal | number | string;
  otherCharges?: Prisma.Decimal | number | string;
}) {
  const unitPrice = roundMoney(input.unitPrice);
  const subtotal = multiplyQuantity(input.quantity, unitPrice);
  const taxRate = roundMoney(input.taxRate, MONEY_SCALE);
  const taxAmount = roundMoney(subtotal.times(taxRate).dividedBy(100));
  const freight = roundMoney(input.freightAmount ?? 0);
  const installation = roundMoney(input.installationAmount ?? 0);
  const other = roundMoney(input.otherCharges ?? 0);
  const total = roundMoney(subtotal.plus(taxAmount).plus(freight).plus(installation).plus(other));
  return { unitPrice, taxRate, subtotal, taxAmount, freight, installation, other, total };
}

/** Format an amount for printed documents, e.g. "1040.50". */
export function formatMoney(value: Prisma.Decimal | number | string, currency?: string): string {
  const formatted = roundDisplay(value).toFixed(DISPLAY_SCALE);
  return currency ? `${formatted} ${currency}` : formatted;
}