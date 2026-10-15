import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Wrench, ArrowLeft } from 'lucide-react';
import { Button } from '../components/ui/Button';

export const ReportsPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-5">
        <button onClick={() => navigate(-1)} className="p-1.5 hover:bg-stone-100 rounded-lg transition-colors">
          <ArrowLeft className="h-5 w-5 text-stone-500" />
        </button>
        <div>
          <h1 className="text-xl font-semibold text-stone-900">Reports</h1>
          <p className="text-sm text-stone-500 mt-1">Analytics and platform reporting.</p>
        </div>
      </div>
      <div className="card p-12 text-center">
        <Wrench className="h-10 w-10 text-stone-300 mx-auto mb-3" />
        <p className="text-stone-600 font-medium">Reports page is under construction.</p>
        <p className="text-sm text-stone-400 mt-1">We are redesigning analytics for the new NAVO AI-native platform.</p>
        <Button onClick={() => navigate('/')} className="mt-5" variant="secondary">Go to Home</Button>
      </div>
    </div>
  );
};