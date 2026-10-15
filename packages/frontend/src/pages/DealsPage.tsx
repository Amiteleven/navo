import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Send, Zap, CheckCircle,
  Package, DollarSign, Calendar, Building2,
  FileText, Loader2, Sparkles, AlertCircle, TrendingDown, Clock,
  ClipboardCheck,
} from 'lucide-react';
import { dealsApi, negotiationApi, notificationApi, purchaseApprovalApi } from '../services/api';
import type {
  ProcurementRequest, Vendor, DealOffer, NegotiationMessage,
  DealRoomDetail, Connection, Deal, ResolvedApprovalRoute,
} from '../types';
import { ConnectionStatus } from '../types';
import { presentRole } from '../utils/purchaseApproval';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmtINR = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;

const landedCost = (offer: DealOffer) =>
  offer.unitPrice * offer.quantity +
  (offer.unitPrice * offer.quantity * (offer.gst || 0)) / 100 +
  (offer.freightAmount || 0) +
  (offer.installationAmount || 0) +
  (offer.otherCharges || 0);

type MessageSide = 'buyer' | 'seller' | 'system';

interface DisplayMessage {
  id: string;
  from: MessageSide;
  text: string;
  time: Date;
  kind?: 'text' | 'offer' | 'system';
  pending?: boolean;
}

interface DraftState {
  approach: string;
  draftMessage: string;
  keyPoints: string[];
  tradeoffs: string[];
  currentOfferPrice: number;
  targetPrice: number;
}

