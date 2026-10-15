import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  amountsEqual,
  computeTotals,
  decimalToNumber,
  difference,
  roundMoney,
  toDecimal,
} from './money';

describe('toDecimal', () => {
  it('accepts strings without float drift', () => {
    expect(toDecimal('19.99').toString()).toBe('19.99');
    expect(toDecimal(19.99).toString()).toBe('19.99');
    expect(toDecimal(0.1).toString()).toBe('0.1');
  });

  it('treats empty input as zero', () => {
    expect(toDecimal(undefined).toString()).toBe('0');
    expect(toDecimal(null).toString()).toBe('0');
    expect(toDecimal('').toString()).toBe('0');
  });

  it('rejects malformed amounts', () => {
    expect(() => toDecimal('abc', 'unitPrice')).toThrow();
    expect(() => toDecimal('1.2.3', 'unitPrice')).toThrow();
    expect(() => toDecimal({} as unknown as number, 'unitPrice')).toThrow();
    expect(() => toDecimal(Number.NaN, 'unitPrice')).toThrow();
  });
});

describe('decimalToNumber', () => {
  it('round-trips the shortest representation', () => {
    expect(decimalToNumber(new Prisma.Decimal('1040.50'))).toBe(1040.5);
    expect(String(decimalToNumber(new Prisma.Decimal('19.99')))).toBe('19.99');
  });

  it('maps null to zero', () => {
    expect(decimalToNumber(null)).toBe(0);
  });
});

describe('computeTotals', () => {
  it('keeps money in Decimal space', () => {
    const totals = computeTotals({
      quantity: 3,
      unitPrice: toDecimal('19.99'),
      taxRate: toDecimal('18'),
      freightAmount: toDecimal('250.50'),
      installationAmount: toDecimal('100'),
      otherCharges: 0,
    });

    expect(totals.subtotal.toString()).toBe('59.97');
    expect(totals.taxAmount.toString()).toBe('10.7946');
    expect(totals.total.toString()).toBe('421.2646');
  });

  it('does not drift where float arithmetic would', () => {
    // Genuine binary-float drift cases. In JavaScript:
    //   1.005 * 100 === 100.49999999999999
    //   0.1 + 0.2    === 0.30000000000000004
    // A tax or freight line computed this way would breach a 1.00 tolerance
    // check spuriously, or pass a real mismatch. Decimal never drifts.
    expect(1.005 * 100).not.toBe(100.5);
    expect(0.1 + 0.2).not.toBe(0.3);

    expect(decimalToNumber(roundMoney(toDecimal('1.005').times(100)))).toBe(100.5);
    expect(decimalToNumber(roundMoney(toDecimal('0.1').plus(toDecimal('0.2'))))).toBe(0.3);
  });
});

describe('amountsEqual', () => {
  it('applies tolerance symmetrically', () => {
    expect(amountsEqual('100.0000', '100', 0)).toBe(true);
    // 0.02 apart, within a 1.00 tolerance.
    expect(amountsEqual('100.02', '100.00', '1.00')).toBe(true);
    // 1.50 apart, outside a 1.00 tolerance.
    expect(amountsEqual('101.50', '100.00', '1.00')).toBe(false);
    // Negative tolerance is treated as its absolute value.
    expect(amountsEqual('100.00', '101.50', '-1.50')).toBe(true);
    expect(amountsEqual('100.00', '101.60', '-1.50')).toBe(false);
  });
});

describe('difference', () => {
  it('is signed and preserves the storage scale', () => {
    // Decimal.toString() does not pad trailing zeros; toFixed does.
    expect(difference('100.00', '99.00').toFixed(4)).toBe('1.0000');
    expect(difference('99.00', '100.00').toFixed(4)).toBe('-1.0000');
  });

  it('is scale-insensitive under Decimal equality', () => {
    expect(difference('100.00', '99.00').equals(new Prisma.Decimal('1'))).toBe(true);
  });
});