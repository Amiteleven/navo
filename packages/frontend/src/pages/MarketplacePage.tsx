import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  MapPin,
  Package,
  Calendar,
  Handshake,
  AlertTriangle,
  Loader2,
  Info,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { communicationApi } from '../services/api';
import { Button } from '../components/ui/Button';
import {
  MarketRequirement,
  InterestStatus,
  InteractionBasis,
} from '../types';
import { format, formatDistanceToNow, isPast } from 'date-fns';
import toast from 'react-hot-toast';

/**
 * Seller-facing open market.
 *
 * The page deliberately renders only what the API returns. There is no "budget"
 * column or hidden detail expansion, because the server projection never selects
 * those fields - the buyer's confidential data is absent from the response, not
 * merely hidden in the markup.
 */

const BASIS_EXPLANATION: Record<InteractionBasis, string> = {
  NONE: 'Send a quotation or wait for a buyer invitation before you can message this buyer.',
  MARKETPLACE_INTEREST: 'You expressed interest in this buyer\'s requirement, so you can message them.',
  BUYER_INVITED: 'This buyer invited you, so you can message them.',
  CONNECTION_ACCEPTED: 'You have an accepted connection with this buyer.',
  ACTIVE_DEAL: 'You have an active deal with this buyer.',
};

interface RequestCardProps {
  requirement: MarketRequirement;
  interestStatus: InterestStatus | null;
  onExpress: (id: string) => void;
  onWithdraw: (id: string) => void;
  busy: boolean;
}

