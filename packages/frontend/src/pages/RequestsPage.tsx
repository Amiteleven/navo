import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, FileText, ChevronRight,
  Calendar, MapPin, Package
} from 'lucide-react';
import { requestApi } from '../services/api';
import { ProcurementRequest, RequestStatus } from '../types';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  DRAFT:                 { label: 'Draft',             color: 'text-stone-600',   bg: 'bg-stone-100'  },
  SUBMITTED:             { label: 'Submitted',          color: 'text-blue-700',    bg: 'bg-blue-50'    },
  REQUIREMENT_EXTRACTED: { label: 'Analysed',           color: 'text-blue-700',    bg: 'bg-blue-50'    },
  VENDORS_IDENTIFIED:    { label: 'Vendors Found',      color: 'text-indigo-700',  bg: 'bg-indigo-50'  },
  RFQ_CREATED:           { label: 'RFQ Created',        color: 'text-purple-700',  bg: 'bg-purple-50'  },
  RFQ_SENT:              { label: 'RFQ Sent',           color: 'text-purple-700',  bg: 'bg-purple-50'  },
  QUOTES_RECEIVED:       { label: 'Quotes In',          color: 'text-amber-700',   bg: 'bg-amber-50'   },
  RECOMMENDATION_READY:  { label: 'Recommended',        color: 'text-emerald-700', bg: 'bg-emerald-50' },
  APPROVAL_PENDING:      { label: 'Awaiting Approval',  color: 'text-amber-700',   bg: 'bg-amber-50'   },
  APPROVED:              { label: 'Approved',           color: 'text-emerald-700', bg: 'bg-emerald-50' },
  REJECTED:              { label: 'Rejected',           color: 'text-red-700',     bg: 'bg-red-50'     },
  COMPLETED:             { label: 'Completed',          color: 'text-emerald-700', bg: 'bg-emerald-50' },
  CANCELLED:             { label: 'Cancelled',          color: 'text-stone-500',   bg: 'bg-stone-100'  },
};

const FILTER_TABS = [
  { label: 'All', value: '' },
  { label: 'Active', value: 'SUBMITTED' },
  { label: 'Quotes', value: 'QUOTES_RECEIVED' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Completed', value: 'COMPLETED' },
];

export const RequestsPage: React.FC = () => {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<ProcurementRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const fetchRequests = async () => {
    setIsLoading(true);
    try {
      const res = await requestApi.list({
        page,
        limit: 15,
        status: statusFilter as RequestStatus || undefined,
        sortOrder: 'desc',
      });
      if (res.data.success && res.data.data) {
        let data = res.data.data.data;
        if (search) {
          data = data.filter((r: ProcurementRequest) =>
            r.title.toLowerCase().includes(search.toLowerCase()) ||
            r.item.toLowerCase().includes(search.toLowerCase())
          );
        }
        setRequests(data);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      }
    } catch {
      toast.error('Failed to load requests');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { fetchRequests(); }, [page, statusFilter]);
  useEffect(() => {
    const t = setTimeout(fetchRequests, 300);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">My Requests</h1>
          <p className="text-sm text-stone-500 mt-0.5">{total} total requests</p>
        </div>
        <button onClick={() => navigate('/')} className="btn-primary btn-sm">
          <Plus className="h-3.5 w-3.5" />
          New Request
        </button>
      </div>

      {/* Search + filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
          <input
            type="text"
            placeholder="Search requests…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="input pl-9 text-sm"
          />
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {FILTER_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => { setStatusFilter(tab.value); setPage(1); }}
            className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 ${
              statusFilter === tab.value
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="card p-4 animate-pulse flex gap-4">
              <div className="h-10 w-10 rounded-xl bg-stone-100 flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 bg-stone-100 rounded w-1/2" />
                <div className="h-3 bg-stone-100 rounded w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : requests.length === 0 ? (
        <div className="card p-12 text-center">
          <FileText className="h-10 w-10 text-stone-200 mx-auto mb-3" />
          <p className="text-stone-600 font-medium">No requests found</p>
          <p className="text-sm text-stone-400 mt-1">
            {search ? 'Try a different search.' : 'Describe a requirement on the home page to get started.'}
          </p>
          <button onClick={() => navigate('/')} className="btn-primary btn-sm mt-5">
            New Request
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {requests.map(req => {
            const sc = STATUS_CONFIG[req.status] || { label: req.status, color: 'text-stone-600', bg: 'bg-stone-100' };
            return (
              <button
                key={req.id}
                onClick={() => navigate(`/requests/${req.id}`)}
                className="card w-full p-4 flex items-center gap-4 hover:border-stone-300 hover:shadow-sm transition-all duration-150 text-left group"
              >
                <div className="h-10 w-10 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
                  <FileText className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-stone-800 truncate">{req.title}</p>
                    <span className={`badge flex-shrink-0 text-xs ${sc.bg} ${sc.color}`}>{sc.label}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <span className="flex items-center gap-1 text-xs text-stone-400">
                      <Package className="h-3 w-3" />
                      {req.quantity} × {req.item}
                    </span>
                    {req.location && (
                      <span className="flex items-center gap-1 text-xs text-stone-400">
                        <MapPin className="h-3 w-3" />
                        {req.location}
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-xs text-stone-400">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(req.createdAt), 'dd MMM')}
                    </span>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-stone-300 group-hover:text-stone-500 transition-colors flex-shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-stone-500">
            Page {page} of {totalPages} · {total} requests
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-secondary btn-sm"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="btn-secondary btn-sm"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};