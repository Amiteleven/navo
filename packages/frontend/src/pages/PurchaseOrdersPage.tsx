import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ClipboardList,
  Loader2,
  Search,
  ChevronRight,
  AlertTriangle,
  PackageCheck,
  Printer,
} from 'lucide-react';
import { purchaseOrderApi, PurchaseOrderListItem } from '../services/api';
import { PurchaseOrderStatus, UserRole } from '../types';
import { useAuth } from '../context/AuthContext';
import {
  formatAmount,
  formatDate,
  poStatusClass,
  poStatusLabel,
} from '../utils/purchaseOrder';

const STATUS_FILTERS: Array<{ value: PurchaseOrderStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: PurchaseOrderStatus.DRAFT, label: 'Draft' },
  { value: PurchaseOrderStatus.PENDING_APPROVAL, label: 'Pending approval' },
  { value: PurchaseOrderStatus.ISSUED, label: 'Issued' },
  { value: PurchaseOrderStatus.SUPPLIER_CONFIRMED, label: 'Confirmed' },
  { value: PurchaseOrderStatus.IN_PROGRESS, label: 'In progress' },
  { value: PurchaseOrderStatus.PARTIALLY_DELIVERED, label: 'Part delivered' },
  { value: PurchaseOrderStatus.DELIVERED, label: 'Delivered' },
  { value: PurchaseOrderStatus.CLOSED, label: 'Closed' },
  { value: PurchaseOrderStatus.CANCELLED, label: 'Cancelled' },
];

export const PurchaseOrdersPage: React.FC = () => {
  const navigate = useNavigate();
  const { user, hasRole } = useAuth();

  const [orders, setOrders] = useState<PurchaseOrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<PurchaseOrderStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const isSeller = user?.role === UserRole.VENDOR;
  const canSeeAll = hasRole([
    UserRole.PROCUREMENT_MANAGER,
    UserRole.COMPANY_ADMIN,
    UserRole.PLATFORM_ADMIN,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await purchaseOrderApi.list({
        status: status === 'ALL' ? undefined : status,
        search: debouncedSearch || undefined,
        limit: 100,
      });
      setOrders(response.data.data ?? []);
    } catch (err) {
      setError((err as Error).message || 'Could not load purchase orders');
    } finally {
      setLoading(false);
    }
  }, [status, debouncedSearch]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = orders.reduce(
    (acc, order) => {
      acc.value += order.totalAmount;
      if ([PurchaseOrderStatus.DELIVERED, PurchaseOrderStatus.CLOSED].includes(order.status)) {
        acc.delivered += 1;
      }
      if (order.status === PurchaseOrderStatus.PENDING_APPROVAL) acc.awaitingApproval += 1;
      return acc;
    },
    { value: 0, delivered: 0, awaitingApproval: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">
            {isSeller ? 'Orders' : 'Purchase Orders'}
          </h1>
          <p className="text-sm text-stone-500 mt-1">
            {isSeller
              ? 'Purchase orders issued to your organisation.'
              : 'Track every order from approval through delivery, invoicing and payment.'}
          </p>
        </div>
        <button
          onClick={() => window.print()}
          className="btn btn-secondary btn-sm"
          title="Print this list"
        >
          <Printer className="h-4 w-4" aria-hidden="true" />
          Print
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label="Orders shown" value={String(orders.length)} />
        <SummaryTile label="Total value" value={formatAmount(totals.value)} />
        <SummaryTile label="Delivered" value={String(totals.delivered)} />
        <SummaryTile label="Awaiting approval" value={String(totals.awaitingApproval)} />
      </div>

      <div className="card p-4 space-y-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by PO number, item or supplier"
            className="input pl-9 w-full"
            aria-label="Search purchase orders"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setStatus(filter.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                status === filter.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
              }`}
              aria-pressed={status === filter.value}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : orders.length === 0 ? (
        <div className="card p-12 text-center">
          <ClipboardList className="mx-auto mb-3 h-10 w-10 text-stone-200" aria-hidden="true" />
          <p className="font-medium text-stone-600">
            {debouncedSearch || status !== 'ALL'
              ? 'No purchase orders match these filters'
              : 'No purchase orders yet'}
          </p>
          <p className="mt-1 text-sm text-stone-400">
            {debouncedSearch || status !== 'ALL'
              ? 'Try clearing the search or status filter.'
              : 'Purchase orders are created from an accepted deal.'}
          </p>
          {!debouncedSearch && status === 'ALL' && !isSeller && (
            <button onClick={() => navigate('/deals')} className="btn-primary btn-sm mt-5">
              Go to Live Deals
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => {
            const approvedLevels = order._count?.approvals ?? 0;
            return (
              <button
                key={order.id}
                onClick={() => navigate(`/purchase-orders/${order.id}`)}
                className="card group flex w-full items-center gap-4 p-4 text-left transition-all duration-150 hover:border-stone-300 hover:shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-stone-900">{order.poNumber}</span>
                    <span className={`badge ${poStatusClass(order.status)}`}>
                      {poStatusLabel(order.status)}
                    </span>
                    {order.status === PurchaseOrderStatus.PENDING_APPROVAL && approvedLevels > 0 && (
                      <span className="badge bg-stone-100 text-stone-600">
                        {approvedLevels} approval level(s)
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-sm text-stone-600">
                    {order.quantity}
                    {order.unit ? ` ${order.unit}` : ''} × {order.itemName}
                  </p>
                  <p className="mt-0.5 text-xs text-stone-400">
                    {isSeller ? 'Buyer reference' : order.vendor.name}
                    {order.expectedDeliveryDate && (
                      <> · Due {formatDate(order.expectedDeliveryDate)}</>
                    )}
                  </p>
                </div>

                <div className="hidden text-right sm:block">
                  <p className="font-semibold text-stone-900">
                    {formatAmount(order.totalAmount, order.currency)}
                  </p>
                  {order.status === PurchaseOrderStatus.DELIVERED && (
                    <p className="mt-0.5 flex items-center justify-end gap-1 text-xs text-emerald-600">
                      <PackageCheck className="h-3 w-3" aria-hidden="true" />
                      Delivered
                    </p>
                  )}
                </div>

                <ChevronRight
                  className="h-4 w-4 flex-shrink-0 text-stone-300 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
      )}

      {canSeeAll && orders.length > 0 && (
        <p className="text-xs text-stone-400">
          Showing all purchase orders in your organisation.
        </p>
      )}
    </div>
  );
};

const SummaryTile: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="card p-3">
    <p className="text-xs text-stone-500">{label}</p>
    <p className="mt-1 text-lg font-semibold text-stone-900">{value}</p>
  </div>
);

export default PurchaseOrdersPage;