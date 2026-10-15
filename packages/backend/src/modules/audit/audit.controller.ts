import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { getAuditLogs } from './audit.service';
import { validate } from '../../middleware/validate';
import { z } from 'zod';
import { idSchema } from '../../utils/validation';
import { AuditAction } from '@navo/shared';

const auditLogsSchema = z.object({
  query: z.object({
    entityType: z.string().optional(),
    entityId: idSchema.optional(),
    userId: idSchema.optional(),
    action: z.nativeEnum(AuditAction).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
});

export const getAuditLogsHandler = [
  validate(auditLogsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await getAuditLogs(req.user!.tenantId, req.query as Record<string, string>);
    res.json({ success: true, data: result });
  },
];