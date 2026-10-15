import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Loader2,
  AlertTriangle,
  Users,
  BarChart3,
  RefreshCw,
  CheckCircle,
  Send,
} from 'lucide-react';
import { commercialOffersApi, dealExecutionApi } from '../../services/api';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { OfferComplianceStatus, OfferType } from '../../types';
import { formatAmount, formatDate } from '../../utils/purchaseOrder';

interface OfferDetail {
  id: string;
  requestId: string;
  vendorId: string;
  vendorAssignmentId: string;
  status: string;
  offerType: OfferType;
  currency: string;
  deadline?: Date | null;
  submissionsInRound: number;
  finalOfferSubmitted: boolean;
  commercialRound: number;
  request?: {
    id: string;
    title: string;
    item: string;
    quantity: number;
    unit?: string | null;
    specifications?: string | null;
    location: string;
    requiredDate?: string;
  };
  vendor?: {
    id: string;
    name: string;
    email: string;
    vendorType?: string;
  };
  submissions?: Array<{
    id: string;
    submissionNumber: number;
    totalAmount: string;
    currency: string;
    subTotal: string;
    taxAmount: string;
    submittedAt?: Date | null;
    isFinal: boolean;
    complianceStatus: string;
    complianceDetails?: Record<string, unknown> | null;
    unitPrice?: string | null;
    quantity?: number | null;
    contractDuration?: string | null;
    numberOfLicenses?: number | null;
    billingFrequency?: string | null;
    subscriptionTerm?: string | null;
    deliveryDate?: Date | null;
    paymentTerms?: string | null;
    offerValidityDays?: number | null;
  }>;
}

export const BuyerCommercialPage: React.FC = () => {
  const { requestId } = useParams<{ requestId: string }>();
  const navigate = useNavigate();
  const [offers, setOffers] = useState<OfferDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadOffers = useCallback(async () => {
    if (!requestId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await commercialOffersApi.listOffers({ requestId });
      if (response.data.success) {
        setOffers(response.data.data?.data || []);
      } else {
        setError(response.data.error || 'Could not load offers');
      }
    } catch (err) {
      setError((err as Error).message || 'Could not load offers');
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    loadOffers();
  }, [loadOffers]);

  const handleReopen = async (vendorAssignmentId: string, reason: string) => {
    try {
      await commercialOffersApi.reopenCommercialProcess(vendorAssignmentId, reason);
      await loadOffers();
    } catch (err) {
      setError((err as Error).message || 'Could not reopen commercial process');
    }
  };

  const handleSelectFinal = async (submissionId: string) => {
    setSelecting(true);
    try {
      await dealExecutionApi.selectFinalOffer(submissionId);
      setSelectedSubmissionId(submissionId);
    } catch (err) {
      setError((err as Error).message || 'Could not select final offer');
    } finally {
      setSelecting(false);
    }
  };

  const handleSubmitForApproval = async () => {
    if (!selectedSubmissionId) return;
    setSubmitting(true);
    try {
      const response = await dealExecutionApi.submitForFinalApproval(selectedSubmissionId);
      if (response.data.success) {
        navigate('/purchase-approvals');
      }
    } catch (err) {
      setError((err as Error).message || 'Could not submit for approval');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
        <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
        {error}
      </div>
    );
  }

   const totalOffers = offers.reduce((sum, o) => sum + (o.submissions?.length ?? 0), 0);
  const compliantOffers = offers.filter((o) =>
    o.submissions?.some((s) => s.complianceStatus === OfferComplianceStatus.COMPLIANT)
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={() => navigate(-1)}
          className="p-1.5 hover:bg-stone-100 rounded-lg transition-colors"
        >
          <RefreshCw className="h-5 w-5 text-stone-500" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-stone-900">Commercial Evaluation</h1>
          <p className="text-sm text-stone-500 mt-1">
            Request #{requestId?.slice(0, 8)} · {offers.length} vendor{offers.length !== 1 ? 's' : ''} responded
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="p-4 text-center">
          <div className="text-2xl font-semibold text-stone-900">{offers.length}</div>
          <p className="text-xs text-stone-500">Vendors responded</p>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-semibold text-stone-900">{totalOffers}</div>
          <p className="text-xs text-stone-500">Total submissions</p>
        </Card>
        <Card className="p-4 text-center">
          <div className="text-2xl font-semibold text-emerald-700">{compliantOffers.length}</div>
          <p className="text-xs text-stone-500">Compliant offers</p>
        </Card>
      </div>

      {selectedSubmissionId && (
        <Card className="p-4 bg-emerald-50 border-emerald-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-emerald-600" />
              <span className="text-sm font-medium text-emerald-900">
                Final offer selected — ready for approval
              </span>
            </div>
            <Button variant="primary" size="sm" onClick={handleSubmitForApproval} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Submit for Approval
            </Button>
          </div>
        </Card>
      )}

      <div className="space-y-6">
        {offers.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            onReopen={handleReopen}
            onSelectFinal={handleSelectFinal}
            selectLoading={selecting}
          />
        ))}
      </div>

      {offers.length === 0 && (
        <Card className="p-12 text-center">
          <Users className="h-10 w-10 text-stone-300 mx-auto mb-3" />
          <p className="text-stone-600 font-medium">No vendors have submitted offers yet.</p>
          <p className="text-sm text-stone-400 mt-1">Check back as vendors respond to their invitations.</p>
        </Card>
      )}
    </div>
  );
};