const RequestCard: React.FC<RequestCardProps> = ({
  requirement,
  interestStatus,
  onExpress,
  onWithdraw,
  busy,
}) => {
  const deadline = requirement.quotationDeadline ? new Date(requirement.quotationDeadline) : null;
  const closingSoon =
    deadline && !isPast(deadline) && deadline.getTime() - Date.now() < 24 * 60 * 60 * 1000;

  return (
    <article className="card p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-stone-900 truncate">{requirement.title}</h3>
          <p className="text-xs text-stone-500 mt-0.5">{requirement.item}</p>
        </div>
        {requirement.category && (
          <span className="badge shrink-0">{requirement.category.name}</span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-stone-600">
        <div className="flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" aria-hidden="true" />
          <dt className="sr-only">Quantity</dt>
          <dd className="truncate">
            {requirement.quantity} {requirement.unit}
          </dd>
        </div>
        {requirement.location && (
          <div className="flex items-center gap-1.5 min-w-0">
            <MapPin className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" aria-hidden="true" />
            <dt className="sr-only">Delivery location</dt>
            <dd className="truncate">{requirement.location}</dd>
          </div>
        )}
        {requirement.requiredDate && (
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 text-stone-400 flex-shrink-0" aria-hidden="true" />
            <dt className="sr-only">Required by</dt>
            <dd className="truncate">By {format(new Date(requirement.requiredDate), 'd MMM yyyy')}</dd>
          </div>
        )}
        {deadline && (
          <div
            className={`flex items-center gap-1.5 ${closingSoon ? 'text-amber-700' : ''}`}
          >
            <Clock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <dt className="sr-only">Quotation deadline</dt>
            <dd className="truncate">
              Quotes {closingSoon ? 'close' : 'due'} {format(deadline, 'd MMM')}
            </dd>
          </div>
        )}
      </dl>

      <p className="text-[11px] text-stone-400 flex items-center gap-1.5">
        <Info className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        Published {formatDistanceToNow(new Date(requirement.createdAt), { addSuffix: true })}.
        Budget and buyer details are not shared at this stage.
      </p>

      <div className="mt-auto pt-1">
        {interestStatus ? (
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Interest recorded
            </span>
            <Button
              size="sm"
              variant="ghost"
              loading={busy}
              onClick={() => onWithdraw(requirement.id)}
            >
              Withdraw
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            loading={busy}
            onClick={() => onExpress(requirement.id)}
            className="w-full"
          >
            <Handshake className="h-3.5 w-3.5" aria-hidden="true" />
            Express interest
          </Button>
        )}
      </div>
    </article>
  );
};

export const MarketplacePage: React.FC = () => {
  const navigate = useNavigate();
  const [requirements, setRequirements] = useState<MarketRequirement[]>([]);
  const [interests, setInterests] = useState<Record<string, InterestStatus>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [market, submissions] = await Promise.all([
        communicationApi.browseMarket({
          search: search || undefined,
          location: location || undefined,
          limit: 30,
        }),
        communicationApi.mySubmissions(),
      ]);

      const rows = market.data.data ?? [];
      setRequirements(rows);

      // Submission status is a separate call because the list projection omits
      // per-seller state; deriving it from the detail endpoint would mean N
      // requests for something already known in one.
      const map: Record<string, InterestStatus> = {};
      for (const submission of submissions.data.data ?? []) {
        map[submission.request.id] = submission.status;
      }
      setInterests(map);
    } catch (err: any) {
      const message =
        err?.response?.data?.error ?? 'Could not load the open market';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [search, location]);

  useEffect(() => {
    const timer = setTimeout(load, 300);
    return () => clearTimeout(timer);
  }, [load]);

  const express = async (requestId: string) => {
    setBusyId(requestId);
    try {
      await communicationApi.expressInterest(requestId);
      setInterests((prev) => ({ ...prev, [requestId]: InterestStatus.EXPRESSED }));
      toast.success('Interest recorded. The buyer can now message you.');
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Could not record your interest');
    } finally {
      setBusyId(null);
    }
  };

  const withdraw = async (requestId: string) => {
    setBusyId(requestId);
    try {
      await communicationApi.withdrawInterest(requestId);
      setInterests((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
      toast.success('Interest withdrawn. The buyer can no longer message you.');
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Could not withdraw your interest');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5 animate-fade-in">
      <header>
        <h1 className="text-xl font-semibold text-stone-900">Open market</h1>
        <p className="text-sm text-stone-500 mt-1">
          Published requirements from buyers. Express interest to open a line of contact.
        </p>
      </header>

      <div className="card p-4 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, item or specification"
            aria-label="Search requirements"
            className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="relative sm:w-56">
          <MapPin
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400"
            aria-hidden="true"
          />
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location"
            aria-label="Filter by location"
            className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading requirements
        </div>
      ) : error ? (
        <div className="card p-10 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto mb-3" aria-hidden="true" />
          <p className="text-sm font-medium text-stone-800">{error}</p>
          <p className="text-xs text-stone-500 mt-1">
            Requirements are only visible to approved, active suppliers.
          </p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={load}>
            Try again
          </Button>
        </div>
      ) : requirements.length === 0 ? (
        <div className="card p-12 text-center">
          <Package className="h-10 w-10 text-stone-300 mx-auto mb-3" aria-hidden="true" />
          <p className="text-stone-600 font-medium">No open requirements match your search</p>
          <p className="text-sm text-stone-400 mt-1">
            New requirements appear here as buyers publish them.
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-stone-500">
            {requirements.length} open requirement{requirements.length === 1 ? '' : 's'}
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {requirements.map((requirement) => (
              <RequestCard
                key={requirement.id}
                requirement={requirement}
                interestStatus={interests[requirement.id] ?? null}
                onExpress={express}
                onWithdraw={withdraw}
                busy={busyId === requirement.id}
              />
            ))}
          </div>
        </>
      )}

      <section className="card p-5">
        <h2 className="text-sm font-semibold text-stone-900">How contact works</h2>
        <p className="text-xs text-stone-500 mt-1.5">
          Buyers cannot be messaged cold. A conversation opens only after you express
          interest in one of their requirements, they invite you, or you already share an
          accepted connection or active deal.
        </p>
        <ul className="mt-3 space-y-1.5">
          {(Object.keys(BASIS_EXPLANATION) as InteractionBasis[]).map((basis) => (
            <li key={basis} className="text-xs text-stone-600 flex items-start gap-2">
              <span
                className={`mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                  basis === 'NONE' ? 'bg-stone-300' : 'bg-emerald-500'
                }`}
                aria-hidden="true"
              />
              {BASIS_EXPLANATION[basis]}
            </li>
          ))}
        </ul>
        <Button
          variant="ghost"
          size="sm"
          className="mt-3"
          onClick={() => navigate('/deals')}
        >
          Go to Live Deals
        </Button>
      </section>
    </div>
  );
};
