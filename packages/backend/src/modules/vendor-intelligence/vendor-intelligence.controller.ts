import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import {
  getVendorCapabilities,
  createCapability,
  updateCapability,
  deleteCapability,
  getVendorCertifications,
  createCertification,
  verifyCertification,
  getVendorDocuments,
  uploadVendorDocument,
  verifyVendorDocument,
  getVendorProfileDetail,
  CreateCapabilityInput,
  UpdateCapabilityInput,
  CreateCertificationInput,
  CreateDocumentInput,
} from './vendor-profile.service.js';
import {
  getOnboardingStatus,
  createOnboarding,
  transitionOnboardingStatus,
  recalculateMissingDocs,
  getOnboardingDashboard,
} from './vendor-onboarding.service.js';
import {
  matchVendorsAgainstRequest,
  saveMatchingResult,
  getVendorMatchingResults,
} from './vendor-matching.service.js';
import {
  assignVendor,
  getVendorAssignments,
  listVendorAssignments,
  deactivateAssignment,
  acceptAssignment,
  declineAssignment,
  AssignVendorInput,
} from './vendor-assignment.service.js';
import {
  getCommercialHistory,
  addCommercialHistory,
  getVendorSpendingSummary,
  getTopVendorsBySpending,
  CommercialHistoryInput,
} from './vendor-commercial-history.service.js';
import {
  findPotentialDuplicates,
  recordDuplicateDetection,
  confirmDuplicate,
  listDuplicateDetections,
  mergeVendors,
} from './vendor-duplicate.service.js';
import {
  getCategoryHierarchy,
  getCategoryTree,
  getCategoryPath,
} from './category-hierarchy.service.js';
import { recordVendorEvent, getVendorEvents, getAllVendorEvents } from './vendor-event.service.js';
import {
  VendorOnboardingStatus,
  VendorDocumentType,
  VendorDuplicateConfidence,
} from '@navo/shared';
import { NotFoundError } from '../../utils/errors.js';
import prisma from '../../utils/prisma.js';

const vendorIdParam = z.object({ params: z.object({ vendorId: idSchema }) });
const capabilityIdParam = z.object({ params: z.object({ capabilityId: idSchema }) });
const certificationIdParam = z.object({ params: z.object({ certificationId: idSchema }) });
const documentIdParam = z.object({ params: z.object({ documentId: idSchema }) });
const assignmentIdParam = z.object({ params: z.object({ assignmentId: idSchema }) });
const declineAssignmentSchema = z.object({
  params: z.object({ assignmentId: idSchema }),
  body: z.object({ reason: z.string().min(1).max(1000) }),
});
const duplicateIdParam = z.object({ params: z.object({ duplicateId: idSchema }) });
const categoryIdParam = z.object({ params: z.object({ categoryId: idSchema }) });
const requestIdParam = z.object({ params: z.object({ requestId: idSchema }) });

const createCapabilitySchema = z.object({
  body: z.object({
    vendorId: idSchema,
    category: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    proficiencyLevel: z.string().optional(),
    matchingFactors: z.array(z.string()).optional(),
  }),
});

const updateCapabilitySchema = z.object({
  params: z.object({ capabilityId: idSchema }),
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    proficiencyLevel: z.string().optional(),
    matchingFactors: z.array(z.string()).optional(),
  }),
});

const createCertificationSchema = z.object({
  body: z.object({
    vendorId: idSchema,
    name: z.string().min(1),
    issuingBody: z.string().optional(),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
    documentId: idSchema.optional(),
  }),
});

const createDocumentSchema = z.object({
  body: z.object({
    vendorId: idSchema,
    documentType: z.nativeEnum(VendorDocumentType),
    fileName: z.string().min(1),
    mimeType: z.string().optional(),
    fileSize: z.number().int().positive().optional(),
    path: z.string().min(1),
  }),
});

