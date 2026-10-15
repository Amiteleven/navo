import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  Loader2,
  AlertTriangle,
  Inbox,
  ShieldAlert,
} from 'lucide-react';
import { notificationApi, communicationApi } from '../services/api';
import { Button } from '../components/ui/Button';
import {
  NotificationItem,
  NotificationFrequency,
  ContactRestriction,
} from '../types';
import { format, formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';

/**
 * Notification inbox, moderation queue, and delivery preferences.
 *
 * Moderation controls are buyer-side and live here because a supplier is blocked
 * per buyer, not platform-wide: the buyer is the one who has to recognise the
 * behaviour and act on it.
 */

/**
 * Events a user can tune, with the plain-language description shown next to the
 * control. The list mirrors the server's `NotificationEvent` set; an event with
 * no stored preference falls back to the server default, so the initial render
 * shows the effective setting rather than a misleading blank.
 */
const EVENT_LABELS: Record<string, { label: string; hint: string; defaultFrequency: NotificationFrequency }> = {
  MARKETPLACE_INTEREST: {
    label: 'Supplier interest',
    hint: 'A supplier expressed interest in one of your requirements.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
  CONNECTION_REQUEST: {
    label: 'Connection requests',
    hint: 'A buyer asked to connect with you.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
  NEGOTIATION_MESSAGE: {
    label: 'Negotiation messages',
    hint: 'New messages inside a deal room.',
    defaultFrequency: NotificationFrequency.DIGEST,
  },
  COUNTEROFFER: {
    label: 'Counteroffers',
    hint: 'The other side countered an offer.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
  OFFER_ACCEPTED: {
    label: 'Accepted offers',
    hint: 'An offer was accepted.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
  DEAL_CLOSED: {
    label: 'Closed deals',
    hint: 'A deal reached a closed state.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
  QUOTE_RESPONSE: {
    label: 'Quotation activity',
    hint: 'A quotation was submitted or updated.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
  AVAILABILITY_CHANGE: {
    label: 'Availability changes',
    hint: 'A supplier changed their availability.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
  VENDOR_FEEDBACK: {
    label: 'Supplier feedback',
    hint: 'Feedback was left about your company.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
  REQUIREMENT_PUBLISHED: {
    label: 'Publication results',
    hint: 'A requirement you own was published or withdrawn.',
    defaultFrequency: NotificationFrequency.IMMEDIATE,
  },
};

const FREQUENCY_OPTIONS: Array<{ value: NotificationFrequency; label: string }> = [
  { value: NotificationFrequency.IMMEDIATE, label: 'Each one' },
  { value: NotificationFrequency.DIGEST, label: 'Daily digest' },
  { value: NotificationFrequency.OFF, label: 'Off' },
];

const ReportSection: React.FC = () => {
  const [restrictions, setRestrictions] = useState<ContactRestriction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await communicationApi.listRestrictions();
      setRestrictions(res.data.data ?? []);
    } catch {
      toast.error('Could not load your restriction list');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = async (vendorId: string) => {
    try {
      await communicationApi.clearRestriction(vendorId);
      setRestrictions((prev) => prev.filter((r) => r.vendorId !== vendorId));
      toast.success('Restriction lifted');
    } catch {
      toast.error('Could not lift that restriction');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading restrictions
      </div>
    );
  }

  if (restrictions.length === 0) {
    return <p className="py-4 text-sm text-stone-500">You have not blocked or muted any supplier.</p>;
  }

  return (
    <ul className="divide-y divide-stone-100">
      {restrictions.map((restriction) => (
        <li key={restriction.id} className="flex items-start justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-stone-900">
              {restriction.vendor?.name ?? restriction.vendorId}
              <span
                className={`badge ml-2 ${
                  restriction.kind === 'BLOCK' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
                }`}
              >
                {restriction.kind === 'BLOCK' ? 'Blocked' : 'Muted'}
              </span>
            </p>
            {restriction.reason && (
              <p className="text-xs text-stone-500 mt-0.5">{restriction.reason}</p>
            )}
            {restriction.kind === 'MUTE' && restriction.expiresAt && (
              <p className="text-xs text-stone-400 mt-0.5">
                Lifts on {format(new Date(restriction.expiresAt), 'd MMM yyyy')}
              </p>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={() => clear(restriction.vendorId)}>
            Lift
          </Button>
        </li>
      ))}
    </ul>
  );
};

const PreferencesSection: React.FC = () => {
  const [prefs, setPrefs] = useState<Record<string, NotificationFrequency>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await notificationApi.listPreferences();
        const map: Record<string, NotificationFrequency> = {};
        for (const pref of res.data.data ?? []) {
          map[pref.eventType] = pref.frequency;
        }
        setPrefs(map);
      } catch {
        toast.error('Could not load your notification settings');
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Show the effective value: an explicit preference if stored, otherwise the
  // server's default for that event type.
  const effective = useMemo(
    () => (event: string) => prefs[event] ?? EVENT_LABELS[event]?.defaultFrequency ?? NotificationFrequency.IMMEDIATE,
    [prefs]
  );

  const update = async (event: string, frequency: NotificationFrequency) => {
    setSaving(event);
    const previous = prefs[event];
    setPrefs((prev) => ({ ...prev, [event]: frequency }));
    try {
      await notificationApi.setPreference(event, frequency);
    } catch {
      // Roll back so the control never claims a setting that was not stored.
      setPrefs((prev) => {
        const next = { ...prev };
        if (previous) next[event] = previous;
        else delete next[event];
        return next;
      });
      toast.error('Could not save that setting');
    } finally {
      setSaving(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading settings
      </div>
    );
  }

  return (
    <ul className="divide-y divide-stone-100">
      {Object.entries(EVENT_LABELS).map(([event, meta]) => (
        <li key={event} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-stone-900">{meta.label}</p>
            <p className="text-xs text-stone-500 mt-0.5">{meta.hint}</p>
          </div>
          <div
            className="inline-flex rounded-lg border border-stone-200 p-0.5 self-start sm:self-auto"
            role="group"
            aria-label={`Email frequency for ${meta.label}`}
          >
            {FREQUENCY_OPTIONS.map((option) => {
              const active = effective(event) === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={saving === event}
                  aria-pressed={active}
                  onClick={() => update(event, option.value)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
};

export const NotificationsPage: React.FC = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await notificationApi.list();
      setItems(res.data.data ?? []);
      setUnread(res.data.meta?.unread ?? 0);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Could not load notifications');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (item: NotificationItem) => {
    if (!item.isRead) {
      // Mark read first so the badge does not lag behind navigation.
      setItems((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n))
      );
      setUnread((count) => Math.max(0, count - 1));
      try {
        await notificationApi.markRead(item.id);
      } catch {
        // A failed read receipt is not worth interrupting the user over.
      }
    }
    const path = item.data?.linkPath;
    if (typeof path === 'string' && path.startsWith('/')) {
      navigate(path);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5 animate-fade-in">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">Notifications</h1>
          <p className="text-sm text-stone-500 mt-1">
            {unread > 0 ? `${unread} unread` : 'You are all caught up'}
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={load}>
          Refresh
        </Button>
      </header>

      <section className="card overflow-hidden">
        <h2 className="sr-only">Inbox</h2>
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading notifications
          </div>
        ) : error ? (
          <div className="p-10 text-center">
            <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto mb-3" aria-hidden="true" />
            <p className="text-sm font-medium text-stone-800">{error}</p>
            <Button variant="secondary" size="sm" className="mt-4" onClick={load}>
              Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center">
            <Inbox className="h-10 w-10 text-stone-300 mx-auto mb-3" aria-hidden="true" />
            <p className="text-stone-600 font-medium">Nothing here yet</p>
            <p className="text-sm text-stone-400 mt-1">
              Activity on your requests, deals and suppliers will appear here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-stone-100">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  onClick={() => open(item)}
                  className={`w-full text-left px-5 py-3.5 hover:bg-stone-50 transition-colors ${
                    item.isRead ? '' : 'bg-blue-50/40'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {!item.isRead && (
                      <span
                        className="mt-1.5 h-2 w-2 rounded-full bg-blue-600 flex-shrink-0"
                        aria-label="Unread"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-sm ${
                          item.isRead ? 'text-stone-600' : 'font-medium text-stone-900'
                        }`}
                      >
                        {item.title}
                      </p>
                      {item.message && item.message !== item.title && (
                        <p className="text-xs text-stone-500 mt-0.5">{item.message}</p>
                      )}
                      <p className="text-[11px] text-stone-400 mt-1">
                        {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-stone-100">
          <h2 className="text-sm font-semibold text-stone-900 flex items-center gap-2">
            <Bell className="h-4 w-4 text-stone-400" aria-hidden="true" />
            Email delivery
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Emails never contain prices, quantities or documents. They link back here so you
            sign in to see the detail.
          </p>
        </div>
        <div className="px-5 py-1">
          <PreferencesSection />
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-stone-100">
          <h2 className="text-sm font-semibold text-stone-900 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-stone-400" aria-hidden="true" />
            Supplier restrictions
          </h2>
          <p className="text-xs text-stone-500 mt-1">
            Blocking stops a supplier messaging you and hides their open-market submissions.
            Muting hides them without notifying them.
          </p>
        </div>
        <div className="px-5 py-1">
          <ReportSection />
        </div>
      </section>
    </div>
  );
};
