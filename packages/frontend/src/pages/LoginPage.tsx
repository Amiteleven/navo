import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Invalid email or password');
    } finally {
      setIsLoading(false);
    }
  };

  const quickLogin = async (e: string, p: string) => {
    setEmail(e); setPassword(p);
    setIsLoading(true);
    try {
      await login(e, p);
      navigate('/');
    } catch {
      setError('Quick login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      {/* Logo */}
      <div className="flex items-center gap-2.5 mb-8">
        <div className="h-9 w-9 rounded-xl bg-blue-600 flex items-center justify-center">
          <span className="text-white font-bold text-base">N</span>
        </div>
        <div>
          <p className="font-semibold text-stone-900 leading-none">NAVO</p>
          <p className="text-xs text-stone-400">Procurement Network</p>
        </div>
      </div>

      <h1 className="text-2xl font-semibold text-stone-900 mb-1">Sign in</h1>
      <p className="text-sm text-stone-500 mb-8">Welcome back. Enter your credentials to continue.</p>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="label">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="input"
            required
            autoComplete="email"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="password" className="label mb-0">Password</label>
          </div>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              className="input pr-10"
              required
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={isLoading}
          className="w-full btn-primary btn-md py-2.5 text-sm"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign in'}
        </button>
      </form>

      <p className="text-center text-sm text-stone-500 mt-6">
        Don't have an account?{' '}
        <Link to="/register" className="text-blue-600 font-medium hover:underline">
          Create one
        </Link>
      </p>

      {/* Demo accounts */}
      <div className="mt-8 border-t border-stone-200 pt-6">
        <p className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-3">Demo accounts</p>
        <div className="space-y-2">
          {[
            { role: 'Admin', email: 'admin@demo.com' },
            { role: 'Procurement', email: 'procurement@demo.com' },
            { role: 'Finance', email: 'finance@demo.com' },
            { role: 'Buyer', email: 'requester@demo.com' },
          ].map(({ role, email: e }) => (
            <button
              key={e}
              onClick={() => quickLogin(e, 'password123')}
              disabled={isLoading}
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-stone-700 border border-stone-200 rounded-lg hover:bg-stone-50 hover:border-stone-300 transition-colors disabled:opacity-40"
            >
              <span className="font-medium">{role}</span>
              <span className="text-stone-400 text-xs">{e}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};