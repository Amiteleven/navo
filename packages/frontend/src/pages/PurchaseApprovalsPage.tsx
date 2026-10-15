import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  MessageSquare,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import { Textarea } from '../components/ui/Textarea';
import { purchaseApprovalApi } from '../services/api';
import {
  PurchaseApprovalRequestDetail,
  PurchaseApprovalStatus,
  UserRole,
} from '../types';
import { useAuth } from '../context/AuthContext';
import {
  canCancel,
  canConfirmPurchase,
  describeRoute,
  formatApprovalAmount,
  nextRequiredRole,
  pendingLevels,
  presentApprovalStatus,
  presentDecisionStatus,
  presentRole,
} from '../utils/purchaseApproval';

/**
 * The approver's inbox.
 *
 * Three things this screen has to get right, and which the layout is built
 * around:
 *
 *  - **Nothing is shown that is not stored.** Every number on a row comes from
 *    the server's snapshot of the offer. Nothing is estimated, and a request
 *    with no vendor or no amount is rendered as absent rather than as zero.
 *  - **The current stage and the next approver are always visible**, so a
 *    manager can tell "waiting on me" from "waiting on finance" without
 *    opening anything.
 *  - **Approval is never shown as a purchase.** An approved row says it still
 *    has to be confirmed by the buyer.
 */

const APPROVER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
];

const BUYER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
  UserRole.REQUESTER,
];

const STATUS_TABS: Array<{ label: string; value: '' | PurchaseApprovalStatus }> = [
  { label: 'All', value: '' },
  { label: 'Waiting on me', value: PurchaseApprovalStatus.PENDING_APPROVAL },
  { label: 'Changes requested', value: PurchaseApprovalStatus.CHANGES_REQUESTED },
  { label: 'Approved', value: PurchaseApprovalStatus.APPROVED },
  { label: 'Rejected', value: PurchaseApprovalStatus.REJECTED },
  { label: 'Confirmed', value: PurchaseApprovalStatus.PURCHASE_CONFIRMED },
];

type Scope = 'assigned' | 'requested' | 'all';

