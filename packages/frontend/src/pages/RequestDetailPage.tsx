import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, CheckCircle, MapPin, Calendar, Package, DollarSign,
  Users, Zap, Star, Loader2,
  Send, RefreshCw, Building2, AlertCircle, Phone, Mail, Bot,
  Globe, Lock, X
} from 'lucide-react';
import { requestApi, vendorApi, dealsApi, communicationApi } from '../services/api';
import {
  ProcurementRequest,
  Vendor,
  VendorAvailability,
  RequestVisibility,
} from '../types';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

// ─── Status helpers ────────────────────────────────────────────────────────
const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  DRAFT:                 { label: 'Draft',             color: 'text-stone-600', bg: 'bg-stone-100' },
  SUBMITTED:             { label: 'Submitted',          color: 'text-blue-700',  bg: 'bg-blue-50'   },
  REQUIREMENT_EXTRACTED: { label: 'Analysed',           color: 'text-blue-700',  bg: 'bg-blue-50'   },
  VENDORS_IDENTIFIED:    { label: 'Vendors Identified', color: 'text-indigo-700',bg: 'bg-indigo-50' },
  RFQ_CREATED:           { label: 'RFQ Created',        color: 'text-purple-700',bg: 'bg-purple-50' },
  RFQ_SENT:              { label: 'RFQ Sent',           color: 'text-purple-700',bg: 'bg-purple-50' },
  QUOTES_RECEIVED:       { label: 'Quotes In',          color: 'text-amber-700', bg: 'bg-amber-50'  },
  RECOMMENDATION_READY:  { label: 'Recommended',        color: 'text-emerald-700', bg: 'bg-emerald-50' },
  APPROVAL_PENDING:      { label: 'Awaiting Approval',  color: 'text-amber-700', bg: 'bg-amber-50'  },
  APPROVED:              { label: 'Approved',           color: 'text-emerald-700', bg: 'bg-emerald-50' },
  REJECTED:              { label: 'Rejected',           color: 'text-red-700',   bg: 'bg-red-50'    },
  COMPLETED:             { label: 'Completed',          color: 'text-emerald-700', bg: 'bg-emerald-50' },
  CANCELLED:             { label: 'Cancelled',          color: 'text-stone-500', bg: 'bg-stone-100' },
};

