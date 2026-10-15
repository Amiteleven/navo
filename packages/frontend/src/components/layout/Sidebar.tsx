import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Zap,
  Settings,
  ChevronRight,
  ClipboardCheck,
  Bot,
  Store,
  Package,
  ShieldCheck,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { UserRole } from '../../types';


const ADMIN_ROLES = [
  UserRole.PROCUREMENT_MANAGER,
  UserRole.COMPANY_ADMIN,
  UserRole.PLATFORM_ADMIN,
];

/** Only a supplier account can browse the open market; the API refuses others. */
const SELLER_ROLES = [UserRole.VENDOR];

/** Roles that can view approval inboxes. */
const APPROVAL_ROLES = [
  UserRole.FINANCE_APPROVER,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.COMPANY_ADMIN,
  UserRole.PLATFORM_ADMIN,
  UserRole.REQUESTER,
];

/**
 * `label`/`vendorLabel` let a supplier see their own vocabulary for the same route
 * without a separate navigation tree.
 */
const navigation = [
  { name: 'NAVO Chat',           vendorName: 'Home',           href: '/',                    icon: Bot,            roles: [] },
  { name: 'Purchase Approvals',  vendorName: '—',              href: '/approvals',           icon: ClipboardCheck, roles: APPROVAL_ROLES },
  { name: 'Requirement Approvals', vendorName: '—',            href: '/approvals/requirements', icon: ShieldCheck,   roles: APPROVAL_ROLES },
  { name: 'Open Market',         vendorName: 'Open Market',    href: '/market',              icon: Store,          roles: SELLER_ROLES },
  { name: 'Workspace',           vendorName: 'Workspace',      href: '/deals',               icon: Zap,            roles: [] },
  { name: 'Execution',           vendorName: 'My Orders',      href: '/purchase-orders',     icon: Package,        roles: [] },
  { name: 'Settings',            vendorName: 'Settings',       href: '/settings',            icon: Settings,       roles: ADMIN_ROLES },
  { name: 'Vendor Intelligence', vendorName: '—',              href: '/vendor-intelligence', icon: BarChart3,  roles: ADMIN_ROLES },
];

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isCollapsed, onToggle }) => {
  const location = useLocation();
  const { user, hasRole } = useAuth();
  const isVendor = Boolean(user && hasRole([UserRole.VENDOR]));

  const filteredNav = navigation.filter(
    (item) => item.roles.length === 0 || (user && hasRole(item.roles))
  );

  return (
    <aside
      className={`fixed left-0 top-0 z-40 h-full bg-white border-r border-stone-200 transition-all duration-200 flex flex-col ${isCollapsed ? 'w-[60px]' : 'w-56'}`}
      aria-label="Sidebar navigation"
    >
      {/* Logo */}
      <div className={`flex items-center h-14 border-b border-stone-200 px-3 ${isCollapsed ? 'justify-center' : 'gap-2.5'}`}>
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600">
          <span className="text-white font-bold text-sm tracking-tight">N</span>
        </div>
        {!isCollapsed && (
          <div>
            <span className="font-semibold text-stone-900 text-sm">NAVO</span>
            <p className="text-[10px] text-stone-400 leading-none mt-0.5">Procurement</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5" aria-label="Main navigation">
        {filteredNav.map((item) => {
          const label = isVendor ? item.vendorName : item.name;
          const isActive =
            location.pathname === item.href ||
            (item.href !== '/' && location.pathname.startsWith(item.href));
          return (
            <NavLink
              key={item.name}
              to={item.href}
              className={() =>
                `flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                  isActive
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
                } ${isCollapsed ? 'justify-center' : ''}`
              }
              title={isCollapsed ? label : undefined}
              aria-current={isActive ? 'page' : undefined}
            >
              <item.icon className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" />
              {!isCollapsed && <span>{label}</span>}
            </NavLink>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div className="p-2 border-t border-stone-100">
        <button
          onClick={onToggle}
          className={`w-full flex items-center gap-2 px-2.5 py-2 text-xs text-stone-400 hover:text-stone-600 hover:bg-stone-50 rounded-lg transition-colors ${isCollapsed ? 'justify-center' : ''}`}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronRight className={`h-4 w-4 flex-shrink-0 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-180'}`} />
          {!isCollapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
};