export const PurchaseApprovalsPage: React.FC = () => {
  const { user, hasRole } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const canApprove = user ? hasRole(APPROVER_ROLES) : false;
  const canBuy = user ? hasRole(BUYER_ROLES) : false;

  const [scope, setScope] = useState<Scope>((searchParams.get('scope') as Scope) ?? 'assigned');
  const [status, setStatus] = useState<'' | PurchaseApprovalStatus>(
    (searchParams.get('status') as PurchaseApprovalStatus) ?? '',
  );
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [minAmount, setMinAmount] = useState(searchParams.get('minAmount') ?? '');
  const [maxAmount, setMaxAmount] = useState(searchParams.get('maxAmount') ?? '');
  const [from, setFrom] = useState(searchParams.get('from') ?? '');
  const [to, setTo] = useState(searchParams.get('to') ?? '');

  const [rows, setRows] = useState<PurchaseApprovalRequestDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const [selected, setSelected] = useState<PurchaseApprovalRequestDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [decision, setDecision] = useState<{
    decisionId: string;
    status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  } | null>(null);
  const [comments, setComments] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Filters live in the URL so an inbox view can be linked to and survives a
  // reload, which is how managers hand a specific queue to a colleague.
  useEffect(() => {
    const next = new URLSearchParams();
    if (scope !== 'assigned') next.set('scope', scope);
    if (status) next.set('status', status);
    if (search) next.set('search', search);
    if (minAmount) next.set('minAmount', minAmount);
    if (maxAmount) next.set('maxAmount', maxAmount);
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    setSearchParams(next, { replace: true });
  }, [scope, status, search, minAmount, maxAmount, from, to, setSearchParams]);

  const fetchRows = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await purchaseApprovalApi.list({
        scope,
        status: status || undefined,
        search: search || undefined,
        minAmount: minAmount ? Number(minAmount) : undefined,
        maxAmount: maxAmount ? Number(maxAmount) : undefined,
        from: from || undefined,
        to: to || undefined,
        page,
        limit: 20,
      });
      if (response.data.success && response.data.data) {
        setRows(response.data.data.data);
        setTotal(response.data.data.total);
        setTotalPages(response.data.data.totalPages);
      }
    } catch (err) {
      // A refusal is a real, expected outcome here - a buyer with no approval
      // authority gets one - so it is shown as a state rather than a toast that
      // disappears before it is read.
      const status = (err as { response?: { status?: number } }).response?.status;
      setError(
        status === 403
          ? 'You do not have access to purchase approvals. Ask an administrator if you should.'
          : 'Could not load approvals. Check your connection and try again.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [scope, status, search, minAmount, maxAmount, from, to, page]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const openDetail = async (approvalId: string) => {
    setIsDetailLoading(true);
    setDetailError(null);
    setSelected(null);
    try {
      const response = await purchaseApprovalApi.get(approvalId);
      if (response.data.success && response.data.data) setSelected(response.data.data);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      setDetailError(
        status === 403
          ? 'You are not authorized to view this purchase approval.'
          : 'Could not load this approval request.',
      );
    } finally {
      setIsDetailLoading(false);
    }
  };

  const submitDecision = async () => {
    if (!decision) return;
    // Rejection and requested-changes need a reason; the button stays disabled
    // until one is given rather than failing after the fact.
    if (decision.status !== 'APPROVED' && !comments.trim()) {
      setDecisionError('A comment is required when rejecting or requesting changes.');
      return;
    }
    setDeciding(true);
    setDecisionError(null);
    try {
      const response = await purchaseApprovalApi.decide(decision.decisionId, {
        status: decision.status,
        comments: comments.trim() || undefined,
      });
      toast.success(
        decision.status === 'APPROVED'
          ? 'Approved'
          : decision.status === 'REJECTED'
            ? 'Rejected'
            : 'Returned for changes',
      );
      setDecision(null);
      setComments('');
      if (response.data.data) setSelected(response.data.data);
      void fetchRows();
    } catch (err) {
      const message =
        (err as { response?: { data?: { error?: string } } }).response?.data?.error ??
        'Could not record that decision.';
      setDecisionError(message);
    } finally {
      setDeciding(false);
    }
  };

  const confirmPurchase = async () => {
    if (!selected) return;
    setConfirming(true);
    try {
      const response = await purchaseApprovalApi.confirm(selected.id);
      toast.success('Purchase confirmed');
      setConfirmOpen(false);
      if (response.data.data) setSelected(response.data.data);
      void fetchRows();
    } catch (err) {
      toast.error(
        (err as { response?: { data?: { error?: string } } }).response?.data?.error ??
          'Could not confirm that purchase.',
      );
    } finally {
      setConfirming(false);
    }
  };

  const activeFilters = useMemo(
    () => [search, minAmount, maxAmount, from, to].filter(Boolean).length,
    [search, minAmount, maxAmount, from, to],
  );

  if (!canApprove && !canBuy) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="card p-10 text-center">
          <ShieldCheck className="h-10 w-10 text-stone-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-stone-700">No access to purchase approvals</p>
          <p className="text-sm text-stone-500 mt-1">
            Purchase approvals are available to buyers and to designated approvers. Ask an
            administrator if you should have access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">Approvals</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            {total} purchase authorization request{total === 1 ? '' : 's'}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setShowFilters((v) => !v)}>
          Filters{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </Button>
      </div>

      {/* Scope: whose queue this is */}
      <div className="flex gap-1 flex-wrap">
        {(
          [
            { label: 'Waiting on me', value: 'assigned', show: canApprove },
            { label: 'I submitted', value: 'requested', show: canBuy },
            { label: 'All', value: 'all', show: canApprove || canBuy },
          ] as Array<{ label: string; value: Scope; show: boolean }>
        )
          .filter((tab) => tab.show)
          .map((tab) => (
            <button
              key={tab.value}
              onClick={() => {
                setScope(tab.value);
                setPage(1);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                scope === tab.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="card p-4 space-y-3 animate-fade-in">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="label">Search</label>
              <input
                className="input"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Reference, vendor, requirement or item"
              />
            </div>
            <div>
              <label className="label">Value from</label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={minAmount}
                onChange={(e) => {
                  setMinAmount(e.target.value);
                  setPage(1);
                }}
                placeholder="0"
              />
            </div>
            <div>
              <label className="label">Value to</label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={maxAmount}
                onChange={(e) => {
                  setMaxAmount(e.target.value);
                  setPage(1);
                }}
                placeholder="No limit"
              />
            </div>
            <div>
              <label className="label">Submitted from</label>
              <input
                className="input"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <label className="label">Submitted to</label>
              <input
                className="input"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>
          {activeFilters > 0 && (
            <button
              onClick={() => {
                setSearch('');
                setMinAmount('');
                setMaxAmount('');
                setFrom('');
                setTo('');
                setPage(1);
              }}
              className="text-xs text-blue-600 hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Status filter */}
      <div className="flex gap-1 flex-wrap">
        {STATUS_TABS.filter((tab) => tab.value !== 'PENDING_APPROVAL' || canApprove).map((tab) => (
          <button
            key={tab.value || 'all'}
            onClick={() => {
              setStatus(tab.value);
              setPage(1);
            }}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
              status === tab.value
                ? 'bg-stone-800 text-white'
                : 'bg-white border border-stone-200 text-stone-500 hover:border-stone-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-16" role="status" aria-live="polite">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          <span className="sr-only">Loading approvals</span>
        </div>
      ) : error ? (
        <div className="card p-8 text-center">
          <AlertCircle className="h-8 w-8 text-amber-500 mx-auto mb-2" />
          <p className="text-sm font-medium text-stone-700">{error}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void fetchRows()}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-12 text-center">
          <CheckCircle className="h-10 w-10 text-stone-200 mx-auto mb-3" />
          <p className="text-stone-600 font-medium">
            {scope === 'assigned' ? 'Nothing waiting on you' : 'No approval requests found'}
          </p>
          <p className="text-sm text-stone-400 mt-1">
            {scope === 'assigned'
              ? 'Purchases appear here when they reach the approval level you are responsible for.'
              : 'Submit a negotiated offer from a deal room to request authorization.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <ApprovalRow
              key={row.id}
              approval={row}
              onOpen={() => void openDetail(row.id)}
              onOpenRequest={() => navigate(`/requests/${row.requestId}`)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-stone-500">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <ApprovalDetailModal
        approval={selected}
        isLoading={isDetailLoading}
        error={detailError}
        onClose={() => setSelected(null)}
        onDecide={(decisionId, nextStatus) => {
          setDecision({ decisionId, status: nextStatus });
          setComments('');
          setDecisionError(null);
        }}
        onConfirm={() => setConfirmOpen(true)}
        canApprove={canApprove}
        canBuy={canBuy}
      />

      {/* Decision modal */}
      <Modal
        isOpen={decision !== null}
        onClose={() => setDecision(null)}
        title={
          decision?.status === 'APPROVED'
            ? 'Approve purchase'
            : decision?.status === 'REJECTED'
              ? 'Reject purchase'
              : 'Request changes'
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-stone-600">
            {decision?.status === 'APPROVED'
              ? 'Approving releases this purchase for confirmation by the buyer. It is not a purchase yet.'
              : decision?.status === 'REJECTED'
                ? 'Rejecting stops this purchase. The buyer will see your reason.'
                : 'The buyer will see your reason and can submit a revised offer.'}
          </p>
          <div>
            <label className="label">
              Comment{' '}
              {decision?.status === 'APPROVED' ? '(optional)' : '(required)'}
            </label>
            <Textarea
              value={comments}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setComments(e.target.value)}
              rows={4}
              placeholder={
                decision?.status === 'APPROVED'
                  ? 'Add a note for the record…'
                  : 'Explain what needs to change…'
              }
            />
            {decisionError && (
              <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {decisionError}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-stone-100">
            <Button variant="secondary" size="sm" onClick={() => setDecision(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={decision?.status === 'APPROVED' ? 'success' : 'danger'}
              onClick={submitDecision}
              loading={deciding}
            >
              {decision?.status === 'APPROVED'
                ? 'Confirm approval'
                : decision?.status === 'REJECTED'
                  ? 'Confirm rejection'
                  : 'Request changes'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Purchase confirmation */}
      <Modal isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm purchase">
        <div className="space-y-4">
          <p className="text-sm text-stone-600">
            Confirming commits company funds for{' '}
            <span className="font-medium">{selected?.reference}</span> at the approved terms:{' '}
            <span className="font-medium">
              {formatApprovalAmount(selected?.totalAmount, selected?.currency)}
            </span>
            {selected?.purchaseOrder ? (
              <>
                {' '}
                against purchase order{' '}
                <span className="font-medium">{selected.purchaseOrder.poNumber}</span>.
              </>
            ) : (
              '. You can then raise the purchase order from the deal.'
            )}
          </p>
          {selected && !selected.isPurchaseComplete && selected.purchaseOrder == null && (
            <p className="text-xs text-stone-500">
              The purchase is not complete until the order is raised. Until then this remains an
              approved, unconfirmed commitment.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-stone-100">
            <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="success" onClick={confirmPurchase} loading={confirming}>
              Confirm purchase
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

// ── Row ───────────────────────────────────────────────────────────────────────

const ApprovalRow: React.FC<{
  approval: PurchaseApprovalRequestDetail;
  onOpen: () => void;
  onOpenRequest: () => void;
}> = ({ approval, onOpen, onOpenRequest }) => {
  const presentation = presentApprovalStatus(approval.status);

  const icon =
    approval.status === PurchaseApprovalStatus.APPROVED ||
    approval.status === PurchaseApprovalStatus.PURCHASE_CONFIRMED ? (
      <CheckCircle className="h-5 w-5 text-emerald-600" />
    ) : approval.status === PurchaseApprovalStatus.REJECTED ||
      approval.status === PurchaseApprovalStatus.CHANGES_REQUESTED ? (
      <XCircle className="h-5 w-5 text-red-600" />
    ) : (
      <Clock className="h-5 w-5 text-amber-600" />
    );

  return (
    <div className="card p-4 flex items-start gap-4">
      <div className="h-10 w-10 rounded-xl bg-stone-50 flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-stone-800 font-mono">{approval.reference}</span>
          <Badge variant={presentation.tone}>{presentation.label}</Badge>
          {approval.revision > 1 && <Badge variant="neutral">Revision {approval.revision}</Badge>}
        </div>
        <p className="text-xs text-stone-500">
          {approval.vendor?.name ?? 'Vendor unavailable'} ·{' '}
          {formatApprovalAmount(approval.totalAmount, approval.currency)} ·{' '}
          {approval.quantity} unit{approval.quantity === 1 ? '' : 's'}
        </p>
        <p className="text-xs text-stone-400">
          Submitted {format(new Date(approval.createdAt), 'dd MMM yyyy · HH:mm')}
          {approval.submittedBy ? ` by ${approval.submittedBy.firstName} ${approval.submittedBy.lastName}` : ''}
        </p>
      </div>
      <div className="flex gap-2 flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={onOpenRequest}>
          <FileText className="h-3.5 w-3.5" />
          Requirement
        </Button>
        <Button size="sm" onClick={onOpen}>
          Review
        </Button>
      </div>
    </div>
  );
};

// ── Detail ────────────────────────────────────────────────────────────────────

const ApprovalDetailModal: React.FC<{
  approval: PurchaseApprovalRequestDetail | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onDecide: (decisionId: string, status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED') => void;
  onConfirm: () => void;
  canApprove: boolean;
  canBuy: boolean;
}> = ({ approval, isLoading, error, onClose, onDecide, onConfirm, canApprove, canBuy }) => {
  if (!approval && !isLoading && !error) return null;

  const presentation = approval ? presentApprovalStatus(approval.status) : null;
  const outstanding = approval ? pendingLevels(approval.decisions) : [];
  const next = approval ? nextRequiredRole(approval.decisions, approval.currentLevel) : null;
  const isOwnRequest = approval?.submittedById != null;

  return (
    <Modal
      isOpen={Boolean(approval) || isLoading || Boolean(error)}
      onClose={onClose}
      title="Purchase authorization"
      size="xl"
    >
      {isLoading ? (
        <div className="flex justify-center py-10" role="status" aria-live="polite">
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          <span className="sr-only">Loading approval</span>
        </div>
      ) : error ? (
        <div className="py-8 text-center">
          <AlertCircle className="h-8 w-8 text-amber-500 mx-auto mb-2" />
          <p className="text-sm text-stone-600">{error}</p>
        </div>
      ) : approval && presentation ? (
        <div className="space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Status and what it means */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-sm font-medium text-stone-800">{approval.reference}</p>
              <p className="text-xs text-stone-500 mt-0.5">{presentation.explanation}</p>
            </div>
            <Badge variant={presentation.tone}>{presentation.label}</Badge>
          </div>

          {approval.supersedeReason && (
            <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
              <p className="text-xs text-amber-800 flex items-start gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
                {approval.supersedeReason}
              </p>
            </div>
          )}

          {/* Commercial terms */}
          <div className="rounded-lg border border-stone-200 divide-y divide-stone-100">
            <Row label="Requirement" value={approval.request?.title ?? '—'} />
            <Row label="Vendor" value={approval.vendor?.name ?? '—'} />
            <Row
              label="Quantity"
              value={`${approval.quantity} unit${approval.quantity === 1 ? '' : 's'}`}
            />
            <Row label="Unit price" value={formatApprovalAmount(approval.unitPrice, approval.currency)} />
            <Row label="Subtotal" value={formatApprovalAmount(approval.subtotal, approval.currency)} />
            <Row label="Tax" value={formatApprovalAmount(approval.taxAmount, approval.currency)} />
            <Row label="Freight" value={formatApprovalAmount(approval.freightAmount, approval.currency)} />
            <Row
              label="Installation"
              value={formatApprovalAmount(approval.installationAmount, approval.currency)}
            />
            <Row label="Other charges" value={formatApprovalAmount(approval.otherCharges, approval.currency)} />
            <Row
              label="Total"
              value={formatApprovalAmount(approval.totalAmount, approval.currency)}
              emphasis
            />
            <Row
              label="Approval threshold"
              value={
                approval.route
                  ? `${formatApprovalAmount(approval.route.thresholdAmount, approval.currency)} ${
                      approval.policyId ? '(policy basis)' : ''
                    }`
                  : '—'
              }
            />
            <Row label="Payment terms" value={approval.paymentTerms ?? 'Not specified'} />
            <Row
              label="Delivery"
              value={
                approval.deliverySchedule ??
                (approval.deliveryTimelineDays
                  ? `${approval.deliveryTimelineDays} days`
                  : 'Not specified')
              }
            />
            <Row
              label="Warranty"
              value={approval.warrantyMonths ? `${approval.warrantyMonths} months` : 'Not specified'}
            />
            {approval.otherChargesDetails && (
              <Row label="Charge breakdown" value={approval.otherChargesDetails} />
            )}
          </div>

          {/* Why approval is required and who must give it */}
          {approval.route && (
            <div className="rounded-lg bg-blue-50 border border-blue-100 p-3">
              <p className="text-xs font-medium text-blue-900 mb-1 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" />
                Why this needs approval
              </p>
              <p className="text-xs text-blue-800">{describeRoute(approval.route)}</p>
              {next && (
                <p className="text-xs text-blue-800 mt-1.5">
                  Waiting on <span className="font-medium">level {next.level}</span> —{' '}
                  {next.label}
                </p>
              )}
            </div>
          )}

          {/* Approval chain */}
          <div>
            <p className="text-xs font-medium text-stone-600 mb-2 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              Approval chain
            </p>
            <div className="space-y-1.5">
              {approval.decisions.length === 0 ? (
                <p className="text-xs text-stone-400">
                  No approval levels were required for this purchase.
                </p>
              ) : (
                approval.decisions.map((level) => {
                  const levelPresentation = presentDecisionStatus(level.status);
                  return (
                    <div
                      key={level.id}
                      className="rounded-lg border border-stone-200 px-3 py-2 flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-stone-700">
                          Level {level.level} — {level.label ?? presentRole(String(level.requiredRole))}
                        </p>
                        <p className="text-xs text-stone-400 mt-0.5">
                          {level.assignedApprover
                            ? `${level.assignedApprover.firstName} ${level.assignedApprover.lastName}`
                            : `Any ${presentRole(String(level.requiredRole)).toLowerCase()}`}
                          {level.decidedBy
                            ? ` · decided by ${level.decidedBy.firstName} ${level.decidedBy.lastName}`
                            : ''}
                        </p>
                        {level.comments && (
                          <p className="text-xs text-stone-600 mt-1 flex items-start gap-1">
                            <MessageSquare className="h-3 w-3 flex-shrink-0 mt-0.5" />
                            {level.comments}
                          </p>
                        )}
                        {level.delegationReason && (
                          <p className="text-xs text-stone-400 mt-1">
                            Reassigned: {level.delegationReason}
                          </p>
                        )}
                      </div>
                      <Badge variant={levelPresentation.tone}>{levelPresentation.label}</Badge>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Negotiation history */}
          {approval.negotiationSnapshot && (
            <div>
              <p className="text-xs font-medium text-stone-600 mb-2">
                Negotiation history ({approval.negotiationSnapshot.messageCount} message
                {approval.negotiationSnapshot.messageCount === 1 ? '' : 's'},{' '}
                {approval.negotiationSnapshot.offerCount} offer
                {approval.negotiationSnapshot.offerCount === 1 ? '' : 's'})
              </p>
              <div className="space-y-1">
                {approval.negotiationSnapshot.offers.map((offer) => (
                  <div
                    key={offer.id}
                    className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-1.5"
                  >
                    <span className="text-xs text-stone-600">
                      {offer.submittedByRole === 'BUYER' ? 'Buyer' : 'Seller'} ·{' '}
                      {offer.quantity} × {formatApprovalAmount(offer.unitPrice, approval.currency)}
                    </span>
                    <span className="text-xs text-stone-500">
                      {formatApprovalAmount(offer.totalAmount, approval.currency)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Supporting documents */}
          {approval.documents && approval.documents.length > 0 && (
            <div>
              <p className="text-xs font-medium text-stone-600 mb-2">Supporting documents</p>
              <ul className="space-y-1">
                {approval.documents.map((document) => (
                  <li key={document} className="text-xs text-stone-600 flex items-center gap-1.5">
                    <FileText className="h-3 w-3" />
                    {document}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {approval.requesterComment && (
            <div>
              <p className="text-xs font-medium text-stone-600 mb-1">Note from the requester</p>
              <p className="text-xs text-stone-600">{approval.requesterComment}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap justify-end gap-2 pt-3 border-t border-stone-100">
            {canBuy && isOwnRequest && canCancel(approval.status) && approval.status !== 'PURCHASE_CONFIRMED' && (
              <p className="text-xs text-stone-400 mr-auto self-center">
                You submitted this request.
              </p>
            )}

            {canBuy && isOwnRequest && canConfirmPurchase(approval.status) && (
              <Button size="sm" variant="success" onClick={onConfirm}>
                Confirm purchase
              </Button>
            )}

            {canApprove && approval.status === 'PENDING_APPROVAL' && outstanding[0] && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onDecide(outstanding[0].id, 'CHANGES_REQUESTED')}
                >
                  Request changes
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => onDecide(outstanding[0].id, 'REJECTED')}
                >
                  Reject
                </Button>
                <Button size="sm" variant="success" onClick={() => onDecide(outstanding[0].id, 'APPROVED')}>
                  Approve
                </Button>
              </>
            )}

            {!canApprove && approval.status === 'PENDING_APPROVAL' && (
              <p className="text-xs text-stone-400 self-center">
                {next ? `Waiting on ${next.label}` : 'Awaiting a decision'}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
};

const Row: React.FC<{ label: string; value: string; emphasis?: boolean }> = ({
  label,
  value,
  emphasis,
}) => (
  <div className="flex items-start justify-between gap-3 px-3 py-2">
    <span className="text-xs text-stone-500 flex-shrink-0">{label}</span>
    <span
      className={`text-xs text-right break-words ${
        emphasis ? 'font-semibold text-stone-800' : 'text-stone-700'
      }`}
    >
      {value}
    </span>
  </div>
);
