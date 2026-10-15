import { requirementIntakeApi, dealsApi } from './api';
import axios from 'axios';
import { getAccessToken } from './api';

const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || '/api';

const navoAxios = axios.create({
  baseURL: `${API_BASE_URL}/navo`,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

const intakeAxios = axios.create({
  baseURL: `${API_BASE_URL}/requirement-intake`,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

const authInterceptor = (config: any) => {
  const token = getAccessToken();
  if (token && config.headers) config.headers.Authorization = `Bearer ${token}`;
  return config;
};
navoAxios.interceptors.request.use(authInterceptor, (error) => Promise.reject(error));
intakeAxios.interceptors.request.use(authInterceptor, (error) => Promise.reject(error));

export const navoApi = {
  // Requirements
  getActiveRequirements: (limit = 20, offset = 0) =>
    navoAxios.get('/requirements', { params: { limit, offset } }),

  getRequirementStatus: (requestId: string) =>
    navoAxios.get(`/requirements/${requestId}`),

  // Commercial Intelligence
  getVendorOffers: (requestId: string) =>
    navoAxios.get(`/requirements/${requestId}/offers`),

  runCommercialEvaluation: (requestId: string) =>
    navoAxios.get(`/requirements/${requestId}/commercial-eval`),

  // NAVO Approval summary (for approvers)
  getPendingApprovals: () =>
    navoAxios.get('/approvals/pending'),

  decideRequirementApproval: (
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED',
    comments?: string
  ) =>
    navoAxios.post(`/approvals/requirement/${approvalId}/decide`, { decision, comments }),
};

/** Requirement intake API — draft flow */
export const intakeApi = {
  createDraft: (message: string, conversationId?: string) =>
    intakeAxios.post('/draft', { message, conversationId }),

  getActiveDraft: (conversationId?: string) =>
    intakeAxios.get('/draft', { params: { conversationId } }),

  answerClarification: (draftId: string, field: string, answer: string) =>
    intakeAxios.post(`/draft/${draftId}/answer`, { field, answer }),

  confirmDraft: (draftId: string) =>
    intakeAxios.post(`/draft/${draftId}/confirm`),

  abandonDraft: (draftId: string) =>
    intakeAxios.post(`/draft/${draftId}/abandon`),

  /** Submit confirmed request for department approval — the critical link */
  submitForApproval: (requestId: string, requesterComment?: string) =>
    intakeAxios.post(`/request/${requestId}/submit-for-approval`, { requesterComment }),

  /** Poll approval status for a confirmed request */
  getApprovalStatus: (requestId: string) =>
    intakeAxios.get(`/request/${requestId}/approval-status`),

  /** Get pending approvals for the current user (as approver) */
  getPendingApprovals: () =>
    intakeAxios.get('/approvals/pending'),

  /** Get version revision history for a draft */
  getDraftVersions: (draftId: string) =>
    intakeAxios.get(`/draft/${draftId}/versions`),

  /** Check if proposed post-approval changes require re-approval */
  checkMaterialChange: (requestId: string, changes: Record<string, any>) =>
    intakeAxios.post(`/request/${requestId}/check-material-change`, { changes }),
};

// Re-export existing APIs needed by the chat page
export { requirementIntakeApi, dealsApi as dealApi };
