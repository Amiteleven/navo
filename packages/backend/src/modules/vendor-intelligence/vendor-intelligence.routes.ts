import { Router } from '../../utils/router';
import {
  vendorProfileHandlers,
  onboardingHandlers,
  matchingHandlers,
  assignmentHandlers,
  commercialHistoryHandlers,
  duplicateHandlers,
  categoryHierarchyHandlers,
  vendorEventHandlers,
} from './vendor-intelligence.controller.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { UserRole } from '@navo/shared';

const router = Router();
const adminOrManager = [UserRole.COMPANY_ADMIN, UserRole.PROCUREMENT_MANAGER, UserRole.PLATFORM_ADMIN];

router.use(authenticate);

router.get('/categories', categoryHierarchyHandlers.getHierarchy);
router.get('/categories/:categoryId/tree', categoryHierarchyHandlers.getTree);
router.get('/categories/:categoryId/path', categoryHierarchyHandlers.getPath);

router.get('/vendors/:vendorId/profile', vendorProfileHandlers.getProfileDetail);
router.get('/vendors/:vendorId/capabilities', vendorProfileHandlers.getCapabilities);
router.get('/vendors/:vendorId/certifications', vendorProfileHandlers.getCertifications);
router.get('/vendors/:vendorId/documents', vendorProfileHandlers.getDocuments);

// Vendor-facing assignment responses. Registered before the
// admin/manager gate so vendor users can respond; the service
// verifies the caller's vendor link against the assignment
// before any write.
router.post('/assignments/:assignmentId/accept', assignmentHandlers.acceptAssignment);
router.post('/assignments/:assignmentId/decline', assignmentHandlers.declineAssignment);

router.use(requireRole(...adminOrManager));

router.post('/capabilities', vendorProfileHandlers.createCapability);
router.patch('/capabilities/:capabilityId', vendorProfileHandlers.updateCapability);
router.delete('/capabilities/:capabilityId', vendorProfileHandlers.deleteCapability);

router.post('/certifications', vendorProfileHandlers.createCertification);
router.patch('/certifications/:certificationId/verify', vendorProfileHandlers.verifyCertification);

router.post('/documents', vendorProfileHandlers.uploadDocument);
router.patch('/documents/:documentId/verify', vendorProfileHandlers.verifyDocument);

router.get('/onboarding', onboardingHandlers.getDashboard);
router.post('/onboarding', onboardingHandlers.createOnboarding);
router.get('/vendors/:vendorId/onboarding', onboardingHandlers.getStatus);
router.patch('/vendors/:vendorId/onboarding/transition', onboardingHandlers.transitionStatus);
router.patch('/vendors/:vendorId/onboarding/recalculate-docs', onboardingHandlers.recalculateMissingDocs);

router.get('/requests/:requestId/match', matchingHandlers.matchVendors);
router.get('/vendors/:vendorId/matchings', matchingHandlers.getMatchingResults);

router.post('/assignments', assignmentHandlers.assignVendor);
router.get('/assignments', assignmentHandlers.listAssignments);
router.get('/vendors/:vendorId/assignments', assignmentHandlers.getAssignments);
router.patch('/assignments/:assignmentId/deactivate', assignmentHandlers.deactivateAssignment);

router.get('/vendors/:vendorId/commercial-history', commercialHistoryHandlers.list);
router.post('/commercial-history', commercialHistoryHandlers.create);
router.get('/vendors/:vendorId/spending-summary', commercialHistoryHandlers.getSpendingSummary);
router.get('/spending/top-vendors', commercialHistoryHandlers.getTopVendors);

router.get('/vendors/:vendorId/duplicates/scan', duplicateHandlers.scan);
router.post('/duplicates', duplicateHandlers.record);
router.patch('/duplicates/:duplicateId/confirm', duplicateHandlers.confirm);
router.get('/duplicates', duplicateHandlers.list);
router.post('/vendors/merge', duplicateHandlers.merge);

router.post('/events', vendorEventHandlers.record);
router.get('/events/vendor/:vendorId', vendorEventHandlers.listForVendor);
router.get('/events', vendorEventHandlers.listAll);

export default router;
