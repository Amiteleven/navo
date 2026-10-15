import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { MainLayout } from './components/layout/MainLayout';
import { AuthLayout } from './components/layout/AuthLayout';
import { NavoChatPage } from './pages/NavoChatPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { RequestsPage } from './pages/RequestsPage';
import { RequestDetailPage } from './pages/RequestDetailPage';
import { VendorsPage } from './pages/VendorsPage';
import { RFQsPage } from './pages/RFQsPage';
import { QuotesPage } from './pages/QuotesPage';
import { PurchaseApprovalsPage } from './pages/PurchaseApprovalsPage';
import { RequirementApprovalsPage } from './pages/RequirementApprovalsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { DealsPage } from './pages/DealsPage';
import { PurchaseHistoryPage } from './pages/PurchaseHistoryPage';
import { PurchaseOrdersPage } from './pages/PurchaseOrdersPage';
import { PurchaseOrderDetailPage } from './pages/PurchaseOrderDetailPage';
import { PurchaseOrderCreatePage } from './pages/PurchaseOrderCreatePage';
import { SellerDashboardPage } from './pages/SellerDashboardPage';
import { CopilotPage } from './pages/CopilotPage';
import { MarketplacePage } from './pages/MarketplacePage';
import { NotificationsPage } from './pages/NotificationsPage';
import { VendorIntelligencePage } from './pages/VendorIntelligencePage';
import { VendorOfferPage } from './pages/commercial-offers/VendorOfferPage';
import { BuyerCommercialPage } from './pages/commercial-offers/BuyerCommercialPage';
import { UserRole } from './types';
import { Loader2 } from 'lucide-react';

const ProtectedRoute: React.FC<{ children: React.ReactNode; allowedRoles?: UserRole[] }> = ({
  children,
  allowedRoles,
}) => {
  const { isAuthenticated, isLoading, user, hasRole } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (allowedRoles && user && !hasRole(allowedRoles)) return <Navigate to="/" replace />;

  return <>{children}</>;
};

const PublicRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (isAuthenticated) return <Navigate to="/" replace />;
  return <>{children}</>;
};

/** Roles allowed to raise a purchase order. Suppliers never create orders. */
const BUYER_ROLES = [
  UserRole.REQUESTER,
  UserRole.PROCUREMENT_MANAGER,
  UserRole.FINANCE_APPROVER,
  UserRole.COMPANY_ADMIN,
  UserRole.PLATFORM_ADMIN,
];

/**
 * Suppliers land on their dashboard instead of the buyer's order book, so a vendor
 * never has to learn a buyer-only layout just to confirm an order.
 */
const PurchaseOrdersRoute: React.FC = () => {
  const { user, hasRole } = useAuth();
  if (user && hasRole([UserRole.VENDOR])) return <SellerDashboardPage />;
  return <PurchaseOrdersPage />;
};

const App: React.FC = () => {
  return (
    <Routes>
      {/* Public */}
      <Route element={<AuthLayout />}>
        <Route path="/login"    element={<PublicRoute><LoginPage /></PublicRoute>} />
        <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />
      </Route>

      {/* Protected */}
      <Route element={<MainLayout />}>
        <Route path="/" element={<ProtectedRoute><NavoChatPage /></ProtectedRoute>} />

        {/* Every role may ask; the backend limits which records each one can read. */}
        <Route path="/copilot" element={<ProtectedRoute><CopilotPage /></ProtectedRoute>} />

        <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />

        {/* Suppliers browse the open market; buyers manage their own requirements. */}
        <Route path="/market" element={
          <ProtectedRoute allowedRoles={[UserRole.VENDOR]}>
            <MarketplacePage />
          </ProtectedRoute>
        } />

        <Route path="/requests"     element={<ProtectedRoute><RequestsPage /></ProtectedRoute>} />
        <Route path="/requests/:requestId" element={<ProtectedRoute><RequestDetailPage /></ProtectedRoute>} />

        <Route path="/vendors" element={
          <ProtectedRoute allowedRoles={[UserRole.PROCUREMENT_MANAGER, UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN]}>
            <VendorsPage />
          </ProtectedRoute>
        } />

        <Route path="/deals"   element={<ProtectedRoute><DealsPage /></ProtectedRoute>} />
        <Route path="/deals/new" element={<ProtectedRoute><DealsPage /></ProtectedRoute>} />

        <Route path="/history" element={<ProtectedRoute><PurchaseHistoryPage /></ProtectedRoute>} />

        <Route path="/purchase-orders" element={<ProtectedRoute><PurchaseOrdersRoute /></ProtectedRoute>} />
        <Route path="/purchase-orders/new" element={
          <ProtectedRoute allowedRoles={BUYER_ROLES}>
            <PurchaseOrderCreatePage />
          </ProtectedRoute>
        } />
        <Route path="/purchase-orders/:poId" element={<ProtectedRoute><PurchaseOrderDetailPage /></ProtectedRoute>} />

        <Route path="/rfqs"    element={
          <ProtectedRoute allowedRoles={[UserRole.PROCUREMENT_MANAGER, UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN]}>
            <RFQsPage />
          </ProtectedRoute>
        } />
        <Route path="/quotes"  element={
          <ProtectedRoute allowedRoles={[UserRole.PROCUREMENT_MANAGER, UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN]}>
            <QuotesPage />
          </ProtectedRoute>
        } />
        <Route path="/approvals" element={
          <ProtectedRoute allowedRoles={[UserRole.FINANCE_APPROVER, UserRole.PROCUREMENT_MANAGER, UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN, UserRole.REQUESTER]}>
            <PurchaseApprovalsPage />
          </ProtectedRoute>
        } />
        <Route path="/approvals/requirements" element={
          <ProtectedRoute allowedRoles={[UserRole.FINANCE_APPROVER, UserRole.PROCUREMENT_MANAGER, UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN, UserRole.REQUESTER]}>
            <RequirementApprovalsPage />
          </ProtectedRoute>
        } />
        <Route path="/reports" element={
          <ProtectedRoute allowedRoles={[UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN]}>
            <ReportsPage />
          </ProtectedRoute>
        } />
        <Route path="/settings" element={
          <ProtectedRoute allowedRoles={[UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN]}>
            <SettingsPage />
          </ProtectedRoute>
        } />

        <Route path="/vendor-intelligence" element={
          <ProtectedRoute allowedRoles={[UserRole.PROCUREMENT_MANAGER, UserRole.COMPANY_ADMIN, UserRole.PLATFORM_ADMIN]}>
            <VendorIntelligencePage />
          </ProtectedRoute>
        } />

        <Route path="/commercial-offers/assignment/:vendorAssignmentId" element={
          <ProtectedRoute allowedRoles={[UserRole.VENDOR]}>
            <VendorOfferPage />
          </ProtectedRoute>
        } />

        <Route path="/requests/:requestId/commercial" element={
          <ProtectedRoute allowedRoles={BUYER_ROLES}>
            <BuyerCommercialPage />
          </ProtectedRoute>
        } />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default App;