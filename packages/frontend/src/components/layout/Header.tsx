import React, { useState } from 'react';
import { LogOut, Menu, ChevronDown, ClipboardCheck, Bot } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';
import { CopilotContextType, UserRole } from '../../types';
import { NotificationBell } from '../notifications/NotificationBell';

interface HeaderProps {
  onMenuClick: () => void;
  sidebarWidth: number;
}

/**
 * Record detail routes the copilot can be anchored to. Opening Navo from one of
 * these starts the thread about that record, so "what about delivery?" resolves
 * without the user restating the id.
 */
const CONTEXT_ROUTES: Array<{ pattern: RegExp; entityType: CopilotContextType }> = [
  { pattern: /^\/requests\/([^/]+)$/, entityType: 'REQUEST' },
  { pattern: /^\/purchase-orders\/([^/]+)$/, entityType: 'PURCHASE_ORDER' },
  { pattern: /^\/vendors\/([^/]+)$/, entityType: 'VENDOR' },
  { pattern: /^\/deals\/([^/]+)$/, entityType: 'DEAL' },
  { pattern: /^\/rfqs\/([^/]+)$/, entityType: 'RFQ' },
];

export const Header: React.FC<HeaderProps> = ({ onMenuClick, sidebarWidth }) => {
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const initials = user
    ? `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase() || 'U'
    : 'U';

  const roleLabel: Record<string, string> = {
    PLATFORM_ADMIN: 'Platform Admin',
    COMPANY_ADMIN: 'Admin',
    PROCUREMENT_MANAGER: 'Procurement',
    FINANCE_APPROVER: 'Finance',
    REQUESTER: 'Buyer',
    VIEWER: 'Viewer',
    VENDOR: 'Supplier',
  };

  const isVendor = Boolean(user && hasRole([UserRole.VENDOR]));
  const showOrdersShortcut = location.pathname !== '/purchase-orders';

  const openCopilot = () => {
    const route = CONTEXT_ROUTES.find((entry) => entry.pattern.test(location.pathname));
    const match = route?.pattern.exec(location.pathname);
    const entityId = match?.[1];
    const query =
      route && entityId
        ? `?entityType=${route.entityType}&entityId=${encodeURIComponent(entityId)}`
        : '';
    navigate(`/copilot${query}`);
  };

  return (
    <header
      className="fixed top-0 right-0 z-30 h-14 bg-white border-b border-stone-200 flex items-center justify-between px-5 transition-all duration-200"
      style={{ left: sidebarWidth }}
      role="banner"
    >
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors lg:hidden"
          aria-label="Toggle menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={openCopilot}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
        >
          <Bot className="h-4 w-4" aria-hidden="true" />
          Ask Navo
        </button>

        {showOrdersShortcut && (
          <button
            onClick={() => navigate('/purchase-orders')}
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 sm:flex"
          >
            <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
            {isVendor ? 'My Orders' : 'Purchase Orders'}
          </button>
        )}

        {/* Notifications */}
        <NotificationBell />

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-stone-100 rounded-lg transition-colors"
            aria-expanded={showUserMenu}
          >
            <div className="h-7 w-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-semibold text-white">{initials}</span>
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-stone-800 leading-none">
                {user?.firstName || 'User'}
              </p>
              <p className="text-xs text-stone-400 mt-0.5">
                {user?.role ? roleLabel[user.role] || user.role : ''}
              </p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 text-stone-400 hidden sm:block" />
          </button>

          {showUserMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowUserMenu(false)} />
              <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-stone-200 rounded-xl shadow-lg z-20 py-1 animate-fade-in">
                <div className="px-3 py-2.5 border-b border-stone-100">
                  <p className="text-sm font-medium text-stone-900">{user?.firstName} {user?.lastName}</p>
                  <p className="text-xs text-stone-500 mt-0.5 truncate">{user?.email}</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-stone-600 hover:bg-stone-50 transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
};