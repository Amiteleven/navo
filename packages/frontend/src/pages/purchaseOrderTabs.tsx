import React, { useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Truck,
  PackageCheck,
  Receipt,
  Wallet,
  Paperclip,
  Upload,
  Download,
  FileQuestion,
  Info,
} from 'lucide-react';
import {
  purchaseOrderApi,
  PurchaseOrderDetail,
  InvoiceRecord,
  DocumentRecord,
  ReceiptTotals,
} from '../services/api';
import {
  DiscrepancyResolution,
  DocumentCategory,
  InvoiceMatchStatus,
  InvoiceStatus,
  PaymentStatus,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  TransactionTimelineEntry,
} from '../types';
import {
  DELIVERY_EVENT_LABELS,
  discrepancyClass,
  discrepancyLabel,
  documentCategoryLabel,
  formatAmount,
  formatDate,
  formatDateTime,
  formatFileSize,
  invoiceStatusClass,
  invoiceStatusLabel,
  matchStatusLabel,
  paymentStatusClass,
  paymentStatusLabel,
} from '../utils/purchaseOrder';

type RunFn = (key: string, action: () => Promise<unknown>, success: string) => Promise<void>;

// ── Overview ─────────────────────────────────────────────────────────────────

export const OverviewTab: React.FC<{ po: PurchaseOrderDetail; summary: PurchaseOrderSummary | null }> = ({
  po,
  summary,
}) => (
  <div className="grid gap-4 lg:grid-cols-3">
    <section className="card p-4 lg:col-span-2">
      <h2 className="text-sm font-semibold text-stone-800">Commercial terms</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <Field label="Item" value={po.itemName} />
        <Field label="Quantity" value={`${po.quantity}${po.unit ? ` ${po.unit}` : ''}`} />
        <Field label="Unit price" value={formatAmount(po.unitPrice, po.currency)} />
        <Field label="Subtotal" value={formatAmount(po.subtotal, po.currency)} />
        <Field
          label={`Tax (${po.taxRate}%)`}
          value={formatAmount(po.taxAmount, po.currency)}
        />
        <Field label="Freight" value={formatAmount(po.freightAmount, po.currency)} />
        <Field label="Installation" value={formatAmount(po.installationAmount, po.currency)} />
        <Field label="Other charges" value={formatAmount(po.otherCharges, po.currency)} />
        <Field
          label="Total"
          value={formatAmount(po.totalAmount, po.currency)}
          emphasis
        />
      </dl>

      {po.otherChargesDetails && (
        <p className="mt-3 text-xs text-stone-500">Other charges: {po.otherChargesDetails}</p>
      )}

      <div className="mt-4 grid gap-3 border-t border-stone-100 pt-3 text-sm sm:grid-cols-2">
        <Detail label="Delivery address" value={po.deliveryAddress ?? '—'} />
        <Detail label="Expected delivery" value={formatDate(po.expectedDeliveryDate)} />
        <Detail
          label="Supplier committed"
          value={formatDate(po.supplierConfirmedDeliveryDate)}
        />
        <Detail label="Actual delivery" value={formatDate(po.actualDeliveryDate)} />
        <Detail label="Payment terms" value={po.paymentTerms ?? '—'} />
        <Detail
          label="Warranty"
          value={po.warrantyMonths ? `${po.warrantyMonths} months` : '—'}
        />
      </div>

      {po.terms && (
        <div className="mt-3 border-t border-stone-100 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Terms</p>
          <p className="mt-1 whitespace-pre-line text-sm text-stone-700">{po.terms}</p>
        </div>
      )}

      {po.notes && (
        <div className="mt-3 border-t border-stone-100 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Notes</p>
          <p className="mt-1 whitespace-pre-line text-sm text-stone-700">{po.notes}</p>
        </div>
      )}
    </section>

    <div className="space-y-4">
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-stone-800">Progress</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <Row label="Received" value={`${summary?.acceptedQuantity ?? 0} of ${po.quantity}`} />
          <Row label="Invoiced" value={formatAmount(summary?.invoicedAmount ?? 0, po.currency)} />
          <Row label="Verified" value={formatAmount(summary?.verifiedAmount ?? 0, po.currency)} />
          <Row label="Paid" value={formatAmount(summary?.paidAmount ?? 0, po.currency)} />
          <Row
            label="Outstanding"
            value={formatAmount(summary?.outstandingAmount ?? po.totalAmount, po.currency)}
          />
        </dl>
        {summary?.daysDelayed ? (
          <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
            Delivery is {summary.daysDelayed} day(s) past the committed date.
          </p>
        ) : null}
      </section>

      {summary?.missingDocuments && summary.missingDocuments.length > 0 && (
        <section className="card border-amber-200 p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Missing documents
          </h2>
          <ul className="mt-2 list-inside list-disc text-xs text-amber-800">
            {(summary.missingDocuments ?? []).map((item: string) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {summary && (
        <section className="card p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
            <Info className="h-4 w-4" aria-hidden="true" />
            Position
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-stone-600">{summary.narrative}</p>
        </section>
      )}
    </div>
  </div>
);

// ── Delivery and receipts ────────────────────────────────────────────────────

export const DeliveryTab: React.FC<{
  po: PurchaseOrderDetail;
  canReceive: boolean;
  busy: string | null;
  run: RunFn;
  reload: () => Promise<void>;
}> = ({ po, canReceive, busy, run, reload }) => {
  const [totals, setTotals] = useState<ReceiptTotals | null>(null);
  const [received, setReceived] = useState('');
  const [accepted, setAccepted] = useState('');
  const [rejected, setRejected] = useState('');
  const [notes, setNotes] = useState('');

  const remaining = totals ? totals.remainingQuantity : po.quantity;

  React.useEffect(() => {
    purchaseOrderApi
      .getReceiptTotals(po.id)
      .then((response) => setTotals(response.data.data ?? null))
      .catch(() => setTotals(null));
  }, [po.id]);

  const numeric = (value: string) => (value === '' ? 0 : Number(value));
  const receivedQty = numeric(received);
  const acceptedQty = numeric(accepted);
  const rejectedQty = numeric(rejected);

  // Mirrors the server rule so the user sees the problem before submitting.
  const splitValid = receivedQty > 0 && acceptedQty + rejectedQty === receivedQty;
  const withinOrder = acceptedQty <= remaining;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="card p-4 lg:col-span-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
          <Truck className="h-4 w-4" aria-hidden="true" />
          Delivery milestones
        </h2>
        {po.deliveryEvents.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">No delivery updates recorded yet.</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {po.deliveryEvents.map((event) => (
              <li key={event.id} className="flex gap-3">
                <div className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-blue-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-stone-800">
                    {DELIVERY_EVENT_LABELS[event.type] ?? event.type}
                  </p>
                  <p className="text-xs text-stone-400">{formatDateTime(event.occurredAt)}</p>
                  {event.notes && <p className="mt-0.5 text-sm text-stone-600">{event.notes}</p>}
                  <p className="mt-0.5 text-xs text-stone-500">
                    {[event.carrierName, event.trackingRef && `Tracking: ${event.trackingRef}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}

        <h2 className="mt-6 flex items-center gap-1.5 border-t border-stone-100 pt-4 text-sm font-semibold text-stone-800">
          <PackageCheck className="h-4 w-4" aria-hidden="true" />
          Goods receipts
        </h2>
        {totals && (
          <p className="mt-1 text-xs text-stone-500">
            {totals.acceptedQuantity} of {totals.orderedQuantity} units accepted ·{' '}
            {totals.rejectedQuantity} rejected · {totals.remainingQuantity} outstanding
          </p>
        )}

        {po.goodsReceipts.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">Nothing received yet.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {po.goodsReceipts.map((receipt) => (
              <div key={receipt.id} className="rounded-lg border border-stone-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-stone-800">{receipt.receiptNumber}</span>
                  <span className="text-xs text-stone-400">{formatDate(receipt.receiptDate)}</span>
                </div>
                <p className="mt-1 text-sm text-stone-600">
                  Received {receipt.receivedQuantity} of {receipt.orderedQuantity} · accepted{' '}
                  {receipt.acceptedQuantity} · rejected {receipt.rejectedQuantity}
                </p>
                {receipt.conditionNotes && (
                  <p className="mt-0.5 text-xs text-stone-500">{receipt.conditionNotes}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {canReceive && (
        <section className="no-print card h-fit p-4">
          <h2 className="text-sm font-semibold text-stone-800">Record a receipt</h2>
          <p className="mt-1 text-xs text-stone-500">
            Partial deliveries are supported. {remaining} unit(s) remain to be accepted.
          </p>

          <div className="mt-3 space-y-2">
            <div>
              <label htmlFor="received-qty" className="label">
                Units received
              </label>
              <input
                id="received-qty"
                type="number"
                min={0}
                value={received}
                onChange={(event) => setReceived(event.target.value)}
                className="input w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="accepted-qty" className="label">
                  Accepted
                </label>
                <input
                  id="accepted-qty"
                  type="number"
                  min={0}
                  value={accepted}
                  onChange={(event) => setAccepted(event.target.value)}
                  className="input w-full"
                />
              </div>
              <div>
                <label htmlFor="rejected-qty" className="label">
                  Rejected
                </label>
                <input
                  id="rejected-qty"
                  type="number"
                  min={0}
                  value={rejected}
                  onChange={(event) => setRejected(event.target.value)}
                  className="input w-full"
                />
              </div>
            </div>
            <div>
              <label htmlFor="receipt-notes" className="label">
                Condition notes
              </label>
              <input
                id="receipt-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="input w-full"
                placeholder="Packaging, damage, expiry…"
              />
            </div>

            {receivedQty > 0 && !splitValid && (
              <p className="rounded-md bg-red-50 p-2 text-xs text-red-700">
                Accepted ({acceptedQty}) plus rejected ({rejectedQty}) must equal received (
                {receivedQty}).
              </p>
            )}
            {splitValid && !withinOrder && (
              <p className="rounded-md bg-red-50 p-2 text-xs text-red-700">
                Cannot accept {acceptedQty} unit(s); only {remaining} remain.
              </p>
            )}

            <button
              disabled={busy !== null || !splitValid || !withinOrder}
              onClick={() =>
                void run(
                  'receipt',
                  async () => {
                    await purchaseOrderApi.recordReceipt(po.id, {
                      receivedQuantity: receivedQty,
                      acceptedQuantity: acceptedQty,
                      rejectedQuantity: rejectedQty,
                      conditionNotes: notes || undefined,
                    });
                    setReceived('');
                    setAccepted('');
                    setRejected('');
                    setNotes('');
                    await reload();
                  },
                  'Goods receipt recorded',
                )
              }
              className="btn-primary btn-sm w-full"
            >
              {busy === 'receipt' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <PackageCheck className="h-4 w-4" aria-hidden="true" />
              )}
              Record receipt
            </button>
          </div>
        </section>
      )}
    </div>
  );
};

// ── Invoices ─────────────────────────────────────────────────────────────────

export const InvoicesTab: React.FC<{
  po: PurchaseOrderDetail;
  isSeller: boolean;
  busy: string | null;
  run: RunFn;
  reload: () => Promise<void>;
}> = ({ po, isSeller, busy, run, reload }) => {
  const [showForm, setShowForm] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [totalAmount, setTotalAmount] = useState('');
  const [dueDate, setDueDate] = useState('');

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-stone-600">
          Invoices are checked against the purchase order and the goods received.
        </p>
        {[PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.SUPPLIER_CONFIRMED, PurchaseOrderStatus.IN_PROGRESS, PurchaseOrderStatus.PARTIALLY_DELIVERED, PurchaseOrderStatus.DELIVERED].includes(po.status) && (
          <button onClick={() => setShowForm((value) => !value)} className="btn btn-secondary btn-sm">
            <Receipt className="h-4 w-4" aria-hidden="true" />
            {showForm ? 'Cancel' : 'Submit invoice'}
          </button>
        )}
      </div>

      {showForm && (
        <section className="no-print card border-blue-100 bg-blue-50/50 p-4">
          <h2 className="text-sm font-semibold text-stone-800">Invoice details</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="invoice-number" className="label">
                Invoice number
              </label>
              <input
                id="invoice-number"
                value={invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label htmlFor="invoice-date" className="label">
                Invoice date
              </label>
              <input
                id="invoice-date"
                type="date"
                value={invoiceDate}
                onChange={(event) => setInvoiceDate(event.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label htmlFor="invoice-total" className="label">
                Total ({po.currency})
              </label>
              <input
                id="invoice-total"
                type="number"
                step="0.01"
                value={totalAmount}
                onChange={(event) => setTotalAmount(event.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label htmlFor="invoice-due" className="label">
                Due date
              </label>
              <input
                id="invoice-due"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className="input w-full"
              />
            </div>
          </div>
          <button
            disabled={busy !== null || !invoiceNumber.trim() || !totalAmount}
            onClick={() =>
              void run(
                'invoice',
                async () => {
                  await purchaseOrderApi.submitInvoice({
                    poId: po.id,
                    invoiceNumber: invoiceNumber.trim(),
                    invoiceDate: new Date(invoiceDate).toISOString(),
                    dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
                    totalAmount: Number(totalAmount),
                  });
                  setShowForm(false);
                  setInvoiceNumber('');
                  setTotalAmount('');
                  await reload();
                },
                'Invoice submitted',
              )
            }
            className="btn-primary btn-sm mt-3"
          >
            {busy === 'invoice' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Submit for verification
          </button>
        </section>
      )}

      {po.invoices.length === 0 ? (
        <div className="card p-10 text-center">
          <Receipt className="mx-auto mb-2 h-8 w-8 text-stone-200" aria-hidden="true" />
          <p className="text-sm text-stone-500">No invoice has been submitted yet.</p>
        </div>
      ) : (
        po.invoices.map((invoice) => (
          <InvoiceCard
            key={invoice.id}
            invoice={invoice}
            isSeller={isSeller}
            busy={busy}
            run={run}
            reload={reload}
          />
        ))
      )}
    </div>
  );
};

const InvoiceCard: React.FC<{
  invoice: InvoiceRecord;
  isSeller: boolean;
  busy: string | null;
  run: RunFn;
  reload: () => Promise<void>;
}> = ({ invoice, isSeller, busy, run, reload }) => {
  const verification = invoice.verifications?.[0];
  const discrepancies = (verification?.discrepancies ?? []) as Array<{
    type: string;
    severity: string;
    field: string;
    message: string;
    expected?: string;
    actual?: string;
    difference?: string;
    resolution: string;
    resolutionNote?: string | null;
  }>;
  const criticals = discrepancies.filter(
    (d) => d.severity === 'CRITICAL' && d.resolution === 'OPEN',
  );

  return (
    <article className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-stone-900">{invoice.invoiceNumber}</h2>
            <span className={invoiceStatusClass(invoice.status)}>{invoiceStatusLabel(invoice.status)}</span>
            {verification && (
              <span
                className={`badge ${
                  verification.status === InvoiceMatchStatus.MATCHED
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-red-50 text-red-700'
                }`}
              >
                {matchStatusLabel(verification.status)}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-stone-500">
            Dated {formatDate(invoice.invoiceDate)}
            {invoice.dueDate ? ` · due ${formatDate(invoice.dueDate)}` : ''}
          </p>
        </div>
        <p className="text-lg font-semibold text-stone-900">
          {formatAmount(invoice.totalAmount, invoice.currency)}
        </p>
      </div>

      {verification && (
        <p className="mt-2 text-xs text-stone-500">
          Tolerance {formatAmount(verification.toleranceAmount, invoice.currency)}
          {verification.verifiedAt ? ` · verified ${formatDate(verification.verifiedAt)}` : ''}
        </p>
      )}

      {!isSeller && (
        <div className="no-print mt-3 flex flex-wrap gap-2">
          <button
            disabled={busy !== null || invoice.status === InvoiceStatus.VERIFIED}
            onClick={() =>
              void run(
                `verify-${invoice.id}`,
                () => purchaseOrderApi.verifyInvoice(invoice.id),
                'Three-way match completed',
              ).then(reload)
            }
            className="btn btn-sm"
          >
            {busy === `verify-${invoice.id}` ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileQuestion className="h-4 w-4" aria-hidden="true" />
            )}
            {verification ? 'Re-run verification' : 'Verify (three-way match)'}
          </button>
        </div>
      )}

      {criticals.length > 0 && (
        <p className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-800">
          {criticals.length} critical discrepanc{criticals.length === 1 ? 'y' : 'ies'} block payment.
        </p>
      )}

      {discrepancies.length > 0 && (
        <div className="mt-3 space-y-2">
          {discrepancies.map((discrepancy, index) => (
            <DiscrepancyRow
              key={`${discrepancy.field}-${index}`}
              invoiceId={invoice.id}
              discrepancy={discrepancy}
              canResolve={!isSeller}
              busy={busy}
              run={run}
            />
          ))}
        </div>
      )}

      {invoice.extractedData && (
        <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-2">
          <p className="text-xs font-medium text-stone-600">
            Extracted from the document — not verified
          </p>
          <pre className="mt-1 overflow-x-auto text-xs text-stone-600">
            {JSON.stringify(invoice.extractedData, null, 2)}
          </pre>
        </div>
      )}

      {invoice.payments && invoice.payments.length > 0 && (
        <div className="mt-3 border-t border-stone-100 pt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Payments against this invoice
          </p>
          <ul className="mt-1 space-y-1">
            {invoice.payments.map((payment) => (
              <li key={payment.id} className="flex items-center justify-between text-sm">
                <span className={paymentStatusClass(payment.status)}>
                  {paymentStatusLabel(payment.status)}
                </span>
                <span className="text-stone-700">
                  {formatAmount(payment.paidAmount, payment.currency)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
};

const DiscrepancyRow: React.FC<{
  invoiceId: string;
  discrepancy: {
    severity: string;
    field: string;
    message: string;
    expected?: string;
    actual?: string;
    difference?: string;
    resolution: string;
    resolutionNote?: string | null;
  };
  canResolve: boolean;
  busy: string | null;
  run: RunFn;
}> = ({ invoiceId, discrepancy, canResolve, busy, run }) => {
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const resolved = discrepancy.resolution !== 'OPEN';

  return (
    <div className="rounded-lg border border-stone-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={discrepancyClass(discrepancy.severity as never)}>
              {discrepancy.severity.toLowerCase()}
            </span>
            <span className="text-sm font-medium text-stone-800">
              {discrepancyLabel(discrepancy.field)}
            </span>
            {resolved && (
              <span className="badge bg-stone-100 text-stone-600">
                {discrepancy.resolution.toLowerCase()}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-stone-700">{discrepancy.message}</p>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-stone-500">
            <span>Expected: {discrepancy.expected ?? '—'}</span>
            <span>Actual: {discrepancy.actual ?? '—'}</span>
            {discrepancy.difference && <span>Difference: {discrepancy.difference}</span>}
          </dl>
          {discrepancy.resolutionNote && (
            <p className="mt-1 text-xs italic text-stone-500">
              Note: {discrepancy.resolutionNote}
            </p>
          )}
        </div>
      </div>

      {canResolve && !resolved && (
        <div className="no-print mt-2 space-y-2 border-t border-stone-100 pt-2">
          {!expanded ? (
            <button onClick={() => setExpanded(true)} className="btn btn-sm">
              Resolve
            </button>
          ) : (
            <>
              {discrepancy.severity === 'CRITICAL' && (
                <p className="text-xs text-stone-500">
                  A rationale is required for a critical discrepancy.
                </p>
              )}
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className="input w-full"
                placeholder="Rationale or agreed correction"
                aria-label="Resolution note"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={busy !== null || (discrepancy.severity === 'CRITICAL' && !note.trim())}
                  onClick={() =>
                    void run(
                      `resolve-${discrepancy.field}`,
                      () =>
                        purchaseOrderApi.resolveDiscrepancy(invoiceId, {
                          field: discrepancy.field,
                          resolution: DiscrepancyResolution.ACCEPTED,
                          note: note.trim() || undefined,
                        }),
                      'Discrepancy resolved',
                    )
                  }
                  className="btn-primary btn-sm"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Accept correction
                </button>
                <button
                  disabled={busy !== null || (discrepancy.severity === 'CRITICAL' && !note.trim())}
                  onClick={() =>
                    void run(
                      `waive-${discrepancy.field}`,
                      () =>
                        purchaseOrderApi.resolveDiscrepancy(invoiceId, {
                          field: discrepancy.field,
                          resolution: DiscrepancyResolution.WAIVED,
                          note: note.trim() || undefined,
                        }),
                      'Discrepancy waived (payment still blocked)'
                    )
                  }
                  className="btn btn-sm"
                >
                  Waive
                </button>
                <button onClick={() => setExpanded(false)} className="btn btn-sm">
                  Close
                </button>
              </div>
              <p className="text-xs text-stone-500">
                Waiving records the decision but does not clear the payment block; only
                accepting a correction does.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ── Payments ─────────────────────────────────────────────────────────────────

export const PaymentsTab: React.FC<{
  po: PurchaseOrderDetail;
  canPay: boolean;
  busy: string | null;
  run: RunFn;
}> = ({ po, canPay, busy, run }) => {
  const [invoiceId, setInvoiceId] = useState('');
  const [status, setStatus] = useState<PaymentStatus>(PaymentStatus.PARTIALLY_PAID);
  const [paidAmount, setPaidAmount] = useState('');
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState('');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));

  const selectedInvoice = po.invoices.find((invoice) => invoice.id === invoiceId);
  const blocked = selectedInvoice
    ? !isClearedForPayment(selectedInvoice)
    : false;

  const totalPaid = po.payments.reduce((sum, payment) => sum + payment.paidAmount, 0);
  const outstanding = Math.max(0, po.totalAmount - totalPaid);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="card p-4 lg:col-span-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
          <Wallet className="h-4 w-4" aria-hidden="true" />
          Payment record
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          NAVO records payments made outside the system. It does not initiate bank or
          gateway transfers, so every status here is a user assertion.
        </p>

        <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
          <Row label="Order value" value={formatAmount(po.totalAmount, po.currency)} />
          <Row label="Recorded" value={formatAmount(totalPaid, po.currency)} />
          <Row label="Outstanding" value={formatAmount(outstanding, po.currency)} />
        </dl>

        {po.payments.length === 0 ? (
          <p className="mt-4 text-sm text-stone-500">No payment recorded yet.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {po.payments.map((payment) => (
              <div key={payment.id} className="rounded-lg border border-stone-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={paymentStatusClass(payment.status)}>
                    {paymentStatusLabel(payment.status)}
                  </span>
                  <span className="text-sm font-medium text-stone-800">
                    {formatAmount(payment.paidAmount, payment.currency)} of{' '}
                    {formatAmount(payment.amount, payment.currency)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-stone-500">
                  {[payment.reference, payment.paymentMethod, payment.paidAt && `Paid ${formatDate(payment.paidAt)}`]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {payment.notes && <p className="mt-0.5 text-xs text-stone-500">{payment.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      {canPay && (
        <section className="no-print card h-fit p-4">
          <h2 className="text-sm font-semibold text-stone-800">Record a payment</h2>
          <div className="mt-3 space-y-2">
            <div>
              <label htmlFor="payment-invoice" className="label">
                Against invoice
              </label>
              <select
                id="payment-invoice"
                value={invoiceId}
                onChange={(event) => setInvoiceId(event.target.value)}
                className="input w-full"
              >
                <option value="">Purchase order total</option>
                {po.invoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.invoiceNumber} — {formatAmount(invoice.totalAmount, po.currency)}
                  </option>
                ))}
              </select>
            </div>

            {blocked && (
              <p className="rounded-md bg-red-50 p-2 text-xs text-red-800">
                This invoice has unresolved critical discrepancies. Resolve them before
                recording a payment.
              </p>
            )}

            <div>
              <label htmlFor="payment-status" className="label">
                Status
              </label>
              <select
                id="payment-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as PaymentStatus)}
                className="input w-full"
              >
                <option value={PaymentStatus.PARTIALLY_PAID}>Partially paid</option>
                <option value={PaymentStatus.PAID}>Paid in full</option>
                <option value={PaymentStatus.DUE}>Due</option>
                <option value={PaymentStatus.ON_HOLD}>On hold</option>
                <option value={PaymentStatus.DISPUTED}>Disputed</option>
              </select>
            </div>

            <div>
              <label htmlFor="payment-amount" className="label">
                Amount paid ({po.currency})
              </label>
              <input
                id="payment-amount"
                type="number"
                step="0.01"
                value={paidAmount}
                onChange={(event) => setPaidAmount(event.target.value)}
                className="input w-full"
                placeholder={
                  selectedInvoice
                    ? String(selectedInvoice.totalAmount)
                    : String(po.totalAmount)
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="payment-ref" className="label">
                  Reference
                </label>
                <input
                  id="payment-ref"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  className="input w-full"
                />
              </div>
              <div>
                <label htmlFor="payment-method" className="label">
                  Method
                </label>
                <input
                  id="payment-method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                  className="input w-full"
                  placeholder="NEFT, RTGS…"
                />
              </div>
            </div>

            <div>
              <label htmlFor="payment-date" className="label">
                Paid on
              </label>
              <input
                id="payment-date"
                type="date"
                value={paidAt}
                onChange={(event) => setPaidAt(event.target.value)}
                className="input w-full"
              />
            </div>

            <button
              disabled={busy !== null || blocked || !paidAmount}
              onClick={() =>
                void run(
                  'payment',
                  () =>
                    purchaseOrderApi.recordPayment({
                      poId: po.id,
                      invoiceId: invoiceId || undefined,
                      status,
                      paidAmount: Number(paidAmount),
                      reference: reference || undefined,
                      paymentMethod: method || undefined,
                      paidAt: status === PaymentStatus.PAID || Number(paidAmount) > 0
                        ? new Date(paidAt).toISOString()
                        : undefined,
                    }),
                  'Payment recorded',
                )
              }
              className="btn-primary btn-sm w-full"
            >
              {busy === 'payment' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Wallet className="h-4 w-4" aria-hidden="true" />
              )}
              Record payment
            </button>
          </div>
        </section>
      )}
    </div>
  );
};

// ── Documents ────────────────────────────────────────────────────────────────

export const DocumentsTab: React.FC<{
  po: PurchaseOrderDetail;
  busy: string | null;
  reload: () => Promise<void>;
}> = ({ po, busy, reload }) => {
  const [category, setCategory] = useState<DocumentCategory>(DocumentCategory.SUPPORTING);
  const [file, setFile] = useState<File | null>(null);

  const upload = async () => {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    await purchaseOrderApi.uploadDocument({
      poId: po.id,
      category,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      content: base64,
    });
    setFile(null);
    await reload();
  };

  return (
    <div className="space-y-4">
      <section className="no-print card p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
          <Upload className="h-4 w-4" aria-hidden="true" />
          Upload a document
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          Files are stored against this order and served only through an authorised
          download.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="doc-category" className="label">
              Category
            </label>
            <select
              id="doc-category"
              value={category}
              onChange={(event) => setCategory(event.target.value as DocumentCategory)}
              className="input"
            >
              {Object.values(DocumentCategory).map((value) => (
                <option key={value} value={value}>
                  {documentCategoryLabel(value)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="doc-file" className="label">
              File
            </label>
            <input
              id="doc-file"
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="input"
            />
          </div>
          <button
            disabled={busy !== null || !file}
            onClick={() => void runUpload(upload)}
            className="btn-primary btn-sm"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload
          </button>
        </div>
      </section>

      {po.documents.length === 0 ? (
        <div className="card p-10 text-center">
          <Paperclip className="mx-auto mb-2 h-8 w-8 text-stone-200" aria-hidden="true" />
          <p className="text-sm text-stone-500">No documents attached to this order.</p>
        </div>
      ) : (
        <section className="card divide-y divide-stone-100">
          {po.documents.map((document) => (
            <DocumentRow key={document.id} document={document} />
          ))}
        </section>
      )}
    </div>
  );

  async function runUpload(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      // Surfaced through the shared notice on the parent page.
      console.error((err as Error).message);
    }
  }
};

const DocumentRow: React.FC<{ document: DocumentRecord }> = ({ document }) => {
  const [downloading, setDownloading] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3 p-3">
      <Paperclip className="h-4 w-4 flex-shrink-0 text-stone-400" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-stone-800">{document.fileName}</p>
        <p className="text-xs text-stone-400">
          {documentCategoryLabel(document.category)} · {formatFileSize(document.size)} ·{' '}
          {formatDate(document.createdAt)}
        </p>
      </div>
      <button
        disabled={downloading}
        onClick={async () => {
          setDownloading(true);
          try {
            await purchaseOrderApi.downloadDocument(document.id, document.fileName);
          } finally {
            setDownloading(false);
          }
        }}
        className="btn btn-sm"
      >
        {downloading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4" aria-hidden="true" />
        )}
        Download
      </button>
    </div>
  );
};

// ── History ──────────────────────────────────────────────────────────────────

export const HistoryTab: React.FC<{ timeline: TransactionTimelineEntry[] }> = ({
  timeline,
}) => (
  <section className="card p-5">
    <h2 className="text-sm font-semibold text-stone-800">Purchase transaction history</h2>
    <p className="mt-1 text-xs text-stone-500">
      Assembled from the records themselves. Each entry shows whether it came from
      application data or the audit trail.
    </p>

    {timeline.length === 0 ? (
      <p className="mt-4 text-sm text-stone-500">No history recorded yet.</p>
    ) : (
      <ol className="mt-4 space-y-4">
        {timeline.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className="mt-1 h-2 w-2 rounded-full bg-blue-600" />
              {index < timeline.length - 1 && <div className="mt-1 w-px flex-1 bg-stone-200" />}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge bg-stone-100 text-stone-600">{entry.stage}</span>
                <span className="text-sm font-medium text-stone-800">{entry.title}</span>
                {entry.status && (
                  <span className="text-xs text-stone-400">{entry.status}</span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-stone-400">
                {formatDateTime(entry.at)}
                {entry.actorName ? ` · ${entry.actorName}` : ''} · {entry.source}
              </p>
              {entry.detail && <p className="mt-1 text-sm text-stone-600">{entry.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
    )}
  </section>
);

// ── Shared bits ──────────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; value: string; emphasis?: boolean }> = ({
  label,
  value,
  emphasis,
}) => (
  <div>
    <dt className="text-xs text-stone-500">{label}</dt>
    <dd className={`mt-0.5 ${emphasis ? 'font-semibold text-stone-900' : 'text-stone-800'}`}>
      {value}
    </dd>
  </div>
);

const Detail: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <dt className="text-xs text-stone-500">{label}</dt>
    <dd className="mt-0.5 whitespace-pre-line text-stone-700">{value}</dd>
  </div>
);

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between">
    <dt className="text-stone-500">{label}</dt>
    <dd className="font-medium text-stone-800">{value}</dd>
  </div>
);

/** Mirrors the server rule: only a fully matched invoice clears payment. */
function isClearedForPayment(invoice: InvoiceRecord): boolean {
  const verification = invoice.verifications?.[0];
  if (!verification) return false;
  if (verification.matched) return true;
  const list = (verification.discrepancies ?? []) as Array<{ severity: string; resolution: string }>;
  return !list.some((d) => d.severity === 'CRITICAL' && d.resolution === 'OPEN');
}

export { Info };