const createOnboardingSchema = z.object({
  body: z.object({
    vendorId: idSchema,
  }),
});

const transitionOnboardingSchema = z.object({
  params: z.object({ vendorId: idSchema }),
  body: z.object({
    status: z.nativeEnum(VendorOnboardingStatus),
    notes: z.string().optional(),
  }),
});

const matchVendorsSchema = z.object({
  params: z.object({ requestId: idSchema }),
  query: z.object({
    limit: z.coerce.number().int().positive().max(100).default(20),
    save: z.coerce.boolean().default(false),
  }),
});

const assignVendorSchema = z.object({
  body: z.object({
    vendorId: idSchema,
    requestId: idSchema,
    notes: z.string().optional(),
  }),
});

const createHistorySchema = z.object({
  body: z.object({
    vendorId: idSchema,
    periodStart: z.coerce.date(),
    orderCount: z.number().int().nonnegative().default(1),
    totalSpend: z.union([z.string(), z.number()]).transform((v) => v.toString()),
    avgDiscountPct: z.number().optional(),
    currency: z.string().default('INR'),
  }),
});

const recordEventSchema = z.object({
  body: z.object({
    vendorId: idSchema,
    eventType: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
  }),
});

const duplicateScanSchema = z.object({
  params: z.object({ vendorId: idSchema }),
  query: z.object({
    threshold: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('LOW'),
  }),
});

const listDuplicatesSchema = z.object({
  query: z.object({
    confirmed: z.coerce.boolean().optional(),
  }),
});

const recordDuplicateSchema = z.object({
  body: z.object({
    primaryVendorId: idSchema,
    duplicateVendorId: idSchema,
    confidence: z.nativeEnum(VendorDuplicateConfidence),
    method: z.string(),
    fieldsMatched: z.array(z.string()),
    score: z.number().min(0).max(100).default(50),
  }),
});

const mergeVendorsSchema = z.object({
  body: z.object({
    primaryVendorId: idSchema,
    duplicateVendorId: idSchema,
  }),
});

const getAssignedVendorsSchema = z.object({ params: z.object({ buyerId: idSchema }) });

const checkAssignmentSchema = z.object({
  params: z.object({ vendorId: idSchema, buyerId: idSchema }),
});

