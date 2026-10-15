import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Loader2,
  AlertTriangle,
  FileText,
  RefreshCw,
} from 'lucide-react';
import { commercialOffersApi } from '../../services/api';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { OfferStatus } from '../../types';
import { formatAmount, formatDate } from '../../utils/purchaseOrder';

const MAX_SUBMISSIONS = 4;

export const VendorOfferPage: React.FC = () => {
  const { vendorAssignmentId } = useParams<{ vendorAssignmentId: string }>();
  const navigate = useNavigate();
  const [offer, setOffer] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOffer = useCallback(async () => {
    if (!vendorAssignmentId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await commercialOffersApi.getOfferByAssignment(vendorAssignmentId);
      if (response.data.success && response.data.data) {
        setOffer(response.data.data);
      } else {
        setError(response.data.error || 'Could not load offer');
      }
    } catch (err) {
      setError((err as Error).message || 'Could not load offer');
    } finally {
      setLoading(false);
    }
  }, [vendorAssignmentId]);

  useEffect(() => {
    loadOffer();
  }, [loadOffer]);

  const handleSubmit = async () => {
    if (!offer || !vendorAssignmentId) return;

    const submittedCount = offer.submissions?.length ?? 0;
    if (submittedCount >= MAX_SUBMISSIONS) {
      setError(`You have already submitted ${MAX_SUBMISSIONS} offers. The commercial process must be reopened by the buyer.`);
      return;
    }

    setSubmitting(true);
    try {
      const response = await commercialOffersApi.submitOffer(vendorAssignmentId, {
        requestId: offer.requestId,
        offerType: offer.offerType,
        currency: offer.currency,
        subTotal: 0,
        totalAmount: 0,
        paymentTerms: 'Net 30',
        offerValidityDays: 30,
        scope: 'Standard scope',
        exclusions: '',
        supportingDocuments: [],
        idempotencyKey: `${vendorAssignmentId}-${Date.now()}`,
      });

      if (response.data.success) {
        await loadOffer();
      } else {
        setError(response.data.error || 'Submission failed');
      }
    } catch (err) {
      setError((err as Error).message || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async () => {
    if (!offer || !window.confirm('Withdraw this offer?')) return;
    try {
      await commercialOffersApi.withdrawOffer(offer.id);
      await loadOffer();
    } catch (err) {
      setError((err as Error).message || 'Could not withdraw offer');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error || !offer) {
    return (
      <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
        <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
        {error ?? 'Offer not found'}
      </div>
    );
  }

  const submittedCount = offer.submissions?.length ?? 0;
  const canSubmit = submittedCount < MAX_SUBMISSIONS && !offer.finalOfferSubmitted;
  const isDeadlinePassed = offer.deadline ? new Date(offer.deadline) < new Date() : false;

  const statusVariant: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'purple'> = {
    VENDOR_INVITED: 'info',
    OFFER_DRAFT: 'warning',
    OFFER_SUBMITTED: 'primary',
    FINAL_OFFER_SUBMITTED: 'success',
    COMMERCIAL_PROCESS_REOPENED: 'purple',
    WITHDRAWN: 'danger',
    DECLINED: 'neutral',
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => navigate(-1)}
          className="p-1.5 hover:bg-stone-100 rounded-lg transition-colors"
        >
          <RefreshCw className="h-5 w-5 text-stone-500" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-stone-900">
            Offer for: {offer.request?.title ?? 'Opportunity'}
          </h1>
          <p className="text-sm text-stone-500 mt-1">
            {offer.vendor?.name} · Opportunity #{vendorAssignmentId?.slice(0, 8)}
          </p>
        </div>
        <Badge variant={statusVariant[offer.status] ?? 'neutral'}>{offer.status}</Badge>
      </div>

      <Card className="p-6">
        <h2 className="text-sm font-semibold text-stone-800 mb-4">Requirement Summary</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-stone-500">Item</dt>
            <dd className="font-medium text-stone-900">{offer.request?.item}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Quantity</dt>
            <dd className="font-medium text-stone-900">
              {offer.request?.quantity} {offer.request?.unit ?? ''}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Required by</dt>
            <dd className="font-medium text-stone-900">
              {offer.request?.requiredDate ? formatDate(new Date(offer.request.requiredDate)) : 'Not specified'}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Location</dt>
            <dd className="font-medium text-stone-900">{offer.request?.location}</dd>
          </div>
        </div>
        {offer.request?.specifications && (
          <div className="mt-4">
            <dt className="text-stone-500 text-sm">Specifications</dt>
            <dd className="mt-1 text-sm text-stone-700">{offer.request.specifications}</dd>
          </div>
        )}
      </Card>

      {offer.deadline && isDeadlinePassed && (
        <div className="card border-amber-200 bg-amber-50 p-4">
          <AlertTriangle className="mr-2 inline h-4 w-4 text-amber-700" aria-hidden="true" />
          <span className="text-sm text-amber-700 font-medium">
            The deadline has passed. Contact the buyer to reopen the commercial process.
          </span>
        </div>
      )}

      {!offer.finalOfferSubmitted && offer.status !== OfferStatus.WITHDRAWN && offer.status !== OfferStatus.DECLINED && (
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-stone-800 mb-4">Submission Status</h2>
          <div className="mb-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-stone-600">
                Submitted {submittedCount} of {MAX_SUBMISSIONS} offers
              </span>
              <span className="font-medium text-stone-900">
                {submittedCount}/{MAX_SUBMISSIONS}
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-100">
              <div
                className="h-full rounded-full bg-blue-600 transition-all"
                style={{ width: `${(submittedCount / MAX_SUBMISSIONS) * 100}%` }}
              />
            </div>
          </div>

          {submittedCount >= MAX_SUBMISSIONS && (
            <div className="mb-4 p-3 border border-amber-200 bg-amber-50 rounded-lg text-sm text-amber-700">
              <AlertTriangle className="inline h-4 w-4 mr-1" aria-hidden="true" />
              You have used all {MAX_SUBMISSIONS} submission slots. The buyer must reopen the commercial process.
            </div>
          )}
        </Card>
      )}

      {offer.submissions && offer.submissions.length > 0 && (
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-stone-800 mb-4">Submission History</h2>
          <div className="space-y-3">
            {offer.submissions.map((sub: any) => (
              <div key={sub.id} className="flex items-center justify-between p-3 border border-stone-200 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100">
                    <FileText className="h-4 w-4 text-blue-600" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="font-medium text-stone-900">Offer {sub.submissionNumber}</p>
                    <p className="text-sm text-stone-500">
                      {sub.submittedAt ? formatDate(new Date(sub.submittedAt)) : 'Not submitted'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={sub.complianceStatus === 'COMPLIANT' ? 'success' : sub.complianceStatus === 'NON_COMPLIANT' ? 'danger' : 'warning'}>
                    {sub.complianceStatus}
                  </Badge>
                  <span className="font-medium text-stone-900">
                    {formatAmount(parseFloat(sub.totalAmount), sub.currency)}
                  </span>
                  {sub.isFinal && <Badge variant="success">Final</Badge>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex gap-3">
        {canSubmit && !isDeadlinePassed && (
          <Button onClick={handleSubmit} loading={submitting}>
            Submit Offer {submittedCount + 1} of {MAX_SUBMISSIONS}
          </Button>
        )}
        {offer.status !== OfferStatus.WITHDRAWN && offer.status !== OfferStatus.DECLINED && (
          <Button variant="outline" onClick={() => navigate(`/commercial-offers/${offer.id}`)}>
            Edit Draft
          </Button>
        )}
        {offer.status !== OfferStatus.DECLINED && (
          <Button variant="ghost" onClick={handleWithdraw}>
            Withdraw Offer
          </Button>
        )}
      </div>

      <Card className="p-6">
        <h2 className="text-sm font-semibold text-stone-800 mb-3">Clarification Thread</h2>
        <ClarificationThread vendorAssignmentId={vendorAssignmentId!} />
      </Card>
    </div>
  );
};

function ClarificationThread({ vendorAssignmentId }: { vendorAssignmentId: string }) {
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const response = await commercialOffersApi.getClarificationThread(vendorAssignmentId);
      if (response.data.success) {
        setMessages(response.data.data || []);
      }
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [vendorAssignmentId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  if (loading) {
    return <Loader2 className="h-4 w-4 animate-spin text-stone-400" />;
  }

  if (messages.length === 0) {
    return <p className="text-sm text-stone-500">No clarifications yet.</p>;
  }

  return (
    <div className="space-y-2 max-h-60 overflow-y-auto">
      {messages.map((msg) => (
        <div key={msg.id} className="text-sm">
          <span className="font-medium text-stone-700">
            {msg.eventType === 'CLARIFICATION_REQUESTED' ? 'Buyer' : 'Vendor'}:
          </span>
          <span className="text-stone-600 ml-2">{msg.description}</span>
          <span className="text-xs text-stone-400 ml-2">
            ({formatDate(new Date(msg.createdAt))})
          </span>
        </div>
      ))}
    </div>
  );
}
