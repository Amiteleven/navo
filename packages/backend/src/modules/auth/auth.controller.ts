import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { register, login, refreshAccessToken, getProfile, changePassword, RegisterInput, LoginInput } from './auth.service';
import { validate } from '../../middleware/validate';
import { registerSchema, loginSchema } from '@navo/shared';

export const registerHandler = [
  validate(registerSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: RegisterInput = req.body;
    const result = await register(input);
    res.status(201).json({ success: true, data: result });
  },
];

export const loginHandler = [
  validate(loginSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input: LoginInput = req.body;
    const result = await login(input);
    res.json({ success: true, data: result });
  },
];

export const refreshHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    res.status(400).json({ success: false, error: 'Refresh token required' });
    return;
  }
  
  const result = await refreshAccessToken(refreshToken);
  res.json({ success: true, data: result });
};

export const profileHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  
  const profile = await getProfile(req.user.userId);
  res.json({ success: true, data: profile });
};

export const changePasswordHandler = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    res.status(400).json({ success: false, error: 'Current and new password required' });
    return;
  }
  
  await changePassword(req.user.userId, currentPassword, newPassword);
  res.json({ success: true, message: 'Password changed successfully' });
};

export const logoutHandler = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.json({ success: true, message: 'Logged out successfully' });
};