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
import { requirementApprovalApi } from '../services/api';
import {
  RequirementApprovalRequestDetail,
  RequirementApprovalStatus,
  UserRole,
} from '../types';
import { useAuth } from '../context/AuthContext';
import {
  formatRequirementAmount,
  nextRequiredRole,
  pendingLevels,
  presentRequirementApprovalStatus,
  presentRequirementDecisionStatus,
  presentRole,
} from '../utils/requirementApproval';

const APPROVER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
];

const BUYER_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.COMPANY_ADMIN,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
  UserRole.REQUESTER,
];

const STATUS_TABS: Array<{ label: string; value: '' | RequirementApprovalStatus }> = [
  { label: 'All', value: '' },
  { label: 'Waiting on me', value: RequirementApprovalStatus.PENDING_APPROVAL },
  { label: 'Changes requested', value: RequirementApprovalStatus.CHANGES_REQUESTED },
  { label: 'Approved', value: RequirementApprovalStatus.APPROVED },
  { label: 'Rejected', value: RequirementApprovalStatus.REJECTED },
  { label: 'Sent back', value: RequirementApprovalStatus.SEND_BACK },
  { label: 'Cancelled', value: RequirementApprovalStatus.CANCELLED },
];

type Scope = 'assigned' | 'requested' | 'all';

