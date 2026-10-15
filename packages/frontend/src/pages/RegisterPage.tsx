import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { authApi } from '../services/api';
import toast from 'react-hot-toast';

export const RegisterPage: React.FC = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    companyName: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.id]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await authApi.register({
        ...formData,
        tenantName: formData.companyName,
      });
      toast.success('Registration successful. Please log in.');
      navigate('/login');
    } catch (err: any) {
      setError(err.response?.data?.error?.message || 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-center gap-2.5 mb-8">
        <div className="h-9 w-9 rounded-xl bg-blue-600 flex items-center justify-center">
          <span className="text-white font-bold text-base">N</span>
        </div>
        <div>
          <p className="font-semibold text-stone-900 leading-none">NAVO</p>
          <p className="text-xs text-stone-400">Procurement Network</p>
        </div>
      </div>

      <h1 className="text-2xl font-semibold text-stone-900 mb-1">Create an account</h1>
      <p className="text-sm text-stone-500 mb-8">Join the network and start buying smarter.</p>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="firstName" className="label">First name</label>
            <input id="firstName" value={formData.firstName} onChange={handleChange} className="input" required />
          </div>
          <div>
            <label htmlFor="lastName" className="label">Last name</label>
            <input id="lastName" value={formData.lastName} onChange={handleChange} className="input" required />
          </div>
        </div>

        <div>
          <label htmlFor="companyName" className="label">Company name</label>
          <input id="companyName" value={formData.companyName} onChange={handleChange} className="input" required />
        </div>

        <div>
          <label htmlFor="email" className="label">Work email</label>
          <input id="email" type="email" value={formData.email} onChange={handleChange} className="input" required />
        </div>

        <div>
          <label htmlFor="password" className="label">Password</label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={formData.password}
              onChange={handleChange}
              className="input pr-10"
              required
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

        <button type="submit" disabled={isLoading} className="w-full btn-primary btn-md py-2.5 text-sm mt-2">
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create account'}
        </button>
      </form>

      <p className="text-center text-sm text-stone-500 mt-6">
        Already have an account?{' '}
        <Link to="/login" className="text-blue-600 font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
};