export const vendorProfileHandlers = {
  getCapabilities: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getVendorCapabilities(req.params.vendorId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],

  createCapability: [
    validate(createCapabilitySchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { vendorId, ...rest } = req.body;
      const input: CreateCapabilityInput = { vendorId, ...rest };
      const data = await createCapability(input, req.user!.tenantId);
      res.status(201).json({ success: true, data });
    },
  ],

  updateCapability: [
    validate(updateCapabilitySchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { capabilityId } = req.params;
      const input: UpdateCapabilityInput = req.body;
      const data = await updateCapability(capabilityId, input, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],

  deleteCapability: [
    validate(capabilityIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      await deleteCapability(req.params.capabilityId, req.user!.tenantId);
      res.json({ success: true, message: 'Capability deleted' });
    },
  ],

  getCertifications: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getVendorCertifications(req.params.vendorId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],

  createCertification: [
    validate(createCertificationSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const input: CreateCertificationInput = req.body;
      const data = await createCertification(input, req.user!.tenantId);
      res.status(201).json({ success: true, data });
    },
  ],

  verifyCertification: [
    validate(certificationIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await verifyCertification(
        req.params.certificationId, req.user!.userId, req.user!.tenantId
      );
      res.json({ success: true, data });
    },
  ],

  getDocuments: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getVendorDocuments(req.params.vendorId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],

  uploadDocument: [
    validate(createDocumentSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const input: CreateDocumentInput = req.body;
      const data = await uploadVendorDocument(input, req.user!.userId, req.user!.tenantId);
      res.status(201).json({ success: true, data });
    },
  ],

  verifyDocument: [
    validate(documentIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await verifyVendorDocument(
        req.params.documentId, req.user!.userId, req.user!.tenantId
      );
      res.json({ success: true, data });
    },
  ],

  getProfileDetail: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getVendorProfileDetail(req.params.vendorId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],
};

export const onboardingHandlers = {
  getStatus: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getOnboardingStatus(req.params.vendorId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],

  createOnboarding: [
    validate(createOnboardingSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { vendorId } = req.body;
      const data = await createOnboarding(vendorId, req.user!.tenantId, req.user!.userId);
      res.status(201).json({ success: true, data });
    },
  ],

  transitionStatus: [
    validate(transitionOnboardingSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { vendorId } = req.params;
      const { status, notes } = req.body;
      const data = await transitionOnboardingStatus(
        vendorId, status as VendorOnboardingStatus, req.user!.tenantId, req.user!.userId, notes
      );
      res.json({ success: true, data });
    },
  ],

  recalculateMissingDocs: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const vendor = await prisma.vendor.findFirst({ where: { id: req.params.vendorId, tenantId: req.user!.tenantId }, select: { id: true } });
      if (!vendor) throw new NotFoundError('Vendor');
      const data = await recalculateMissingDocs(req.params.vendorId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],

  getDashboard: async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const status = req.query.status as VendorOnboardingStatus | undefined;
    const search = req.query.search as string | undefined;
    const data = await getOnboardingDashboard(req.user!.tenantId, { status, search });
    res.json({ success: true, data });
  },
};

export const matchingHandlers = {
  matchVendors: [
    validate(matchVendorsSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { requestId } = req.params;
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const save = req.query.save === 'true';
      const weights = extractWeights(req.query as Record<string, unknown>);
      const results = await matchVendorsAgainstRequest(requestId, req.user!.tenantId, limit, weights);

      if (save) {
        await saveMatchingResult(requestId, results, req.user!.tenantId, req.user!.userId);
      }

      res.json({ success: true, data: results });
    },
  ],

  getMatchingResults: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { vendorId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const data = await getVendorMatchingResults(vendorId, req.user!.tenantId, limit);
      res.json({ success: true, data });
    },
  ],
};

function extractWeights(query: Record<string, unknown>): Record<string, number> {
  const weightKeys = [
    'capability', 'geography', 'certification', 'industryExperience',
    'availability', 'capacity', 'historicalPerformance', 'commercialHistory',
    'vendorStatus', 'productServiceFit',
  ];
  const weights: Record<string, number> = {};
  for (const key of weightKeys) {
    if (query[`weight_${key}`] !== undefined) {
      weights[key] = typeof query[`weight_${key}`] === 'number'
        ? query[`weight_${key}`] as number
        : Number(query[`weight_${key}`]);
    }
  }
  return weights;
}

export const assignmentHandlers = {
  assignVendor: [
    validate(assignVendorSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const input: AssignVendorInput = req.body;
      const data = await assignVendor(input, req.user!.tenantId, req.user!.userId);
      res.status(201).json({ success: true, data });
    },
  ],

  getAssignments: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getVendorAssignments(req.params.vendorId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],

  listAssignments: async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const filters = {
      requestId: req.query.requestId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };
    const data = await listVendorAssignments(req.user!.tenantId, filters);
    res.json({ success: true, data });
  },

  deactivateAssignment: [
    validate(assignmentIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await deactivateAssignment(
        req.params.assignmentId, req.user!.tenantId, req.user!.userId
      );
      res.json({ success: true, data });
    },
  ],

  /**
   * Vendor accepts an assignment. Accessible to vendor users;
   * the service verifies the caller's vendor link against the
   * assignment before writing.
   */
  acceptAssignment: [
    validate(assignmentIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await acceptAssignment(
        req.params.assignmentId, req.user!.tenantId, req.user!.userId
      );
      res.json({ success: true, data });
    },
  ],

  /** Vendor declines an assignment with a mandatory reason. */
  declineAssignment: [
    validate(declineAssignmentSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await declineAssignment(
        req.params.assignmentId, req.user!.tenantId, req.user!.userId, req.body.reason
      );
      res.json({ success: true, data });
    },
  ],
};

