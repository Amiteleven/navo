import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loader2,
  AlertTriangle,
  Building2,
  TrendingUp,
  Clock,
  Receipt,
  PackageCheck,
  ChevronRight,
  BadgeCheck,
  Printer,
} from 'lucide-react';
import { purchaseOrderApi, SellerDashboard, SellerOrder } from '../services/api';
import { PurchaseOrderStatus } from '../types';
import {
  formatAmount,
  formatDate,
  invoiceStatusClass,
  invoiceStatusLabel,
  poStatusClass,
  poStatusLabel,
} from '../utils/purchaseOrder';

export const SellerDashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<SellerDashboard | null>(null);
  const [orders, setOrders] = useState<SellerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashboardResponse, ordersResponse] = await Promise.all([
        purchaseOrderApi.seller.dashboard(),
        purchaseOrderApi.seller.orders(),
      ]);
      setDashboard(dashboardResponse.data.data ?? null);
      setOrders(ordersResponse.data.data ?? []);
    } catch (err) {
      setError((err as Error).message || 'Could not load your dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error || !dashboard) {
    return (
      <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
        <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
        {error ?? 'Dashboard unavailable'}
      </div>
    );
  }

  const { summary, vendor } = dashboard;
  const maxMonthValue = Math.max(1, ...dashboard.monthlyPerformance.map((m) => m.value));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">{vendor.name}</h1>
          <p className="mt-1 text-sm text-stone-500">
            Supplier dashboard · {vendor.status.toLowerCase()}
            {vendor.gstin ? ` · GSTIN ${vendor.gstin}` : ' · GSTIN not on record'}
          </p>
        </div>
        <button onClick={() => window.print()} className="btn btn-secondary btn-sm">
          <Printer className="h-4 w-4" aria-hidden="true" />
          Print
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          icon={PackageCheck}
          label="Orders received"
          value={String(summary.totalOrders)}
          hint={formatAmount(summary.totalOrderValue)}
        />
        <Tile
          icon={Clock}
          label="Awaiting your confirmation"
          value={String(summary.pendingConfirmation)}
          hint={summary.pendingConfirmation > 0 ? 'Action needed' : 'Nothing pending'}
          emphasis={summary.pendingConfirmation > 0}
        />
        <Tile
          icon={AlertTriangle}
          label="Past committed date"
          value={String(summary.overdueOrders)}
          hint={summary.overdueOrders > 0 ? 'Behind schedule' : 'On schedule'}
          emphasis={summary.overdueOrders > 0}
        />
        <Tile
          icon={Receipt}
          label="Open invoices"
          value={String(summary.openInvoices)}
          hint="Awaiting buyer review"
        />
      </div>

      {summary.pendingConfirmation > 0 && (
        <section className="card border-blue-200 bg-blue-50/50 p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
            <Clock className="h-4 w-4" aria-hidden="true" />
            Confirm these orders
          </h2>
          <p className="mt-1 text-xs text-stone-600">
            Confirming lets the buyer progress the order and is required before dispatch
            can be reported.
          </p>
          <div className="mt-3 space-y-2">
            {dashboard.pendingOrders.map((order) => (
              <button
                key={order.id}
                onClick={() => navigate(`/purchase-orders/${order.id}`)}
                className="flex w-full items-center gap-3 rounded-lg border border-blue-100 bg-white p-3 text-left transition-all duration-150 hover:border-blue-300"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-stone-900">{order.poNumber}</p>
                  <p className="truncate text-xs text-stone-500">
                    {order.quantity} × {order.itemName} · issued{' '}
                    {formatDate(order.issuedAt)}
                  </p>
                </div>
                <span className="text-sm font-semibold text-stone-900">
                  {formatAmount(order.totalAmount, order.currency)}
                </span>
                <ChevronRight className="h-4 w-4 text-stone-300" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
            <TrendingUp className="h-4 w-4" aria-hidden="true" />
            Order value by month
          </h2>
          {dashboard.monthlyPerformance.every((m) => m.value === 0) ? (
            <p className="mt-3 text-sm text-stone-500">No issued orders in the last six months.</p>
          ) : (
            <div className="mt-4 space-y-2">
              {dashboard.monthlyPerformance.map((month) => (
                <div key={month.month}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-stone-500">{month.month}</span>
                    <span className="font-medium text-stone-700">
                      {month.orders} order(s) · {formatAmount(month.value)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-stone-100">
                    <div
                      className="h-full rounded-full bg-blue-600"
                      style={{ width: `${(month.value / maxMonthValue) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800">
            <Building2 className="h-4 w-4" aria-hidden="true" />
            Orders by status
          </h2>
          {Object.keys(summary.statusCounts).length === 0 ? (
            <p className="mt-3 text-sm text-stone-500">No orders yet.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {Object.entries(summary.statusCounts).map(([status, count]) => (
                <li key={status} className="flex items-center justify-between text-sm">
                  <span className={poStatusClass(status as PurchaseOrderStatus)}>
                    {poStatusLabel(status as PurchaseOrderStatus)}
                  </span>
                  <span className="font-medium text-stone-800">{count}</span>
                </li>
              ))}
            </ul>
          )}

          {vendor.performance && (
            <div className="mt-4 border-t border-stone-100 pt-3">
              <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-stone-500">
                <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Recorded performance
              </h3>
              <dl className="mt-2 space-y-1 text-xs text-stone-600">
                <div className="flex justify-between">
                  <dt>On-time delivery</dt>
                  <dd className="font-medium text-stone-800">
                    {vendor.performance.onTimeDelivery.toFixed(1)}%
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Quality rating</dt>
                  <dd className="font-medium text-stone-800">
                    {vendor.performance.qualityRating.toFixed(1)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>Responsiveness</dt>
                  <dd className="font-medium text-stone-800">
                    {vendor.performance.responsiveness.toFixed(1)}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold text-stone-800">Invoices in review</h2>
          {dashboard.openInvoices.length === 0 ? (
            <p className="mt-3 text-sm text-stone-500">No invoices awaiting review.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {dashboard.openInvoices.map((invoice) => (
                <li key={invoice.id}>
                  <button
                    onClick={() => navigate(`/purchase-orders/${invoice.po.id}`)}
                    className="w-full rounded-lg border border-stone-200 p-3 text-left transition-all duration-150 hover:border-stone-300"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-stone-800">
                        {invoice.invoiceNumber}
                      </span>
                      <span className="text-sm font-semibold text-stone-900">
                        {formatAmount(invoice.totalAmount)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className={invoiceStatusClass(invoice.status)}>
                        {invoiceStatusLabel(invoice.status)}
                      </span>
                      <span className="text-xs text-stone-400">{invoice.po.poNumber}</span>
                    </div>
                    {invoice.discrepancyCount > 0 && (
                      <p className="mt-1 text-xs text-amber-700">
                        {invoice.discrepancyCount} discrepanc
                        {invoice.discrepancyCount === 1 ? 'y' : 'ies'} raised
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <div className="border-b border-stone-100 p-4">
          <h2 className="text-sm font-semibold text-stone-800">All orders</h2>
        </div>
        {orders.length === 0 ? (
          <p className="p-8 text-center text-sm text-stone-500">
            No purchase orders have been issued to you yet.
          </p>
        ) : (
          <div className="divide-y divide-stone-100">
            {orders.map((order) => (
              <button
                key={order.id}
                onClick={() => navigate(`/purchase-orders/${order.id}`)}
                className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-stone-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-stone-900">{order.poNumber}</span>
                    <span className={poStatusClass(order.status)}>
                      {poStatusLabel(order.status)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-stone-500">
                    {order.quantity}
                    {order.unit ? ` ${order.unit}` : ''} × {order.itemName}
                    {order.expectedDeliveryDate
                      ? ` · due ${formatDate(order.expectedDeliveryDate)}`
                      : ''}
                  </p>
                </div>
                <span className="text-sm font-semibold text-stone-900">
                  {formatAmount(order.totalAmount, order.currency)}
                </span>
                <ChevronRight className="h-4 w-4 flex-shrink-0 text-stone-300" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

const Tile: React.FC<{
  icon: React.ElementType;
  label: string;
  value: string;
  hint: string;
  emphasis?: boolean;
}> = ({ icon: Icon, label, value, hint, emphasis }) => (
  <div className={`card p-4 ${emphasis ? 'border-amber-300 bg-amber-50/40' : ''}`}>
    <div className="flex items-center gap-1.5 text-xs text-stone-500">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </div>
    <p className="mt-1 text-2xl font-semibold text-stone-900">{value}</p>
    <p className="mt-0.5 text-xs text-stone-400">{hint}</p>
  </div>
);

export default SellerDashboardPage;