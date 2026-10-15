import {
  DeliveryEventType,
  DiscrepancyResolution,
  DiscrepancySeverity,
  DocumentCategory,
  InvoiceMatchStatus,
  InvoiceStatus,
  PaymentStatus,
  PurchaseOrderStatus,
} from '../types';

/**
 * Presentation helpers for the purchase-execution domain.
 *
 * Kept in one place so a status is labelled and coloured identically on the
 * list, the detail page and the printable document. Money is formatted with
 * `toFixed(2)` rather than `Intl.NumberFormat` so a printed total always shows
 * exactly two decimals, which is what a purchase order document requires.
 */

export const PO_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  [PurchaseOrderStatus.DRAFT]: 'Draft',
  [PurchaseOrderStatus.PENDING_APPROVAL]: 'Pending approval',
  [PurchaseOrderStatus.ISSUED]: 'Issued',
  [PurchaseOrderStatus.SUPPLIER_CONFIRMED]: 'Supplier confirmed',
  [PurchaseOrderStatus.IN_PROGRESS]: 'In progress',
  [PurchaseOrderStatus.PARTIALLY_DELIVERED]: 'Partially delivered',
  [PurchaseOrderStatus.DELIVERED]: 'Delivered',
  [PurchaseOrderStatus.CLOSED]: 'Closed',
  [PurchaseOrderStatus.CANCELLED]: 'Cancelled',
};

type Tone = 'neutral' | 'info' | 'progress' | 'warning' | 'success' | 'danger';

const PO_STATUS_TONES: Record<PurchaseOrderStatus, Tone> = {
  [PurchaseOrderStatus.DRAFT]: 'neutral',
  [PurchaseOrderStatus.PENDING_APPROVAL]: 'warning',
  [PurchaseOrderStatus.ISSUED]: 'info',
  [PurchaseOrderStatus.SUPPLIER_CONFIRMED]: 'info',
  [PurchaseOrderStatus.IN_PROGRESS]: 'progress',
  [PurchaseOrderStatus.PARTIALLY_DELIVERED]: 'progress',
  [PurchaseOrderStatus.DELIVERED]: 'success',
  [PurchaseOrderStatus.CLOSED]: 'neutral',
  [PurchaseOrderStatus.CANCELLED]: 'danger',
};

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700',
  info: 'bg-blue-50 text-blue-700',
  progress: 'bg-indigo-50 text-indigo-700',
  warning: 'bg-amber-50 text-amber-700',
  success: 'bg-emerald-50 text-emerald-700',
  danger: 'bg-red-50 text-red-700',
};

export function poStatusLabel(status: PurchaseOrderStatus): string {
  return PO_STATUS_LABELS[status] ?? status;
}

export function poStatusClass(status: PurchaseOrderStatus): string {
  return TONE_CLASSES[PO_STATUS_TONES[status] ?? 'neutral'];
}

/** Badge markup matching the existing `.badge` utility conventions. */
export function statusBadgeClass(status: PurchaseOrderStatus): string {
  return `badge ${poStatusClass(status)}`;
}

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  [InvoiceStatus.DRAFT]: 'Draft',
  [InvoiceStatus.SUBMITTED]: 'Submitted',
  [InvoiceStatus.UNDER_REVIEW]: 'Under review',
  [InvoiceStatus.VERIFIED]: 'Verified',
  [InvoiceStatus.DISCREPANCIES_FOUND]: 'Discrepancies found',
  [InvoiceStatus.REJECTED]: 'Rejected',
  [InvoiceStatus.DISPUTED]: 'Disputed',
};

const INVOICE_STATUS_TONES: Record<InvoiceStatus, Tone> = {
  [InvoiceStatus.DRAFT]: 'neutral',
  [InvoiceStatus.SUBMITTED]: 'info',
  [InvoiceStatus.UNDER_REVIEW]: 'warning',
  [InvoiceStatus.VERIFIED]: 'success',
  [InvoiceStatus.DISCREPANCIES_FOUND]: 'danger',
  [InvoiceStatus.REJECTED]: 'danger',
  [InvoiceStatus.DISPUTED]: 'warning',
};

export function invoiceStatusLabel(status: InvoiceStatus): string {
  return INVOICE_STATUS_LABELS[status] ?? status;
}

export function invoiceStatusClass(status: InvoiceStatus): string {
  return `badge ${TONE_CLASSES[INVOICE_STATUS_TONES[status] ?? 'neutral']}`;
}

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  [PaymentStatus.NOT_DUE]: 'Not due',
  [PaymentStatus.DUE]: 'Due',
  [PaymentStatus.PARTIALLY_PAID]: 'Partially paid',
  [PaymentStatus.PAID]: 'Paid',
  [PaymentStatus.ON_HOLD]: 'On hold',
  [PaymentStatus.DISPUTED]: 'Disputed',
};

const PAYMENT_STATUS_TONES: Record<PaymentStatus, Tone> = {
  [PaymentStatus.NOT_DUE]: 'neutral',
  [PaymentStatus.DUE]: 'warning',
  [PaymentStatus.PARTIALLY_PAID]: 'progress',
  [PaymentStatus.PAID]: 'success',
  [PaymentStatus.ON_HOLD]: 'neutral',
  [PaymentStatus.DISPUTED]: 'danger',
};