export const commercialHistoryHandlers = {
  list: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const opts = {
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
      };
      const data = await getCommercialHistory(req.params.vendorId, req.user!.tenantId, opts);
      res.json({ success: true, data });
    },
  ],

  create: [
    validate(createHistorySchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const input: CommercialHistoryInput = req.body;
      const data = await addCommercialHistory(input, req.user!.tenantId);
      res.status(201).json({ success: true, data });
    },
  ],

  getSpendingSummary: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getVendorSpendingSummary(req.params.vendorId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],

  getTopVendors: async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const period = (req.query.period as 'all' | 'year') || 'all';
    const data = await getTopVendorsBySpending(req.user!.tenantId, period);
    res.json({ success: true, data });
  },
};

export const duplicateHandlers = {
  scan: [
    validate(duplicateScanSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const threshold = req.query.threshold as 'LOW' | 'MEDIUM' | 'HIGH';
      const data = await findPotentialDuplicates(req.params.vendorId, req.user!.tenantId, threshold);
      res.json({ success: true, data });
    },
  ],

  record: [
    validate(recordDuplicateSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { primaryVendorId, duplicateVendorId, confidence, method, fieldsMatched, score } = req.body as any;
      const data = await recordDuplicateDetection(
        primaryVendorId, duplicateVendorId, confidence as any, method, fieldsMatched, score, req.user!.tenantId
      );
      res.status(201).json({ success: true, data });
    },
  ],

  confirm: [
    validate(duplicateIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await confirmDuplicate(
        req.params.duplicateId, req.user!.userId, req.user!.tenantId
      );
      res.json({ success: true, data });
    },
  ],

  list: [
    validate(listDuplicatesSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const confirmed = req.query.confirmed !== undefined
        ? req.query.confirmed === 'true'
        : undefined;
      const data = await listDuplicateDetections(req.user!.tenantId, { confirmed });
      res.json({ success: true, data });
    },
  ],

  merge: [
    validate(mergeVendorsSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { primaryVendorId, duplicateVendorId } = req.body as any;
      const data = await mergeVendors(
        primaryVendorId, duplicateVendorId, req.user!.tenantId, req.user!.userId
      );
      res.json({ success: true, data });
    },
  ],
};

export const categoryHierarchyHandlers = {
  getHierarchy: async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const data = await getCategoryHierarchy(req.user!.tenantId);
    res.json({ success: true, data });
  },

  getTree: [
    validate(categoryIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getCategoryTree(req.params.categoryId, req.user!.tenantId);
      res.json({ success: true, data: data ?? null });
    },
  ],

  getPath: [
    validate(categoryIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const data = await getCategoryPath(req.params.categoryId, req.user!.tenantId);
      res.json({ success: true, data });
    },
  ],
};

export const vendorEventHandlers = {
  record: [
    validate(recordEventSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const { vendorId, eventType, metadata } = req.body as any;
      const data = await recordVendorEvent({
        vendorId,
        eventType,
        metadata,
        tenantId: req.user!.tenantId,
        actorId: req.user!.userId,
      });
      res.status(201).json({ success: true, data });
    },
  ],

  listForVendor: [
    validate(vendorIdParam),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const opts = {
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
      };
      const data = await getVendorEvents(req.params.vendorId, req.user!.tenantId, opts);
      res.json({ success: true, data });
    },
  ],

  listAll: async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const opts = {
      vendorId: req.query.vendorId as string | undefined,
      eventType: req.query.eventType as string | undefined,
      actorId: req.query.actorId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    };
    const data = await getAllVendorEvents(req.user!.tenantId, opts);
    res.json({ success: true, data });
  },
};
