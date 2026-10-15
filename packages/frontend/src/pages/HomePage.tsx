import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUp, Loader2, Sparkles,
  ChevronRight, Zap, FileText, Building2
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { requestApi, vendorApi } from '../services/api';
import { CreateRequestData, ProcurementRequest } from '../types';
import { format } from 'date-fns';

const EXAMPLE_PROMPTS = [
  'I need 50 office chairs in Bangalore',
  'Find an electrical contractor for 250 KVA installation',
  'I need 20 business laptops under INR 15 lakh',
  'AWS cloud subscription renewal – 12 months enterprise',
  'Marketing agency for Q1 product launch campaign',
];

const extractBasicFields = (text: string): Partial<CreateRequestData> => {
  const lower = text.toLowerCase();
  const result: Partial<CreateRequestData> = {};

  // Quantity
  const qtyMatch = text.match(/(\d+)\s*(laptops?|chairs?|computers?|units?|items?|licenses?|monitors?|printers?)/i);
  if (qtyMatch) {
    result.quantity = parseInt(qtyMatch[1], 10);
    const rawItem = qtyMatch[2].replace(/s$/i, '');
    result.item = rawItem.charAt(0).toUpperCase() + rawItem.slice(1);
  }

  // Location
  const locations = ['bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'chennai', 'pune', 'kolkata', 'gurgaon', 'noida'];
  for (const loc of locations) {
    if (lower.includes(loc)) {
      result.location = loc.charAt(0).toUpperCase() + loc.slice(1);
      break;
    }
  }

  // Budget
  const budgetMatch = text.match(/(?:inr|₹|rs\.?)\s*([\d,]+(?:\s*(?:lakh|lac|l|k|cr))?)/i);
  if (budgetMatch) {
    let amount = parseFloat(budgetMatch[1].replace(/,/g, ''));
    const lower2 = budgetMatch[0].toLowerCase();
    if (lower2.includes('lakh') || lower2.includes('lac') || lower2.includes(' l')) amount *= 100000;
    else if (lower2.includes('cr')) amount *= 10000000;
    else if (lower2.includes('k')) amount *= 1000;
    result.estimatedBudget = amount;
  }

  // Date
  const dateMatch = text.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i);
  if (dateMatch) {
    const d = new Date(`${dateMatch[0]} ${new Date().getFullYear()}`);
    if (!isNaN(d.getTime())) result.requiredDate = d.toISOString();
  }

  // Title
  if (result.item && result.quantity) {
    result.title = `${result.quantity} ${result.item}${(result.quantity || 0) > 1 ? 's' : ''} – ${result.location || 'Office'}`;
  } else {
    result.title = text.slice(0, 80);
  }

  return result;
};

