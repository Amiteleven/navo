import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Loader2, CheckCheck } from 'lucide-react';
import { notificationApi } from '../../services/api';
import { NotificationItem } from '../../types';
import { formatDistanceToNow } from 'date-fns';

/**
 * Header notification bell.
 *
 * Polls rather than subscribing: the backend has no realtime transport, and
 * inventing one here would mean a socket the rest of the app does not use. The
 * interval is deliberately slow, and the poll is paused while the tab is hidden
 * so a backgrounded tab is not the reason the server stays busy.
 *
 * Opening a notification marks it read and suppresses its queued email, which is
 * what stops a user who has already read something in NAVO from receiving a
 * digest about it later.
 */

const POLL_MS = 60_000;
const PREVIEW_COUNT = 8;

export const NotificationBell: React.FC = () => {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchLatest = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setIsLoading(true);
    try {
      const res = await notificationApi.list();
      setItems(res.data.data?.slice(0, PREVIEW_COUNT) ?? []);
      setUnread(res.data.meta?.unread ?? 0);
    } catch {
      // A failed poll must not surface an error: the badge simply keeps its
      // last known value rather than flashing an error on every interval.
    } finally {
      if (showSpinner) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLatest(false);
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void fetchLatest(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchLatest]);

  // Close on an outside click or Escape, so the popover is keyboard-reachable.
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    if (next) void fetchLatest(true);
  };

  const openItem = async (item: NotificationItem) => {
    setIsOpen(false);
    if (!item.isRead) {
      setUnread((count) => Math.max(0, count - 1));
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, isRead: true } : n)));
      try {
        await notificationApi.markRead(item.id);
      } catch {
        // Not worth interrupting navigation over.
      }
    }
    const path = item.data?.linkPath;
    if (typeof path === 'string' && path.startsWith('/')) navigate(path);
  };

  const markAllRead = async () => {
    const unreadItems = items.filter((item) => !item.isRead);
    setUnread(0);
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    // Best effort: each receipt is independent, and a partial failure only
    // leaves the item visually read until the next poll.
    await Promise.allSettled(unreadItems.map((item) => notificationApi.markRead(item.id)));
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={toggle}
        className="relative p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={isOpen}
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unread > 0 && (
          <>
            <span className="absolute top-1 right-1 h-2 w-2 bg-blue-500 rounded-full" />
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold flex items-center justify-center">
              {unread > 9 ? '9+' : unread}
            </span>
          </>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-stone-200 rounded-xl shadow-lg z-20 animate-fade-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100">
            <p className="text-sm font-medium text-stone-900">Notifications</p>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Mark all read
              </button>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-stone-500">
              Nothing to report yet.
            </p>
          ) : (
            <ul className="max-h-96 overflow-y-auto divide-y divide-stone-50">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => openItem(item)}
                    className={`w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors ${
                      item.isRead ? '' : 'bg-blue-50/40'
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      {!item.isRead && (
                        <span
                          className="mt-1.5 h-1.5 w-1.5 rounded-full bg-blue-600 flex-shrink-0"
                          aria-label="Unread"
                        />
                      )}
                      <div className="min-w-0">
                        <p
                          className={`text-xs ${
                            item.isRead ? 'text-stone-600' : 'font-medium text-stone-900'
                          }`}
                        >
                          {item.title}
                        </p>
                        <p className="text-[11px] text-stone-400 mt-0.5">
                          {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                        </p>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={() => {
              setIsOpen(false);
              navigate('/notifications');
            }}
            className="w-full px-4 py-2.5 text-center text-xs font-medium text-blue-600 hover:bg-stone-50 border-t border-stone-100"
          >
            View all notifications
          </button>
        </div>
      )}
    </div>
  );
};