export const RequirementApprovalsPage: React.FC = () => {
  const { user, hasRole } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const canApprove = user ? hasRole(APPROVER_ROLES) : false;
  const canBuy = user ? hasRole(BUYER_ROLES) : false;

  const [scope, setScope] = useState<Scope>((searchParams.get('scope') as Scope) ?? 'assigned');
  const [status, setStatus] = useState<'' | RequirementApprovalStatus>(
    (searchParams.get('status') as RequirementApprovalStatus) ?? '',
  );
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [minAmount, setMinAmount] = useState(searchParams.get('minAmount') ?? '');
  const [maxAmount, setMaxAmount] = useState(searchParams.get('maxAmount') ?? '');
  const [from, setFrom] = useState(searchParams.get('from') ?? '');
  const [to, setTo] = useState(searchParams.get('to') ?? '');

  const [rows, setRows] = useState<RequirementApprovalRequestDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const [selected, setSelected] = useState<RequirementApprovalRequestDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [decision, setDecision] = useState<{
    decisionId: string;
    status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  } | null>(null);
  const [comments, setComments] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

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
      const response = await requirementApprovalApi.list({
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
      const statusCode = (err as { response?: { status?: number } }).response?.status;
      setError(
        statusCode === 403
          ? 'You do not have access to requirement approvals. Ask an administrator if you should.'
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
      const response = await requirementApprovalApi.get(approvalId);
      if (response.data.success && response.data.data) setSelected(response.data.data);
    } catch (err) {
      const statusCode = (err as { response?: { status?: number } }).response?.status;
      setDetailError(
        statusCode === 403
          ? 'You are not authorized to view this requirement approval.'
          : 'Could not load this approval request.',
      );
    } finally {
      setIsDetailLoading(false);
    }
  };

  const submitDecision = async () => {
    if (!decision) return;
    if (decision.status !== 'APPROVED' && !comments.trim()) {
      setDecisionError('A comment is required when rejecting or requesting changes.');
      return;
    }
    setDeciding(true);
    setDecisionError(null);
    try {
      await requirementApprovalApi.decide(decision.decisionId, {
        decision: decision.status,
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
      void fetchRows();
      void openDetail(decision.decisionId);
    } catch (err) {
      const message =
        (err as { response?: { data?: { error?: string } } }).response?.data?.error ??
        'Could not record that decision.';
      setDecisionError(message);
    } finally {
      setDeciding(false);
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
          <p className="text-sm font-medium text-stone-700">No access to requirement approvals</p>
          <p className="text-sm text-stone-500 mt-1">
            Requirement approvals are available to buyers and to designated approvers. Ask an
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
          <h1 className="text-xl font-semibold text-stone-900">Requirement Approvals</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            {total} department approval request{total === 1 ? '' : 's'}
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
                placeholder="Reference, requirement title or item"
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
              ? 'Requirements appear here when they reach the approval level you are responsible for.'
              : 'Submit a confirmed requirement from the intake chat for department approval.'}
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

      <RequirementApprovalDetailModal
        approval={selected}
        isLoading={isDetailLoading}
        error={detailError}
        onClose={() => setSelected(null)}
        onDecide={(decisionId, nextStatus) => {
          setDecision({ decisionId, status: nextStatus });
          setComments('');
          setDecisionError(null);
        }}
        canApprove={canApprove}
        canBuy={canBuy}
      />

      {/* Decision modal */}
      <Modal
        isOpen={decision !== null}
        onClose={() => setDecision(null)}
        title={
          decision?.status === 'APPROVED'
            ? 'Approve requirement'
            : decision?.status === 'REJECTED'
              ? 'Reject requirement'
              : 'Request changes'
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-stone-600">
            {decision?.status === 'APPROVED'
              ? 'Approving authorizes vendor sourcing for this requirement.'
              : decision?.status === 'REJECTED'
                ? 'Rejecting stops this requirement. The requester will see your reason.'
                : 'The requester will see your reason and can submit a revised requirement.'}
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
    </div>
  );
};

// ── Row ───────────────────────────────────────────────────────────────────────

const ApprovalRow: React.FC<{
  approval: RequirementApprovalRequestDetail;
  onOpen: () => void;
  onOpenRequest: () => void;
}> = ({ approval, onOpen, onOpenRequest }) => {
  const presentation = presentRequirementApprovalStatus(approval.status);

  const icon =
    approval.status === RequirementApprovalStatus.APPROVED ? (
      <CheckCircle className="h-5 w-5 text-emerald-600" />
    ) : approval.status === RequirementApprovalStatus.REJECTED ||
      approval.status === RequirementApprovalStatus.CHANGES_REQUESTED ? (
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
          {approval.request?.title ?? approval.request?.item ?? 'Requirement'} ·{' '}
          {formatRequirementAmount(approval.estimatedAmount, approval.currency)} ·{' '}
          {approval.request?.quantity ? `${approval.request.quantity} ${approval.request.unit ?? 'unit'}` : ''}
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

const RequirementApprovalDetailModal: React.FC<{
  approval: RequirementApprovalRequestDetail | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onDecide: (decisionId: string, status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED') => void;
  canApprove: boolean;
  canBuy: boolean;
}> = ({ approval, isLoading, error, onClose, onDecide, canApprove, canBuy }) => {
  if (!approval && !isLoading && !error) return null;

  const presentation = approval ? presentRequirementApprovalStatus(approval.status) : null;
  const outstanding = approval ? pendingLevels(approval.decisions) : [];
  const next = approval ? nextRequiredRole(approval.decisions, approval.currentLevel) : null;
  const isOwnRequest = approval?.submittedById != null;

  return (
    <Modal
      isOpen={Boolean(approval) || isLoading || Boolean(error)}
      onClose={onClose}
      title="Requirement authorization"
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

          {/* Requirement details */}
          <div className="rounded-lg border border-stone-200 divide-y divide-stone-100">
            <Row label="Requirement" value={approval.request?.title ?? '—'} />
            <Row label="Item" value={approval.request?.item ?? '—'} />
            <Row
              label="Quantity"
              value={approval.request?.quantity
                ? `${approval.request.quantity} ${approval.request.unit ?? 'unit'}`
                : '—'}
            />
            <Row label="Estimated budget" value={formatRequirementAmount(approval.estimatedAmount, approval.currency)} />
            <Row label="Department" value={approval.request?.department ?? '—'} />
            <Row label="Cost center" value={approval.request?.costCenter ?? '—'} />
            <Row label="Location" value={approval.request?.location ?? '—'} />
            <Row label="Required by" value={approval.request?.requiredDate ? format(new Date(approval.request.requiredDate), 'dd MMM yyyy') : '—'} />
            <Row label="Specifications" value={approval.request?.specifications ?? 'Not specified'} />
            <Row label="Description" value={approval.request?.description ?? '—'} />
          </div>

          {/* Why approval is required and who must give it */}
          {approval.route && (
            <div className="rounded-lg bg-blue-50 border border-blue-100 p-3">
              <p className="text-xs font-medium text-blue-900 mb-1 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" />
                Why this needs approval
              </p>
              <p className="text-xs text-blue-800">
                {approval.route.rule
                  ? `Matched rule "${approval.route.rule.name}" (priority ${approval.route.rule.priority})`
                  : 'Auto-approved (below threshold)'}
              </p>
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
                  No approval levels were required for this requirement.
                </p>
              ) : (
                approval.decisions.map((level) => {
                  const levelPresentation = presentRequirementDecisionStatus(level.status);
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

          {approval.requesterComment && (
            <div>
              <p className="text-xs font-medium text-stone-600 mb-1">Note from the requester</p>
              <p className="text-xs text-stone-600">{approval.requesterComment}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap justify-end gap-2 pt-3 border-t border-stone-100">
            {canBuy && isOwnRequest && approval.status !== RequirementApprovalStatus.APPROVED && (
              <p className="text-xs text-stone-400 mr-auto self-center">
                You submitted this request.
              </p>
            )}

            {canApprove && approval.status === RequirementApprovalStatus.PENDING_APPROVAL && outstanding[0] && (
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

            {!canApprove && approval.status === RequirementApprovalStatus.PENDING_APPROVAL && (
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