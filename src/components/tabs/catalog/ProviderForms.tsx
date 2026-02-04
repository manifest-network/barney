import { useState } from 'react';
import type { CreateProviderFormProps, EditProviderFormProps } from './types';

export function CreateProviderForm({
  defaultAddress,
  onSubmit,
  onClose,
}: CreateProviderFormProps) {
  const [address, setAddress] = useState(defaultAddress || '');
  const [payoutAddress, setPayoutAddress] = useState(defaultAddress || '');
  const [apiUrl, setApiUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ address, payoutAddress, apiUrl });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm text-muted">Management Address</label>
        <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="manifest1..." required className="input" />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Payout Address</label>
        <input type="text" value={payoutAddress} onChange={(e) => setPayoutAddress(e.target.value)} placeholder="manifest1..." required className="input" />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">API URL</label>
        <input type="url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://..." className="input" />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={submitting || !address || !payoutAddress} className="btn btn-primary">
          {submitting ? 'Creating...' : 'Create Provider'}
        </button>
      </div>
    </form>
  );
}

export function EditProviderForm({
  provider,
  onSubmit,
  onClose,
}: EditProviderFormProps) {
  const [address, setAddress] = useState(provider.address);
  const [payoutAddress, setPayoutAddress] = useState(provider.payoutAddress);
  const [apiUrl, setApiUrl] = useState(provider.apiUrl || '');
  const [active, setActive] = useState(provider.active);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ uuid: provider.uuid, address, payoutAddress, apiUrl, active });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded bg-surface-800/50 p-3 text-xs text-muted font-mono">{provider.uuid}</div>
      <div>
        <label className="mb-1 block text-sm text-muted">Management Address</label>
        <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="manifest1..." required className="input" />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Payout Address</label>
        <input type="text" value={payoutAddress} onChange={(e) => setPayoutAddress(e.target.value)} placeholder="manifest1..." required className="input" />
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">API URL</label>
        <input type="url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://..." className="input" />
      </div>
      <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 rounded border-surface-500 bg-surface-700" />
        Active
      </label>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={submitting || !address || !payoutAddress} className="btn btn-primary">
          {submitting ? 'Updating...' : 'Update Provider'}
        </button>
      </div>
    </form>
  );
}
