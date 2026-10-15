import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { UserRole } from '@navo/shared';

export interface TokenPayload {
  userId: string;
  tenantId: string;
  email: string;
  role: UserRole;
  /**
   * Phase 5: set on supplier (VENDOR) accounts. The access token deliberately
   * does not carry a vendor claim - seller authorization resolves
   * `User.vendorId` from the database at request time.
   */
  vendorId?: string | null;
}

export interface RefreshTokenPayload {
  userId: string;
  tenantId: string;
  tokenVersion: number;
}

const accessTokenOptions: SignOptions = {
  expiresIn: config.jwt.accessTokenExpiry as SignOptions['expiresIn'],
};

const refreshTokenOptions: SignOptions = {
  expiresIn: config.jwt.refreshTokenExpiry as SignOptions['expiresIn'],
};

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwt.secret, accessTokenOptions);
}

export function generateRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, config.jwt.refreshSecret, refreshTokenOptions);
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwt.secret) as TokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.jwt.refreshSecret) as RefreshTokenPayload;
}

export function decodeToken(token: string): TokenPayload | null {
  try {
    return jwt.decode(token) as TokenPayload;
  } catch {
    return null;
  }
}