import React, { useState, useEffect } from 'react';
import {
  Plus, Search, Trash2, Building2, Star, MapPin
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import { vendorApi } from '../services/api';
import { Vendor, VendorStatus } from '../types';
import toast from 'react-hot-toast';

const STATUS_CONFIG: Record<VendorStatus, { label: string; variant: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  ACTIVE:           { label: 'Active',          variant: 'success'  },
  INACTIVE:         { label: 'Inactive',         variant: 'neutral'  },
  PENDING_APPROVAL: { label: 'Pending Approval', variant: 'warning'  },
  BLACKLISTED:      { label: 'Blacklisted',      variant: 'danger'   },
};

const getAvailability = (id: string) => {
  const h = id.charCodeAt(0) + id.charCodeAt(id.length - 1);
  return h % 3 === 0 ? 'online' : h % 3 === 1 ? 'busy' : 'offline';
};

const EMPTY_FORM = {
  name: '', categoryId: '', contactPerson: '', email: '',
  phone: '', address: '', city: '', state: '', country: 'India',
  postalCode: '', products: '', notes: '',
};

export const VendorsPage: React.FC = () => {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<VendorStatus | ''>('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchVendors = async () => {
    setIsLoading(true);
    try {
      const res = await vendorApi.list({
        page, limit: 20,
        status: statusFilter || undefined,
        search: search || undefined,
      });
      if (res.data.success && res.data.data) {
        setVendors(res.data.data.data);
        setTotal(res.data.data.total);
        setTotalPages(res.data.data.totalPages);
      }
    } catch { toast.error('Failed to load vendors'); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchVendors(); }, [page, statusFilter]);
  useEffect(() => {
    const t = setTimeout(fetchVendors, 300);
    return () => clearTimeout(t);
  }, [search]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await vendorApi.create(formData);
      toast.success('Vendor added');
      setShowCreate(false);
      setFormData(EMPTY_FORM);
      fetchVendors();
    } catch { toast.error('Failed to add vendor'); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selectedVendor) return;
    try {
      await vendorApi.delete(selectedVendor.id);
      toast.success('Vendor removed');
      setShowDelete(false);
      fetchVendors();
    } catch { toast.error('Failed to delete vendor'); }
  };

  const handleStatusChange = async (vendor: Vendor, newStatus: VendorStatus) => {
    try {
      await vendorApi.update(vendor.id, { status: newStatus } as any);
      toast.success('Status updated');
      fetchVendors();
    } catch { toast.error('Failed to update status'); }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">My Vendors</h1>
          <p className="text-sm text-stone-500 mt-0.5">{total} vendors in your network</p>
        </div>
        <Button onClick={() => { setFormData(EMPTY_FORM); setShowCreate(true); }} size="sm">
          <Plus className="h-3.5 w-3.5" />
          Add Vendor
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-col sm:flex-row">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
          <input
            type="text"
            placeholder="Search vendors…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="input pl-9 text-sm"
          />
        </div>
        <div className="flex gap-1">
          {(['', 'ACTIVE', 'PENDING_APPROVAL', 'INACTIVE'] as const).map(s => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s as VendorStatus | ''); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                statusFilter === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'
              }`}
            >
              {s === '' ? 'All' : STATUS_CONFIG[s as VendorStatus]?.label || s}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1,2,3,4,5,6].map(i => (
            <div key={i} className="card p-5 animate-pulse space-y-3">
              <div className="flex gap-3">
                <div className="h-10 w-10 rounded-xl bg-stone-100" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 bg-stone-100 rounded w-2/3" />
                  <div className="h-3 bg-stone-100 rounded w-1/2" />
                </div>
              </div>
              <div className="h-3 bg-stone-100 rounded" />
              <div className="h-8 bg-stone-100 rounded-lg" />
            </div>
          ))}
        </div>
      ) : vendors.length === 0 ? (
        <div className="card p-12 text-center">
          <Building2 className="h-10 w-10 text-stone-200 mx-auto mb-3" />
          <p className="text-stone-600 font-medium">No vendors found</p>
          <p className="text-sm text-stone-400 mt-1">Add your first vendor to start matching them with requests.</p>
          <Button size="sm" className="mt-5" onClick={() => { setFormData(EMPTY_FORM); setShowCreate(true); }}>
            <Plus className="h-3.5 w-3.5" />
            Add Vendor
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {vendors.map(v => {
            const sc = STATUS_CONFIG[v.status];
            const avail = getAvailability(v.id);
            const rating = 4.2;
            return (
              <div key={v.id} className="card p-4 space-y-3 hover:border-stone-300 hover:shadow-sm transition-all duration-150">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center flex-shrink-0 border border-stone-100">
                    <Building2 className="h-5 w-5 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-stone-900 truncate">{v.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant={sc.variant}>{sc.label}</Badge>
                      <span className={`inline-flex items-center gap-1 text-xs ${
                        avail === 'online' ? 'text-emerald-600' : avail === 'busy' ? 'text-amber-600' : 'text-stone-400'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          avail === 'online' ? 'bg-emerald-500' : avail === 'busy' ? 'bg-amber-500' : 'bg-stone-300'
                        }`} />
                        {avail.charAt(0).toUpperCase() + avail.slice(1)}
                      </span>
                    </div>
                  </div>
                </div>

                {(v.city || v.country) && (
                  <div className="flex items-center gap-1.5 text-xs text-stone-500">
                    <MapPin className="h-3 w-3 flex-shrink-0" />
                    {[v.city, v.state, v.country].filter(Boolean).join(', ')}
                  </div>
                )}

                {v.products && (
                  <p className="text-xs text-stone-500 line-clamp-2">{v.products}</p>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-stone-100">
                  <div className="flex items-center gap-3 text-xs text-stone-500">
                    {rating && (
                      <span className="flex items-center gap-1">
                        <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
                        {rating.toFixed(1)}
                      </span>
                    )}
                    {v.contactPerson && <span>{v.contactPerson}</span>}
                  </div>
                  <div className="flex gap-1">
                    <select
                      value={v.status}
                      onChange={e => handleStatusChange(v, e.target.value as VendorStatus)}
                      className="text-xs border border-stone-200 rounded-lg px-2 py-1 text-stone-600 bg-white hover:bg-stone-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {Object.entries(STATUS_CONFIG).map(([val, cfg]) => (
                        <option key={val} value={val}>{cfg.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => { setSelectedVendor(v); setShowDelete(true); }}
                      className="p-1.5 text-stone-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-stone-500">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setPage(p => Math.max(1, p-1))} disabled={page===1}>Previous</Button>
            <Button variant="secondary" size="sm" onClick={() => setPage(p => Math.min(totalPages, p+1))} disabled={page===totalPages}>Next</Button>
          </div>
        </div>
      )}

      {/* Create Modal */}
      <Modal isOpen={showCreate} onClose={() => { setShowCreate(false); setFormData(EMPTY_FORM); }} title="Add Vendor" size="lg">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">Vendor Name *</label>
              <input className="input" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="e.g. Dell Technologies" required />
            </div>
            <div>
              <label className="label">Contact Person</label>
              <input className="input" value={formData.contactPerson} onChange={e => setFormData({...formData, contactPerson: e.target.value})} placeholder="John Smith" />
            </div>
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} placeholder="contact@vendor.com" />
            </div>
            <div>
              <label className="label">Phone</label>
              <input className="input" value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} placeholder="+91-9876543210" />
            </div>
            <div>
              <label className="label">City</label>
              <input className="input" value={formData.city} onChange={e => setFormData({...formData, city: e.target.value})} placeholder="Bangalore" />
            </div>
            <div>
              <label className="label">State</label>
              <input className="input" value={formData.state} onChange={e => setFormData({...formData, state: e.target.value})} placeholder="Karnataka" />
            </div>
            <div>
              <label className="label">Country</label>
              <input className="input" value={formData.country} onChange={e => setFormData({...formData, country: e.target.value})} placeholder="India" />
            </div>
            <div className="col-span-2">
              <label className="label">Products / Services</label>
              <textarea className="input resize-none" rows={2} value={formData.products} onChange={e => setFormData({...formData, products: e.target.value})} placeholder="Laptops, Monitors, IT hardware…" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-stone-100">
            <Button type="button" variant="secondary" size="sm" onClick={() => { setShowCreate(false); setFormData(EMPTY_FORM); }}>Cancel</Button>
            <Button type="submit" size="sm" loading={saving}>Add Vendor</Button>
          </div>
        </form>
      </Modal>

      {/* Delete Modal */}
      <Modal isOpen={showDelete} onClose={() => setShowDelete(false)} title="Remove Vendor">
        <p className="text-sm text-stone-600 mb-5">
          Are you sure you want to remove <strong>{selectedVendor?.name}</strong> from your vendor network? This cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowDelete(false)}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={handleDelete}>Remove</Button>
        </div>
      </Modal>
    </div>
  );
};