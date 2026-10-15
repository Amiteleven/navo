import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { 
  ApiResponse, AuthTokens, LoginCredentials, RegisterData,
  Tenant, Category, PaginatedResponse, ProcurementRequest,
  CreateRequestData, ExtractedRequirement, RequestStatus,
  Vendor, CreateVendorData, RFQ, CreateRFQData, RFQVendor,
  Quote, SubmitQuoteData, QuoteComparison, Approval,
  ApprovalStatus, Recommendation, AuditLog,
  Connection, DealRoom, DealRoomDetail, DealMessage, DealOffer, Deal,
  VendorAvailability, CreateConnectionInput, CreateOfferInput,
  NegotiationMessage,
  SavingsRecord,
  SavingsType,
  QuoteAnalysis,
  // Phase 5: purchase execution
  PurchaseOrderStatus,
  DeliveryEventType,
  InvoiceStatus,
  InvoiceMatchStatus,
  DiscrepancyResolution,
  PaymentStatus,
  DocumentCategory,
  Discrepancy,
  PurchaseOrderSummary,
  TransactionTimelineEntry,
  // Phase 6: copilot
  CopilotAskResult,
  CopilotContext,
  CopilotConversation,
  CopilotConversationSummary,
  CopilotDescribe,
  CopilotExecutedAction,
  // Marketplace and controlled communication
  MarketRequirement,
  MarketRequirementDetail,
  MarketplaceInterest,
  ContactRestriction,
  AbuseReport,
  InterestStatus,
  RestrictionKind,
  ReportReason,
  InteractionBasis,
  RequestVisibility,
  // Notifications
  NotificationItem,
  NotificationPreference,
  NotificationFrequency,
  RoomUnreadState,
  // Manager approval & purchase authorization
  PurchaseApprovalPolicy,
  PurchaseApprovalRequestDetail,
  ResolvedApprovalRoute,
  PurchaseApprovalStatus,
  ApprovalOverview,
  // Requirement Intake
  RequirementDraftDetail,
  CreateRequirementDraftInput,
  AnswerClarificationInput,
  ConfirmRequirementDraftInput,
  RequirementCategoryFields,
  RequirementIntakeListParams,
  PaginatedRequirementDrafts,
  // Requirement Approval
  RequirementApprovalRequestDetail,
   RequirementApprovalStatus,
   ResolvedRequirementRoute,
   // Vendor Intelligence
   VendorOnboardingStatus,
   VendorDuplicateConfidence,
   // Commercial Offers
   CommercialOffer,
   CommercialOfferDetail,
   CommercialOfferSubmission,
   OfferEvent,
   UpsertOfferDraftInput,
   SubmitOfferInput,
    OfferType,
    // Deal Execution
    ListDealExecutionsResponse,
    DealExecutionDetail,
    } from '../types';

const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

// Token management
let accessToken: string | null = null;
let refreshToken: string | null = null;

export const setTokens = (tokens: AuthTokens) => {
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
  localStorage.setItem('accessToken', tokens.accessToken);
  localStorage.setItem('refreshToken', tokens.refreshToken);
};

export const getAccessToken = () => accessToken || localStorage.getItem('accessToken');
export const getRefreshToken = () => refreshToken || localStorage.getItem('refreshToken');

export const clearTokens = () => {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
};

// Initialize tokens from localStorage
if (typeof window !== 'undefined') {
  accessToken = localStorage.getItem('accessToken');
  refreshToken = localStorage.getItem('refreshToken');
}

// Request interceptor
api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getAccessToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor for token refresh
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}> = [];

const processQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    
    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${token}`;
          }
          return api(originalRequest);
        }).catch((err) => {
          return Promise.reject(err);
        });
      }
      
      originalRequest._retry = true;
      isRefreshing = true;
      
      try {
        const refresh = getRefreshToken();
        if (!refresh) {
          throw new Error('No refresh token');
        }
        
        const response = await axios.post<ApiResponse<{ accessToken: string }>>(
          `${API_BASE_URL}/auth/refresh`,
          { refreshToken: refresh }
        );
        
        const newAccessToken = response.data.data?.accessToken;
        if (newAccessToken) {
          accessToken = newAccessToken;
          localStorage.setItem('accessToken', newAccessToken);
          processQueue(null, newAccessToken);
          
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
          }
          return api(originalRequest);
        }
        throw new Error('No access token in response');
      } catch (err) {
        processQueue(err, null);
        clearTokens();
        window.location.href = '/login';
        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }
    
    return Promise.reject(error);
  }
);

// Auth API
export const authApi = {
  login: (credentials: LoginCredentials) =>
    api.post<ApiResponse<AuthTokens>>('/auth/login', credentials),
  
  register: (data: RegisterData) =>
    api.post<ApiResponse<AuthTokens>>('/auth/register', data),
  
  refresh: (refreshToken: string) =>
    api.post<ApiResponse<{ accessToken: string }>>('/auth/refresh', { refreshToken }),
  
  logout: () =>
    api.post<ApiResponse<null>>('/auth/logout'),
  
  profile: () =>
    api.get<ApiResponse<{ userId: string; tenantId: string; email: string; role: string }>>('/auth/profile'),
  
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<ApiResponse<null>>('/auth/change-password', { currentPassword, newPassword }),
};

// Tenant API
export const tenantApi = {
  getCurrent: () =>
    api.get<ApiResponse<Tenant>>('/tenants/current'),
  
  getStats: () =>
    api.get<ApiResponse<{ users: number; vendors: number; requests: number; rfqs: number; quotes: number }>>('/tenants/current/stats'),
  
  update: (data: Partial<Tenant>) =>
    api.patch<ApiResponse<Tenant>>('/tenants/current', data),
};

// Categories API
export const categoryApi = {
  list: () =>
    api.get<ApiResponse<Category[]>>('/categories'),
  
  create: (data: { name: string; description?: string }) =>
    api.post<ApiResponse<Category>>('/categories', data),
  
  update: (id: string, data: { name?: string; description?: string }) =>
    api.patch<ApiResponse<Category>>(`/categories/${id}`, data),
  
  delete: (id: string) =>
    api.delete<ApiResponse<null>>(`/categories/${id}`),
};

// Requests API
export const requestApi = {
  list: (params?: {
    status?: string;
    requesterId?: string;
    assigneeId?: string;
    categoryId?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }) =>
    api.get<ApiResponse<PaginatedResponse<ProcurementRequest>>>('/requests', { params }),
  
  get: (id: string) =>
    api.get<ApiResponse<ProcurementRequest>>(`/requests/${id}`),
  
  create: (data: CreateRequestData) =>
    api.post<ApiResponse<ProcurementRequest>>('/requests', data),
  
  update: (id: string, data: Partial<CreateRequestData>) =>
    api.patch<ApiResponse<ProcurementRequest>>(`/requests/${id}`, data),
  
  submit: (id: string) =>
    api.post<ApiResponse<ProcurementRequest>>(`/requests/${id}/submit`),
  
  extract: (id: string) =>
    api.post<ApiResponse<{ request: ProcurementRequest; extractedReq: ExtractedRequirement }>>(`/requests/${id}/extract`),
  
  updateStatus: (id: string, status: RequestStatus) =>
    api.patch<ApiResponse<ProcurementRequest>>(`/requests/${id}/status`, { status }),
  
  delete: (id: string) =>
    api.delete<ApiResponse<null>>(`/requests/${id}`),
  
  getStats: () =>
    api.get<ApiResponse<Record<RequestStatus, number>>>('/requests/stats'),
};

// Vendors API
export const vendorApi = {
  list: (params?: {
    status?: string;
    categoryId?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<PaginatedResponse<Vendor>>>('/vendors', { params }),
  
  get: (id: string) =>
    api.get<ApiResponse<Vendor>>(`/vendors/${id}`),
  
  create: (data: CreateVendorData) =>
    api.post<ApiResponse<Vendor>>('/vendors', data),
  
  update: (id: string, data: Partial<CreateVendorData>) =>
    api.patch<ApiResponse<Vendor>>(`/vendors/${id}`, data),
  
  delete: (id: string) =>
    api.delete<ApiResponse<null>>(`/vendors/${id}`),
  
  search: (query: string) =>
    api.get<ApiResponse<Vendor[]>>('/vendors/search', { params: { q: query } }),
  
  byCategory: (categoryId: string) =>
    api.get<ApiResponse<Vendor[]>>(`/vendors/category/${categoryId}`),
};

// RFQs API
export const rfqApi = {
  list: (params?: {
    status?: string;
    requestId?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<PaginatedResponse<RFQ>>>('/rfqs', { params }),
  
  get: (id: string) =>
    api.get<ApiResponse<RFQ>>(`/rfqs/${id}`),
  
  create: (data: CreateRFQData) =>
    api.post<ApiResponse<RFQ>>('/rfqs', data),
  
  send: (id: string) =>
    api.post<ApiResponse<RFQ>>(`/rfqs/${id}/send`),
  
  close: (id: string) =>
    api.post<ApiResponse<RFQ>>(`/rfqs/${id}/close`),
  
  getVendors: (id: string) =>
    api.get<ApiResponse<RFQVendor[]>>(`/rfqs/${id}/vendors`),
};

// Quotes API
export const quoteApi = {
  list: (params?: {
    rfqId?: string;
    vendorId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<PaginatedResponse<Quote>>>('/quotes', { params }),
  
  get: (id: string) =>
    api.get<ApiResponse<Quote>>(`/quotes/${id}`),
  
  submit: (data: SubmitQuoteData) =>
    api.post<ApiResponse<Quote>>('/quotes', data),
  
  update: (id: string, data: Partial<SubmitQuoteData>) =>
    api.patch<ApiResponse<Quote>>(`/quotes/${id}`, data),
  
  review: (id: string) =>
    api.post<ApiResponse<Quote>>(`/quotes/${id}/review`),
  
  createComparison: (id: string) =>
    api.post<ApiResponse<QuoteComparison>>(`/quotes/${id}/comparison`),
  
  getComparison: (id: string) =>
    api.get<ApiResponse<QuoteComparison>>(`/quotes/${id}/comparison`),
  
  getRFQComparison: (rfqId: string) =>
    api.get<ApiResponse<Quote[]>>(`/quotes/rfq/${rfqId}/comparison`),
};

// Approvals API
export const approvalApi = {
  list: (params?: {
    status?: string;
    approverId?: string;
    requestId?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<PaginatedResponse<Approval>>>('/approvals', { params }),
  
  get: (id: string) =>
    api.get<ApiResponse<Approval>>(`/approvals/${id}`),
  
  create: (data: { requestId: string; approverId: string }) =>
    api.post<ApiResponse<Approval>>('/approvals', data),
  
  decide: (id: string, data: { status: ApprovalStatus; comments?: string }) =>
    api.post<ApiResponse<Approval>>(`/approvals/${id}/decide`, data),
  
  generateRecommendation: (requestId: string) =>
    api.post<ApiResponse<Recommendation>>(`/approvals/request/${requestId}/recommendation`),
  
  getRecommendation: (requestId: string) =>
    api.get<ApiResponse<Recommendation>>(`/approvals/request/${requestId}/recommendation`),
};

// Purchase Approvals API -> `purchaseApprovalApi` is declared below, next to the
// approval DTOs it is typed against.

// Audit API
export const auditApi = {
  list: (params?: {
    entityType?: string;
    entityId?: string;
    userId?: string;
    action?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }) =>
    api.get<ApiResponse<PaginatedResponse<AuditLog>>>('/audit', { params }),
};

// Deals API
export const dealsApi = {
  // Connections
  createConnection: (data: CreateConnectionInput) =>
    api.post<ApiResponse<Connection>>('/deals/connections', data),

  listConnections: (params?: {
    status?: string;
    requestId?: string;
    vendorId?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<PaginatedResponse<Connection>>>('/deals/connections', { params }),

  getConnection: (connectionId: string) =>
    api.get<ApiResponse<Connection>>(`/deals/connections/${connectionId}`),

  respondToConnection: (connectionId: string, accept: boolean) =>
    api.post<ApiResponse<Connection>>(`/deals/connections/${connectionId}/respond`, { accept }),

  // Deal Rooms
  getDealRoom: (dealRoomId: string) =>
    api.get<ApiResponse<DealRoom>>(`/deals/deal-rooms/${dealRoomId}`),

  getMessages: (dealRoomId: string) =>
    api.get<ApiResponse<DealMessage[]>>(`/deals/deal-rooms/${dealRoomId}/messages`),

  addMessage: (dealRoomId: string, content: string) =>
    api.post<ApiResponse<DealMessage>>(`/deals/deal-rooms/${dealRoomId}/messages`, { content }),

  // Offers
  createOffer: (data: CreateOfferInput) =>
    api.post<ApiResponse<DealOffer>>('/deals/offers', data),

  acceptOffer: (offerId: string) =>
    api.post<ApiResponse<{ deal: Deal; updatedOffer: DealOffer }>>('/deals/offers/accept', { offerId }),

  // Deals
  listDeals: (params?: {
    status?: string;
    requestId?: string;
    vendorId?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<PaginatedResponse<Deal>>>('/deals/deals', { params }),

  getDeal: (dealId: string) =>
    api.get<ApiResponse<Deal>>(`/deals/deals/${dealId}`),

  updateDealStatus: (dealId: string, status: string) =>
    api.patch<ApiResponse<Deal>>(`/deals/deals/${dealId}/status`, { status }),

  // Vendor Availability
  getVendorAvailability: (vendorId: string) =>
    api.get<ApiResponse<VendorAvailability>>(`/deals/vendors/${vendorId}/availability`),

  updateVendorAvailability: (vendorId: string, data: { isOnline: boolean; isBusy: boolean }) =>
    api.patch<ApiResponse<VendorAvailability>>(`/deals/vendors/${vendorId}/availability`, data),

  getOnlineVendors: (categoryId?: string) =>
    api.get<ApiResponse<Vendor[]>>('/deals/vendors/online', { params: { categoryId } }),

  // Utilities
  calculateOfferTotal: (offer: {
    unitPrice: number;
    quantity: number;
    gst?: number;
    freightAmount?: number;
    installationAmount?: number;
    otherCharges?: number;
  }) =>
    api.get<ApiResponse<{ subtotal: number; gstAmount: number; total: number }>>('/deals/offers/calculate-total', {
      params: offer,
    }),
};

// Negotiation API
export const negotiationApi = {
  getDealRoom: (dealRoomId: string) =>
    api.get<ApiResponse<DealRoomDetail>>(`/negotiation/deal-rooms/${dealRoomId}`),

  getMessages: (dealRoomId: string) =>
    api.get<ApiResponse<NegotiationMessage[]>>(`/negotiation/deal-rooms/${dealRoomId}/messages`),

  addMessage: (dealRoomId: string, content: string, messageType?: string) =>
    api.post<ApiResponse<NegotiationMessage>>(`/negotiation/deal-rooms/${dealRoomId}/messages`, { content, messageType }),

  submitOffer: (dealRoomId: string, data: {
    unitPrice: number;
    quantity: number;
    gst?: number;
    freightAmount?: number;
    installationAmount?: number;
    warrantyMonths?: number;
    deliveryTimelineDays?: number;
    paymentTerms?: string;
    validityDays?: number;
    otherCharges?: number;
    otherChargesDetails?: string;
  }) =>
    api.post<ApiResponse<DealOffer>>(`/negotiation/deal-rooms/${dealRoomId}/offers`, data),

  getOffers: (dealRoomId: string) =>
    api.get<ApiResponse<DealOffer[]>>(`/negotiation/deal-rooms/${dealRoomId}/offers`),

  generateNegotiationDraft: (dealRoomId: string, data: {
    targetPrice?: number;
    targetDeliveryDays?: number;
    buyerNotes?: string;
  }) =>
    api.post<ApiResponse<{
      approach: string;
      draftMessage: string;
      keyPoints: string[];
      tradeoffs: string[];
      context: { currentOfferPrice: number; targetPrice: number };
    }>>(`/negotiation/deal-rooms/${dealRoomId}/negotiation-draft`, data),

  acceptOffer: (offerId: string) =>
    api.post<ApiResponse<{ deal: Deal; updatedOffer: DealOffer }>>(`/negotiation/offers/accept`, { offerId }),

  updateStatus: (dealRoomId: string, status: string) =>
    api.patch<ApiResponse<DealRoom>>(`/negotiation/deal-rooms/${dealRoomId}/status`, { status }),

  getNegotiationWorthiness: (dealRoomId: string) =>
    api.get<ApiResponse<{
      dealRoomId: string;
      vendorId: string;
      worthinessScore: number;
      recommendation: 'NEGOTIATE' | 'ACCEPT_AS_IS' | 'OVER_BUDGET';
      reasoning: string;
      factors: Record<string, { score: number; weight: number }>;
      analyzedAt: string;
    }>>(`/negotiation/deal-rooms/${dealRoomId}/worthiness`),

  calculateOfferTotal: (offer: {
    unitPrice: number;
    quantity: number;
    gst?: number;
    freightAmount?: number;
    installationAmount?: number;
    otherCharges?: number;
  }) =>
    api.get<ApiResponse<{ basePrice: number; gstAmount: number; freightAmount: number; installationAmount: number; otherCharges: number; totalLandedCost: number }>>('/negotiation/offers/calculate-total', {
      params: offer,
    }),
};

// Quote Analysis API
export const quoteAnalysisApi = {
  analyzeQuote: (quoteId: string) =>
    api.post<ApiResponse<QuoteAnalysis>>(`/quote-analysis/quotes/${quoteId}/analyze`),

  getAnalysis: (quoteId: string) =>
    api.get<ApiResponse<QuoteAnalysis>>(`/quote-analysis/quotes/${quoteId}/analysis`),

  compareQuotes: (rfqId: string) =>
    api.post<ApiResponse<Array<{
      id: string;
      vendor: Vendor;
      unitPrice: number;
      quantity: number;
      comparison: any;
      analysis?: QuoteAnalysis;
      isLowest: boolean;
    }>>>(`/quote-analysis/rfqs/${rfqId}/compare`),
};

// Savings API
export const savingsApi = {
  create: (data: {
    dealId: string;
    type: SavingsType;
    baselineAmount: number;
    baselineSource: string;
    baselinePeriodStart?: string;
    baselinePeriodEnd?: string;
    calculationMethod: string;
    evidence?: Record<string, unknown>;
  }) =>
    api.post<ApiResponse<SavingsRecord>>('/savings', data),

  getSummary: () =>
    api.get<ApiResponse<{
      verified: { amount: number; count: number };
      potential: { amount: number; count: number };
      realized: { amount: number; count: number };
      total: { amount: number };
    }>>('/savings/summary'),

  list: (params?: {
    type?: string;
    dealId?: string;
    requestId?: string;
    vendorId?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<PaginatedResponse<SavingsRecord>>>('/savings', { params }),

  getTopVendors: (limit?: number) =>
    api.get<ApiResponse<Array<{
      vendorId: string;
      vendorName: string;
      vendorStatus: string;
      totalSavings: number;
      dealCount: number;
    }>>>(`/savings/top-vendors`, { params: { limit } }),
};

// ── Phase 5: Purchase execution ─────────────────────────────────────────────
//
// All monetary fields arrive as JSON numbers: the backend normalises Prisma
// Decimal columns at the response boundary, so the client can compare and total
// these values directly without per-field coercion.

export interface PurchaseOrderListItem {
  id: string;
  poNumber: string;
  dealId: string;
  requestId: string;
  buyerId: string;
  vendorId: string;
  status: PurchaseOrderStatus;
  itemName: string;
  description?: string | null;
  quantity: number;
  unit?: string | null;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  freightAmount: number;
  installationAmount: number;
  otherCharges: number;
  otherChargesDetails?: string | null;
  subtotal: number;
  totalAmount: number;
  currency: string;
  deliveryAddress?: string | null;
  expectedDeliveryDate?: string | null;
  actualDeliveryDate?: string | null;
  supplierConfirmedDeliveryDate?: string | null;
  paymentTerms?: string | null;
  warrantyMonths?: number | null;
  notes?: string | null;
  terms?: string | null;
  issuedAt?: string | null;
  supplierConfirmedAt?: string | null;
  closedAt?: string | null;
  cancelledAt?: string | null;
  rejectionReason?: string | null;
  dispatchTrackingRef?: string | null;
  createdAt: string;
  updatedAt: string;
  vendor: { id: string; name: string; status: string; gstin?: string | null; email?: string | null };
  buyer: { id: string; firstName: string; lastName: string; email: string; role: string };
  request: { id: string; title: string; item: string; quantity: number; unit?: string | null };
  _count?: {
    goodsReceipts: number;
    invoices: number;
    deliveryEvents: number;
    approvals: number;
  };
}

export interface PoApproval {
  id: string;
  poId: string;
  level: number;
  requiredRole: string;
  approverId?: string | null;
  status: ApprovalStatus;
  comments?: string | null;
  decidedAt?: string | null;
  decidedById?: string | null;
  approver?: { id: string; firstName: string; lastName: string; email?: string } | null;
  decidedBy?: { id: string; firstName: string; lastName: string } | null;
}

export type PurchaseOrderDetail = PurchaseOrderListItem & {
  acceptedOfferId: string;
  acceptedOfferSnapshot?: Record<string, unknown> | null;
  approvals: PoApproval[];
  deliveryEvents: Array<{
    id: string;
    type: DeliveryEventType;
    notes?: string | null;
    location?: string | null;
    carrierName?: string | null;
    trackingRef?: string | null;
    estimatedDeliveryDate?: string | null;
    occurredAt: string;
    actorId: string;
    documentIds: string[];
  }>;
  goodsReceipts: Array<{
    id: string;
    receiptNumber: string;
    orderedQuantity: number;
    receivedQuantity: number;
    acceptedQuantity: number;
    rejectedQuantity: number;
    receiptDate: string;
    receivedById: string;
    conditionNotes?: string | null;
    discrepancies?: Record<string, unknown>[] | null;
    documentIds: string[];
    createdAt: string;
  }>;
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  documents: DocumentRecord[];
};

export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  poId: string;
  vendorId: string;
  status: InvoiceStatus;
  currency: string;
  invoiceDate: string;
  dueDate?: string | null;
  subtotal: number;
  taxRate?: number | null;
  taxAmount: number;
  freightAmount: number;
  otherCharges: number;
  otherChargesDetails?: string | null;
  totalAmount: number;
  description?: string | null;
  extractedData?: Record<string, unknown> | null;
  extractionMethod?: string | null;
  extractedAt?: string | null;
  documentIds: string[];
  createdAt: string;
  verifications?: Array<{
    id: string;
    status: InvoiceMatchStatus;
    matched: boolean;
    discrepancies?: Discrepancy[] | null;
    checkedFields?: Record<string, unknown> | null;
    toleranceAmount: number;
    verifiedAt?: string | null;
    notes?: string | null;
    verifiedById?: string | null;
  }>;
  payments?: PaymentRecord[];
}

export interface PaymentRecord {
  id: string;
  poId: string;
  invoiceId?: string | null;
  status: PaymentStatus;
  amount: number;
  currency: string;
  paidAmount: number;
  reference?: string | null;
  paymentMethod?: string | null;
  paidAt?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  recordedById: string;
  createdAt: string;
  invoice?: { id: string; invoiceNumber: string; totalAmount: number } | null;
}

export interface DocumentRecord {
  id: string;
  poId?: string | null;
  invoiceId?: string | null;
  category: DocumentCategory;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedById: string;
  createdAt: string;
}

export interface ReceiptTotals {
  orderedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  remainingQuantity: number;
  fullyReceived: boolean;
}

export interface AssistantAnswer {
  answer: string;
  source: 'application_data';
  evidence: string[];
  suggestedQuestions: string[];
  notAnswerable?: boolean;
}

export interface SellerDashboard {
  vendor: {
    id: string;
    name: string;
    status: string;
    gstin?: string | null;
    city?: string | null;
    state?: string | null;
    verificationStatus?: string;
    performance?: {
      totalOrders: number;
      onTimeDelivery: number;
      qualityRating: number;
      responsiveness: number;
      lastOrderDate?: string | null;
    } | null;
  };
  summary: {
    totalOrders: number;
    totalOrderValue: number;
    pendingConfirmation: number;
    overdueOrders: number;
    openInvoices: number;
    statusCounts: Record<string, number>;
  };
  pendingOrders: Array<{
    id: string;
    poNumber: string;
    itemName: string;
    quantity: number;
    totalAmount: number;
    currency: string;
    issuedAt?: string | null;
    expectedDeliveryDate?: string | null;
  }>;
  recentOrders: Array<{
    id: string;
    poNumber: string;
    itemName: string;
    status: PurchaseOrderStatus;
    quantity: number;
    totalAmount: number;
    currency: string;
    expectedDeliveryDate?: string | null;
    supplierConfirmedDeliveryDate?: string | null;
    issuedAt?: string | null;
    updatedAt: string;
  }>;
  openInvoices: Array<{
    id: string;
    invoiceNumber: string;
    totalAmount: number;
    status: InvoiceStatus;
    invoiceDate: string;
    po: { id: string; poNumber: string };
    discrepancyCount: number;
  }>;
  monthlyPerformance: Array<{ month: string; orders: number; value: number }>;
}

/** Seller-facing order record. Deliberately omits the buyer's approval chain. */
export interface SellerOrder {
  id: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  itemName: string;
  description?: string | null;
  quantity: number;
  unit?: string | null;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  freightAmount: number;
  installationAmount: number;
  otherCharges: number;
  otherChargesDetails?: string | null;
  subtotal: number;
  totalAmount: number;
  currency: string;
  deliveryAddress?: string | null;
  expectedDeliveryDate?: string | null;
  supplierConfirmedDeliveryDate?: string | null;
  paymentTerms?: string | null;
  warrantyMonths?: number | null;
  terms?: string | null;
  issuedAt?: string | null;
  rejectionReason?: string | null;
  updatedAt: string;
  _count?: { deliveryEvents: number; invoices: number; documents: number };
}

const PO_BASE = '/purchase-orders';

export const purchaseOrderApi = {
  // ── Purchase orders ────────────────────────────────────────────────────────
  createFromDeal: (data: {
    dealId: string;
    deliveryAddress?: string;
    expectedDeliveryDate?: string;
    paymentTerms?: string;
    warrantyMonths?: number;
    notes?: string;
    terms?: string;
    overrides?: {
      quantity?: number;
      unitPrice?: number;
      taxRate?: number;
      freightAmount?: number;
      installationAmount?: number;
      otherCharges?: number;
      otherChargesDetails?: string;
    };
  }) =>
    api.post<ApiResponse<PurchaseOrderDetail>>(PO_BASE, data),

  list: (params?: {
    status?: PurchaseOrderStatus;
    vendorId?: string;
    buyerId?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<PaginatedResponse<PurchaseOrderListItem>>(PO_BASE, { params }),

  get: (poId: string) =>
    api.get<ApiResponse<PurchaseOrderDetail>>(`${PO_BASE}/${poId}`),

  getSummary: (poId: string) =>
    api.get<ApiResponse<PurchaseOrderSummary>>(`${PO_BASE}/${poId}/summary`),

  getTimeline: (poId: string) =>
    api.get<ApiResponse<TransactionTimelineEntry[]>>(`${PO_BASE}/${poId}/timeline`),

  submitForApproval: (poId: string) =>
    api.post<ApiResponse<PurchaseOrderDetail>>(`${PO_BASE}/${poId}/submit-approval`),

  decideApproval: (poId: string, approvalId: string, data: { status: ApprovalStatus; comments?: string }) =>
    api.post<ApiResponse<{ allApproved: boolean; remainingLevels: number; poStatus: string }>>(
      `${PO_BASE}/${poId}/approvals/${approvalId}/decide`,
      data,
    ),

  issue: (poId: string) =>
    api.post<ApiResponse<PurchaseOrderDetail>>(`${PO_BASE}/${poId}/issue`),

  cancel: (poId: string, reason: string) =>
    api.post<ApiResponse<PurchaseOrderDetail>>(`${PO_BASE}/${poId}/cancel`, { reason }),

  close: (poId: string, notes?: string) =>
    api.post<ApiResponse<PurchaseOrderDetail>>(`${PO_BASE}/${poId}/close`, { notes }),

  // ── Supplier actions ───────────────────────────────────────────────────────
  confirmOrder: (poId: string, data: { confirmedDeliveryDate?: string; notes?: string }) =>
    api.post<ApiResponse<PurchaseOrderDetail>>(`${PO_BASE}/${poId}/confirm`, data),

  rejectOrder: (poId: string, reason: string) =>
    api.post<ApiResponse<PurchaseOrderDetail>>(`${PO_BASE}/${poId}/reject`, { reason }),

  addDeliveryEvent: (poId: string, data: {
    type: DeliveryEventType;
    notes?: string;
    location?: string;
    carrierName?: string;
    trackingRef?: string;
    estimatedDeliveryDate?: string;
    documentIds?: string[];
  }) =>
    api.post<ApiResponse<{ id: string; type: DeliveryEventType; occurredAt: string }>>(
      `${PO_BASE}/${poId}/delivery-events`,
      data,
    ),

  // ── Goods receipts ─────────────────────────────────────────────────────────
  recordReceipt: (poId: string, data: {
    receivedQuantity: number;
    acceptedQuantity: number;
    rejectedQuantity?: number;
    receiptDate?: string;
    conditionNotes?: string;
    documentIds?: string[];
  }) =>
    api.post<ApiResponse<{
      id: string;
      receiptNumber: string;
      acceptedQuantity: number;
      rejectedQuantity: number;
      remainingQuantity: number;
      cumulativeAccepted: number;
      poStatus: PurchaseOrderStatus;
    }>>(`${PO_BASE}/${poId}/receipts`, data),

  listReceipts: (poId: string) =>
    api.get<ApiResponse<PurchaseOrderDetail['goodsReceipts']>>(`${PO_BASE}/${poId}/receipts`),

  getReceiptTotals: (poId: string) =>
    api.get<ApiResponse<ReceiptTotals>>(`${PO_BASE}/${poId}/receipts/totals`),

  // ── Invoices ───────────────────────────────────────────────────────────────
  submitInvoice: (data: {
    poId: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate?: string;
    quantity?: number;
    unitPrice?: number;
    taxRate?: number;
    taxAmount?: number;
    freightAmount?: number;
    otherCharges?: number;
    otherChargesDetails?: string;
    totalAmount?: number;
    description?: string;
    extractedData?: Record<string, unknown>;
    extractionMethod?: string;
    documentIds?: string[];
  }) =>
    api.post<ApiResponse<InvoiceRecord>>(`${PO_BASE}/invoices`, data),

  listInvoices: (params?: { poId?: string; status?: InvoiceStatus; page?: number; limit?: number }) =>
    api.get<PaginatedResponse<InvoiceRecord>>(`${PO_BASE}/invoices`, { params }),

  getInvoice: (invoiceId: string) =>
    api.get<ApiResponse<InvoiceRecord>>(`${PO_BASE}/invoices/${invoiceId}`),

  verifyInvoice: (invoiceId: string, data?: { tolerance?: number; notes?: string }) =>
    api.post<ApiResponse<{
      matched: boolean;
      hasCritical: boolean;
      discrepancies: Discrepancy[];
      checkedFields: Record<string, unknown>;
      invoiceStatus: InvoiceStatus;
    }>>(`${PO_BASE}/invoices/${invoiceId}/verify`, data ?? {}),

  resolveDiscrepancy: (invoiceId: string, data: {
    field: string;
    resolution: DiscrepancyResolution;
    note?: string;
  }) =>
    api.post<ApiResponse<{ outstandingCritical: boolean; invoiceStatus: InvoiceStatus }>>(
      `${PO_BASE}/invoices/${invoiceId}/resolve-discrepancy`,
      data,
    ),

  // ── Payments ───────────────────────────────────────────────────────────────
  recordPayment: (data: {
    poId: string;
    invoiceId?: string;
    status: PaymentStatus;
    amount?: number;
    paidAmount?: number;
    paidAt?: string;
    dueDate?: string;
    reference?: string;
    paymentMethod?: string;
    notes?: string;
  }) =>
    api.post<ApiResponse<PaymentRecord>>(`${PO_BASE}/payments`, data),

  listPayments: (params?: { poId?: string; status?: PaymentStatus }) =>
    api.get<ApiResponse<PaymentRecord[]>>(`${PO_BASE}/payments`, { params }),

  // ── Documents ──────────────────────────────────────────────────────────────
  uploadDocument: (data: {
    poId?: string;
    invoiceId?: string;
    category: DocumentCategory;
    fileName: string;
    mimeType: string;
    content: string;
  }) =>
    api.post<ApiResponse<DocumentRecord>>(`${PO_BASE}/documents`, data),

  listDocuments: (params?: { poId?: string; invoiceId?: string; category?: DocumentCategory }) =>
    api.get<ApiResponse<DocumentRecord[]>>(`${PO_BASE}/documents`, { params }),

  /**
   * Download document bytes through the API so the tenant- and role-scoped
   * authorization check always runs. There is no public file URL.
   */
  downloadDocument: async (documentId: string, fileName: string) => {
    const response = await api.get<Blob>(`${PO_BASE}/documents/${documentId}/download`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(response.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  // ── Assistant ──────────────────────────────────────────────────────────────
  ask: (question: string, poId?: string) =>
    api.post<ApiResponse<AssistantAnswer>>(PO_BASE + '/assistant', { question }, { params: { poId } }),

  // ── Seller surface ─────────────────────────────────────────────────────────
  seller: {
    dashboard: () =>
      api.get<ApiResponse<SellerDashboard>>(`${PO_BASE}/seller/dashboard`),

    orders: (params?: { status?: PurchaseOrderStatus; search?: string }) =>
      api.get<ApiResponse<SellerOrder[]>>(`${PO_BASE}/seller/orders`, { params }),

    orderSummary: (poId: string) =>
      api.get<ApiResponse<PurchaseOrderSummary>>(`${PO_BASE}/seller/orders/${poId}/summary`),
  },
};

// Copilot API
// Answers are composed by the backend from stored data. Nothing here composes
// or derives an answer locally, and no action is ever written without the
// explicit `/actions/:actionId/confirm` call.
export const copilotApi = {
  describe: () => api.get<ApiResponse<CopilotDescribe>>('/copilot/describe'),

  listTools: () =>
    api.get<ApiResponse<Array<{ name: string; description: string; argumentHint: string }>>>(
      '/copilot/tools'
    ),

  suggestions: (params?: { entityType?: string; entityLabel?: string }) =>
    api.get<ApiResponse<{ suggestions: string[] }>>('/copilot/suggestions', { params }),

  ask: (message: string, conversationId?: string, context?: CopilotContext) =>
    api.post<ApiResponse<CopilotAskResult>>('/copilot/ask', { message, conversationId, context }),

  listConversations: () =>
    api.get<ApiResponse<CopilotConversationSummary[]>>('/copilot/conversations'),

  getConversation: (conversationId: string) =>
    api.get<ApiResponse<CopilotConversation>>(`/copilot/conversations/${conversationId}`),

  deleteConversation: (conversationId: string) =>
    api.delete<ApiResponse<null>>(`/copilot/conversations/${conversationId}`),

  proposeAction: (type: string, payload: Record<string, unknown>, conversationId?: string) =>
    api.post<ApiResponse<CopilotExecutedAction & { summary: string; details: Array<{ field: string; value: string }>; warnings: string[] }>>(
      '/copilot/actions',
      { type, payload, conversationId }
    ),

  confirmAction: (actionId: string) =>
    api.post<ApiResponse<CopilotExecutedAction>>(`/copilot/actions/${actionId}/confirm`),

  listPreferences: () =>
    api.get<ApiResponse<Array<{ key: string; value: unknown; updatedAt: string }>>>('/copilot/preferences'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Marketplace and controlled communication
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketQuery {
  search?: string;
  categoryId?: string;
  location?: string;
  limit?: number;
  offset?: number;
}

export const communicationApi = {
  // Seller open market. The response is already redacted server-side.
  browseMarket: (params: MarketQuery = {}) =>
    api.get<ApiResponse<MarketRequirement[]> & { meta: { total: number; limit: number; offset: number } }>(
      '/communication/market',
      { params }
    ),

  getRequirement: (requestId: string) =>
    api.get<ApiResponse<MarketRequirementDetail>>(`/communication/market/${requestId}`),

  expressInterest: (requestId: string, note?: string) =>
    api.post<ApiResponse<{ id: string; status: InterestStatus; createdAt: string }>>(
      `/communication/market/${requestId}/interest`,
      { note }
    ),

  withdrawInterest: (requestId: string) =>
    api.delete<ApiResponse<null>>(`/communication/market/${requestId}/interest`),

  mySubmissions: () => api.get<ApiResponse<MarketplaceInterest[]>>('/communication/my-submissions'),

  /**
   * Publish a requirement.
   *
   * `confirmed` is required by the server and cannot be defaulted here: opening
   * the market exposes the item, quantity and deadline to every eligible seller,
   * so the call site must make the user agree to it first.
   */
  publishRequirement: (
    requestId: string,
    input: { visibility: RequestVisibility; quotationDeadline?: string; confirmed: true }
  ) =>
    api.post<ApiResponse<{ id: string; visibility: RequestVisibility; quotationDeadline: string | null; publishedAt: string | null }>>(
      `/communication/requests/${requestId}/publish`,
      input
    ),

  withdrawRequirement: (requestId: string) =>
    api.post<ApiResponse<null>>(`/communication/requests/${requestId}/withdraw`),

  listRestrictions: () => api.get<ApiResponse<ContactRestriction[]>>('/communication/restrictions'),

  restrictVendor: (input: {
    vendorId: string;
    kind: RestrictionKind;
    reason?: string;
    expiresAt?: string;
  }) => api.post<ApiResponse<ContactRestriction>>('/communication/restrictions', input),

  clearRestriction: (vendorId: string) =>
    api.delete<ApiResponse<null>>(`/communication/restrictions/${vendorId}`),

  reportVendor: (input: { vendorId: string; reason: ReportReason; details?: string }) =>
    api.post<ApiResponse<AbuseReport>>('/communication/reports', input),

  /** Why this seller may contact a buyer, so the UI can explain a refusal. */
  interactionBasis: (buyerId: string) =>
    api.get<ApiResponse<{ basis: InteractionBasis; mayContact: boolean }>>(
      `/communication/interaction/${buyerId}`
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

export const notificationApi = {
  /**
   * `unread` arrives in `meta`, matching the list endpoints elsewhere in the
   * API; the body carries only the items.
   */
  list: () =>
    api.get<ApiResponse<NotificationItem[]> & { meta: { unread: number } }>('/notifications'),

  markRead: (notificationId: string) =>
    api.post<ApiResponse<null>>(`/notifications/${notificationId}/read`),

  unreadInRoom: (dealRoomId: string) =>
    api.get<ApiResponse<RoomUnreadState>>(`/notifications/unread/${dealRoomId}`),

  markRoomRead: (dealRoomId: string) =>
    api.post<ApiResponse<{ marked: number }>>(`/notifications/unread/${dealRoomId}/read`),

  listPreferences: () =>
    api.get<ApiResponse<NotificationPreference[]>>('/notifications/preferences'),

  setPreference: (eventType: string, frequency: NotificationFrequency) =>
    api.put<ApiResponse<NotificationPreference>>('/notifications/preferences', {
      eventType,
      frequency,
    }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Manager approval & purchase authorization
// ─────────────────────────────────────────────────────────────────────────────

const APPROVAL_BASE = '/purchase-approvals';

export interface ListPurchaseApprovalsParams {
  scope?: 'assigned' | 'requested' | 'all';
  status?: PurchaseApprovalStatus;
  requesterId?: string;
  vendorId?: string;
  department?: string;
  minAmount?: number;
  maxAmount?: number;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface UpsertApprovalPolicyBody {
  name?: string;
  description?: string;
  currency?: string;
  isActive?: boolean;
  includeTaxesInThreshold?: boolean;
  includeDeliveryChargesInThreshold?: boolean;
  autoApproveBelowAmount?: number | null;
  allowSelfApproval?: boolean;
  selfApprovalJustification?: string;
  reapprovalRules?: {
    priceIncrease?: boolean;
    priceDecrease?: boolean;
    quantityChange?: boolean;
    deliveryTermsChange?: boolean;
    paymentTermsChange?: boolean;
    otherTermsChange?: boolean;
  };
  splitGuardEnabled?: boolean;
  splitGuardWindowDays?: number;
  rules?: Array<{
    name: string;
    priority: number;
    isActive: boolean;
    minAmount?: number;
    maxAmount?: number;
    department?: string;
    categoryId?: string;
    costCenter?: string;
    requireApproval: boolean;
    levels: Array<{
      level: number;
      requiredRole: string;
      label?: string;
      approverIds?: string[];
    }>;
  }>;
}

/**
 * Purchase authorization.
 *
 * `preview` exists so a buyer can be told what will happen - why approval is
 * required and who must give it - before committing to a submission, using the
 * same resolver the server will use.
 */
export const purchaseApprovalApi = {
  /**
   * List rows carry the same relations as the detail view (vendor, submitter)
   * because the inbox has to render who and what without a fetch per row.
   */
  list: (params?: ListPurchaseApprovalsParams) =>
    api.get<ApiResponse<PaginatedResponse<PurchaseApprovalRequestDetail>>>(APPROVAL_BASE, { params }),

  get: (approvalId: string) =>
    api.get<ApiResponse<PurchaseApprovalRequestDetail>>(`${APPROVAL_BASE}/${approvalId}`),

  preview: (offerId: string) =>
    api.get<ApiResponse<ResolvedApprovalRoute>>(`${APPROVAL_BASE}/preview/${offerId}`),

  submit: (body: { offerId: string; requesterComment?: string; parentRequestId?: string }) =>
    api.post<ApiResponse<{
      request: PurchaseApprovalRequestDetail;
      route: ResolvedApprovalRoute;
    }>>(`${APPROVAL_BASE}/submit`, body),

  decide: (decisionId: string, body: { status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED'; comments?: string }) =>
    api.post<ApiResponse<PurchaseApprovalRequestDetail>>(
      `${APPROVAL_BASE}/decisions/${decisionId}/decide`,
      body,
    ),

  reassign: (decisionId: string, body: { approverId: string; reason: string }) =>
    api.post<ApiResponse<unknown>>(`${APPROVAL_BASE}/decisions/${decisionId}/reassign`, body),

  cancel: (approvalId: string, body: { reason: string }) =>
    api.post<ApiResponse<PurchaseApprovalRequestDetail>>(`${APPROVAL_BASE}/${approvalId}/cancel`, body),

  /**
   * `confirmTermsMatch` is sent explicitly: the buyer is asserting the purchase
   * still matches the approved terms, and the server refuses if it does not.
   */
  confirm: (approvalId: string) =>
    api.post<ApiResponse<PurchaseApprovalRequestDetail>>(`${APPROVAL_BASE}/${approvalId}/confirm`, {
      confirmTermsMatch: true,
    }),

  getPolicy: () => api.get<ApiResponse<PurchaseApprovalPolicy | null>>(`${APPROVAL_BASE}/policy`),

  savePolicy: (body: UpsertApprovalPolicyBody) =>
    api.put<ApiResponse<PurchaseApprovalPolicy>>(`${APPROVAL_BASE}/policy`, body),

  saveRule: (ruleId: string, body: NonNullable<UpsertApprovalPolicyBody['rules']>[number]) =>
    api.put<ApiResponse<unknown>>(`${APPROVAL_BASE}/rules/${ruleId}`, body),

  deleteRule: (ruleId: string) => api.delete<ApiResponse<null>>(`${APPROVAL_BASE}/rules/${ruleId}`),

  requestHistory: (requestId: string) =>
    api.get<ApiResponse<ApprovalOverview['history']>>(`${APPROVAL_BASE}/request/${requestId}/history`),

  overview: () => api.get<ApiResponse<ApprovalOverview>>(`${APPROVAL_BASE}/overview`),
};

// Requirement Intake API
export const requirementIntakeApi = {
  createDraft: (body: CreateRequirementDraftInput) =>
    api.post<ApiResponse<RequirementDraftDetail>>('/requirement-intake/draft', body),

  getActiveDraft: (conversationId?: string) =>
    api.get<ApiResponse<RequirementDraftDetail | null>>('/requirement-intake/draft/active', {
      params: conversationId ? { conversationId } : {},
    }),

  getDraft: (draftId: string) =>
    api.get<ApiResponse<RequirementDraftDetail>>(`/requirement-intake/draft/${draftId}`),

  answerClarification: (body: AnswerClarificationInput) =>
    api.post<ApiResponse<RequirementDraftDetail>>('/requirement-intake/draft/answer', body),

  confirmDraft: (body: ConfirmRequirementDraftInput) =>
    api.post<ApiResponse<{ requestId: string; draftId: string }>>('/requirement-intake/draft/confirm', body),

  getCategoryFields: (category: string) =>
    api.get<ApiResponse<RequirementCategoryFields>>('/requirement-intake/categories/fields', {
      params: { category },
    }),

  listCategories: () =>
    api.get<ApiResponse<{ categories: string[] }>>('/requirement-intake/categories'),

  listDrafts: (params?: RequirementIntakeListParams) =>
    api.get<ApiResponse<PaginatedRequirementDrafts>>('/requirement-intake/drafts', { params }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Requirement Approval API (Department approval - first checkpoint)
// ─────────────────────────────────────────────────────────────────────────────

const REQUIREMENT_APPROVAL_BASE = '/requirement-approval';

export interface ListRequirementApprovalsParams {
  scope?: 'assigned' | 'requested' | 'all';
  status?: RequirementApprovalStatus;
  requesterId?: string;
  department?: string;
  minAmount?: number;
  maxAmount?: number;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface SubmitRequirementApprovalBody {
  requestId: string;
  requesterComment?: string;
}

export interface DecideRequirementApprovalBody {
  decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  comments?: string;
}

export interface RequirementApprovalPreviewResponse {
  success: boolean;
  data: ResolvedRequirementRoute;
}

export const requirementApprovalApi = {
  list: (params?: ListRequirementApprovalsParams) =>
    api.get<ApiResponse<PaginatedResponse<RequirementApprovalRequestDetail>>>(REQUIREMENT_APPROVAL_BASE, { params }),

  get: (approvalId: string) =>
    api.get<ApiResponse<RequirementApprovalRequestDetail>>(`${REQUIREMENT_APPROVAL_BASE}/${approvalId}`),

  preview: (requestId: string) =>
    api.get<ApiResponse<ResolvedRequirementRoute>>(`${REQUIREMENT_APPROVAL_BASE}/request/${requestId}/preview`),

  submit: (body: SubmitRequirementApprovalBody) =>
    api.post<ApiResponse<{
      approvalId: string;
      status: string;
      autoApproved: boolean;
      approverId?: string | null;
    }>>(`${REQUIREMENT_APPROVAL_BASE}/submit`, body),

  decide: (approvalId: string, body: DecideRequirementApprovalBody) =>
    api.post<ApiResponse<{ requestId: string; newStatus: string }>>(
      `${REQUIREMENT_APPROVAL_BASE}/${approvalId}/decide`,
      body,
    ),

   getStatus: (requestId: string) =>
     api.get<ApiResponse<RequirementApprovalRequestDetail | null>>(
       `${REQUIREMENT_APPROVAL_BASE}/request/${requestId}/status`
     ),
};

// Vendor Intelligence & Onboarding Engine API

export const VENDOR_INTELLIGENCE_BASE = '/vendor-intelligence';

export const vendorIntelligenceApi = {
  // Category Hierarchy
  getCategoryHierarchy: () =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/categories`),

  getCategoryTree: (categoryId: string) =>
    api.get<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/categories/${categoryId}/tree`),

  getCategoryPath: (categoryId: string) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/categories/${categoryId}/path`),

  // Vendor Profile - Capabilities
  getCapabilities: (vendorId: string) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/capabilities`),

  createCapability: (data: { vendorId: string; name: string; description?: string; category?: string; proficiencyLevel?: string; matchingFactors?: string[] }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/capabilities`, data),

  updateCapability: (capabilityId: string, data: Record<string, unknown>) =>
    api.patch<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/capabilities/${capabilityId}`, data),

  deleteCapability: (capabilityId: string) =>
    api.delete<ApiResponse<null>>(`${VENDOR_INTELLIGENCE_BASE}/capabilities/${capabilityId}`),

  // Vendor Profile - Certifications
  getCertifications: (vendorId: string) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/certifications`),

  createCertification: (data: { vendorId: string; name: string; issuingBody?: string; issueDate?: string; expiryDate?: string; documentId?: string; matchingFactors?: string[] }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/certifications`, data),

  verifyCertification: (certificationId: string) =>
    api.patch<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/certifications/${certificationId}/verify`),

  // Vendor Profile - Documents
  getDocuments: (vendorId: string) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/documents`),

  uploadDocument: (data: { vendorId: string; documentType: string; fileName: string; url?: string; mimeType?: string; fileSize?: number }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/documents`, data),

  verifyDocument: (documentId: string) =>
    api.patch<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/documents/${documentId}/verify`),

  // Vendor Profile Detail
  getProfileDetail: (vendorId: string) =>
    api.get<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/profile`),

  // Onboarding
  getOnboardingStatus: (vendorId: string) =>
    api.get<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/onboarding`),

  createOnboarding: (data: { vendorId: string }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/onboarding`, data),

  transitionOnboardingStatus: (vendorId: string, data: { status: VendorOnboardingStatus; notes?: string }) =>
    api.patch<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/onboarding/transition`, data),

  recalculateMissingDocs: (vendorId: string) =>
    api.patch<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/onboarding/recalculate-docs`),

  getOnboardingDashboard: (params?: { status?: VendorOnboardingStatus; search?: string }) =>
    api.get<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/onboarding`, { params }),

  // Matching
  matchVendors: (requestId: string, params?: { limit?: number; save?: boolean; weights?: Record<string, number> }) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/requests/${requestId}/match`, { params }),

  getMatchingResults: (vendorId: string, limit?: number) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/matchings`, { params: { limit } }),

  // Vendor Assignments
  assignVendor: (data: { vendorId: string; buyerId?: string; department?: string; costCenter?: string; requestId?: string; notes?: string }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/assignments`, data),

  getAssignments: (vendorId: string, activeOnly = true) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/assignments`, { params: { activeOnly } }),

  listAssignments: (params?: { buyerId?: string; department?: string; costCenter?: string; requestId?: string; activeOnly?: boolean }) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/assignments`, { params }),

  getAssignedVendorsForBuyer: (buyerId: string) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/buyers/${buyerId}/assigned-vendors`),

  checkAssignment: (vendorId: string, buyerId: string) =>
    api.get<ApiResponse<{ assigned: boolean }>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/buyers/${buyerId}/assigned`),

  deactivateAssignment: (assignmentId: string) =>
    api.patch<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/assignments/${assignmentId}/deactivate`),

  acceptAssignment: (assignmentId: string) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/assignments/${assignmentId}/accept`),

  declineAssignment: (assignmentId: string, reason: string) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/assignments/${assignmentId}/decline`, { reason }),

  // Commercial History
  getCommercialHistory: (vendorId: string, params?: { limit?: number; offset?: number; status?: string }) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/commercial-history`, { params }),

  addCommercialHistory: (data: { vendorId: string; requestId?: string; poNumber?: string; amount: string; currency?: string; orderDate: string; deliveryDate?: string; paymentDate?: string; status?: string; notes?: string }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/commercial-history`, data),

  getSpendingSummary: (vendorId: string) =>
    api.get<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/spending-summary`),

  getTopVendorsBySpending: (period: 'all' | 'year' = 'all') =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/spending/top-vendors`, { params: { period } }),

  // Duplicate Detection
  scanDuplicates: (vendorId: string, threshold: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW') =>
    api.get<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/${vendorId}/duplicates/scan`, { params: { threshold } }),

  recordDuplicate: (data: { primaryVendorId: string; duplicateVendorId: string; confidence: VendorDuplicateConfidence; method: string; fieldsMatched: string[] }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/duplicates`, data),

  confirmDuplicate: (duplicateId: string) =>
    api.patch<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/duplicates/${duplicateId}/confirm`),

  listDuplicates: (params?: { confirmed?: boolean }) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/duplicates`, { params }),

  mergeVendors: (data: { primaryVendorId: string; duplicateVendorId: string }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/vendors/merge`, data),

  // Vendor Events
  recordEvent: (data: { vendorId: string; eventType: string; metadata?: Record<string, unknown>; ipAddress?: string; userAgent?: string }) =>
    api.post<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/events`, data),

  getVendorEvents: (vendorId: string, params?: { limit?: number; offset?: number }) =>
    api.get<ApiResponse<any[]>>(`${VENDOR_INTELLIGENCE_BASE}/events/vendor/${vendorId}`, { params }),

  getAllVendorEvents: (params?: { vendorId?: string; eventType?: string; actorId?: string; limit?: number; offset?: number }) =>
    api.get<ApiResponse<any>>(`${VENDOR_INTELLIGENCE_BASE}/events`, { params }),
};

// Commercial Offers API

export const COMMERCIAL_OFFERS_BASE = '/commercial-offers';

export const commercialOffersApi = {
  listOffers: (params?: {
    requestId?: string;
    vendorId?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<{ data: CommercialOffer[]; total: number; page: number; limit: number }>>(
      COMMERCIAL_OFFERS_BASE,
      { params }
    ),

  createOrGetOffer: (data: {
    vendorAssignmentId: string;
    requestId: string;
    offerType?: OfferType;
    currency?: string;
    deadline?: string;
  }) =>
    api.post<ApiResponse<CommercialOffer>>(`${COMMERCIAL_OFFERS_BASE}/offer`, data),

  getOffer: (offerId: string) =>
    api.get<ApiResponse<CommercialOfferDetail>>(`${COMMERCIAL_OFFERS_BASE}/offer/${offerId}`),

  getOfferByAssignment: (vendorAssignmentId: string) =>
    api.get<ApiResponse<CommercialOfferDetail>>(`${COMMERCIAL_OFFERS_BASE}/assignment/${vendorAssignmentId}`),

  getSubmissions: (offerId: string) =>
    api.get<ApiResponse<CommercialOfferSubmission[]>>(`${COMMERCIAL_OFFERS_BASE}/${offerId}/submissions`),

  upsertDraft: (vendorAssignmentId: string, data: Partial<UpsertOfferDraftInput>) =>
    api.put<ApiResponse<{ offer: CommercialOffer; submission: CommercialOfferSubmission }>>(
      `${COMMERCIAL_OFFERS_BASE}/assignment/${vendorAssignmentId}/draft`,
      data
    ),

  submitOffer: (vendorAssignmentId: string, data: Omit<SubmitOfferInput, 'vendorAssignmentId'>) =>
    api.post<ApiResponse<{ submission: CommercialOfferSubmission; offerId: string; isFinal: boolean; submissionNumber: number }>>(
      `${COMMERCIAL_OFFERS_BASE}/assignment/${vendorAssignmentId}/submit`,
      data
    ),

  getClarificationThread: (vendorAssignmentId: string) =>
    api.get<ApiResponse<OfferEvent[]>>(`${COMMERCIAL_OFFERS_BASE}/assignment/${vendorAssignmentId}/clarifications`),

  postClarification: (vendorAssignmentId: string, content: string) =>
    api.post<ApiResponse<OfferEvent>>(`${COMMERCIAL_OFFERS_BASE}/assignment/${vendorAssignmentId}/clarification`, { content }),

  postClarificationResponse: (vendorAssignmentId: string, content: string) =>
    api.post<ApiResponse<OfferEvent>>(`${COMMERCIAL_OFFERS_BASE}/assignment/${vendorAssignmentId}/clarification-response`, { content }),

  withdrawOffer: (offerId: string) =>
    api.put<ApiResponse<CommercialOffer>>(`${COMMERCIAL_OFFERS_BASE}/${offerId}/withdraw`),

  declineOpportunity: (offerId: string) =>
    api.put<ApiResponse<CommercialOffer>>(`${COMMERCIAL_OFFERS_BASE}/${offerId}/decline`),

  reopenCommercialProcess: (vendorAssignmentId: string, reason: string) =>
    api.post<ApiResponse<{ offer: CommercialOffer; newRound: number }>>(
      `${COMMERCIAL_OFFERS_BASE}/assignment/${vendorAssignmentId}/reopen`,
      { reason }
    ),

  getOfferEvents: (offerId: string) =>
    api.get<ApiResponse<OfferEvent[]>>(`${COMMERCIAL_OFFERS_BASE}/${offerId}/events`),

  evaluateCompliance: (submissionId: string) =>
    api.post<ApiResponse<{ submission: any; compliance: any }>>(
      `${COMMERCIAL_OFFERS_BASE}/submission/${submissionId}/compliance`
    ),

  getSummary: (submissionId: string) =>
    api.get<ApiResponse<{ summary: string }>>(`${COMMERCIAL_OFFERS_BASE}/submission/${submissionId}/summary`),
};

export const DEAL_EXECUTION_BASE = '/deals/execution';

export const dealExecutionApi = {
  selectFinalOffer: (submissionId: string) =>
    api.post<ApiResponse<{ requestId: string; submission: { id: string; submissionNumber: number; offerType: string } }>>(
      `${DEAL_EXECUTION_BASE}/final-offer/${submissionId}/select`,
    ),

  submitForFinalApproval: (submissionId: string, data?: { requesterComment?: string }) =>
    api.post<ApiResponse<{ requestId: string; reference: string; approvalRequired: boolean; status: string }>>(
      `${DEAL_EXECUTION_BASE}/final-offer/${submissionId}/submit`,
      data,
    ),

  listDealExecutions: (params?: {
    status?: string;
    requestId?: string;
    vendorId?: string;
    page?: number;
    limit?: number;
  }) =>
    api.get<ApiResponse<ListDealExecutionsResponse>>(`${DEAL_EXECUTION_BASE}`, { params }),

  getDealExecutionDetail: (dealId: string) =>
    api.get<ApiResponse<DealExecutionDetail>>(`${DEAL_EXECUTION_BASE}/${dealId}`),

  advanceExecutionStatus: (dealId: string, data: { status: string; cancellationReason?: string }) =>
    api.post<ApiResponse<{ dealId: string; executionStatus: string }>>(
      `${DEAL_EXECUTION_BASE}/${dealId}/advance`,
      data,
    ),

  recordExecutionEvent: (
    dealId: string,
    data: { type: string; description: string; metadata?: Record<string, unknown> },
  ) =>
    api.post<ApiResponse<{ eventId: string }>>(`${DEAL_EXECUTION_BASE}/${dealId}/events`, data),

  createExecutionRecord: (
    dealId: string,
    data: {
      type: 'purchase_order' | 'service_commencement' | 'subscription_registration' | 'milestone';
      deliveryAddress?: string;
      expectedDeliveryDate?: string;
      paymentTerms?: string;
      warrantyMonths?: number;
      notes?: string;
      milestoneName?: string;
      milestoneIndex?: number;
      startDate?: string;
      endDate?: string;
      description?: string;
    },
  ) => api.post<ApiResponse<{ recordId: string; recordType: string }>>(`${DEAL_EXECUTION_BASE}/${dealId}/execution-record`, data),
};

export default api;