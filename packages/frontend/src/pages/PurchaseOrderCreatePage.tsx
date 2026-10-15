import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck, Loader2, AlertTriangle, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { dealsApi, purchaseOrderApi } from '../services/api';
import type { Deal } from '../types';
import { formatAmount } from '../utils/purchaseOrder';

interface AcceptedOffer {
  quantity: number;
  unitPrice: number;
  freightAmount?: number;
  installationAmount?: number;
  taxRate?: number;
  otherCharges?: number;
  currency?: string;
  deliveryDays?: number | null;
  paymentTerms?: string | null;
  warrantyMonths?: number | null;
}

const Field: React.FC<{
  label: string;
  hint?: string;
  children: React.ReactNode;
  required?: boolean;
}> = ({ label, hint, children, required }) => (
  <label className="block">
    <span className="text-sm font-medium text-stone-700">
      {label}
      {required && <span className="ml-0.5 text-red-500">*</span>}
    </span>
    {children}
    {hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
  </label>
);

const inputClass =
  'mt-1 block w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

export const PurchaseOrderCreatePage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const dealId = searchParams.get('dealId');

  const [offer, setOffer] = useState<AcceptedOffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [freightAmount, setFreightAmount] = useState('');
  const [installationAmount, setInstallationAmount] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [warrantyMonths, setWarrantyMonths] = useState('');
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    if (!dealId) {
      setError('No deal was supplied. Open this page from a confirmed deal.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await dealsApi.getDeal(dealId);
      const created = response.data.data as
        | (Deal & { acceptedOffer?: AcceptedOffer | null })
        | undefined;
      const accepted = created?.acceptedOffer ?? null;
      if (!accepted) {
        setError('This deal has no accepted offer, so it cannot become a purchase order yet.');
        return;
      }
      setOffer(accepted);
      setQuantity(String(accepted.quantity ?? ''));
      setUnitPrice(String(accepted.unitPrice ?? ''));
      setFreightAmount(String(accepted.freightAmount ?? 0));
      setInstallationAmount(String(accepted.installationAmount ?? 0));
      setTaxRate(String(accepted.taxRate ?? 0));
      setPaymentTerms(accepted.paymentTerms ?? '');
      setWarrantyMonths(
        accepted.warrantyMonths != null ? String(accepted.warrantyMonths) : ''
      );
    } catch (err) {
      setError((err as Error).message || 'Could not load the accepted offer');
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    load();
  }, [load]);

  const num = (value: string) => (value.trim() === '' ? undefined : Number(value));
  const qty = Number(quantity) || 0;
  const price = Number(unitPrice) || 0;
  const tax = Number(taxRate) || 0;

  // Mirrors the backend total so the buyer sees the approval threshold before submitting.
  const subtotal = qty * price;
  const estimatedTotal =
    subtotal +
    (Number(freightAmount) || 0) +
    (Number(installationAmount) || 0) +
    (subtotal * tax) / 100;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dealId) return;
    setSaving(true);
    try {
      const response = await purchaseOrderApi.createFromDeal({
        dealId,
        deliveryAddress: deliveryAddress || undefined,
        expectedDeliveryDate: expectedDeliveryDate || undefined,
        paymentTerms: paymentTerms || undefined,
        warrantyMonths: num(warrantyMonths),
        notes: notes || undefined,
        overrides: {
          quantity: num(quantity),
          unitPrice: num(unitPrice),
          taxRate: num(taxRate),
          freightAmount: num(freightAmount),
          installationAmount: num(installationAmount),
        },
      });
      const createdPo = response.data.data;
      if (!createdPo) throw new Error('The server did not return the new purchase order.');
      toast.success(`Purchase order ${createdPo.poNumber} created`);
      navigate(`/purchase-orders/${createdPo.id}`);
    } catch (err) {
      toast.error((err as Error).message || 'Could not create the purchase order');
    } finally {
      setSaving(false);
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
      <div className="space-y-4">
        <button onClick={() => navigate('/deals')} className="btn btn-secondary btn-sm">
          <ArrowLeft className="h-4 w-4" />
          Back to deals
        </button>
        <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
          {error ?? 'Accepted offer unavailable'}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-5">
      <div>
        <button
          type="button"
          onClick={() => navigate('/deals')}
          className="btn btn-secondary btn-sm mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to deals
        </button>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-stone-900">
          <ClipboardCheck className="h-5 w-5 text-blue-600" aria-hidden="true" />
          Raise Purchase Order
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          The accepted offer is pre-filled below. A purchase order is a single-line snapshot, so
          later changes to the deal will not alter it.
        </p>
      </div>

      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold text-stone-800">Line and pricing</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantity" required>
            <input
              className={inputClass}
              type="number"
              min="0.0001"
              step="any"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
          <Field label="Unit price" required>
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              required
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
            />
          </Field>
          <Field label="Freight">
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={freightAmount}
              onChange={(e) => setFreightAmount(e.target.value)}
            />
          </Field>
          <Field label="Installation">
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={installationAmount}
              onChange={(e) => setInstallationAmount(e.target.value)}
            />
          </Field>
          <Field label="Tax rate (%)">
            <input
              className={inputClass}
              type="number"
              min="0"
              step="any"
              value={taxRate}
              onChange={(e) => setTaxRate(e.target.value)}
            />
          </Field>
        </div>

        <div className="rounded-lg bg-stone-50 p-3 text-sm">
          <div className="flex justify-between text-stone-600">
            <span>Estimated order total</span>
            <span className="font-semibold text-stone-900">
              {formatAmount(estimatedTotal, offer.currency ?? 'INR')}
            </span>
          </div>
          <p className="mt-1 text-xs text-stone-500">
            The server recomputes this from the accepted offer; this is a preview only.
          </p>
        </div>
      </section>

      <section className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold text-stone-800">Delivery and terms</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Expected delivery date"
            hint={
              offer.deliveryDays
                ? `The deal agreed roughly ${offer.deliveryDays} day(s) from issuance.`
                : undefined
            }
          >
            <input
              className={inputClass}
              type="date"
              value={expectedDeliveryDate}
              onChange={(e) => setExpectedDeliveryDate(e.target.value)}
            />
          </Field>
          <Field label="Warranty (months)">
            <input
              className={inputClass}
              type="number"
              min="0"
              step="1"
              value={warrantyMonths}
              onChange={(e) => setWarrantyMonths(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Delivery address">
          <textarea
            className={inputClass}
            rows={3}
            value={deliveryAddress}
            onChange={(e) => setDeliveryAddress(e.target.value)}
            placeholder="Site, street, city, state, PIN"
          />
        </Field>
        <Field label="Payment terms">
          <input
            className={inputClass}
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
            placeholder="e.g. 30 days from invoice"
          />
        </Field>
        <Field label="Notes for the supplier">
          <textarea
            className={inputClass}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </section>

      <div className="card flex items-start gap-2 border-blue-200 bg-blue-50/50 p-4 text-xs text-stone-600">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" aria-hidden="true" />
        <p>
          Creating the order starts it as a draft. It still has to be submitted for approval before
          the supplier sees it. Approval level is set automatically from the total
          {estimatedTotal >= 1_000_000
            ? ' and will require a company admin'
            : estimatedTotal >= 100_000
              ? ' and will require finance'
              : ' and needs only procurement'}
          .
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => navigate('/deals')}
          className="btn btn-secondary"
        >
          Cancel
        </button>
        <button type="submit" disabled={saving} className="btn btn-primary">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create draft order
        </button>
      </div>
    </form>
  );
};

export default PurchaseOrderCreatePage;