const statusConfig: Record<string, { label: string; color: string }> = {
  DRAFT:                { label: 'Draft',            color: 'text-stone-500' },
  SUBMITTED:            { label: 'Submitted',         color: 'text-blue-600' },
  REQUIREMENT_EXTRACTED:{ label: 'Analysed',          color: 'text-blue-600' },
  VENDORS_IDENTIFIED:   { label: 'Vendors Found',     color: 'text-indigo-600' },
  RFQ_CREATED:          { label: 'RFQ Created',       color: 'text-purple-600' },
  RFQ_SENT:             { label: 'RFQ Sent',          color: 'text-purple-600' },
  QUOTES_RECEIVED:      { label: 'Quotes In',         color: 'text-amber-600' },
  RECOMMENDATION_READY: { label: 'Recommended',       color: 'text-emerald-600' },
  APPROVAL_PENDING:     { label: 'Awaiting Approval', color: 'text-amber-600' },
  APPROVED:             { label: 'Approved',          color: 'text-emerald-600' },
  REJECTED:             { label: 'Rejected',          color: 'text-red-600' },
  COMPLETED:            { label: 'Completed',         color: 'text-emerald-700' },
  CANCELLED:            { label: 'Cancelled',         color: 'text-stone-400' },
};

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentRequests, setRecentRequests] = useState<ProcurementRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [vendorCount, setVendorCount] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const [reqRes, vendorRes] = await Promise.all([
          requestApi.list({ limit: 5, sortOrder: 'desc' }),
          vendorApi.list({ limit: 1 }),
        ]);
        if (reqRes.data.success && reqRes.data.data) {
          setRecentRequests(reqRes.data.data.data);
        }
        if (vendorRes.data.success && vendorRes.data.data) {
          setVendorCount(vendorRes.data.data.total);
        }
      } catch (_) {
        // silent
      } finally {
        setLoadingRequests(false);
      }
    };
    load();
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    }
  }, [description]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!description.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const extracted = extractBasicFields(description);
      const requestData: CreateRequestData = {
        title: extracted.title || description.slice(0, 80),
        description,
        item: extracted.item || 'General Item',
        quantity: extracted.quantity || 1,
        location: extracted.location || 'Office',
        requiredDate: extracted.requiredDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        estimatedBudget: extracted.estimatedBudget,
        specifications: description,
        priority: 2,
      };

      const response = await requestApi.create(requestData);
      if (response.data.success && response.data.data) {
        navigate(`/requests/${response.data.data.id}?new=1`);
      }
    } catch (err) {
      console.error('Failed to create request:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const greet = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Hero */}
      <div className="pt-4 pb-2">
        <p className="text-sm text-stone-400 mb-1">{greet()}, {user?.firstName || 'there'} 👋</p>
        <h1 className="text-2xl font-semibold text-stone-900">What do you need today?</h1>
        <p className="text-stone-500 text-sm mt-1">Describe your requirement. Find vendors and connect instantly.</p>
      </div>

      {/* Chat Input */}
      <form onSubmit={handleSubmit}>
        <div className="chat-input-wrap">
          <textarea
            ref={textareaRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. I need 50 office chairs in Bangalore, budget INR 5 lakh, delivery by Dec 15"
            className="w-full px-4 pt-4 pb-2 text-sm text-stone-900 placeholder:text-stone-400 resize-none bg-transparent focus:outline-none min-h-[80px]"
            disabled={isSubmitting}
            rows={3}
            aria-label="Describe your procurement requirement"
          />
          <div className="flex items-center justify-between px-3 pb-3 pt-1">
            <p className="text-xs text-stone-400">Press Enter to send · Shift+Enter for new line</p>
            <button
              type="submit"
              disabled={!description.trim() || isSubmitting}
              className="flex items-center justify-center h-8 w-8 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Send requirement"
            >
              {isSubmitting
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <ArrowUp className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </form>

      {/* Example Prompts */}
      <div>
        <p className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-2">Try an example</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => setDescription(prompt)}
              className="px-3 py-1.5 text-xs text-stone-600 bg-white border border-stone-200 rounded-lg hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-all duration-150"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Active Requests', value: recentRequests.filter(r => !['COMPLETED','CANCELLED','REJECTED'].includes(r.status)).length, icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
          { label: 'Vendors on NAVO', value: vendorCount, icon: Building2, color: 'text-emerald-600', bg: 'bg-emerald-50' },
          { label: 'Live Deals', value: 0, icon: Zap, color: 'text-amber-600', bg: 'bg-amber-50' },
        ].map((stat) => (
          <div key={stat.label} className="card p-4 flex items-center gap-3">
            <div className={`h-9 w-9 rounded-lg ${stat.bg} flex items-center justify-center flex-shrink-0`}>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </div>
            <div>
              <p className="text-lg font-semibold text-stone-900 leading-none">
                {loadingRequests ? '—' : stat.value}
              </p>
              <p className="text-xs text-stone-500 mt-0.5">{stat.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Recent Requests */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-stone-900">Recent Requests</h2>
          <button
            onClick={() => navigate('/requests')}
            className="text-xs text-blue-600 hover:underline flex items-center gap-0.5"
          >
            View all <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        {loadingRequests ? (
          <div className="space-y-2">
            {[1,2,3].map(i => (
              <div key={i} className="card p-4 animate-pulse flex gap-3">
                <div className="h-8 w-8 rounded-lg bg-stone-100 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-stone-100 rounded w-1/2" />
                  <div className="h-3 bg-stone-100 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : recentRequests.length === 0 ? (
          <div className="card p-8 text-center">
            <Sparkles className="h-8 w-8 text-stone-300 mx-auto mb-2" />
            <p className="text-sm text-stone-500">No requests yet. Describe your first requirement above.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recentRequests.map((req) => {
              const sc = statusConfig[req.status] || { label: req.status, color: 'text-stone-500' };
              return (
                <button
                  key={req.id}
                  onClick={() => navigate(`/requests/${req.id}`)}
                  className="card w-full p-4 flex items-center gap-3 hover:border-stone-300 hover:shadow-sm transition-all duration-150 text-left group"
                >
                  <div className="h-8 w-8 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                    <FileText className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-stone-800 truncate">{req.title}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className={`text-xs font-medium ${sc.color}`}>{sc.label}</span>
                      <span className="text-xs text-stone-400">
                        {format(new Date(req.createdAt), 'dd MMM')}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-stone-300 group-hover:text-stone-500 flex-shrink-0 transition-colors" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};