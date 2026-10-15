import bcrypt from 'bcryptjs';
import prisma from '../../utils/prisma';
import { config } from '../../config';
import { generateAccessToken, generateRefreshToken, TokenPayload, RefreshTokenPayload, verifyRefreshToken } from '../../utils/jwt';
import { AuthenticationError, ConflictError, NotFoundError } from '../../utils/errors';
import { UserRole } from '@navo/shared';
import { createAuditLog } from '../audit/audit.service';
import { AuditAction } from '@navo/shared';

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
  companySlug: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: TokenPayload;
}

export async function register(input: RegisterInput): Promise<AuthTokens> {
  const existingUser = await prisma.user.findFirst({
    where: { email: input.email.toLowerCase() },
  });
  
  if (existingUser) {
    throw new ConflictError('Email already registered');
  }
  
  const existingTenant = await prisma.tenant.findUnique({
    where: { slug: input.companySlug.toLowerCase() },
  });
  
  if (existingTenant) {
    throw new ConflictError('Company slug already taken');
  }
  
  const passwordHash = await bcrypt.hash(input.password, config.bcrypt.saltRounds);
  
  const tenant = await prisma.tenant.create({
    data: {
      name: input.companyName,
      slug: input.companySlug.toLowerCase(),
      isActive: true,
    },
  });
  
  const user = await prisma.user.create({
    data: {
      email: input.email.toLowerCase(),
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: UserRole.COMPANY_ADMIN,
      tenantId: tenant.id,
      isActive: true,
    },
  });
  
  await createAuditLog({
    userId: user.id,
    action: AuditAction.CREATED,
    entityType: 'Tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
    metadata: { companyName: input.companyName },
  });
  
  await createAuditLog({
    userId: user.id,
    action: AuditAction.CREATED,
    entityType: 'User',
    entityId: user.id,
    tenantId: tenant.id,
    metadata: { role: UserRole.COMPANY_ADMIN },
  });
  
  const tokens = generateTokens(user, tenant.id);
  
  return tokens;
}

export async function login(input: LoginInput): Promise<AuthTokens> {
  const user = await prisma.user.findFirst({
    where: { 
      email: input.email.toLowerCase(),
    },
    include: { tenant: true },
  });
  
  if (!user || !user.isActive || !user.tenant.isActive) {
    throw new AuthenticationError('Invalid credentials');
  }
  
  const isValid = await bcrypt.compare(input.password, user.passwordHash);
  
  if (!isValid) {
    throw new AuthenticationError('Invalid credentials');
  }
  
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  
  await createAuditLog({
    userId: user.id,
    action: AuditAction.CREATED,
    entityType: 'Session',
    entityId: user.id,
    tenantId: user.tenantId,
  });
  
  const tokens = generateTokens(user, user.tenantId);
  
  return tokens;
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string }> {
  const payload = verifyRefreshToken(refreshToken) as RefreshTokenPayload;
  
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: { tenant: true },
  });
  
  if (!user || !user.isActive || !user.tenant.isActive) {
    throw new AuthenticationError('User not found or inactive');
  }
  
  const accessToken = generateAccessToken({
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role as UserRole,
  });
  
  return { accessToken };
}

export async function getProfile(userId: string): Promise<TokenPayload> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      tenantId: true,
      // Phase 5: supplier accounts need to know which vendor they act for.
      vendorId: true,
    },
  });
  
  if (!user) {
    throw new NotFoundError('User');
  }
  
  return {
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role as UserRole,
    // Included so supplier views can be keyed without a second lookup.
    vendorId: user.vendorId,
  };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  
  if (!user) {
    throw new NotFoundError('User');
  }
  
  const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
  
  if (!isValid) {
    throw new AuthenticationError('Current password is incorrect');
  }
  
  const passwordHash = await bcrypt.hash(newPassword, config.bcrypt.saltRounds);
  
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
  
  await createAuditLog({
    userId,
    action: AuditAction.UPDATED,
    entityType: 'User',
    entityId: userId,
    tenantId: user.tenantId,
    metadata: { field: 'password' },
  });
}

function generateTokens(
  user: { id: string; email: string; role: any; tenantId: string; vendorId?: string | null },
  tenantId: string
): AuthTokens {
  const accessTokenPayload: TokenPayload = {
    userId: user.id,
    tenantId,
    email: user.email,
    role: user.role as UserRole,
    // Carried so a supplier can be identified without a profile round-trip. It is
    // never trusted for authorization: reloads re-read User.vendorId.
    vendorId: user.vendorId ?? null,
  };
  
  const refreshTokenPayload: RefreshTokenPayload = {
    userId: user.id,
    tenantId,
    tokenVersion: 0,
  };
  
  return {
    accessToken: generateAccessToken(accessTokenPayload),
    refreshToken: generateRefreshToken(refreshTokenPayload),
    user: accessTokenPayload,
  };
}