import React from 'react';
import { Outlet } from 'react-router-dom';

export const AuthLayout: React.FC = () => {
  return (
    <div className="min-h-screen bg-stone-50 flex">
      {/* Left panel - decorative */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-blue-600 to-indigo-700 flex-col justify-between p-12">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-white/20 flex items-center justify-center">
            <span className="text-white font-bold text-sm">N</span>
          </div>
          <span className="text-white font-semibold">NAVO</span>
        </div>

        <div className="space-y-6">
          <div>
            <h2 className="text-3xl font-semibold text-white leading-snug">
              The smarter way to<br />buy for your business
            </h2>
            <p className="text-blue-200 mt-3 text-sm leading-relaxed max-w-sm">
              Describe what you need in plain language. NAVO finds vendors, 
              collects quotes, and helps you negotiate the best deal — all in one place.
            </p>
          </div>

          <div className="space-y-3">
            {[
              'Natural language requirement input',
              'Live vendor matching & instant connect',
              'Real-time deal rooms & negotiation',
              'AI-powered quote comparison',
            ].map(f => (
              <div key={f} className="flex items-center gap-2.5">
                <div className="h-4 w-4 rounded-full bg-white/25 flex items-center justify-center flex-shrink-0">
                  <div className="h-1.5 w-1.5 rounded-full bg-white" />
                </div>
                <span className="text-sm text-blue-100">{f}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-blue-300">© 2025 NAVO Procurement Network</p>
      </div>

      {/* Right panel - form */}
      <div className="flex-1 flex items-center justify-center p-8">
        <Outlet />
      </div>
    </div>
  );
};