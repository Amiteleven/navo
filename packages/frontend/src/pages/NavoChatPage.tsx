/**
 * NAVO — Chat-First Procurement Platform
 *
 * The primary interface. The buyer types what they need.
 * NAVO handles everything: intake, approval, vendor matching,
 * offer collection, commercial evaluation, negotiation, and deal.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Building2, Tag, MapPin, Calendar,
  DollarSign, FileText, Package, CornerDownLeft,
  Loader2, Sparkles, ArrowUp, CheckCircle2, History,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { requirementIntakeApi, intakeApi } from '../services/navoApi';
import toast from 'react-hot-toast';
import type { RequirementDraftDetail } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

type WorkflowStage =
  | 'WELCOME'
  | 'INTAKE'
  | 'PENDING_APPROVAL'
  | 'APPROVED_FOR_SOURCING'
  | 'VENDOR_MATCHING'
  | 'OFFERS_RECEIVED'
  | 'COMMERCIAL_EVAL'
  | 'NEGOTIATION'
  | 'PENDING_FINAL_APPROVAL'
  | 'DEAL_CONFIRMED'
  | 'EXECUTION';

interface ChatMessage {
  id: string;
  role: 'user' | 'navo' | 'system';
  content: string;
  timestamp: Date;
  card?: React.ReactNode;
  isTyping?: boolean;
}

interface NavoState {
  stage: WorkflowStage;
  draft: RequirementDraftDetail | null;
  requestId: string | null;
  pendingApprovalId: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCurrency(rawAmount: number | string | null | undefined, currency = 'INR'): string {
  if (!rawAmount) return '—';
  const amount = Number(rawAmount);
  if (isNaN(amount)) return '—';
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency + ' ';
  if (amount >= 10000000) return `${symbol}${(amount / 10000000).toFixed(1)} Cr`;
  if (amount >= 100000) return `${symbol}${(amount / 100000).toFixed(1)} L`;
  if (amount >= 1000) return `${symbol}${(amount / 1000).toFixed(1)}K`;
  return `${symbol}${amount.toLocaleString()}`;
}

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EXAMPLE_PROMPTS = [
  'I need 50 office chairs for our new Bangalore office',
  'We need cybersecurity services for our European operations',
  'Find a supplier for 10,000 packaging boxes',
  'I need 100 laptops for our new employees',
  'We need monthly housekeeping services for 3 floors',
  'I need a CRM for 200 employees',
  'I need an event management company for our annual conference',
];

// ─── Requirement Card Component ───────────────────────────────────────────────

const RequirementCard: React.FC<{
  draft: RequirementDraftDetail & { completeness?: any; version?: number; versionHistory?: any[] };
  isUpdating?: boolean;
  onSubmitForApproval?: () => void;
}> = ({
  draft,
  isUpdating,
  onSubmitForApproval,
}) => {
  const [showHistory, setShowHistory] = useState(false);
  const completeness = draft.completeness;
  const isReady = completeness?.isSourcingReady || draft.state === 'DRAFT' || draft.state === 'CONFIRMED';
  const score = completeness?.score ?? (isReady ? 85 : 45);

  const fields = [
    { icon: Package, label: 'Item', value: draft.item },
    { icon: Tag, label: 'Category', value: draft.category },
    { icon: Building2, label: 'Quantity', value: draft.quantity ? `${draft.quantity} ${draft.unit || ''}` : null },
    { icon: MapPin, label: 'Delivery Location', value: draft.location },
    { icon: Calendar, label: 'Required By', value: formatDate(draft.requiredDate) !== '—' ? formatDate(draft.requiredDate) : null },
    { icon: DollarSign, label: 'Estimated Budget', value: draft.estimatedBudget ? formatCurrency(draft.estimatedBudget, draft.currency) : null },
    {
      icon: FileText,
      label: 'Specifications',
      value: typeof draft.specifications === 'object' && draft.specifications
        ? JSON.stringify(draft.specifications).replace(/["{}]/g, '').replace(/:/g, ': ')
        : draft.specifications,
    },
  ].filter((f) => f.value);

  return (
    <div className="navo-card navo-requirement-card border border-stone-200/80 shadow-sm rounded-xl overflow-hidden bg-white my-2">
      <div className="navo-card-header flex items-center justify-between p-3.5 bg-stone-50/80 border-b border-stone-100">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${isReady ? 'bg-emerald-500 animate-pulse' : 'bg-blue-500'}`} />
          <span className="text-xs font-semibold uppercase tracking-wider text-stone-600">
            {isReady ? 'READY FOR APPROVAL' : 'REQUIREMENT DRAFT'}
          </span>
          {draft.version && (
            <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-stone-200/80 text-stone-700">
              V{draft.version}
            </span>
          )}
        </div>
        {isUpdating ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        ) : (
          <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${isReady ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`}>
            {score}% Complete
          </span>
        )}
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-stone-100 h-1.5">
        <div
          className={`h-1.5 transition-all duration-500 ${isReady ? 'bg-emerald-500' : 'bg-blue-500'}`}
          style={{ width: `${score}%` }}
        />
      </div>

      <div className="p-4">
        <h3 className="text-base font-bold text-stone-900 tracking-tight">{draft.title || draft.item || 'Procurement Requirement'}</h3>

        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          {fields.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex items-start gap-1.5 p-1.5 rounded bg-stone-50/70 border border-stone-100">
              <Icon className="h-3.5 w-3.5 text-stone-400 mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-stone-500 block text-[10px] uppercase font-medium">{label}</span>
                <span className="font-semibold text-stone-800">{String(value)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Missing fields alert if not yet ready */}
        {completeness?.missingFields && completeness.missingFields.length > 0 && !isReady && (
          <div className="mt-3 p-2.5 rounded-lg bg-amber-50/80 border border-amber-200/60 text-xs">
            <span className="font-semibold text-amber-900 block mb-1">Awaiting details before sourcing:</span>
            <ul className="text-amber-800 list-disc list-inside space-y-0.5 text-[11px]">
              {completeness.missingFields.slice(0, 2).map((m: any) => (
                <li key={m.field}>{m.label} {m.isCritical ? '(required)' : '(optional)'}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Version History Toggle */}
        {draft.versionHistory && draft.versionHistory.length > 1 && (
          <div className="mt-3 pt-2 border-t border-stone-100">
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="text-xs font-medium text-stone-500 hover:text-stone-800 flex items-center gap-1 transition-colors"
            >
              <History className="h-3 w-3" />
              {showHistory ? 'Hide Version History' : `View Version History (${draft.versionHistory.length} revisions)`}
            </button>
            {showHistory && (
              <div className="mt-2 space-y-1.5 p-2 rounded bg-stone-50 text-[11px] text-stone-600 border border-stone-100">
                {draft.versionHistory.map((v: any) => (
                  <div key={v.versionNumber} className="flex items-start gap-1.5">
                    <span className="font-bold text-stone-800 min-w-[28px]">V{v.versionNumber}:</span>
                    <span>{v.changeSummary}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Action Button */}
        {isReady && onSubmitForApproval && (
          <div className="mt-4 pt-3 border-t border-stone-100">
            <button
              className="w-full py-2.5 px-3 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-sm"
              onClick={onSubmitForApproval}
            >
              <CheckCircle2 className="h-4 w-4" />
              Submit for Department Head Approval
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Approval Request Card (Department Head view) ─────────────────────────────

/*
interface ApprovalCardProps {
  draft: RequirementDraftDetail;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onSendBack: (comment: string) => void;
  isDeciding: boolean;
}

const ApprovalRequestCard: React.FC<ApprovalCardProps> = ({
  draft, onApprove, onReject, onSendBack, isDeciding,
}) => {
  const [action, setAction] = useState<'idle' | 'rejecting' | 'sendback'>('idle');
  const [reason, setReason] = useState('');

  return (
    <div className="navo-card navo-approval-card">
      <div className="navo-card-header">
        <span className="navo-card-label">PURCHASE REQUEST</span>
        <span className="navo-badge navo-badge-pending">PENDING APPROVAL</span>
      </div>
      <h3 className="navo-card-title mt-2">{draft.title || draft.item}</h3>
      <div className="navo-card-fields mt-3">
        {draft.quantity && (
          <div className="navo-field-row">
            <span className="navo-field-label"><Package className="h-3.5 w-3.5 mr-1.5" />Quantity</span>
            <span className="navo-field-value">{draft.quantity} {draft.unit || ''}</span>
          </div>
        )}
        {draft.location && (
          <div className="navo-field-row">
            <span className="navo-field-label"><MapPin className="h-3.5 w-3.5 mr-1.5" />Location</span>
            <span className="navo-field-value">{draft.location}</span>
          </div>
        )}
        {draft.estimatedBudget && (
          <div className="navo-field-row">
            <span className="navo-field-label"><DollarSign className="h-3.5 w-3.5 mr-1.5" />Est. Value</span>
            <span className="navo-field-value navo-value-highlight">{formatCurrency(draft.estimatedBudget, draft.currency)}</span>
          </div>
        )}
        {draft.requiredDate && (
          <div className="navo-field-row">
            <span className="navo-field-label"><Calendar className="h-3.5 w-3.5 mr-1.5" />Required By</span>
            <span className="navo-field-value">{formatDate(draft.requiredDate)}</span>
          </div>
        )}
      </div>

      {action === 'idle' && (
        <div className="navo-card-actions">
          <button
            className="navo-btn navo-btn-approve"
            onClick={onApprove}
            disabled={isDeciding}
          >
            {isDeciding ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Approve
          </button>
          <button
            className="navo-btn navo-btn-secondary"
            onClick={() => setAction('sendback')}
            disabled={isDeciding}
          >
            <RotateCcw className="h-4 w-4" />
            Send Back
          </button>
          <button
            className="navo-btn navo-btn-danger"
            onClick={() => setAction('rejecting')}
            disabled={isDeciding}
          >
            <XCircle className="h-4 w-4" />
            Reject
          </button>
        </div>
      )}

      {(action === 'rejecting' || action === 'sendback') && (
        <div className="mt-3 space-y-2">
          <textarea
            placeholder={action === 'rejecting' ? 'Reason for rejection (required)…' : 'Comments for buyer…'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full text-sm border border-stone-200 rounded-lg px-3 py-2 resize-none h-20 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
          />
          <div className="flex gap-2">
            <button
              className="navo-btn navo-btn-approve text-sm"
              disabled={!reason.trim() || isDeciding}
              onClick={() => {
                if (action === 'rejecting') onReject(reason);
                else onSendBack(reason);
              }}
            >
              {isDeciding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Confirm {action === 'rejecting' ? 'Rejection' : 'Send Back'}
            </button>
            <button className="navo-btn navo-btn-ghost text-sm" onClick={() => { setAction('idle'); setReason(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Approval Status Card (Buyer view) ───────────────────────────────────────

const ApprovalStatusCard: React.FC<{
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  title: string;
  comments?: string;
}> = ({ status, title, comments }) => {
  const configs = {
    PENDING: { icon: Clock, color: 'navo-badge-pending', label: 'AWAITING APPROVAL', bg: 'navo-status-pending-bg' },
    APPROVED: { icon: CheckCircle2, color: 'navo-badge-approved', label: 'APPROVED', bg: 'navo-status-approved-bg' },
    REJECTED: { icon: XCircle, color: 'navo-badge-rejected', label: 'REJECTED', bg: 'navo-status-rejected-bg' },
    CHANGES_REQUESTED: { icon: RotateCcw, color: 'navo-badge-changes', label: 'CHANGES REQUESTED', bg: 'navo-status-changes-bg' },
  };
  const cfg = configs[status];
  const Icon = cfg.icon;

  return (
    <div className={`navo-card ${cfg.bg}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide">{cfg.label}</p>
          <p className="text-sm font-medium mt-0.5">{title}</p>
        </div>
        <span className={`navo-badge ${cfg.color} ml-auto`}>{cfg.label}</span>
      </div>
      {comments && (
        <p className="mt-2 text-xs text-stone-600 border-t border-stone-200 pt-2">{comments}</p>
      )}
    </div>
  );
};

// ─── Vendor Opportunity Card (Vendor view) ────────────────────────────────────

const VendorOpportunityCard: React.FC<{
  title: string;
  location?: string | null;
  requiredBy?: string | null;
  quantity?: number | null;
  unit?: string | null;
  onRespond: () => void;
  onDecline: () => void;
}> = ({ title, location, requiredBy, quantity, unit, onRespond, onDecline }) => (
  <div className="navo-card navo-opportunity-card">
    <div className="navo-card-header">
      <span className="navo-card-label">NAVO BUSINESS OPPORTUNITY</span>
      <span className="navo-badge navo-badge-new">NEW</span>
    </div>
    <h3 className="navo-card-title mt-2">{title}</h3>
    <div className="navo-card-fields mt-3">
      {quantity && (
        <div className="navo-field-row">
          <span className="navo-field-label"><Package className="h-3.5 w-3.5 mr-1.5" />Quantity</span>
          <span className="navo-field-value">{quantity} {unit || ''}</span>
        </div>
      )}
      {location && (
        <div className="navo-field-row">
          <span className="navo-field-label"><MapPin className="h-3.5 w-3.5 mr-1.5" />Location</span>
          <span className="navo-field-value">{location}</span>
        </div>
      )}
      {requiredBy && (
        <div className="navo-field-row">
          <span className="navo-field-label"><Calendar className="h-3.5 w-3.5 mr-1.5" />Required By</span>
          <span className="navo-field-value">{formatDate(requiredBy)}</span>
        </div>
      )}
    </div>
    <p className="text-xs text-stone-500 mt-2">Submit your best commercial offer.</p>
    <div className="navo-card-actions">
      <button className="navo-btn navo-btn-approve" onClick={onRespond}>
        <MessageSquare className="h-4 w-4" />
        Respond
      </button>
      <button className="navo-btn navo-btn-ghost" onClick={onDecline}>
        Decline
      </button>
    </div>
  </div>
);

// ─── Commercial Evaluation Card ───────────────────────────────────────────────

interface CommEvalCardProps {
  vendorName: string;
  totalAmount: number;
  currency?: string;
  deliveryDays?: number | null;
  paymentTerms?: string | null;
  warrantyMonths?: number | null;
  installationIncluded?: boolean;
  reasoning: string;
  negotiationRecommended: boolean;
  negotiationReason?: string;
  estimatedSavingsMin?: number;
  estimatedSavingsMax?: number;
  onAccept: () => void;
  onNegotiate: () => void;
  onSelectOther?: () => void;
}

const CommercialEvalCard: React.FC<CommEvalCardProps> = ({
  vendorName, totalAmount, currency = 'INR', deliveryDays, paymentTerms,
  warrantyMonths, installationIncluded, reasoning, negotiationRecommended,
  negotiationReason, estimatedSavingsMin, estimatedSavingsMax,
  onAccept, onNegotiate, onSelectOther,
}) => (
  <div className="navo-card navo-eval-card">
    <div className="navo-card-header">
      <span className="navo-card-label">RECOMMENDED COMMERCIAL OUTCOME</span>
      <span className="navo-badge navo-badge-approved">RECOMMENDED</span>
    </div>
    <div className="navo-eval-vendor mt-3">
      <div className="flex items-center gap-2">
        <span className="navo-vendor-avatar">{vendorName.charAt(0)}</span>
        <div>
          <p className="font-semibold text-stone-900">{vendorName}</p>
          <p className="text-xs text-stone-500">Recommended Vendor</p>
        </div>
        <span className="ml-auto text-xl font-bold text-emerald-700">{formatCurrency(totalAmount, currency)}</span>
      </div>
    </div>
    <div className="navo-card-fields mt-3">
      {deliveryDays && (
        <div className="navo-field-row">
          <span className="navo-field-label"><Clock className="h-3.5 w-3.5 mr-1.5" />Delivery</span>
          <span className="navo-field-value">{deliveryDays} days</span>
        </div>
      )}
      {installationIncluded && (
        <div className="navo-field-row">
          <span className="navo-field-label"><ShieldCheck className="h-3.5 w-3.5 mr-1.5" />Installation</span>
          <span className="navo-field-value text-emerald-700">Included</span>
        </div>
      )}
      {warrantyMonths && (
        <div className="navo-field-row">
          <span className="navo-field-label"><Star className="h-3.5 w-3.5 mr-1.5" />Warranty</span>
          <span className="navo-field-value">{warrantyMonths} months</span>
        </div>
      )}
      {paymentTerms && (
        <div className="navo-field-row">
          <span className="navo-field-label"><FileText className="h-3.5 w-3.5 mr-1.5" />Payment</span>
          <span className="navo-field-value">{paymentTerms}</span>
        </div>
      )}
    </div>

    <div className="navo-navo-assessment mt-3">
      <div className="flex items-start gap-2">
        <Sparkles className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-stone-700">{reasoning}</p>
      </div>
    </div>

    {negotiationRecommended && (
      <div className="navo-negotiation-tip mt-2">
        <div className="flex items-start gap-2">
          <TrendingDown className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-xs font-medium text-amber-800">Negotiation Recommended</p>
            <p className="text-xs text-amber-700 mt-0.5">{negotiationReason}</p>
            {estimatedSavingsMin && estimatedSavingsMax && (
              <p className="text-xs text-amber-600 mt-0.5">
                Estimated opportunity: {formatCurrency(estimatedSavingsMin, currency)}–{formatCurrency(estimatedSavingsMax, currency)}
              </p>
            )}
          </div>
        </div>
      </div>
    )}

    <div className="navo-card-actions mt-4">
      <button className="navo-btn navo-btn-approve" onClick={onAccept}>
        <CheckCircle2 className="h-4 w-4" />
        Accept Recommendation
      </button>
      <button className="navo-btn navo-btn-secondary" onClick={onNegotiate}>
        <MessageSquare className="h-4 w-4" />
        {negotiationRecommended ? 'Negotiate' : 'Continue Negotiation'}
      </button>
      {onSelectOther && (
        <button className="navo-btn navo-btn-ghost" onClick={onSelectOther}>
          Select Another Vendor
        </button>
      )}
    </div>
  </div>
);

// ─── Deal Confirmed Card ──────────────────────────────────────────────────────

const DealConfirmedCard: React.FC<{
  dealNumber?: string;
  vendorName: string;
  totalAmount: number;
  currency?: string;
  onViewDeal: () => void;
}> = ({ dealNumber, vendorName, totalAmount, currency = 'INR', onViewDeal }) => (
  <div className="navo-card navo-deal-card">
    <div className="flex items-center gap-3">
      <span className="navo-deal-icon">
        <CheckCircle2 className="h-6 w-6 text-white" />
      </span>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">DEAL CONFIRMED</p>
        <p className="font-semibold text-stone-900">
          {vendorName} · {formatCurrency(totalAmount, currency)}
        </p>
        {dealNumber && <p className="text-xs text-stone-500">Ref: {dealNumber}</p>}
      </div>
    </div>
    <button className="navo-btn navo-btn-approve mt-3 w-full" onClick={onViewDeal}>
      <Zap className="h-4 w-4" />
      View Deal & Begin Execution
    </button>
  </div>
);
*/


// ─── Typing Indicator ─────────────────────────────────────────────────────────

const TypingIndicator: React.FC = () => (
  <div className="navo-typing">
    <span />
    <span />
    <span />
  </div>
);

// ─── NAVO Chat Page ───────────────────────────────────────────────────────────

export const NavoChatPage: React.FC = () => {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [navoState, setNavoState] = useState<NavoState>({
    stage: 'WELCOME',
    draft: null,
    requestId: null,
    pendingApprovalId: null,
  });
  const [clarificationField, setClarificationField] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, scrollToBottom]);

  // ─── Welcome message ──────────────────────────────────────────────────────

  useEffect(() => {
    const greeting = getGreeting();
    const firstName = user?.firstName || 'there';
    setMessages([
      {
        id: 'welcome',
        role: 'navo',
        content: `${greeting}, ${firstName} 👋\n\nI'm NAVO — your AI procurement agent.\n\n**What do you need?**\n\nJust tell me in plain language. I'll handle approval, vendor sourcing, offer collection, negotiation, and the deal — all without leaving this chat.`,
        timestamp: new Date(),
      },
    ]);
  }, [user?.firstName]);

  // ─── Add NAVO message with typing delay ───────────────────────────────────

  const addNavoMessage = useCallback(
    async (content: string, card?: React.ReactNode, delay = 600): Promise<string> => {
      setIsTyping(true);
      await sleep(delay);
      setIsTyping(false);
      const id = `navo-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id, role: 'navo', content, timestamp: new Date(), card },
      ]);
      return id;
    },
    []
  );

  const addUserMessage = useCallback((content: string): string => {
    const id = `user-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id, role: 'user', content, timestamp: new Date() },
    ]);
    return id;
  }, []);

  // ─── Handle requirement intake ────────────────────────────────────────────

  // ─── Handle approval submission ───────────────────────────────────────────

  const handleSubmitForApproval = useCallback(async () => {
    if (!navoState.draft) return;
    setIsSending(true);
    try {
      // Step 1: Confirm the draft → creates ProcurementRequest
      const confirmRes = await requirementIntakeApi.confirmDraft({ draftId: navoState.draft.id });
      const requestId = confirmRes.data.data?.requestId;

      if (!requestId) throw new Error('No requestId returned from confirmDraft');

      // Step 2: Submit the confirmed request for department approval
      const approvalRes = await intakeApi.submitForApproval(requestId);
      const approvalData = approvalRes.data.data;

      setNavoState((s) => ({
        ...s,
        stage: approvalData?.autoApproved ? 'APPROVED_FOR_SOURCING' : 'PENDING_APPROVAL',
        requestId: requestId || null,
        pendingApprovalId: approvalData?.approvalId || null,
      }));

      if (approvalData?.autoApproved) {
        await addNavoMessage(
          '✅ Your requirement was **auto-approved** by policy. I will now begin matching vendors.',
          undefined,
          600
        );
      } else {
        await addNavoMessage(
          'Your requirement has been sent for **department approval**. I\'ll notify you the moment a decision is made.',
          <div className="navo-card navo-approval-card border border-stone-200/80 rounded-xl p-4 bg-white shadow-sm my-2">
            <div className="navo-card-header flex items-center justify-between pb-2 border-b border-stone-100">
              <span className="text-xs font-semibold uppercase tracking-wider text-stone-600">PENDING DEPARTMENT APPROVAL</span>
              <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800">PENDING</span>
            </div>
            <div className="text-sm font-bold text-stone-900 mt-2">{navoState.draft!.title || navoState.draft!.item || 'Your Requirement'}</div>
            <p className="text-xs text-stone-500 mt-1">The department head has been notified and will review shortly.</p>
          </div>,
          600
        );
      }
    } catch (err: any) {
      const message = err?.response?.data?.message || 'Failed to submit for approval';
      toast.error(message);
      await addNavoMessage('I had trouble submitting this for approval. Please try again.', undefined, 400);
    } finally {
      setIsSending(false);
    }
  }, [navoState.draft, addNavoMessage]);

  // ─── Handle requirement intake ────────────────────────────────────────────

  const handleRequirementMessage = useCallback(
    async (text: string) => {
      setIsSending(true);
      try {
        const conversationId = navoState.draft?.copilotConversationId || (navoState.draft ? `conv-${navoState.draft.id}` : undefined);
        const res = await intakeApi.createDraft(text, conversationId);
        const data = res.data.data!;

        setNavoState((s) => ({
          ...s,
          draft: data,
          stage: 'INTAKE',
        }));

        if (data.completeness?.nextQuestions && data.completeness.nextQuestions.length > 0 && !data.completeness.isSourcingReady) {
          setClarificationField(data.completeness.nextQuestions[0].field);
        } else {
          setClarificationField(null);
        }

        const replyText = data.replyMessage || (
          data.completeness?.isSourcingReady
            ? `I've structured your requirement for **${data.item || 'your request'}**. Everything needed for department approval is in place.`
            : `I've noted your requirement for **${data.item || 'this item'}**.`
        );

        await addNavoMessage(
          replyText,
          <RequirementCard
            draft={data}
            onSubmitForApproval={data.completeness?.isSourcingReady ? handleSubmitForApproval : undefined}
          />,
          600
        );
      } catch (err) {
        await addNavoMessage('I had trouble processing that. Could you try again?', undefined, 400);
        console.error(err);
      } finally {
        setIsSending(false);
      }
    },
    [navoState.draft, addNavoMessage, handleSubmitForApproval, setClarificationField]
  );

  // ─── Handle approval decision (for approvers) ─────────────────────────────

/*
  const handleApprovalDecision = useCallback(
    async (approvalId: string, decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED', comments?: string) => {
      setIsDecidingApproval(true);
      try {
        await navoApi.decideRequirementApproval(approvalId, decision, comments);
        const stageMap = {
          APPROVED: 'APPROVED_FOR_SOURCING',
          REJECTED: 'WELCOME',
          CHANGES_REQUESTED: 'INTAKE',
        } as const;
        setNavoState((s) => ({ ...s, stage: stageMap[decision] }));

        if (decision === 'APPROVED') {
          await addNavoMessage(
            'Requirement **approved**. I\'ll now find the most suitable vendors and send them this requirement privately.',
            <ApprovalStatusCard status="APPROVED" title="Requirement approved for sourcing" />,
            600
          );
        } else if (decision === 'REJECTED') {
          await addNavoMessage(
            'Requirement rejected. The buyer will be notified with your comments.',
            <ApprovalStatusCard status="REJECTED" title="Requirement rejected" comments={comments} />,
            600
          );
        } else {
          await addNavoMessage(
            'Requirement sent back with your comments.',
            <ApprovalStatusCard status="CHANGES_REQUESTED" title="Changes requested" comments={comments} />,
            600
          );
        }
      } catch (err) {
        toast.error('Failed to process approval decision');
      } finally {
        setIsDecidingApproval(false);
      }
    },
    [addNavoMessage, setIsDecidingApproval]
  );
*/


  // ─── Main message handler ─────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isSending) return;

    addUserMessage(text);
    setInput('');

    const lower = text.toLowerCase();

    switch (navoState.stage) {
      case 'WELCOME':
      case 'INTAKE':
        if (isApprovalIntent(lower) && navoState.draft) {
          // Check if draft is confirmable first
          const unanswered = (navoState.draft.questions ?? []).filter((q: any) => !q.userAnswer);
          if (unanswered.length > 0) {
            await addNavoMessage(
              `I still need a few details before we can proceed. ${unanswered[0].question}`,
              undefined,
              400
            );
          } else {
            await handleSubmitForApproval();
          }
        } else {
          await handleRequirementMessage(text);
        }
        break;

      case 'PENDING_APPROVAL':
        await addNavoMessage(
          'Your requirement is **pending department approval**. I\'ll bring you back here the moment a decision is made. Is there anything else you want to work on?',
          undefined,
          500
        );
        break;

      case 'APPROVED_FOR_SOURCING':
        await addNavoMessage(
          'Great! Let me find the right vendors for this. I\'m matching your requirement against our global vendor network.',
          undefined,
          500
        );
        setNavoState((s) => ({ ...s, stage: 'VENDOR_MATCHING' }));
        await sleep(1500);
        await addNavoMessage(
          'I\'ve identified qualified vendors matching your requirement. I\'m sending each of them your requirement privately — **they won\'t know about each other**.\n\nYou\'ll be notified as offers come in.',
          undefined,
          600
        );
        setNavoState((s) => ({ ...s, stage: 'OFFERS_RECEIVED' }));
        break;

      default:
        await addNavoMessage(
          'I\'m here to help with your procurement. What do you need?',
          undefined,
          400
        );
    }
  }, [input, isSending, navoState, addUserMessage, handleRequirementMessage, handleSubmitForApproval, addNavoMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="navo-chat-page">
      {/* Messages */}
      <div className="navo-messages-area">
        <div className="navo-messages-inner">
          {messages.map((msg) => (
            <div key={msg.id} className={`navo-message-row ${msg.role === 'user' ? 'navo-message-user' : 'navo-message-navo'}`}>
              {msg.role === 'navo' && (
                <span className="navo-avatar">
                  <Sparkles className="h-3.5 w-3.5 text-white" />
                </span>
              )}
              <div className={`navo-message-content ${msg.role === 'user' ? 'navo-bubble-user' : 'navo-bubble-navo'}`}>
                {msg.content && (
                  <div className="navo-message-text">
                    {formatMarkdown(msg.content)}
                  </div>
                )}
                {msg.card && <div className="mt-3">{msg.card}</div>}
              </div>
            </div>
          ))}

          {isTyping && (
            <div className="navo-message-row navo-message-navo">
              <span className="navo-avatar">
                <Sparkles className="h-3.5 w-3.5 text-white" />
              </span>
              <div className="navo-bubble-navo p-3">
                <TypingIndicator />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Example prompts — shown on welcome screen */}
      {navoState.stage === 'WELCOME' && messages.length <= 1 && (
        <div className="navo-examples">
          <p className="navo-examples-label">Try an example</p>
          <div className="navo-examples-grid">
            {EXAMPLE_PROMPTS.slice(0, 4).map((prompt) => (
              <button
                key={prompt}
                className="navo-example-chip"
                onClick={() => {
                  setInput(prompt);
                  inputRef.current?.focus();
                }}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="navo-composer">
        <div className="navo-composer-inner">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={getPlaceholder(navoState.stage, clarificationField)}
            className="navo-composer-textarea"
            rows={1}
            disabled={isSending}
          />
          <div className="navo-composer-actions">
            <span className="navo-composer-hint">
              <CornerDownLeft className="h-3 w-3 mr-1" />
              Enter to send
            </span>
            <button
              className="navo-send-btn"
              onClick={() => void handleSend()}
              disabled={!input.trim() || isSending}
            >
              {isSending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function isApprovalIntent(text: string): boolean {
  return (
    text.includes('send for approval') ||
    text.includes('submit') ||
    text.includes('approve') ||
    text.includes('yes') ||
    text.includes('confirm') ||
    text.includes('proceed') ||
    text.includes('go ahead')
  );
}

function getPlaceholder(stage: WorkflowStage, clarificationField: string | null): string {
  if (clarificationField) return 'Type your answer…';
  switch (stage) {
    case 'WELCOME':
      return 'What do you need? (e.g. "I need 50 office chairs for Bangalore")';
    case 'INTAKE':
      return 'Continue describing your requirement…';
    case 'PENDING_APPROVAL':
      return 'Ask me anything about this requirement…';
    case 'APPROVED_FOR_SOURCING':
      return 'Add sourcing details or ask me to proceed…';
    default:
      return 'Message NAVO…';
  }
}

/** Very lightweight markdown bold/newline renderer */
function formatMarkdown(text: string): React.ReactNode {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    // Bold: **text**
    const parts = line.split(/\*\*(.*?)\*\*/g);
    const rendered = parts.map((part, j) =>
      j % 2 === 1 ? <strong key={j}>{part}</strong> : part
    );
    return (
      <React.Fragment key={i}>
        {rendered}
        {i < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
}
