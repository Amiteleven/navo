import { describe, expect, it } from 'vitest';
import {
  DiscrepancySeverity,
  InvoiceMatchStatus,
  InvoiceStatus,
  PaymentStatus,
  PurchaseOrderStatus,
} from '../types';
import {
  discrepancyClass,
  discrepancyLabel,
  documentCategoryLabel,
  formatAmount,
  formatDate,
  formatDateTime,
  formatFileSize,
  invoiceStatusLabel,
  isAwaitingSupplier,
  isEditableStatus,
  matchStatusLabel,
  poStatusClass,
  poStatusLabel,
  paymentStatusLabel,
  statusBadgeClass,
} from './purchaseOrder';
import { DocumentCategory } from '../types';

describe('formatAmount', () => {
  it('always renders exactly two decimals', () => {
    expect(formatAmount(1040.5)).toBe('1040.50');
    expect(formatAmount(1040.567)).toBe('1040.57');
    expect(formatAmount(0)).toBe('0.00');
  });

  it('appends the currency when given', () => {
    expect(formatAmount(70579.08, 'INR')).toBe('70579.08 INR');
  });

  it('accepts numeric strings from the API', () => {
    expect(formatAmount('1040.50')).toBe('1040.50');
  });

  it('falls back to zero for missing or non-finite values', () => {
    expect(formatAmount(null)).toBe('0.00');
    expect(formatAmount(undefined)).toBe('0.00');
    expect(formatAmount(Number.NaN)).toBe('0.00');
    expect(formatAmount(Number.POSITIVE_INFINITY)).toBe('0.00');
  });

  it('never surfaces floating point noise', () => {
    // 0.1 + 0.2 in float space. Money arrives as a JSON number, so the
    // formatter has to absorb the drift rather than expose it.
    expect(formatAmount(0.1 + 0.2)).toBe('0.30');
  });

  it('rounds half away from zero rather than on the binary value', () => {
    // toFixed rounds the binary representation, giving 1.00 and 2.67 here.
    expect(formatAmount(1.005)).toBe('1.01');
    expect(formatAmount(2.675)).toBe('2.68');
    expect(formatAmount(1.015)).toBe('1.02');
  });

  it('rounds negatives away from zero', () => {
    expect(formatAmount(-12.345)).toBe('-12.35');
    expect(formatAmount(-0.125)).toBe('-0.13');
  });

  it('handles extreme magnitudes without corrupting the value', () => {
    expect(formatAmount(1e-9)).toBe('0.00');
    expect(formatAmount(0)).toBe('0.00');
    // Past Number.MAX_SAFE_INTEGER the exponent shift cannot be trusted, so the
    // formatter defers to toFixed, which switches to exponential notation.
    expect(formatAmount(1e21)).toBe((1e21).toFixed(2));
  });
});

describe('formatDate', () => {
  it('returns an em dash for absent or unparseable values', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });

  it('formats a valid ISO string as YYYY-MM-DD', () => {
    expect(formatDate('2026-10-01T08:45:07.000Z')).toBe('2026-10-01');
  });
});

describe('formatDateTime', () => {
  it('returns an em dash for absent values', () => {
    expect(formatDateTime(null)).toBe('—');
  });

  it('marks the zone explicitly', () => {
    expect(formatDateTime('2026-10-01T08:45:07.000Z')).toBe('2026-10-01 08:45 UTC');
  });
});

describe('formatFileSize', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('status presentation', () => {
  it('labels every purchase order status', () => {
    for (const status of Object.values(PurchaseOrderStatus)) {
      expect(poStatusLabel(status)).toBeTruthy();
      expect(poStatusClass(status)).toBeTruthy();
    }
  });

  it('falls back to the raw value for an unknown status', () => {
    const unknown = 'NOT_A_STATUS' as PurchaseOrderStatus;
    expect(poStatusLabel(unknown)).toBe('NOT_A_STATUS');
    expect(poStatusClass(unknown)).toBe('bg-stone-100 text-stone-700');
  });

  it('distinguishes blocking statuses from terminal ones', () => {
    expect(poStatusClass(PurchaseOrderStatus.CANCELLED)).not.toBe(
      poStatusClass(PurchaseOrderStatus.DELIVERED)
    );
    expect(poStatusClass(PurchaseOrderStatus.PENDING_APPROVAL)).toContain('amber');
    expect(poStatusClass(PurchaseOrderStatus.DELIVERED)).toContain('emerald');
  });

  it('builds badge markup for statuses rendered as badges', () => {
    expect(statusBadgeClass(PurchaseOrderStatus.ISSUED)).toBe(
      `badge ${poStatusClass(PurchaseOrderStatus.ISSUED)}`
    );
  });

  it('labels invoices, payments and discrepancies', () => {
    expect(invoiceStatusLabel(InvoiceStatus.DISCREPANCIES_FOUND)).toBe('Discrepancies found');
    expect(paymentStatusLabel(PaymentStatus.PARTIALLY_PAID)).toBe('Partially paid');
    expect(discrepancyLabel('TOTAL_MISMATCH')).toBe('Total mismatch');
    expect(documentCategoryLabel(DocumentCategory.PROOF_OF_DELIVERY)).toBe('Proof of delivery');
  });

  it('colours critical discrepancies as blocking', () => {
    expect(discrepancyClass(DiscrepancySeverity.CRITICAL)).toContain('red');
    expect(discrepancyClass(DiscrepancySeverity.WARNING)).toContain('amber');
  });

  it('reports an unverified match status honestly', () => {
    expect(matchStatusLabel(InvoiceMatchStatus.MATCHED)).toBe('Matched');
    expect(matchStatusLabel(InvoiceMatchStatus.DISCREPANCIES)).toBe('Discrepancies found');
    expect(matchStatusLabel(InvoiceMatchStatus.NOT_STARTED)).toBe('Not verified');
  });
});

describe('status predicates', () => {
  it('allows commercial edits only before issuance', () => {
    expect(isEditableStatus(PurchaseOrderStatus.DRAFT)).toBe(true);
    expect(isEditableStatus(PurchaseOrderStatus.PENDING_APPROVAL)).toBe(true);
    expect(isEditableStatus(PurchaseOrderStatus.ISSUED)).toBe(false);
    expect(isEditableStatus(PurchaseOrderStatus.DELIVERED)).toBe(false);
    expect(isEditableStatus(PurchaseOrderStatus.CANCELLED)).toBe(false);
  });

  it('treats delivery states as supplier-owned', () => {
    expect(isAwaitingSupplier(PurchaseOrderStatus.ISSUED)).toBe(true);
    expect(isAwaitingSupplier(PurchaseOrderStatus.SUPPLIER_CONFIRMED)).toBe(true);
    expect(isAwaitingSupplier(PurchaseOrderStatus.IN_PROGRESS)).toBe(true);
    expect(isAwaitingSupplier(PurchaseOrderStatus.DRAFT)).toBe(false);
    expect(isAwaitingSupplier(PurchaseOrderStatus.DELIVERED)).toBe(false);
  });
});