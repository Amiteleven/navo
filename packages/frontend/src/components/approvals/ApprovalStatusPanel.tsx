import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, Clock, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { purchaseApprovalApi } from '../../services/api';
import { PurchaseApprovalRequestDetail } from '../../types';
import {
  formatApprovalAmount,
  nextRequiredRole,
  presentApprovalStatus,
} from '../../utils/purchaseApproval';

/**
 * The buyer's read-only view of a purchase they have already submitted for
 * authorization.
 *
 * It exists because the states in this workflow are easy to misread from the
 * outside. An approved request is authorized but *not bought*; a rejected one is
 * not the same as a request nobody has looked at. A buyer who cannot see which of
 * those they are in will either wait on nothing or re-negotiate a deal that was
 * already approved.
 */
export const ApprovalStatusPanel: React.FC<{
  approvalId: string;
  onOpenInbox?: () => void;
}> = ({ approvalId, onOpenInbox }) => {
  const [detail, setDetail] = useState<PurchaseApprovalRequestDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    purchaseApprovalApi
      .get(approvalId)
      .then((response) => {
        if (!cancelled) setDetail(response.data.data ?? null);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [approvalId]);

  if (isLoading) {
    return (
      <div className="card p-4 flex items-center gap-2 text-sm text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading approval status…
      </div>
    );
  }

  // A failed lookup renders nothing rather than an error: the panel is an
  // addition to the page, and a dead panel must not take the requirement down
  // with it.
  if (!detail) return null;

  const presentation = presentApprovalStatus(detail.status);
  const nextRole = nextRequiredRole(detail.decisions, detail.currentLevel);

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          {presentation.tone === 'success' ? (
            <CheckCircle className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
          ) : presentation.tone === 'warning' ? (
            <Clock className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          ) : presentation.tone === 'danger' ? (
            <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-4 w-4 text-stone-500 flex-shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-stone-800">
              {presentation.label}{' '}
              <span className="font-mono text-xs font-normal text-stone-400">
                {detail.reference}
              </span>
            </p>
            <p className="text-xs text-stone-500 mt-0.5">{presentation.explanation}</p>
            <p className="text-xs text-stone-400 mt-0.5">
              {formatApprovalAmount(detail.totalAmount, detail.currency)}
              {detail.revision > 1 && ` · revision ${detail.revision}`}
            </p>
            {nextRole && (
              <p className="text-xs text-stone-500 mt-1">
                Awaiting {nextRole.label.toLowerCase()} approval
              </p>
            )}
          </div>
        </div>
        <Badge variant={presentation.tone}>{presentation.label}</Badge>
      </div>
      {onOpenInbox && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onOpenInbox}>
          View in approvals
        </Button>
      )}
    </div>
  );
};