export function paymentStatusLabel(status: PaymentStatus): string {
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

export function paymentStatusClass(status: PaymentStatus): string {
  return `badge ${TONE_CLASSES[PAYMENT_STATUS_TONES[status] ?? 'neutral']}`;
}

export const DELIVERY_EVENT_LABELS: Record<DeliveryEventType, string> = {
  [DeliveryEventType.CONFIRMED]: 'Order confirmed',
  [DeliveryEventType.PREPARATION]: 'Preparing goods',
  [DeliveryEventType.DISPATCH]: 'Dispatched',
  [DeliveryEventType.IN_TRANSIT]: 'In transit',
  [DeliveryEventType.PARTIALLY_DELIVERED]: 'Partial delivery',
  [DeliveryEventType.DELIVERED]: 'Delivered',
  [DeliveryEventType.EXCEPTION]: 'Delivery exception',
};

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  [DocumentCategory.PURCHASE_ORDER]: 'Purchase order',
  [DocumentCategory.DELIVERY_NOTE]: 'Delivery note',
  [DocumentCategory.PROOF_OF_DELIVERY]: 'Proof of delivery',
  [DocumentCategory.INVOICE]: 'Invoice',
  [DocumentCategory.TAX_INVOICE]: 'Tax invoice',
  [DocumentCategory.SUPPORTING]: 'Supporting document',
  [DocumentCategory.RECEIPT]: 'Receipt',
};

export function documentCategoryLabel(category: DocumentCategory): string {
  return DOCUMENT_CATEGORY_LABELS[category] ?? category;
}

export const DISCREPANCY_TYPE_LABELS: Record<string, string> = {
  DUPLICATE_INVOICE: 'Duplicate invoice',
  QUANTITY_MISMATCH: 'Quantity mismatch',
  UNIT_PRICE_VARIATION: 'Unit price variation',
  TAX_MISMATCH: 'Tax mismatch',
  TOTAL_MISMATCH: 'Total mismatch',
  UNEXPECTED_CHARGE: 'Unexpected charge',
  MISSING_GOODS_RECEIPT: 'Missing goods receipt',
  UNVERIFIED_TAX_DETAILS: 'Unverified tax details',
};

export function discrepancyLabel(type: string): string {
  return DISCREPANCY_TYPE_LABELS[type] ?? type;
}

export function discrepancyClass(severity: DiscrepancySeverity): string {
  if (severity === DiscrepancySeverity.CRITICAL) return 'badge bg-red-50 text-red-700';
  if (severity === DiscrepancySeverity.WARNING) return 'badge bg-amber-50 text-amber-700';
  return 'badge bg-stone-100 text-stone-700';
}

export const RESOLUTION_LABELS: Record<DiscrepancyResolution, string> = {
  [DiscrepancyResolution.OPEN]: 'Open',
  [DiscrepancyResolution.ACCEPTED]: 'Accepted',
  [DiscrepancyResolution.WAIVED]: 'Waived',
  [DiscrepancyResolution.REJECTED]: 'Rejected',
};

export function matchStatusLabel(status: InvoiceMatchStatus): string {
  if (status === InvoiceMatchStatus.MATCHED) return 'Matched';
  if (status === InvoiceMatchStatus.DISCREPANCIES) return 'Discrepancies found';
  return 'Not verified';
}

/**
 * Format a monetary value with exactly two decimals.
 *
 * `toFixed` alone is not safe for money: it rounds on the underlying binary
 * value, so 1.005 renders as "1.00" and 2.675 as "2.67" — a printed purchase
 * order would then be a cent away from the stored total. Amounts arrive as JSON
 * numbers, so the value is first shifted into a scaled integer (rounding half
 * away from zero, as a document total should) and the decimal point is
 * reinserted as text.
 *
 * Extreme magnitudes fall back to `toFixed`, where the exponent trick would
 * overflow: a value past Number.MAX_SAFE_INTEGER cannot be scaled safely, and
 * one below 1e-6 is below the precision that matters.
 */
export function formatAmount(value: number | string | null | undefined, currency?: string): string {
  const numeric = typeof value === 'string' ? Number(value) : (value ?? 0);

  const format = (n: number): string => {
    if (!Number.isFinite(n)) return '0.00';
    if (Math.abs(n) >= 1e15 || (n !== 0 && Math.abs(n) < 1e-6)) return n.toFixed(2);

    const negative = n < 0;
    // `${n}e2` shifts the decimal point textually, so the rounding happens on
    // the decimal value rather than on its binary approximation.
    const scaled = Math.round(Number(`${Math.abs(n)}e2`));
    const digits = String(scaled).padStart(3, '0');
    const body = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
    return negative ? `-${body}` : body;
  };

  const formatted = format(numeric);
  return currency ? `${formatted} ${currency}` : formatted;
}

/** Format a date as YYYY-MM-DD, or an em dash when absent. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Statuses in which the buyer may still change commercial terms. Used to decide
 * whether an action row should be offered.
 */
export function isEditableStatus(status: PurchaseOrderStatus): boolean {
  return [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.PENDING_APPROVAL].includes(status);
}

/** Statuses in which the supplier is expected to act. */
export function isAwaitingSupplier(status: PurchaseOrderStatus): boolean {
  return [PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.SUPPLIER_CONFIRMED, PurchaseOrderStatus.IN_PROGRESS].includes(status);
}