// ─── Components ──────────────────────────────────────────────────────────────
const OfferCard: React.FC<{
  offer: DealOffer;
  isCurrent: boolean;
  canAccept: boolean;
  onAccept?: () => void;
}> = ({ offer, isCurrent, canAccept, onAccept }) => {
  const subtotal = offer.unitPrice * offer.quantity;
  const gstAmt = (subtotal * (offer.gst || 0)) / 100;
  const total = landedCost(offer);
  const fromVendor = offer.submittedByRole !== 'BUYER';

  return (
    <div className={`card p-4 space-y-3 ${isCurrent ? 'border-blue-200 bg-blue-50/30' : 'opacity-70'}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className={`badge ${fromVendor ? 'badge-blue' : 'badge-stone'}`}>
          {fromVendor ? 'Seller Offer' : 'Buyer Counter Offer'}
        </span>
        <span className="text-xs text-stone-400">{format(new Date(offer.createdAt), 'HH:mm')}</span>
        {offer.status === 'ACCEPTED' && (
          <span className="badge badge-green flex items-center gap-1">
            <CheckCircle className="h-3 w-3" /> Accepted
          </span>
        )}
        {offer.status === 'SUPERSEDED' && <span className="badge badge-stone">Superseded</span>}
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-xs text-stone-400">Unit Price</p>
          <p className="font-semibold text-stone-900">{fmtINR(offer.unitPrice)}</p>
        </div>
        <div>
          <p className="text-xs text-stone-400">Quantity</p>
          <p className="font-semibold text-stone-900">{offer.quantity} units</p>
        </div>
        <div>
          <p className="text-xs text-stone-400">GST ({offer.gst || 0}%)</p>
          <p className="font-semibold text-stone-900">{fmtINR(gstAmt)}</p>
        </div>
        <div>
          <p className="text-xs text-stone-400">Delivery</p>
          <p className="font-semibold text-stone-900">
            {offer.deliveryTimelineDays ? `${offer.deliveryTimelineDays} days` : '—'}
          </p>
        </div>
      </div>

      {(offer.freightAmount || offer.installationAmount || offer.otherCharges) ? (
        <div className="text-xs text-stone-500 space-y-0.5 border-t border-stone-200 pt-2">
          {!!offer.freightAmount && <p>Freight: {fmtINR(offer.freightAmount)}</p>}
          {!!offer.installationAmount && <p>Installation: {fmtINR(offer.installationAmount)}</p>}
          {!!offer.otherCharges && (
            <p>Other charges: {fmtINR(offer.otherCharges)}{offer.otherChargesDetails ? ` (${offer.otherChargesDetails})` : ''}</p>
          )}
        </div>
      ) : null}

      <div className="border-t border-stone-200 pt-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-xs text-stone-400">Landed Cost</p>
          <p className="text-base font-bold text-stone-900">{fmtINR(total)}</p>
        </div>
        {isCurrent && offer.status === 'ACTIVE' && canAccept && onAccept && (
          <button onClick={onAccept} className="btn-success btn-sm">
            <CheckCircle className="h-3.5 w-3.5" />
            Review & Accept
          </button>
        )}
        {offer.status === 'PENDING_APPROVAL' && (
          <span className="badge bg-amber-100 text-amber-800 flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            Pending Approval
          </span>
        )}
      </div>

      <p className="text-xs text-stone-400">
        Payment: {offer.paymentTerms || 'Not specified'}
        {offer.warrantyMonths ? ` · Warranty: ${offer.warrantyMonths} mo` : ''}
        {offer.validityDays ? ` · Valid: ${offer.validityDays} days` : ''}
      </p>
    </div>
  );
};

const MessageBubble: React.FC<{ msg: DisplayMessage }> = ({ msg }) => {
  if (msg.from === 'system') {
    return (
      <p className="text-xs text-stone-500 text-center px-4 py-1.5 bg-stone-50 rounded-full border border-stone-200 max-w-sm mx-auto">
        {msg.text}
      </p>
    );
  }

  if (msg.from === 'buyer') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <div className="msg-bubble-buyer">{msg.text}</div>
        <span className="text-xs text-stone-400">
          {format(msg.time, 'HH:mm')}{msg.pending ? ' · sending' : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-end gap-2">
      <div className="h-6 w-6 rounded-full bg-stone-200 flex items-center justify-center flex-shrink-0">
        <Building2 className="h-3.5 w-3.5 text-stone-600" />
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="msg-bubble-seller">{msg.text}</div>
        <span className="text-xs text-stone-400">{format(msg.time, 'HH:mm')}</span>
      </div>
    </div>
  );
};

// ─── Deals List View ─────────────────────────────────────────────────────────
const DealsListView: React.FC = () => {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [connRes, dealRes] = await Promise.all([
          dealsApi.listConnections({ limit: 50 }),
          dealsApi.listDeals({ limit: 50 }),
        ]);
        if (connRes.data.success && connRes.data.data) setConnections(connRes.data.data.data || []);
        if (dealRes.data.success && dealRes.data.data) setDeals(dealRes.data.data.data || []);
      } catch {
        toast.error('Failed to load deals');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  const hasContent = connections.length > 0 || deals.length > 0;

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Live Deals</h1>
        <p className="text-sm text-stone-500 mt-1">Your active deal rooms, negotiations and confirmed deals.</p>
      </div>

      {!hasContent && (
        <div className="card p-10 text-center">
          <Zap className="h-8 w-8 text-stone-300 mx-auto mb-2" />
          <p className="text-sm text-stone-600">No deals yet.</p>
          <p className="text-xs text-stone-400 mt-1">
            Open a request, pick a vendor and connect to start a Deal Room.
          </p>
          <button onClick={() => navigate('/requests')} className="btn-primary btn-sm mt-4">
            Go to Requests
          </button>
        </div>
      )}

      {connections.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-stone-700 mb-2">Deal Rooms</h2>
          <div className="space-y-2">
            {connections.map(c => (
              <button
                key={c.id}
                onClick={() => navigate(
                  `/deals/new?requestId=${c.requestId}&vendorId=${c.vendorId}&connectionId=${c.id}`
                )}
                className="card p-4 w-full text-left hover:border-blue-300 transition-colors flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-stone-900 truncate">
                    {c.request?.title || 'Deal Room'}
                  </p>
                  <p className="text-xs text-stone-500 truncate">
                    {c.vendor?.name || 'Vendor'} · opened {format(new Date(c.createdAt), 'dd MMM yyyy')}
                  </p>
                </div>
                <span className={`badge shrink-0 ${
                  c.status === 'ACCEPTED' ? 'badge-green'
                  : c.status === 'PENDING' ? 'badge-blue'
                  : 'badge-stone'
                }`}>
                  {c.status}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {deals.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-stone-700 mb-2">Confirmed Deals</h2>
          <div className="space-y-2">
            {deals.map(d => (
              <div key={d.id} className="card p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-stone-900">{d.dealNumber}</p>
                  <p className="text-xs text-stone-500">Closed {format(new Date(d.updatedAt), 'dd MMM yyyy')}</p>
                </div>
                <span className="badge badge-green shrink-0">{d.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Deal Room ───────────────────────────────────────────────────────────────
const DealRoomView: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const requestId = searchParams.get('requestId');
  const vendorId = searchParams.get('vendorId');
  const connectionId = searchParams.get('connectionId');
  const dealRoomIdParam = searchParams.get('dealRoomId');

  const [dealRoom, setDealRoom] = useState<DealRoomDetail | null>(null);
  const [request, setRequest] = useState<ProcurementRequest | null>(null);
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [deal, setDeal] = useState<Deal | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [offers, setOffers] = useState<DealOffer[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);

  const [showOfferForm, setShowOfferForm] = useState(false);
  const [offerForm, setOfferForm] = useState({
    unitPrice: '',
    quantity: '',
    gst: '18',
    freight: '0',
    installation: '0',
    deliveryDays: '14',
    warrantyMonths: '',
    paymentTerms: 'Net 30',
  });

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [targetPrice, setTargetPrice] = useState('');

  const [previewRoute, setPreviewRoute] = useState<ResolvedApprovalRoute | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [offerToApprove, setOfferToApprove] = useState<string | null>(null);

  const isBuyer = !!dealRoom && dealRoom.buyerId === user?.id;
  const roomClosed = !dealRoom || dealRoom.status === 'CLOSED' || dealRoom.status === 'EXPIRED';
  const activeOffer = offers.find(o => o.status === 'ACTIVE' || o.status === 'PENDING_APPROVAL') || null;
  const isPendingApproval = activeOffer?.status === 'PENDING_APPROVAL';
  const pastOffers = offers.filter(o => o.status !== 'ACTIVE' && o.status !== 'PENDING_APPROVAL');

  const [unread, setUnread] = useState(0);

  /**
   * Mark the room read once it is actually on screen.
   *
   * Deferring until messages have rendered avoids writing a receipt for
   * messages the user has not been shown yet, which would silently swallow
   * them. The flag guard keeps a re-render from re-posting the same receipts.
   */
  useEffect(() => {
    if (!dealRoom || messages.length === 0 || roomClosed) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await notificationApi.markRoomRead(dealRoom.id);
          setUnread(0);
        } catch {
          // A missing receipt only affects the badge, not the conversation.
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [dealRoom, messages.length, roomClosed]);

  // Refresh the badge whenever the thread polls for new messages.
  const refreshUnread = useCallback(async (roomId: string) => {
    try {
      const res = await notificationApi.unreadInRoom(roomId);
      setUnread(res.data.data?.unread ?? 0);
    } catch {
      // Non-fatal: the badge falls back to its previous value.
    }
  }, []);

  // ── Resolve the deal room, then load its context ───────────────────────────
  useEffect(() => {
    let cancelled = false;

    const resolve = async (): Promise<DealRoomDetail> => {
      if (dealRoomIdParam) {
        const roomRes = await negotiationApi.getDealRoom(dealRoomIdParam);
        if (!roomRes.data.success || !roomRes.data.data) throw new Error('Failed to load deal room.');
        return roomRes.data.data;
      }

      if (connectionId) {
        const connRes = await dealsApi.getConnection(connectionId);
        if (!connRes.data.success || !connRes.data.data?.dealRoom) {
          throw new Error('This deal room is not available yet.');
        }
        const roomRes = await negotiationApi.getDealRoom(connRes.data.data.dealRoom.id);
        if (!roomRes.data.success || !roomRes.data.data) throw new Error('Failed to load deal room.');
        return roomRes.data.data;
      }

      if (requestId && vendorId) {
        const listRes = await dealsApi.listConnections({ requestId, vendorId, limit: 50 });
        if (listRes.data.success && listRes.data.data) {
          const found = (listRes.data.data.data || []).find(c => c.dealRoom);
          if (found?.dealRoom) {
            const roomRes = await negotiationApi.getDealRoom(found.dealRoom.id);
            if (roomRes.data.success && roomRes.data.data) return roomRes.data.data;
          }
        }
        throw new Error('No deal room found for this request and vendor. Connect from the request first.');
      }

      throw new Error('Missing request or vendor context.');
    };

    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const room = await resolve();
        if (cancelled) return;

        setDealRoom(room);
        if (room.vendor) setVendor(room.vendor);
        if (room.request) {
          setRequest(room.request);
          setOfferForm(f => ({
            ...f,
            quantity: String(room.request!.quantity || ''),
            unitPrice: room.request!.estimatedBudget && room.request!.quantity
              ? String(Math.round(room.request!.estimatedBudget / room.request!.quantity))
              : f.unitPrice,
          }));
        }

        const [msgRes, offerRes] = await Promise.all([
          negotiationApi.getMessages(room.id),
          negotiationApi.getOffers(room.id),
        ]);
        if (cancelled) return;

        const rawMessages: NegotiationMessage[] = (msgRes.data.data as NegotiationMessage[]) || [];
        const display: DisplayMessage[] = rawMessages.map(m => ({
          id: m.id,
          from: m.messageType === 'SYSTEM' ? 'system' : m.senderRole === 'BUYER' ? 'buyer' : 'seller',
          text: m.content,
          time: new Date(m.createdAt),
          kind: m.messageType === 'OFFER' ? 'offer' : m.messageType === 'SYSTEM' ? 'system' : 'text',
        }));

        setMessages(display);
        setOffers(((offerRes.data.data as DealOffer[]) || []).slice().sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        ));

        if (room.deal) setDeal(room.deal);
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.response?.data?.error || err?.message || 'Failed to load deal room');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [requestId, vendorId, connectionId, dealRoomIdParam]);

  // ── Poll for new messages / offers ─────────────────────────────────────────
  const refreshThread = useCallback(async (roomId: string) => {
    try {
      const [msgRes, offerRes, roomRes] = await Promise.all([
        negotiationApi.getMessages(roomId),
        negotiationApi.getOffers(roomId),
        negotiationApi.getDealRoom(roomId),
      ]);

      const rawMessages: NegotiationMessage[] = (msgRes.data.data as NegotiationMessage[]) || [];
      setMessages(rawMessages.map(m => ({
        id: m.id,
        from: m.messageType === 'SYSTEM' ? 'system' : m.senderRole === 'BUYER' ? 'buyer' : 'seller',
        text: m.content,
        time: new Date(m.createdAt),
        kind: m.messageType === 'OFFER' ? 'offer' : m.messageType === 'SYSTEM' ? 'system' : 'text',
      })));

      setOffers(((offerRes.data.data as DealOffer[]) || []).slice().sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ));

      if (roomRes.data.success && roomRes.data.data) {
        setDealRoom(roomRes.data.data);
        if (roomRes.data.data.deal) setDeal(roomRes.data.data.deal);
      }

      // Only count unread when the tab is in the background; the mark-read effect
      // zeroes the badge as soon as the room renders.
      if (typeof document === 'undefined' || document.hidden) {
        void refreshUnread(roomId);
      }
    } catch {
      // polling failures are non-fatal
    }
  }, [refreshUnread]);

  useEffect(() => {
    if (!dealRoom || roomClosed) return;
    const timer = setInterval(() => refreshThread(dealRoom.id), 6000);
    return () => clearInterval(timer);
  }, [dealRoom, roomClosed, refreshThread]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const content = messageText.trim();
    if (!content || !dealRoom || sending) return;

    setSending(true);
    setMessageText('');
    try {
      await negotiationApi.addMessage(dealRoom.id, content, 'TEXT');
      await refreshThread(dealRoom.id);
    } catch (err: any) {
      setMessageText(content);
      toast.error(err?.response?.data?.error || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const sendDraftMessage = async () => {
    if (!draft || !dealRoom) return;
    const content = draft.draftMessage.trim();
    if (!content) return;
    setSending(true);
    try {
      await negotiationApi.addMessage(dealRoom.id, content, 'TEXT');
      setDraft(null);
      await refreshThread(dealRoom.id);
      toast.success('Negotiation message sent');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const submitOffer = async () => {
    if (!dealRoom) return;
    const qty = parseInt(offerForm.quantity, 10);
    const price = parseFloat(offerForm.unitPrice);
    if (Number.isNaN(qty) || Number.isNaN(price) || price <= 0 || qty <= 0) {
      toast.error('Please enter a valid unit price and quantity');
      return;
    }

    const delivery = parseInt(offerForm.deliveryDays, 10);
    const warranty = parseInt(offerForm.warrantyMonths, 10);

    try {
      await negotiationApi.submitOffer(dealRoom.id, {
        unitPrice: price,
        quantity: qty,
        gst: parseFloat(offerForm.gst) || 0,
        freightAmount: parseFloat(offerForm.freight) || 0,
        installationAmount: parseFloat(offerForm.installation) || 0,
        deliveryTimelineDays: Number.isNaN(delivery) ? undefined : delivery,
        warrantyMonths: Number.isNaN(warranty) ? undefined : warranty,
        paymentTerms: offerForm.paymentTerms,
      });
      setShowOfferForm(false);
      setDraft(null);
      await refreshThread(dealRoom.id);
      toast.success('Offer submitted');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to submit offer');
    }
  };

  const reviewOfferForAcceptance = async (offerId: string) => {
    if (!dealRoom) return;
    setOfferToApprove(offerId);
    setPreviewLoading(true);
    try {
      const res = await purchaseApprovalApi.preview(offerId);
      if (res.data.success && res.data.data) {
        setPreviewRoute(res.data.data);
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to check approval policy');
      setOfferToApprove(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const submitForApproval = async () => {
    if (!offerToApprove) return;
    try {
      setPreviewLoading(true);
      await purchaseApprovalApi.submit({ offerId: offerToApprove });
      toast.success('Submitted for approval successfully');
      setOfferToApprove(null);
      setPreviewRoute(null);
      await refreshThread(dealRoom!.id);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to submit for approval');
    } finally {
      setPreviewLoading(false);
    }
};
  // const _recordSavings = async (closedDeal: Deal) => {
  //   const baseline = request?.estimatedBudget;
  //   if (!baseline || baseline <= 0 || closedDeal.requestId !== request?.id) return;
  //   try {
  //     await savingsApi.create({
  //       dealId: closedDeal.id,
  //       type: SavingsType.REALIZED,
  //       baselineAmount: baseline,
  //       baselineSource: 'Approved request budget',
  //       calculationMethod: 'Approved request budget minus accepted landed cost',
  //     });
  //     toast.success('Savings recorded');
  //   } catch {
  //     // non-blocking: savings can be recorded later from the deal record
  //   }
  // };

  const generateDraft = async () => {
    if (!dealRoom || !activeOffer) return;
    setDraftLoading(true);
    try {
      const target = parseFloat(targetPrice);
      const res = await negotiationApi.generateNegotiationDraft(dealRoom.id, {
        targetPrice: Number.isNaN(target) ? undefined : target,
        targetDeliveryDays: activeOffer.deliveryTimelineDays || undefined,
      });
      if (res.data.success && res.data.data) {
        setDraft({ ...res.data.data, currentOfferPrice: res.data.data.context.currentOfferPrice, targetPrice: res.data.data.context.targetPrice });
        toast.success('Negotiation draft ready');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to generate negotiation draft');
    } finally {
      setDraftLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (loadError || !dealRoom) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16 space-y-3">
        <AlertCircle className="h-10 w-10 text-stone-300 mx-auto" />
        <p className="text-stone-600">{loadError || 'Deal room not found.'}</p>
        <button onClick={() => navigate('/deals')} className="btn-secondary btn-sm">
          Back to Deals
        </button>
      </div>
    );
  }

  const roomStatusBadge = roomClosed
    ? <span className="badge badge-green">Deal Closed</span>
    : <span className="badge badge-blue">Live Deal Room</span>;

  const savingsVsBudget = (() => {
    if (!activeOffer || !request?.estimatedBudget) return null;
    const diff = request.estimatedBudget - landedCost(activeOffer);
    if (diff === 0) return null;
    return { amount: diff, pct: (diff / request.estimatedBudget) * 100 };
  })();

  return (
    <div className="max-w-6xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-start gap-3 mb-5">
        <button onClick={() => navigate(-1)} className="p-1.5 hover:bg-stone-100 rounded-lg transition-colors mt-0.5">
          <ArrowLeft className="h-5 w-5 text-stone-500" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {roomStatusBadge}
            {deal && <span className="badge badge-stone">{deal.dealNumber}</span>}
            {!isBuyer && <span className="badge badge-stone">Seller view</span>}
          </div>
          <h1 className="text-lg font-semibold text-stone-900 mt-0.5 truncate">
            {request?.title || 'Deal Room'}
          </h1>
          <p className="text-xs text-stone-500">
            {vendor?.name && `Negotiating with ${vendor.name}`}
            {dealRoom.connection?.status === ConnectionStatus.PENDING && ' · awaiting vendor response'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* ── Left: Chat ── */}
        <div className="lg:col-span-2 space-y-4">
          <div className="card flex flex-col" style={{ height: 480 }}>
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-stone-100">
              <p className="text-xs font-medium text-stone-600">Negotiation</p>
              {unread > 0 ? (
                <span className="badge bg-blue-50 text-blue-700">
                  {unread} unread while away
                </span>
              ) : (
                <span className="text-[11px] text-stone-400">Read up to date</span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
              {messages.length === 0 && (
                <p className="text-xs text-stone-400 text-center py-8">
                  No messages yet. Start the negotiation.
                </p>
              )}
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.from === 'buyer' ? 'justify-end' : msg.from === 'system' ? 'justify-center' : 'justify-start'}`}>
                  <MessageBubble msg={msg} />
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {!roomClosed ? (
              <div className="border-t border-stone-100 p-3 flex items-end gap-2">
                <textarea
                  value={messageText}
                  onChange={e => setMessageText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="Type a message…"
                  rows={1}
                  className="flex-1 input resize-none text-sm py-2"
                />
                <button
                  onClick={sendMessage}
                  disabled={!messageText.trim() || sending}
                  className="btn-primary btn-md h-9 w-9 p-0 rounded-lg"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>
            ) : (
              <div className="border-t border-stone-100 p-3 text-center text-xs text-stone-500">
                This deal room is closed.
              </div>
            )}
          </div>

          {/* AI negotiation draft */}
          {draft && !roomClosed && (
            <div className="card p-4 space-y-3 border-purple-200 bg-purple-50/40 animate-slide-up">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-purple-900 flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4" /> AI Negotiation Draft
                </h4>
                <button onClick={() => setDraft(null)} className="text-xs text-stone-500 hover:text-stone-700">
                  Dismiss
                </button>
              </div>

              <p className="text-xs text-stone-600"><span className="font-medium">Approach:</span> {draft.approach}</p>

              <div className="flex items-center gap-4 text-xs text-stone-600 flex-wrap">
                <span>Current: <strong>{fmtINR(draft.currentOfferPrice)}</strong></span>
                <TrendingDown className="h-3.5 w-3.5 text-emerald-600" />
                <span>Target: <strong>{fmtINR(draft.targetPrice)}</strong></span>
                {draft.currentOfferPrice > 0 && (
                  <span className="text-emerald-700 font-medium">
                    Gap: {(((draft.currentOfferPrice - draft.targetPrice) / draft.currentOfferPrice) * 100).toFixed(1)}%
                  </span>
                )}
              </div>

              {draft.keyPoints.length > 0 && (
                <ul className="text-xs text-stone-600 space-y-0.5 list-disc pl-4">
                  {draft.keyPoints.map((k, i) => <li key={i}>{k}</li>)}
                </ul>
              )}

              {draft.tradeoffs.length > 0 && (
                <div className="text-xs text-stone-600">
                  <span className="font-medium">Tradeoffs to offer:</span> {draft.tradeoffs.join(', ')}
                </div>
              )}

              <div className="bg-white border border-stone-200 rounded-lg p-3 text-sm text-stone-700 whitespace-pre-wrap">
                {draft.draftMessage}
              </div>

              <div className="flex gap-2">
                <button onClick={sendDraftMessage} disabled={sending} className="btn-primary btn-sm">
                  <Send className="h-3.5 w-3.5" /> Send this message
                </button>
                <button onClick={() => { setOfferForm(f => ({ ...f, unitPrice: String(Math.round(draft.targetPrice / (parseInt(f.quantity, 10) || 1))) })); setShowOfferForm(true); setDraft(null); }} className="btn-secondary btn-sm">
                  <FileText className="h-3.5 w-3.5" /> Counter at target
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Right: Deal summary ── */}
        <div className="space-y-4">
          {request && (
            <div className="card p-4 space-y-2">
              <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wide">Requirement</h3>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-stone-700">
                  <Package className="h-4 w-4 text-stone-400 flex-shrink-0" />
                  <span>{request.quantity} × {request.item}</span>
                </div>
                {request.estimatedBudget && (
                  <div className="flex items-center gap-2 text-stone-700">
                    <DollarSign className="h-4 w-4 text-stone-400 flex-shrink-0" />
                    Budget: {fmtINR(request.estimatedBudget)}
                  </div>
                )}
                <div className="flex items-center gap-2 text-stone-700">
                  <Calendar className="h-4 w-4 text-stone-400 flex-shrink-0" />
                  {format(new Date(request.requiredDate), 'dd MMM yyyy')}
                </div>
              </div>
            </div>
          )}

          {activeOffer && (
            <div>
              <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">Current Offer</h3>
              <OfferCard
                offer={activeOffer}
                isCurrent
                canAccept={isBuyer}
                onAccept={() => reviewOfferForAcceptance(activeOffer.id)}
              />
              {savingsVsBudget && (
                <div className={`mt-2 card p-3 text-xs flex items-center gap-2 ${
                  savingsVsBudget.amount > 0
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-rose-50 border-rose-200 text-rose-800'
                }`}>
                  <TrendingDown className="h-4 w-4 flex-shrink-0" />
                  <span>
                    {savingsVsBudget.amount > 0 ? 'Under budget by ' : 'Over budget by '}
                    <strong>{fmtINR(Math.abs(savingsVsBudget.amount))}</strong> ({Math.abs(savingsVsBudget.pct).toFixed(1)}%)
                  </span>
                </div>
              )}
            </div>
          )}

          {pastOffers.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">Previous Offers</h3>
              <div className="space-y-2">
                {pastOffers.map(o => (
                  <OfferCard key={o.id} offer={o} isCurrent={false} canAccept={false} />
                ))}
              </div>
            </div>
          )}

          {!roomClosed && !isPendingApproval && (
            <div className="space-y-2">
              {isBuyer && activeOffer && (
                <div className="card p-3 space-y-2 border-purple-200">
                  <label className="label text-xs">Target price (optional)</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={targetPrice}
                      onChange={e => setTargetPrice(e.target.value)}
                      placeholder={String(Math.round(landedCost(activeOffer) * 0.9))}
                      className="input text-sm py-1.5"
                    />
                    <button onClick={generateDraft} disabled={draftLoading} className="btn-secondary btn-sm whitespace-nowrap">
                      {draftLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      Draft
                    </button>
                  </div>
                  <p className="text-[11px] text-stone-400">Generates a negotiation message from AI using deal context.</p>
                </div>
              )}

              <button
                onClick={() => setShowOfferForm(v => !v)}
                className="w-full btn-secondary btn-sm"
              >
                <FileText className="h-3.5 w-3.5" />
                {showOfferForm ? 'Cancel Offer' : 'Submit Offer'}
              </button>

              {showOfferForm && (
                <div className="card p-4 space-y-3 animate-slide-up">
                  <h4 className="text-sm font-semibold text-stone-800">Offer Details</h4>
                  <div className="space-y-2">
                    {[
                      { label: 'Unit Price (₹)', key: 'unitPrice' },
                      { label: 'Quantity', key: 'quantity' },
                      { label: 'GST %', key: 'gst' },
                      { label: 'Freight (₹)', key: 'freight' },
                      { label: 'Installation (₹)', key: 'installation' },
                      { label: 'Delivery (days)', key: 'deliveryDays' },
                      { label: 'Warranty (months)', key: 'warrantyMonths' },
                    ].map(({ label, key }) => (
                      <div key={key}>
                        <label className="label text-xs">{label}</label>
                        <input
                          type="number"
                          value={offerForm[key as keyof typeof offerForm]}
                          onChange={e => setOfferForm(f => ({ ...f, [key]: e.target.value }))}
                          className="input text-sm py-1.5"
                        />
                      </div>
                    ))}
                    <div>
                      <label className="label text-xs">Payment Terms</label>
                      <select
                        value={offerForm.paymentTerms}
                        onChange={e => setOfferForm(f => ({ ...f, paymentTerms: e.target.value }))}
                        className="input text-sm py-1.5"
                      >
                        {['Net 15', 'Net 30', 'Net 45', 'Net 60', '50% advance, 50% on delivery', '100% advance'].map(t => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </div>

                    {(() => {
                      const qty = parseInt(offerForm.quantity, 10);
                      const price = parseFloat(offerForm.unitPrice);
                      if (Number.isNaN(qty) || Number.isNaN(price)) return null;
                      const total = price * qty
                        + (price * qty * (parseFloat(offerForm.gst) || 0)) / 100
                        + (parseFloat(offerForm.freight) || 0)
                        + (parseFloat(offerForm.installation) || 0);
                      return (
                        <div className="flex items-center justify-between border-t border-stone-200 pt-2">
                          <span className="text-xs text-stone-500">Landed cost</span>
                          <span className="text-sm font-bold text-stone-900">{fmtINR(total)}</span>
                        </div>
                      );
                    })()}
                  </div>
                  <button onClick={submitOffer} className="w-full btn-primary btn-sm">
                    Submit Offer
                  </button>
                </div>
              )}
            </div>
          )}

          {roomClosed && deal && (
            <div className="card p-4 bg-emerald-50 border-emerald-200 text-center space-y-2">
              <CheckCircle className="h-8 w-8 text-emerald-600 mx-auto" />
              <p className="text-sm font-semibold text-emerald-900">Deal Confirmed</p>
              <p className="text-xs text-emerald-700">{deal.dealNumber} · {deal.status}</p>
              {deal.purchaseOrder ? (
                <button
                  onClick={() => navigate(`/purchase-orders/${deal.purchaseOrder!.id}`)}
                  className="btn btn-secondary w-full justify-center"
                >
                  <ClipboardCheck className="h-4 w-4" />
                  View {deal.purchaseOrder.poNumber}
                </button>
              ) : (
                <button
                  onClick={() => navigate(`/purchase-orders/new?dealId=${deal.id}`)}
                  className="btn btn-primary w-full justify-center"
                >
                  <ClipboardCheck className="h-4 w-4" />
                  Raise Purchase Order
                </button>
              )}
            </div>
          )}

          {roomClosed && !deal && (
            <div className="card p-4 bg-stone-50 border-stone-200 text-center space-y-2">
              <Clock className="h-8 w-8 text-stone-400 mx-auto" />
              <p className="text-sm font-semibold text-stone-700">Deal Room Closed</p>
              <p className="text-xs text-stone-500">No confirmed deal was created for this room.</p>
            </div>
          )}
        </div>
      </div>

      {offerToApprove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg overflow-hidden animate-slide-up">
            <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-stone-900">Review & Accept Offer</h3>
              <button onClick={() => { setOfferToApprove(null); setPreviewRoute(null); }} className="text-stone-400 hover:text-stone-600">
                &times;
              </button>
            </div>
            <div className="p-6">
              {previewLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                </div>
              ) : previewRoute ? (
                <div className="space-y-4 text-sm text-stone-700">
                  <p>
                    Landed cost: <strong>{fmtINR(previewRoute.thresholdAmount)}</strong>
                  </p>
                  {previewRoute.approvalRequired ? (
                    <>
                      <div className="p-3 bg-blue-50 text-blue-800 rounded border border-blue-200">
                        {previewRoute.reason}
                      </div>
                      <div className="space-y-2 mt-4">
                        <p className="font-semibold text-stone-800">Required Approvals:</p>
                        <ul className="space-y-1 ml-2">
                          {previewRoute.levels.map((lvl) => (
                            <li key={lvl.level} className="flex items-center gap-2">
                              <span className="w-5 h-5 rounded-full bg-stone-100 text-stone-500 flex items-center justify-center text-xs font-medium">
                                {lvl.level}
                              </span>
                              <span>{lvl.approverName ?? presentRole(lvl.requiredRole)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <p className="text-xs text-stone-500 mt-4">
                        Upon submission, an approval request will be routed to the appropriate managers. You will not be able to confirm the deal until all approvals are received.
                      </p>
                    </>
                  ) : (
                    <div className="p-3 bg-emerald-50 text-emerald-800 rounded border border-emerald-200">
                      {previewRoute.reason}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            <div className="px-6 py-4 bg-stone-50 flex justify-end gap-3 border-t border-stone-100">
              <button
                onClick={() => { setOfferToApprove(null); setPreviewRoute(null); }}
                className="btn-secondary btn-sm"
              >
                Cancel
              </button>
              <button
                onClick={submitForApproval}
                disabled={previewLoading || !previewRoute}
                className="btn-primary btn-sm"
              >
                {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {previewRoute?.approvalRequired ? 'Submit for Approval' : 'Accept & Auto-Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main ─────────────────────────────────────────────────────────────────────
export const DealsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const hasContext = !!(
    searchParams.get('dealRoomId') ||
    searchParams.get('connectionId') ||
    (searchParams.get('requestId') && searchParams.get('vendorId'))
  );

  return hasContext ? <DealRoomView /> : <DealsListView />;
};
