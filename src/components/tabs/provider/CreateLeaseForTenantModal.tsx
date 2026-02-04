import { useState } from 'react';
import { isValidManifestAddress } from '../../../utils/address';
import { useLeaseItems } from '../../../hooks/useLeaseItems';
import { calculateEstimatedCost, isValidLeaseItem } from '../../../utils/pricing';
import { LeaseItemsEditor } from '../../ui/LeaseItemsEditor';
import { Modal } from '../../ui/Modal';
import type { CreateLeaseForTenantModalProps } from './types';

/**
 * Modal for billing module admins to create leases on behalf of tenants.
 * Note: metaHash parameter is supported by the API but intentionally omitted from
 * this UI for MVP. Add payload input similar to CreateLeaseModal if needed.
 */
export function CreateLeaseForTenantModal({ skus, onClose, onSubmit, loading }: CreateLeaseForTenantModalProps) {
  const [tenant, setTenant] = useState('');
  const [tenantTouched, setTenantTouched] = useState(false);
  const { items, addItem, removeItem, updateItem, getItemsForSubmit } = useLeaseItems();
  const [tenantError, setTenantError] = useState<string | null>(null);

  const handleTenantChange = (value: string) => {
    setTenant(value);
    setTenantTouched(true);
    if (!value) {
      setTenantError('Tenant address is required');
    } else if (!isValidManifestAddress(value)) {
      setTenantError('Invalid address format (expected manifest1...)');
    } else {
      setTenantError(null);
    }
  };

  const handleTenantBlur = () => {
    setTenantTouched(true);
    if (!tenant) {
      setTenantError('Tenant address is required');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // isFormValid ensures all items are valid before button is enabled
    if (tenant && !tenantError) {
      onSubmit(tenant, getItemsForSubmit());
    }
  };

  const estimatedCost = calculateEstimatedCost(items, skus);
  const isFormValid = tenant && !tenantError && items.every(isValidLeaseItem);

  return (
    <Modal isOpen onClose={() => { if (!loading) onClose(); }} title="Create Lease for Tenant" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Tenant Address */}
        <div>
          <label className="mb-1 block text-sm text-muted">Tenant Address</label>
          <input
            type="text"
            value={tenant}
            onChange={(e) => handleTenantChange(e.target.value)}
            onBlur={handleTenantBlur}
            placeholder="manifest1..."
            className="input w-full font-mono"
            required
            disabled={loading}
          />
          {tenantTouched && tenantError && (
            <p className="mt-1 text-xs text-error">{tenantError}</p>
          )}
        </div>

        {/* SKU Items */}
        <LeaseItemsEditor
          items={items}
          skus={skus}
          onAddItem={addItem}
          onRemoveItem={removeItem}
          onUpdateItem={updateItem}
          disabled={loading}
        />

        {/* Estimated Cost */}
        {estimatedCost && (
          <div className="rounded-lg bg-surface-800/50 p-3">
            <div className="text-sm text-muted">Estimated Cost</div>
            <div className="text-lg font-medium text-success">{estimatedCost}</div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !isFormValid}
            className="btn btn-primary"
          >
            {loading ? 'Creating...' : 'Create Lease'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