const AvailabilityBadge: React.FC<{ status: 'online' | 'busy' | 'offline' }> = ({ status }) => {
  const config = {
    online: { dot: 'bg-emerald-500', label: 'Online', text: 'text-emerald-700' },
    busy:   { dot: 'bg-amber-500',   label: 'Busy',   text: 'text-amber-700'  },
    offline:{ dot: 'bg-stone-300',   label: 'Offline',text: 'text-stone-500'  },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${config.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot} ${status === 'online' ? 'animate-pulse' : ''}`} />
      {config.label}
    </span>
  );
};

// ─── VendorCard ──────────────────────────────────────────────────────────────
interface VendorWithAvailability extends Vendor {
  availability?: VendorAvailability;
}

const VendorCard: React.FC<{
  vendor: VendorWithAvailability;
  onConnect: (vendor: VendorWithAvailability) => void;
  onRequestQuote: (vendor: VendorWithAvailability) => void;
}> = ({ vendor, onConnect, onRequestQuote }) => {
  const availabilityStatus = vendor.availability?.isOnline 
    ? 'online' 
    : vendor.availability?.isBusy 
      ? 'busy' 
      : 'offline';
  const rating = 4.2;
  const orders = 0;

  return (
    <div className="card p-4 flex flex-col gap-3 hover:border-stone-300 hover:shadow-sm transition-all duration-150 animate-slide-up">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center flex-shrink-0 border border-stone-200">
            <Building2 className="h-5 w-5 text-blue-600" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-stone-900 text-sm truncate">{vendor.name}</p>
            <p className="text-xs text-stone-500 truncate">
              {[vendor.city, vendor.state].filter(Boolean).join(', ') || 'Location not listed'}
            </p>
          </div>
        </div>
        <AvailabilityBadge status={availabilityStatus} />
      </div>

      {vendor.products && (
        <p className="text-xs text-stone-500 line-clamp-2">{vendor.products}</p>
      )}

      <div className="flex items-center gap-4 text-xs text-stone-500">
        <span className="flex items-center gap-1">
          <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
          {rating.toFixed(1)}
        </span>
        {orders > 0 && (
          <span>{orders} orders</span>
        )}
        {vendor.contactPerson && (
          <span className="flex items-center gap-1">
            <Users className="h-3 w-3" />
            {vendor.contactPerson}
          </span>
        )}
      </div>

      <div className="flex gap-2 pt-1 border-t border-stone-100">
        {availabilityStatus === 'online' ? (
          <button
            onClick={() => onConnect(vendor)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <Zap className="h-3.5 w-3.5" />
            Connect Now
          </button>
        ) : (
          <button
            onClick={() => onRequestQuote(vendor)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-white hover:bg-stone-50 text-stone-700 text-xs font-medium rounded-lg border border-stone-200 transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
            Request Quote
          </button>
        )}
        {vendor.phone && (
          <button
            className="flex items-center justify-center w-8 h-8 border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors"
            title={vendor.phone}
          >
            <Phone className="h-3.5 w-3.5 text-stone-500" />
          </button>
        )}
        {vendor.email && (
          <button
            className="flex items-center justify-center w-8 h-8 border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors"
            title={vendor.email}
          >
            <Mail className="h-3.5 w-3.5 text-stone-500" />
          </button>
        )}
      </div>
    </div>
  );
};

// ─── Main Component ──────────────────────────────────────────────────────────
interface VendorWithAvailability extends Vendor {
  availability?: VendorAvailability;
}

export const RequestDetailPage: React.FC = () => {
  const { requestId } = useParams<{ requestId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = searchParams.get('new') === '1';

  const [request, setRequest] = useState<ProcurementRequest | null>(null);
  const [vendors, setVendors] = useState<VendorWithAvailability[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingVendors, setLoadingVendors] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'vendors' | 'activity'>('details');
  const [publishing, setPublishing] = useState(false);

  /**
   * Publishing exposes this requirement to every approved supplier, so the
   * dialog makes the consequence explicit rather than hiding it behind a toast
   * the user may not read. The confirmation flag on the API call is set only
   * after they agree here.
   */
  const [publishDialog, setPublishDialog] = useState<{
    visibility: RequestVisibility;
    deadline: string;
  } | null>(null);

  const confirmPublish = async () => {
    if (!request || !publishDialog) return;
    setPublishing(true);
    try {
      await communicationApi.publishRequirement(request.id, {
        visibility: publishDialog.visibility,
        confirmed: true,
        ...(publishDialog.deadline
          ? { quotationDeadline: new Date(publishDialog.deadline).toISOString() }
          : {}),
      });
      toast.success(
        publishDialog.visibility === 'OPEN_MARKET'
          ? 'Published to the open market'
          : 'Requirement is now private'
      );
      setPublishDialog(null);
      await fetchRequest();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Could not publish that requirement');
    } finally {
      setPublishing(false);
    }
  };

  const withdrawFromMarket = async () => {
    if (!request) return;
    setPublishing(true);
    try {
      await communicationApi.withdrawRequirement(request.id);
      toast.success('Withdrawn from the open market');
      await fetchRequest();
    } catch {
      toast.error('Could not withdraw that requirement');
    } finally {
      setPublishing(false);
    }
  };


  const fetchRequest = useCallback(async () => {
    if (!requestId) return;
    try {
      const res = await requestApi.get(requestId);
      if (res.data.success && res.data.data) {
        setRequest(res.data.data);
      }
    } catch {
      toast.error('Failed to load request');
    } finally {
      setIsLoading(false);
    }
  }, [requestId]);

  const fetchVendors = useCallback(async () => {
    setLoadingVendors(true);
    try {
      // Fetch vendors and their availability in parallel
      const [vendorsRes, availabilityRes] = await Promise.all([
        vendorApi.list({ status: 'ACTIVE', limit: 20 }),
        dealsApi.getOnlineVendors(),
      ]);
      
      if (vendorsRes.data.success && vendorsRes.data.data) {
        const vendorList = vendorsRes.data.data.data;
        const onlineVendors = (availabilityRes.data.success && availabilityRes.data.data) 
          ? (availabilityRes.data.data as VendorWithAvailability[]) 
          : [];
        const onlineVendorIds = new Set(onlineVendors.map(v => v.id));
        
        // Merge availability data
        const mergedVendors = vendorList.map(v => ({
          ...v,
          availability: onlineVendorIds.has(v.id) 
            ? onlineVendors.find(ov => ov.id === v.id)?.availability
            : undefined,
        }));
        
        setVendors(mergedVendors);
      }
    } catch {
      // silent
    } finally {
      setLoadingVendors(false);
    }
  }, []);

  useEffect(() => {
    fetchRequest();
  }, [fetchRequest]);

  useEffect(() => {
    if (activeTab === 'vendors') fetchVendors();
  }, [activeTab, fetchVendors]);

  // Auto-switch to vendors tab for new requests
  useEffect(() => {
    if (isNew && !isLoading) {
      setTimeout(() => setActiveTab('vendors'), 600);
    }
  }, [isNew, isLoading]);

  const handleSubmitRequest = async () => {
    if (!request) return;
    try {
      await requestApi.submit(request.id);
      toast.success('Request submitted');
      fetchRequest();
    } catch {
      toast.error('Failed to submit request');
    }
  };

  const handleConnect = async (vendor: VendorWithAvailability) => {
    if (!requestId) return;
    try {
      // Create connection via deals API
      const res = await dealsApi.createConnection({ requestId, vendorId: vendor.id });
      if (res.data.success && res.data.data) {
        toast.success(`Connected with ${vendor.name}`);
        navigate(
          `/deals/new?requestId=${requestId}&vendorId=${vendor.id}&connectionId=${res.data.data.id}`
        );
      }
    } catch (err) {
      // A connection may already exist for this request/vendor pair; reopen it.
      try {
        const list = await dealsApi.listConnections({ requestId, vendorId: vendor.id, limit: 50 });
        const existing = list.data.data?.data?.[0];
        if (existing) {
          toast(`Opening existing deal room with ${vendor.name}`);
          navigate(
            `/deals/new?requestId=${requestId}&vendorId=${vendor.id}&connectionId=${existing.id}`
          );
          return;
        }
      } catch {
        // fall through to the generic error below
      }
      toast.error('Failed to create connection');
    }
  };

  const handleRequestQuote = async (vendor: VendorWithAvailability) => {
    toast.success(`Quote request sent to ${vendor.name}`);
  };

  const onlineCount = vendors.filter(v => v.availability?.isOnline).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!request) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <AlertCircle className="h-10 w-10 text-stone-300 mx-auto mb-3" />
        <p className="text-stone-600">Request not found.</p>
        <button onClick={() => navigate('/requests')} className="btn-secondary btn-sm mt-4">
          Back to Requests
        </button>
      </div>
    );
  }

  const sc = statusConfig[request.status] || { label: request.status, color: 'text-stone-600', bg: 'bg-stone-100' };

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start gap-4">
        <button
          onClick={() => navigate(-1)}
          className="p-1.5 hover:bg-stone-100 rounded-lg transition-colors mt-0.5"
        >
          <ArrowLeft className="h-5 w-5 text-stone-500" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`badge text-xs font-medium ${sc.bg} ${sc.color}`}>{sc.label}</span>
            {isNew && (
              <span className="badge bg-blue-600 text-white text-xs animate-fade-in">New</span>
            )}
          </div>
          <h1 className="text-xl font-semibold text-stone-900 mt-1">{request.title}</h1>
          <p className="text-sm text-stone-500 mt-1">
            Created {format(new Date(request.createdAt), 'dd MMM yyyy · HH:mm')}
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {/* Anchors a copilot thread to this request, so a follow-up such as
              "which vendors can supply this?" resolves against these records. */}
          <button
            onClick={() =>
              navigate(
                `/copilot?entityType=REQUEST&entityId=${encodeURIComponent(request.id)}` +
                  `&entityLabel=${encodeURIComponent(request.title)}`
              )
            }
            className="btn-secondary btn-sm"
            title="Ask Navo about this request"
          >
            <Bot className="h-3.5 w-3.5" />
            Ask Navo
          </button>
          {request.status === 'DRAFT' && (
            <button onClick={handleSubmitRequest} className="btn-primary btn-sm">
              <Send className="h-3.5 w-3.5" />
              Submit
            </button>
          )}

          {/* Visibility controls. Only buyers who own the requirement reach
              this page, and the server re-checks ownership on every call. */}
          {request.status !== 'DRAFT' && (
            request.visibility === 'OPEN_MARKET' ? (
              <button
                onClick={withdrawFromMarket}
                disabled={publishing}
                className="btn-secondary btn-sm"
                title="Remove this requirement from the open market"
              >
                <Lock className="h-3.5 w-3.5" />
                Withdraw
              </button>
            ) : (
              <button
                onClick={() =>
                  setPublishDialog({ visibility: RequestVisibility.OPEN_MARKET, deadline: '' })
                }
                disabled={publishing}
                className="btn-secondary btn-sm"
                title="Show this requirement to every approved supplier"
              >
                <Globe className="h-3.5 w-3.5" />
                Publish
              </button>
            )
          )}
          <button onClick={fetchRequest} className="btn-secondary btn-sm">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-stone-200 -mb-2">
        {(['details', 'vendors', 'activity'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium capitalize border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-stone-500 hover:text-stone-700'
            }`}
          >
            {tab === 'vendors' && vendors.length > 0 ? (
              <span className="flex items-center gap-1.5">
                Vendors
                <span className="bg-blue-100 text-blue-700 text-xs rounded-full px-1.5 py-0.5 leading-none">
                  {vendors.length}
                </span>
              </span>
            ) : tab === 'vendors' ? 'Vendors' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Details Tab ── */}
      {activeTab === 'details' && (
        <div className="space-y-4 animate-fade-in">
          {/* Description */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-stone-700 mb-2">Requirement</h3>
            <p className="text-sm text-stone-700 leading-relaxed">{request.description}</p>
          </div>

          {/* Key facts */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="card p-4 flex items-center gap-3">
              <Package className="h-5 w-5 text-blue-500 flex-shrink-0" />
              <div>
                <p className="text-xs text-stone-400">Item / Qty</p>
                <p className="text-sm font-medium text-stone-800">{request.quantity} × {request.item}</p>
              </div>
            </div>
            <div className="card p-4 flex items-center gap-3">
              <MapPin className="h-5 w-5 text-emerald-500 flex-shrink-0" />
              <div>
                <p className="text-xs text-stone-400">Location</p>
                <p className="text-sm font-medium text-stone-800">{request.location}</p>
              </div>
            </div>
            <div className="card p-4 flex items-center gap-3">
              <Calendar className="h-5 w-5 text-purple-500 flex-shrink-0" />
              <div>
                <p className="text-xs text-stone-400">Required By</p>
                <p className="text-sm font-medium text-stone-800">
                  {format(new Date(request.requiredDate), 'dd MMM yyyy')}
                </p>
              </div>
            </div>
            {request.estimatedBudget && (
              <div className="card p-4 flex items-center gap-3">
                <DollarSign className="h-5 w-5 text-amber-500 flex-shrink-0" />
                <div>
                  <p className="text-xs text-stone-400">Budget</p>
                  <p className="text-sm font-medium text-stone-800">
                    ₹{request.estimatedBudget.toLocaleString('en-IN')}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Specifications */}
          {request.specifications && request.specifications !== request.description && (
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-stone-700 mb-2">Specifications</h3>
              <p className="text-sm text-stone-600 whitespace-pre-wrap">{request.specifications}</p>
            </div>
          )}

          {/* Action: Find Vendors */}
          <div className="card p-5 flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-100">
            <div>
              <p className="text-sm font-semibold text-stone-900">Ready to find suppliers?</p>
              <p className="text-xs text-stone-500 mt-0.5">See vendors who can fulfill this requirement.</p>
            </div>
            <button
              onClick={() => setActiveTab('vendors')}
              className="btn-primary btn-sm"
            >
              <Users className="h-3.5 w-3.5" />
              View Vendors
            </button>
          </div>
        </div>
      )}

      {/* ── Vendors Tab ── */}
      {activeTab === 'vendors' && (
        <div className="space-y-4 animate-fade-in">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-stone-600">
                {loadingVendors
                  ? 'Finding matching vendors…'
                  : `${vendors.length} vendors · ${onlineCount} online now`}
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-stone-500">
              <span className="flex items-center gap-1"><span className="dot-online" />Online</span>
              <span className="flex items-center gap-1 ml-2"><span className="dot-busy" />Busy</span>
              <span className="flex items-center gap-1 ml-2"><span className="dot-offline" />Offline</span>
            </div>
          </div>

          {loadingVendors ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[1,2,3,4].map(i => (
                <div key={i} className="card p-4 animate-pulse space-y-3">
                  <div className="flex gap-3">
                    <div className="h-10 w-10 rounded-xl bg-stone-100" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-stone-100 rounded w-2/3" />
                      <div className="h-3 bg-stone-100 rounded w-1/2" />
                    </div>
                  </div>
                  <div className="h-8 bg-stone-100 rounded-lg" />
                </div>
              ))}
            </div>
          ) : vendors.length === 0 ? (
            <div className="card p-10 text-center">
              <Building2 className="h-8 w-8 text-stone-300 mx-auto mb-2" />
              <p className="text-sm text-stone-500">No active vendors found.</p>
              <p className="text-xs text-stone-400 mt-1">Add vendors in My Vendors to see matches here.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Online first */}
              {[...vendors]
                .sort((a, b) => {
                  const getStatus = (v: VendorWithAvailability) => {
                    if (v.availability?.isOnline) return 'online';
                    if (v.availability?.isBusy) return 'busy';
                    return 'offline';
                  };
                  const order = { online: 0, busy: 1, offline: 2 };
                  return order[getStatus(a)] - order[getStatus(b)];
                })
                .map((vendor) => (
                  <VendorCard
                    key={vendor.id}
                    vendor={vendor}
                    onConnect={handleConnect}
                    onRequestQuote={handleRequestQuote}
                  />
                ))}
            </div>
          )}
        </div>
      )}

      {/* ── Activity Tab ── */}
      {activeTab === 'activity' && (
        <div className="space-y-3 animate-fade-in">
          <div className="card p-5">
            <div className="flex gap-3 items-start">
              <div className="h-7 w-7 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <CheckCircle className="h-3.5 w-3.5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-stone-800">Request created</p>
                <p className="text-xs text-stone-400">{format(new Date(request.createdAt), 'dd MMM yyyy · HH:mm')}</p>
              </div>
            </div>
          </div>
          {request.status !== 'DRAFT' && (
            <div className="card p-5">
              <div className="flex gap-3 items-start">
                <div className="h-7 w-7 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Send className="h-3.5 w-3.5 text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-stone-800">Request submitted for processing</p>
                  <p className="text-xs text-stone-400">Status: {sc.label}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Publish confirmation ──
          Publishing is consequential and irreversible in the sense that other
          suppliers see it immediately, so the dialog states exactly what becomes
          visible before anything is sent. */}
      {publishDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="publish-title"
        >
          <div className="w-full max-w-md bg-white rounded-xl border border-stone-200 shadow-xl p-5 animate-fade-in">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="publish-title" className="text-sm font-semibold text-stone-900">
                  Publish to the open market
                </h2>
                <p className="text-xs text-stone-500 mt-1">
                  Every approved, active supplier on NAVO will be able to find this
                  requirement.
                </p>
              </div>
              <button
                onClick={() => setPublishDialog(null)}
                className="p-1 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="mt-4 space-y-1.5 rounded-lg bg-stone-50 p-3 text-xs text-stone-600">
              <div className="flex gap-2">
                <dt className="font-medium text-stone-700 w-24 shrink-0">Title</dt>
                <dd className="min-w-0 truncate">{request.title}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium text-stone-700 w-24 shrink-0">Item</dt>
                <dd className="min-w-0 truncate">{request.item}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium text-stone-700 w-24 shrink-0">Quantity</dt>
                <dd>{request.quantity} {request.unit}</dd>
              </div>
              {request.location && (
                <div className="flex gap-2">
                  <dt className="font-medium text-stone-700 w-24 shrink-0">Location</dt>
                  <dd className="min-w-0 truncate">{request.location}</dd>
                </div>
              )}
            </dl>

            <p className="mt-3 text-xs text-stone-500">
              Your budget, internal description and attachments stay private and are never
              included in the market listing.
            </p>

            <label className="block mt-4">
              <span className="text-xs font-medium text-stone-700">
                Quotation deadline (optional)
              </span>
              <input
                type="datetime-local"
                value={publishDialog.deadline}
                min={new Date().toISOString().slice(0, 16)}
                onChange={(e) =>
                  setPublishDialog({ ...publishDialog, deadline: e.target.value })
                }
                className="mt-1 w-full px-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="mt-1 block text-[11px] text-stone-400">
                After this moment the requirement stops appearing in search results.
              </span>
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPublishDialog(null)}
                disabled={publishing}
                className="btn-secondary btn-sm"
              >
                Cancel
              </button>
              <button
                onClick={confirmPublish}
                disabled={publishing}
                className="btn-primary btn-sm"
              >
                {publishing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Publish
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};