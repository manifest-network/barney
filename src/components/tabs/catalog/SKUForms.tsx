import { useState } from 'react';
import { truncateAddress } from '../../../utils/address';
import { Unit, DENOMS } from '../../../api';
import type { CreateSKUFormProps, EditSKUFormProps } from './types';

export function CreateSKUForm({
  providers,
  onSubmit,
  onClose,
}: CreateSKUFormProps) {
  const activeProviders = providers.filter((p) => p.active);
  const [providerUuid, setProviderUuid] = useState(activeProviders[0]?.uuid || '');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<number>(Unit.UNIT_PER_HOUR);
  const [priceAmount, setPriceAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ providerUuid, name, unit, priceAmount, priceDenom: DENOMS.PWR });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm text-muted">Provider</label>
        <select value={providerUuid} onChange={(e) => setProviderUuid(e.target.value)} required className="input select">
          {activeProviders.map((p) => (
            <option key={p.uuid} value={p.uuid}>{truncateAddress(p.address)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Small VM" required className="input" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm text-muted">Price (uPWR)</label>
          <input type="number" value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} placeholder="1000000" required min="1" className="input" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">Unit</label>
          <select value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="input select">
            <option value={Unit.UNIT_PER_HOUR}>Per Hour</option>
            <option value={Unit.UNIT_PER_DAY}>Per Day</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={submitting || !providerUuid || !name || !priceAmount} className="btn btn-success">
          {submitting ? 'Creating...' : 'Create SKU'}
        </button>
      </div>
    </form>
  );
}

export function EditSKUForm({
  sku,
  providers,
  onSubmit,
  onClose,
}: EditSKUFormProps) {
  const [providerUuid, setProviderUuid] = useState(sku.providerUuid);
  const [name, setName] = useState(sku.name);
  const [unit, setUnit] = useState<number>(sku.unit);
  const [priceAmount, setPriceAmount] = useState(sku.basePrice.amount);
  const [active, setActive] = useState(sku.active);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit({ uuid: sku.uuid, providerUuid, name, unit, priceAmount, priceDenom: sku.basePrice.denom, active });
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded bg-surface-800/50 p-3 text-xs text-muted font-mono">{sku.uuid}</div>
      <div>
        <label className="mb-1 block text-sm text-muted">Provider</label>
        <select value={providerUuid} onChange={(e) => setProviderUuid(e.target.value)} required className="input select">
          {providers.map((p) => (
            <option key={p.uuid} value={p.uuid}>{truncateAddress(p.address)}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-sm text-muted">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Small VM" required className="input" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm text-muted">Price (uPWR)</label>
          <input type="number" value={priceAmount} onChange={(e) => setPriceAmount(e.target.value)} placeholder="1000000" required min="1" className="input" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-muted">Unit</label>
          <select value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="input select">
            <option value={Unit.UNIT_PER_HOUR}>Per Hour</option>
            <option value={Unit.UNIT_PER_DAY}>Per Day</option>
          </select>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 rounded border-surface-500 bg-surface-700" />
        Active
      </label>
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="submit" disabled={submitting || !providerUuid || !name || !priceAmount} className="btn btn-primary">
          {submitting ? 'Updating...' : 'Update SKU'}
        </button>
      </div>
    </form>
  );
}
