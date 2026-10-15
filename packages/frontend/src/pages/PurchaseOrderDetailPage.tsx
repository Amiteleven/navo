import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Printer,
  CheckCircle2,
  XCircle,
  Truck,
  PackageCheck,
  Receipt,
  Wallet,
  Paperclip,
  MessageSquare,
  FileSearch,
  Send,
  Clock,
  Info,
  Sparkles,
  Bot,
} from 'lucide-react';
import { AssistantPanel } from './purchaseOrderAssistant';
import {
  purchaseOrderApi,
  PurchaseOrderDetail,
  InvoiceRecord,
} from '../services/api';
import {
  DeliveryEventType,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  TransactionTimelineEntry,
  UserRole,
} from '../types';
import {
  DocumentsTab,
  DeliveryTab,
  HistoryTab,
  InvoicesTab,
  OverviewTab,
  PaymentsTab,
} from './purchaseOrderTabs';
import { useAuth } from '../context/AuthContext';
import {
  formatAmount,
  formatDate,
  isAwaitingSupplier,
  poStatusClass,
  poStatusLabel,
} from '../utils/purchaseOrder';

type Tab =
  | 'OVERVIEW'
  | 'DELIVERY'
  | 'INVOICES'
  | 'PAYMENTS'
  | 'DOCUMENTS'
  | 'ASSISTANT'
  | 'HISTORY';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'OVERVIEW', label: 'Overview', icon: FileSearch },
  { id: 'DELIVERY', label: 'Delivery & Receipts', icon: Truck },
  { id: 'INVOICES', label: 'Invoices', icon: Receipt },
  { id: 'PAYMENTS', label: 'Payments', icon: Wallet },
  { id: 'DOCUMENTS', label: 'Documents', icon: Paperclip },
  { id: 'ASSISTANT', label: 'Assistant', icon: Sparkles },
  { id: 'HISTORY', label: 'History', icon: Clock },
];

