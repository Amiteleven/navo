import React, { useState, useEffect } from 'react';
import {
  Search, Building2, Users, TrendingUp, BarChart3, GitMerge,
  CheckCircle, Clock, PauseCircle, Ban, Archive,
  FileText, Shield
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { vendorIntelligenceApi } from '../services/api';
import { VendorOnboardingStatus } from '../types';
import toast from 'react-hot-toast';

const STATUS_CONFIG: Record<string, { label: string; icon: React.FC<any>; color: string }> = {
  INVITED: { label: 'Invited', icon: Clock, color: 'bg-blue-100 text-blue-800' },
  APPLICATION_STARTED: { label: 'Application Started', icon: FileText, color: 'bg-indigo-100 text-indigo-800' },
  APPLICATION_SUBMITTED: { label: 'Application Submitted', icon: FileText, color: 'bg-purple-100 text-purple-800' },
  UNDER_REVIEW: { label: 'Under Review', icon: Shield, color: 'bg-amber-100 text-amber-800' },
  VERIFICATION_REQUIRED: { label: 'Verification Required', icon: Shield, color: 'bg-orange-100 text-orange-800' },
  VERIFIED: { label: 'Verified', icon: CheckCircle, color: 'bg-green-100 text-green-800' },
  APPROVED: { label: 'Approved', icon: CheckCircle, color: 'bg-emerald-100 text-emerald-800' },
  REJECTED: { label: 'Rejected', icon: Ban, color: 'bg-red-100 text-red-800' },
  SUSPENDED: { label: 'Suspended', icon: PauseCircle, color: 'bg-gray-100 text-gray-800' },
  ARCHIVED: { label: 'Archived', icon: Archive, color: 'bg-stone-100 text-stone-800' },
};

const ALL_STATUSES = Object.values(VendorOnboardingStatus);

export const VendorIntelligencePage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'onboarding' | 'matching' | 'assignments' | 'spending' | 'duplicates'>('onboarding');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [onboardingData, setOnboardingData] = useState<any[]>([]);
  const [assignmentData, setAssignmentData] = useState<any[]>([]);
  const [spendingData, setSpendingData] = useState<any[]>([]);
  const [duplicateData, setDuplicateData] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchOnboarding = async () => {
    setIsLoading(true);
    try {
      const res = await vendorIntelligenceApi.getOnboardingDashboard({
        ...(statusFilter ? { status: statusFilter as any } : {}),
        ...(searchQuery ? { search: searchQuery } : {}),
      });
      if (res.data.success && res.data.data) {
        const d = res.data.data as any;
        setOnboardingData(d?.data || d || []);
      }
    } catch {
      toast.error('Failed to load onboarding data');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAssignments = async () => {
    setIsLoading(true);
    try {
      const res = await vendorIntelligenceApi.listAssignments();
      if (res.data.success && res.data.data) {
        const d = res.data.data as any;
        setAssignmentData(d?.data || d || []);
      }
    } catch {
      toast.error('Failed to load assignments');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchSpending = async () => {
    setIsLoading(true);
    try {
      const res = await vendorIntelligenceApi.getTopVendorsBySpending('year');
      if (res.data.success && res.data.data) {
        const d = res.data.data as any;
        setSpendingData(d?.data || d || []);
      }
    } catch {
      toast.error('Failed to load spending data');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchDuplicates = async () => {
    setIsLoading(true);
    try {
      const res = await vendorIntelligenceApi.listDuplicates();
      if (res.data.success && res.data.data) {
        const d = res.data.data as any;
        setDuplicateData(d?.data || d || []);
      }
    } catch {
      toast.error('Failed to load duplicate data');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'onboarding') fetchOnboarding();
    if (activeTab === 'assignments') fetchAssignments();
    if (activeTab === 'spending') fetchSpending();
    if (activeTab === 'duplicates') fetchDuplicates();
  }, [activeTab, statusFilter, searchQuery]);

  const handleStatusTransition = async (vendorId: string, status: VendorOnboardingStatus) => {
    try {
      await vendorIntelligenceApi.transitionOnboardingStatus(vendorId, { status });
      toast.success(`Status updated to ${STATUS_CONFIG[status]?.label || status}`);
      fetchOnboarding();
    } catch {
      toast.error('Failed to update status');
    }
  };

  const handleDeactivateAssignment = async (assignmentId: string) => {
    try {
      await vendorIntelligenceApi.deactivateAssignment(assignmentId);
      toast.success('Assignment deactivated');
      fetchAssignments();
    } catch {
      toast.error('Failed to deactivate assignment');
    }
  };

  const handleMergeVendors = async (primaryId: string, duplicateId: string) => {
    try {
      await vendorIntelligenceApi.mergeVendors({ primaryVendorId: primaryId, duplicateVendorId: duplicateId });
      toast.success('Vendors merged successfully');
      fetchDuplicates();
    } catch {
      toast.error('Failed to merge vendors');
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">Vendor Intelligence</h1>
          <p className="text-sm text-stone-500 mt-1">
            Structured capabilities, onboarding workflow, matching, and private vendor routing.
          </p>
        </div>
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
          <input
            type="text"
            placeholder="Search vendors…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="input pl-9 text-sm"
          />
        </div>
      </div>

      <div className="border-b border-stone-200">
        <nav className="-mb-px flex gap-6 overflow-x-auto">
          {[
            { id: 'onboarding', label: 'Onboarding' },
            { id: 'matching', label: 'Match Vendors' },
            { id: 'assignments', label: 'Assignments' },
            { id: 'spending', label: 'Spending' },
            { id: 'duplicates', label: 'Duplicates' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id as any); setStatusFilter(''); setSearchQuery(''); }}
              className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-stone-500 hover:text-stone-700 hover:border-stone-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'onboarding' && (
        <>
          {/* Status Filters */}
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setStatusFilter('')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                !statusFilter
                  ? 'bg-blue-600 text-white'
                  : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'
              }`}
            >
              All Statuses
            </button>
            {ALL_STATUSES.map(s => {
              const cfg = STATUS_CONFIG[s];
              return (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${
                    statusFilter === s
                      ? 'bg-blue-600 text-white'
                      : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'
                  }`}
                >
                  <cfg.icon className="h-3 w-3" />
                  {cfg.label}
                </button>
              );
            })}
          </div>

          {/* Onboarding Table */}
          {isLoading ? (
            <div className="space-y-3">
              {[1,2,3,4,5].map(i => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="h-4 bg-stone-100 rounded w-3/4 mb-2" />
                  <div className="h-3 bg-stone-100 rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : onboardingData.length === 0 ? (
            <Card className="p-12 text-center">
              <Users className="h-10 w-10 text-stone-200 mx-auto mb-3" />
              <p className="text-stone-600 font-medium">No vendors in onboarding</p>
              <p className="text-sm text-stone-400 mt-1">Invite vendors to begin the onboarding workflow.</p>
            </Card>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-200">
                    <th className="text-left py-2 font-medium text-stone-700">Vendor</th>
                    <th className="text-left py-2 font-medium text-stone-700">Status</th>
                    <th className="text-left py-2 font-medium text-stone-700">Missing Docs</th>
                    <th className="text-left py-2 font-medium text-stone-700">Started</th>
                    <th className="text-left py-2 font-medium text-stone-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {onboardingData.map((v: any) => {
                    const cfg = STATUS_CONFIG[v.status] || { label: v.status, icon: FileText, color: 'bg-stone-100 text-stone-800' };
                    const Icon = cfg.icon;
                    return (
                      <tr key={v.id} className="border-b border-stone-100 last:border-0">
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-stone-400" />
                            <div>
                              <p className="font-medium text-stone-900">{v.vendor?.name || 'Unknown'}</p>
                              <p className="text-xs text-stone-500">{v.vendor?.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3">
                          <Badge className={cfg.color}>
                            <Icon className="h-3 w-3 mr-1" />
                            {cfg.label}
                          </Badge>
                        </td>
                        <td className="py-3 text-stone-600">
                          {(v.missingDocs ? v.missingDocs.length : 0)} remaining
                        </td>
                        <td className="py-3 text-stone-500">
                          {v.startedAt ? new Date(v.startedAt).toLocaleDateString() : '—'}
                        </td>
                        <td className="py-3">
                          <select
                            value={v.status}
                            onChange={e => handleStatusTransition(v.vendorId || v.vendor?.id, e.target.value as VendorOnboardingStatus)}
                            className="text-xs border border-stone-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                          >
                            {ALL_STATUSES.map(s => (
                              <option key={s} value={s}>{STATUS_CONFIG[s]?.label || s}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {activeTab === 'matching' && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-stone-900 mb-4 flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Match Vendors to a Requirement
          </h2>
          <p className="text-sm text-stone-500 mb-4">
            Enter a requirement ID to run the matching engine against all approved vendors.
            The engine scores vendors on capability, geography, certifications, historical
            performance, and more using configurable weights.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const requestId = (e.currentTarget.elements.namedItem('requestId') as HTMLInputElement).value;
              if (!requestId) return;
              setIsLoading(true);
              try {
                const res = await vendorIntelligenceApi.matchVendors(requestId, { save: true });
                if (res.data.success && res.data.data) {
                  toast.success(`${res.data.data.length} vendors matched`);
                }
              } catch {
                toast.error('Failed to match vendors');
              } finally {
                setIsLoading(false);
              }
            }}
            className="flex gap-3 max-w-md"
          >
            <input
              name="requestId"
              type="text"
              placeholder="Requirement ID"
              className="input flex-1"
              required
            />
            <Button type="submit" size="sm" loading={isLoading}>
              Match
            </Button>
          </form>
        </Card>
      )}

      {activeTab === 'assignments' && (
        <>
          {isLoading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="h-4 bg-stone-100 rounded w-3/4" />
                </div>
              ))}
            </div>
          ) : assignmentData.length === 0 ? (
            <Card className="p-8 text-center">
              <Users className="h-8 w-8 text-stone-200 mx-auto mb-2" />
              <p className="text-stone-600">No private vendor assignments yet.</p>
            </Card>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className="text-left py-2 font-medium text-stone-700">Vendor</th>
                  <th className="text-left py-2 font-medium text-stone-700">Buyer</th>
                  <th className="text-left py-2 font-medium text-stone-700">Department</th>
                  <th className="text-left py-2 font-medium text-stone-700">Request</th>
                  <th className="text-left py-2 font-medium text-stone-700">Status</th>
                  <th className="text-left py-2 font-medium text-stone-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {assignmentData.map((a: any) => (
                  <tr key={a.id} className="border-b border-stone-100 last:border-0">
                    <td className="py-3 text-stone-900">{a.vendor?.name || '—'}</td>
                    <td className="py-3 text-stone-600">{a.buyer ? `${a.buyer.firstName} ${a.buyer.lastName}` : 'All buyers'}</td>
                    <td className="py-3 text-stone-600">{a.department || '—'}</td>
                    <td className="py-3 text-stone-600">{a.request?.title || a.request?.id?.slice(0, 8) || '—'}</td>
                    <td className="py-3">
                      <Badge variant={a.isActive ? 'success' : 'neutral'}>
                        {a.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="py-3">
                      <button
                        onClick={() => handleDeactivateAssignment(a.id)}
                        className="text-xs text-red-600 hover:text-red-800"
                      >
                        Deactivate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {activeTab === 'spending' && (
        <>
          {isLoading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="h-4 bg-stone-100 rounded w-3/4" />
                </div>
              ))}
            </div>
          ) : spendingData.length === 0 ? (
            <Card className="p-8 text-center">
              <TrendingUp className="h-8 w-8 text-stone-200 mx-auto mb-2" />
              <p className="text-stone-600">No spending data available.</p>
            </Card>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className="text-left py-2 font-medium text-stone-700">Vendor</th>
                  <th className="text-right py-2 font-medium text-stone-700">Spend (YTD)</th>
                </tr>
              </thead>
              <tbody>
                {spendingData.map((v: any, i: number) => (
                  <tr key={v.vendor?.id || i} className="border-b border-stone-100 last:border-0">
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-stone-500 w-5">#{i + 1}</span>
                        <Building2 className="h-4 w-4 text-stone-400" />
                        <span className="font-medium text-stone-900">{v.vendor?.name || '—'}</span>
                      </div>
                    </td>
                    <td className="py-3 text-right font-medium text-stone-900">
                      {v.totalSpend} {v.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {activeTab === 'duplicates' && (
        <>
          {isLoading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="h-4 bg-stone-100 rounded w-3/4" />
                </div>
              ))}
            </div>
          ) : duplicateData.length === 0 ? (
            <Card className="p-8 text-center">
              <GitMerge className="h-8 w-8 text-stone-200 mx-auto mb-2" />
              <p className="text-stone-600">No potential duplicates detected.</p>
            </Card>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className="text-left py-2 font-medium text-stone-700">Primary Vendor</th>
                  <th className="text-left py-2 font-medium text-stone-700">Duplicate Vendor</th>
                  <th className="text-left py-2 font-medium text-stone-700">Confidence</th>
                  <th className="text-left py-2 font-medium text-stone-700">Fields Matched</th>
                  <th className="text-left py-2 font-medium text-stone-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {duplicateData.map((d: any) => (
                  <tr key={d.id} className="border-b border-stone-100 last:border-0">
                    <td className="py-3 text-stone-900">{d.primaryVendor?.name || '—'}</td>
                    <td className="py-3 text-stone-900">{d.duplicateVendor?.name || '—'}</td>
                    <td className="py-3">
                  <Badge variant={d.confidence === 'EXACT' ? 'danger' : d.confidence === 'HIGH' ? 'warning' : 'neutral'}>
                    {d.confidence}
                  </Badge>
                </td>
                <td className="py-3 text-stone-600">{d.fieldsMatched?.join(', ') || '—'}</td>
                <td className="py-3">
                  {!d.confirmed && (
                    <Button
                      size="sm"
                      variant="secondary"
                          onClick={() => handleMergeVendors(
                            d.primaryVendorId,
                            d.duplicateVendorId
                          )}
                        >
                          Merge
                        </Button>
                      )}
                      {d.confirmed && <Badge variant="success">Confirmed</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
};
