import { Request, Response, NextFunction } from 'express';
import { TenantIsolationError } from '../utils/errors';
import prisma from '../utils/prisma';
import { AuthenticatedRequest } from './auth';

export interface TenantRequest extends Request {
  tenantId?: string;
}

export const validateTenantAccess = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    return next();
  }

  const requestedTenantId = req.params.tenantId || req.body.tenantId || req.query.tenantId;
  
  if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
    if (req.user.role !== 'PLATFORM_ADMIN') {
      throw new TenantIsolationError();
    }
  }
  
  next();
};

export const getTenantId = (req: AuthenticatedRequest): string => {
  if (!(req as any).tenantId && req.user) {
    return req.user.tenantId;
  }
  return (req as any).tenantId || req.user?.tenantId || '';
};

export const ensureTenantExists = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const tenantId = getTenantId(req);
  
  if (!tenantId) {
    return next();
  }
  
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
  });
  
  if (!tenant || !tenant.isActive) {
    throw new TenantIsolationError('Tenant not found or inactive');
  }
  
  next();
};