export const PurchaseOrderDetailPage: React.FC = () => {
  const { poId } = useParams<{ poId: string }>();
  const navigate = useNavigate();
  const { user, hasRole } = useAuth();

  const [po, setPo] = useState<PurchaseOrderDetail | null>(null);
  const [summary, setSummary] = useState<PurchaseOrderSummary | null>(null);
  const [timeline, setTimeline] = useState<TransactionTimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('OVERVIEW');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const isSeller = user?.role === UserRole.VENDOR;
  const canApprove = hasRole([
    UserRole.PROCUREMENT_MANAGER,
    UserRole.FINANCE_APPROVER,
    UserRole.COMPANY_ADMIN,
    UserRole.PLATFORM_ADMIN,
  ]);
  const canReceive = !isSeller;
  const canPay = hasRole([
    UserRole.FINANCE_APPROVER,
    UserRole.COMPANY_ADMIN,
    UserRole.PROCUREMENT_MANAGER,
    UserRole.PLATFORM_ADMIN,
  ]);

  const load = useCallback(async () => {
    if (!poId) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, summaryResponse, timelineResponse] = await Promise.all([
        purchaseOrderApi.get(poId),
        purchaseOrderApi.getSummary(poId).catch(() => null),
        purchaseOrderApi.getTimeline(poId).catch(() => null),
      ]);
      setPo(detail.data.data ?? null);
      setSummary(summaryResponse?.data.data ?? null);
      setTimeline(timelineResponse?.data.data ?? []);
    } catch (err) {
      setError((err as Error).message || 'Could not load this purchase order');
    } finally {
      setLoading(false);
    }
  }, [poId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Run an action, then reload. Surfaces the server's message on failure. */
  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, successText: string) => {
      setBusy(key);
      setNotice(null);
      try {
        await action();
        setNotice({ kind: 'ok', text: successText });
        await load();
      } catch (err) {
        setNotice({ kind: 'warn', text: (err as Error).message || 'Action failed' });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error || !po) {
    return (
      <div className="space-y-4">
        <button onClick={() => navigate('/purchase-orders')} className="btn btn-secondary btn-sm">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to purchase orders
        </button>
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
          {error ?? 'Purchase order not found'}
        </div>
      </div>
    );
  }

  const pendingApprovals = po.approvals.filter((a) => a.status === 'PENDING');
  const openCritical = countOpenCritical(po.invoices);

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <button onClick={() => navigate('/purchase-orders')} className="btn btn-secondary btn-sm">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
        <div className="flex gap-2">
          <PoPrintButton />
          {isSeller && (
            <SellerActions po={po} busy={busy} run={run} />
          )}
        </div>
      </div>

      {notice && (
        <div
          className={`no-print rounded-lg border p-3 text-sm ${
            notice.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {openCritical > 0 && (
        <div
          className="no-print rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
          {openCritical} unresolved critical invoice discrepanc{openCritical === 1 ? 'y' : 'ies'}.
          Payment cannot be recorded until {openCritical === 1 ? 'it is' : 'they are'} resolved.
        </div>
      )}

      <header className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-stone-900">{po.poNumber}</h1>
              <span className={`badge ${poStatusClass(po.status)}`}>
                {poStatusLabel(po.status)}
              </span>
            </div>
            <p className="mt-1 text-sm text-stone-600">
              {po.quantity}
              {po.unit ? ` ${po.unit}` : ''} × {po.itemName}
            </p>
            <p className="mt-0.5 text-xs text-stone-400">
              Supplier {po.vendor.name}
              {po.vendor.gstin ? ` · GSTIN ${po.vendor.gstin}` : ' · GSTIN not on record'}
            </p>
          </div>
          <div className="flex flex-col items-end">
            <div className="text-right">
              <p className="text-xs text-stone-500">Order total</p>
              <p className="text-2xl font-semibold text-stone-900">
                {formatAmount(po.totalAmount, po.currency)}
              </p>
              <p className="mt-0.5 text-xs text-stone-400">
                Raised by {po.buyer.firstName} {po.buyer.lastName}
              </p>
            </div>
            {/* Anchors a copilot thread to this order so questions about
                delivery, invoices or progress resolve against its records. */}
            <button
              onClick={() =>
                navigate(
                  `/copilot?entityType=PURCHASE_ORDER&entityId=${encodeURIComponent(po.id)}` +
                    `&entityLabel=${encodeURIComponent(po.poNumber)}`
                )
              }
              className="btn-secondary btn-sm mt-3"
              title={`Ask Navo about ${po.poNumber}`}
            >
              <Bot className="h-3.5 w-3.5" />
              Ask Navo
            </button>
          </div>
        </div>

        {!isSeller && (
          <BuyerActions
            po={po}
            pendingApprovals={pendingApprovals}
            canApprove={canApprove}
            busy={busy}
            run={run}
          />
        )}
      </header>

      <nav className="no-print flex flex-wrap gap-1 border-b border-stone-200" aria-label="Purchase order sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === entry.id
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-stone-500 hover:text-stone-700'
            }`}
            aria-current={tab === entry.id ? 'page' : undefined}
          >
            <entry.icon className="h-4 w-4" aria-hidden="true" />
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'OVERVIEW' && <OverviewTab po={po} summary={summary} />}
      {tab === 'DELIVERY' && (
        <DeliveryTab po={po} canReceive={canReceive} busy={busy} run={run} reload={load} />
      )}
      {tab === 'INVOICES' && (
        <InvoicesTab po={po} isSeller={isSeller} busy={busy} run={run} reload={load} />
      )}
      {tab === 'PAYMENTS' && <PaymentsTab po={po} canPay={canPay} busy={busy} run={run} />}
      {tab === 'DOCUMENTS' && <DocumentsTab po={po} busy={busy} reload={load} />}
      {tab === 'ASSISTANT' && <AssistantPanel poId={po.id} />}
      {tab === 'HISTORY' && <HistoryTab timeline={timeline} />}
    </div>
  );
};