const OfferCard: React.FC<{
  offer: OfferDetail;
  onReopen: (vendorAssignmentId: string, reason: string) => void;
  onSelectFinal: (submissionId: string) => void;
  selectLoading: boolean;
}> = ({ offer, onReopen, onSelectFinal, selectLoading }) => {
  const [showReopen, setShowReopen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  const latestSubmission = offer.submissions?.[offer.submissions.length - 1];
  const submittedCount = offer.submissions?.length ?? 0;

  const handleReopen = async () => {
    if (!reopenReason.trim()) return;
    await onReopen(offer.vendorAssignmentId, reopenReason);
    setShowReopen(false);
    setReopenReason('');
  };

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-stone-900">{offer.vendor?.name}</h3>
          <p className="text-sm text-stone-500">{offer.vendor?.email}</p>
          <div className="flex items-center gap-2">
            {offer.finalOfferSubmitted ? (
              <Badge variant="success">Final offer submitted</Badge>
            ) : (
              <Badge variant="info">{submittedCount}/{4} offers submitted</Badge>
            )}
            {offer.deadline && new Date(offer.deadline) < new Date() && (
              <Badge variant="warning">Deadline passed</Badge>
            )}
          </div>
        </div>
        <Badge variant={offer.status === 'FINAL_OFFER_SUBMITTED' ? 'success' : offer.status === 'OFFER_SUBMITTED' ? 'primary' : 'info'}>
          {offer.status}
        </Badge>
      </div>

      {latestSubmission && (
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-stone-500">Total</dt>
            <dd className="font-medium text-stone-900">
              {formatAmount(parseFloat(latestSubmission.totalAmount), latestSubmission.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Submitted</dt>
            <dd className="font-medium text-stone-900">
              {latestSubmission.submittedAt ? formatDate(new Date(latestSubmission.submittedAt)) : '—'}
            </dd>
          </div>
          {latestSubmission.deliveryDate && (
            <div>
              <dt className="text-stone-500">Delivery</dt>
              <dd className="font-medium text-stone-900">{formatDate(new Date(latestSubmission.deliveryDate))}</dd>
            </div>
          )}
          {latestSubmission.paymentTerms && (
            <div>
              <dt className="text-stone-500">Payment Terms</dt>
              <dd className="font-medium text-stone-900">{latestSubmission.paymentTerms}</dd>
            </div>
          )}
        </div>
      )}

      {offer.submissions &&
        offer.submissions
          .filter((s) => s.complianceStatus === OfferComplianceStatus.COMPLIANT && s.submittedAt)
          .map((sub) => (
            <div key={sub.id} className="mt-3 pt-3 border-t border-stone-200 flex items-center justify-between">
              <div className="flex items-center gap-3 text-sm">
                <Badge variant="info">#{sub.submissionNumber}</Badge>
                <span className="text-stone-600">
                  {formatAmount(parseFloat(sub.totalAmount), sub.currency)}
                </span>
                <Badge variant={sub.complianceStatus === OfferComplianceStatus.COMPLIANT ? 'success' : 'warning'}>
                  {sub.complianceStatus}
                </Badge>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onSelectFinal(sub.id)}
                disabled={selectLoading}
              >
                Select as Final Offer
              </Button>
            </div>
          ))}

      {offer.submissions && offer.submissions.length > 1 && (
        <div className="mt-4 pt-3 border-t border-stone-200">
          <div className="flex items-center gap-2 text-xs text-stone-500">
            <BarChart3 className="h-3 w-3" />
            <span>
              {offer.submissions.length} revisions submitted · Latest: #{latestSubmission?.submissionNumber}
            </span>
          </div>
        </div>
      )}

      {offer.finalOfferSubmitted && (
        <div className="mt-4 pt-3 border-t border-stone-200">
          <button
            onClick={() => setShowReopen(true)}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            Reopen for one more round
          </button>
          <p className="text-xs text-stone-400 mt-1">
            Allow this vendor to submit additional offers.
          </p>
        </div>
      )}

      {showReopen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96">
            <h4 className="font-semibold text-stone-900 mb-3">Reopen Commercial Process</h4>
            <p className="text-sm text-stone-600 mb-3">
              You are allowing {offer.vendor?.name} to submit up to 4 more offers.
            </p>
            <textarea
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="Reason for reopening..."
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm resize-none"
              rows={3}
            />
            <div className="flex gap-2 mt-4 justify-end">
              <Button variant="secondary" onClick={() => setShowReopen(false)} size="sm">
                Cancel
              </Button>
              <Button variant="primary" onClick={handleReopen} size="sm">
                Reopen
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};

export default BuyerCommercialPage;
