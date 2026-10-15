import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingBag, ChevronRight, Package, DollarSign, Loader2, CheckCircle } from 'lucide-react';
import { requestApi } from '../services/api';
import { ProcurementRequest } from '../types';
import { format } from 'date-fns';

export const PurchaseHistoryPage: React.FC = () => {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<ProcurementRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await requestApi.list({ limit: 50, sortOrder: 'desc' });
        if (res.data.success && res.data.data) {
          // Show completed / approved requests as history
          setRequests(
            res.data.data.data.filter((r: { status: string }) =>
              ['COMPLETED', 'APPROVED', 'PURCHASE_ORDER_CREATED'].includes(r.status)
            )
          );
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Purchase History</h1>
        <p className="text-sm text-stone-500 mt-1">Completed and approved procurement records.</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : requests.length === 0 ? (
        <div className="card p-12 text-center">
          <ShoppingBag className="h-10 w-10 text-stone-200 mx-auto mb-3" />
          <p className="text-stone-600 font-medium">No purchase history yet</p>
          <p className="text-sm text-stone-400 mt-1">Completed deals will appear here.</p>
          <button onClick={() => navigate('/')} className="btn-primary btn-sm mt-5">
            Start a Request
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {requests.map(req => (
            <button
              key={req.id}
              onClick={() => navigate(`/requests/${req.id}`)}
              className="card w-full p-4 flex items-center gap-4 hover:border-stone-300 hover:shadow-sm transition-all duration-150 text-left group"
            >
              <div className="h-10 w-10 rounded-xl bg-emerald-50 flex items-center justify-center flex-shrink-0">
                <CheckCircle className="h-5 w-5 text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="col-span-2">
                  <p className="text-sm font-medium text-stone-800 truncate">{req.title}</p>
                  <p className="text-xs text-stone-400 mt-0.5">{format(new Date(req.createdAt), 'dd MMM yyyy')}</p>
                </div>
                <div className="hidden sm:flex items-center gap-1.5 text-sm text-stone-600">
                  <Package className="h-3.5 w-3.5 text-stone-400" />
                  {req.quantity} × {req.item}
                </div>
                {req.estimatedBudget && (
                  <div className="hidden sm:flex items-center gap-1.5 text-sm text-stone-600">
                    <DollarSign className="h-3.5 w-3.5 text-stone-400" />
                    ₹{req.estimatedBudget.toLocaleString('en-IN')}
                  </div>
                )}
              </div>
              <ChevronRight className="h-4 w-4 text-stone-300 group-hover:text-stone-500 flex-shrink-0 transition-colors" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