// ── Print button ─────────────────────────────────────────────────────────────

/**
 * Printing uses a dedicated print stylesheet plus window.print(). No PDF
 * generation library exists in this project, and the browser's print-to-PDF is
 * the only available route to a downloadable document.
 */
const PoPrintButton: React.FC = () => (
  <button onClick={() => window.print()} className="btn btn-secondary btn-sm">
    <Printer className="h-4 w-4" aria-hidden="true" />
    Print
  </button>
);

// ── Buyer actions ────────────────────────────────────────────────────────────

const BuyerActions: React.FC<{
  po: PurchaseOrderDetail;
  pendingApprovals: PurchaseOrderDetail['approvals'];
  canApprove: boolean;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void>;
}> = ({ po, pendingApprovals, canApprove, busy, run }) => {
  const [cancelReason, setCancelReason] = useState('');
  const [showCancel, setShowCancel] = useState(false);

  const allApproved =
    po.approvals.length > 0 && po.approvals.every((a) => a.status === 'APPROVED');

  return (
    <div className="no-print mt-4 space-y-3 border-t border-stone-100 pt-4">
      {po.status === PurchaseOrderStatus.DRAFT && (
        <ActionRow>
          <button
            disabled={busy !== null}
            onClick={() => run('submit', () => purchaseOrderApi.submitForApproval(po.id), 'Submitted for approval')}
            className="btn-primary btn-sm"
          >
            {busy === 'submit' ? <Spinner /> : <Send className="h-4 w-4" aria-hidden="true" />}
            Submit for approval
          </button>
        </ActionRow>
      )}

      {po.approvals.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Approval chain ({po.approvals.filter((a) => a.status === 'APPROVED').length} of{' '}
            {po.approvals.length} complete)
          </p>
          {po.approvals.map((approval) => (
            <div
              key={approval.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 p-3"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-600">
                {approval.level}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-stone-800">
                  Level {approval.level} · {approval.requiredRole.replace(/_/g, ' ').toLowerCase()}
                </p>
                {approval.comments && (
                  <p className="truncate text-xs text-stone-500">{approval.comments}</p>
                )}
                {approval.decidedAt && (
                  <p className="text-xs text-stone-400">
                    Decided {formatDate(approval.decidedAt)}
                    {approval.decidedBy
                      ? ` by ${approval.decidedBy.firstName} ${approval.decidedBy.lastName}`
                      : ''}
                  </p>
                )}
              </div>
              <span
                className={`badge ${
                  approval.status === 'APPROVED'
                    ? 'bg-emerald-50 text-emerald-700'
                    : approval.status === 'REJECTED' || approval.status === 'CHANGES_REQUESTED'
                      ? 'bg-red-50 text-red-700'
                      : 'bg-amber-50 text-amber-700'
                }`}
              >
                {approval.status.toLowerCase()}
              </span>
              {canApprove && approval.status === 'PENDING' && (
                <div className="flex gap-1">
                  <button
                    disabled={busy !== null}
                    onClick={() =>
                      run(
                        `approve-${approval.id}`,
                        () =>
                          purchaseOrderApi.decideApproval(po.id, approval.id, {
                            status: 'APPROVED' as never,
                            comments: 'Approved from purchase order screen.',
                          }),
                        `Level ${approval.level} approved`,
                      )
                    }
                    className="btn btn-sm"
                  >
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                    Approve
                  </button>
                  <button
                    disabled={busy !== null}
                    onClick={() => {
                      const reason = window.prompt('Reason for rejection');
                      if (!reason) return;
                      void run(
                        `reject-${approval.id}`,
                        () =>
                          purchaseOrderApi.decideApproval(po.id, approval.id, {
                            status: 'REJECTED' as never,
                            comments: reason,
                          }),
                        `Level ${approval.level} rejected`,
                      );
                    }}
                    className="btn btn-sm"
                  >
                    <XCircle className="h-4 w-4 text-red-600" aria-hidden="true" />
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {po.status === PurchaseOrderStatus.PENDING_APPROVAL && (
        <ActionRow>
          <button
            disabled={busy !== null || !allApproved || pendingApprovals.length > 0}
            onClick={() => run('issue', () => purchaseOrderApi.issue(po.id), 'Purchase order issued')}
            className="btn-primary btn-sm"
            title={
              pendingApprovals.length > 0
                ? `${pendingApprovals.length} approval level(s) still pending`
                : undefined
            }
          >
            {busy === 'issue' ? <Spinner /> : <Send className="h-4 w-4" aria-hidden="true" />}
            Issue to supplier
          </button>
          {pendingApprovals.length > 0 && (
            <span className="text-xs text-stone-500">
              Waiting on {pendingApprovals.length} approval level(s).
            </span>
          )}
        </ActionRow>
      )}

      {[PurchaseOrderStatus.DELIVERED, PurchaseOrderStatus.PARTIALLY_DELIVERED].includes(po.status) && (
        <ActionRow>
          <button
            disabled={busy !== null}
            onClick={() => run('close', () => purchaseOrderApi.close(po.id), 'Purchase order closed')}
            className="btn btn-sm"
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Close order
          </button>
        </ActionRow>
      )}

      {!['CLOSED', 'CANCELLED', 'DELIVERED'].includes(po.status) && (
        <div className="border-t border-stone-100 pt-3">
          {!showCancel ? (
            <button onClick={() => setShowCancel(true)} className="btn btn-sm text-red-600">
              Cancel order
            </button>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[16rem] flex-1">
                <label htmlFor="cancel-reason" className="label">
                  Cancellation reason
                </label>
                <input
                  id="cancel-reason"
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                  className="input w-full"
                  placeholder="Why is this order being cancelled?"
                />
              </div>
              <button
                disabled={busy !== null || !cancelReason.trim()}
                onClick={() =>
                  run('cancel', () => purchaseOrderApi.cancel(po.id, cancelReason.trim()), 'Order cancelled')
                }
                className="btn btn-sm text-red-600"
              >
                Confirm cancellation
              </button>
              <button onClick={() => setShowCancel(false)} className="btn btn-sm">
                Keep order
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ── Seller actions ───────────────────────────────────────────────────────────

const SellerActions: React.FC<{
  po: PurchaseOrderDetail;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void>;
}> = ({ po, busy, run }) => {
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="no-print space-y-3 rounded-lg border border-blue-100 bg-blue-50/50 p-3">
      {po.status === PurchaseOrderStatus.ISSUED && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-stone-800">Confirm this order</p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="confirm-date" className="label">
                Committed delivery date
              </label>
              <input
                id="confirm-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="input"
              />
            </div>
            <button
              disabled={busy !== null}
              onClick={() =>
                run(
                  'confirm',
                  () =>
                    purchaseOrderApi.confirmOrder(po.id, {
                      confirmedDeliveryDate: date ? new Date(date).toISOString() : undefined,
                      notes: notes || undefined,
                    }),
                  'Order confirmed',
                )
              }
              className="btn-primary btn-sm"
            >
              {busy === 'confirm' ? <Spinner /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              Confirm order
            </button>
          </div>
        </div>
      )}

      {isAwaitingSupplier(po.status) && (
        <DeliveryEventForm poId={po.id} busy={busy} run={run} />
      )}

      {[PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.SUPPLIER_CONFIRMED].includes(po.status) && (
        <div className="border-t border-blue-100 pt-2">
          {!showReject ? (
            <button onClick={() => setShowReject(true)} className="btn btn-sm text-red-600">
              Decline order
            </button>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1">
                <label htmlFor="reject-reason" className="label">
                  Reason for declining
                </label>
                <input
                  id="reject-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="input w-full"
                />
              </div>
              <button
                disabled={busy !== null || !reason.trim()}
                onClick={() =>
                  run('reject', () => purchaseOrderApi.rejectOrder(po.id, reason.trim()), 'Order declined')
                }
                className="btn btn-sm text-red-600"
              >
                Confirm decline
              </button>
              <button onClick={() => setShowReject(false)} className="btn btn-sm">
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {!showReject && po.status === PurchaseOrderStatus.ISSUED && (
        <div>
          <label htmlFor="confirm-notes" className="label">
            Note (optional)
          </label>
          <input
            id="confirm-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="input w-full"
            placeholder="Stock allocated, dispatch plan…"
          />
        </div>
      )}
    </div>
  );
};

const DeliveryEventForm: React.FC<{
  poId: string;
  busy: string | null;
  run: (key: string, action: () => Promise<unknown>, success: string) => Promise<void>;
}> = ({ poId, busy, run }) => {
  const [type, setType] = useState<DeliveryEventType>(DeliveryEventType.PREPARATION);
  const [notes, setNotes] = useState('');
  const [trackingRef, setTrackingRef] = useState('');
  const [carrierName, setCarrierName] = useState('');

  return (
    <div className="space-y-2 border-t border-blue-100 pt-2">
      <p className="text-sm font-medium text-stone-800">Report a delivery update</p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="event-type" className="label">
            Milestone
          </label>
          <select
            id="event-type"
            value={type}
            onChange={(event) => setType(event.target.value as DeliveryEventType)}
            className="input"
          >
            <option value={DeliveryEventType.PREPARATION}>Preparing goods</option>
            <option value={DeliveryEventType.DISPATCH}>Dispatched</option>
            <option value={DeliveryEventType.IN_TRANSIT}>In transit</option>
            <option value={DeliveryEventType.EXCEPTION}>Delivery exception</option>
          </select>
        </div>
        <div>
          <label htmlFor="carrier" className="label">
            Carrier
          </label>
          <input
            id="carrier"
            value={carrierName}
            onChange={(event) => setCarrierName(event.target.value)}
            className="input"
          />
        </div>
        <div>
          <label htmlFor="tracking" className="label">
            Tracking reference
          </label>
          <input
            id="tracking"
            value={trackingRef}
            onChange={(event) => setTrackingRef(event.target.value)}
            className="input"
          />
        </div>
      </div>
      <div>
        <label htmlFor="event-notes" className="label">
          Notes
        </label>
        <input
          id="event-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="input w-full"
        />
      </div>
      <button
        disabled={busy !== null}
        onClick={() =>
          run(
            'delivery-event',
            () =>
              purchaseOrderApi.addDeliveryEvent(poId, {
                type,
                notes: notes || undefined,
                carrierName: carrierName || undefined,
                trackingRef: trackingRef || undefined,
              }),
            'Delivery update recorded',
          )
        }
        className="btn btn-sm"
      >
        <Truck className="h-4 w-4" aria-hidden="true" />
        Record update
      </button>
    </div>
  );
};

export default PurchaseOrderDetailPage;

// ── Helpers ──────────────────────────────────────────────────────────────────

const ActionRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-wrap items-center gap-2">{children}</div>
);

const Spinner: React.FC = () => <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;

/** Count critical discrepancies that are still open across all invoices. */
function countOpenCritical(invoices: InvoiceRecord[]): number {
  return invoices.reduce((total, invoice) => {
    const latest = invoice.verifications?.[0];
    const list = (latest?.discrepancies ?? []) as Array<{ severity: string; resolution: string }>;
    return total + list.filter((d) => d.severity === 'CRITICAL' && d.resolution === 'OPEN').length;
  }, 0);
}

export { Info, MessageSquare, PackageCheck };