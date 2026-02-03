import { X } from 'lucide-react';
import { formatPrice } from '../../api/config';
import type { SKU } from '../../api/sku';
import type { LeaseItemWithId } from '../../hooks/useLeaseItems';

interface LeaseItemsEditorProps {
  items: LeaseItemWithId[];
  skus: SKU[];
  onAddItem: () => void;
  onRemoveItem: (id: string) => void;
  onUpdateItem: (id: string, field: 'skuUuid' | 'quantity', value: string | number) => void;
  disabled?: boolean;
  emptyMessage?: string;
}

export function LeaseItemsEditor({
  items,
  skus,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
  disabled,
  emptyMessage = 'No active SKUs available',
}: LeaseItemsEditorProps) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm text-muted">SKU Items</label>
        <button
          type="button"
          onClick={onAddItem}
          className="text-sm text-primary-400 hover:text-primary-300"
          disabled={disabled}
        >
          + Add Item
        </button>
      </div>
      {skus.length === 0 ? (
        <p className="text-sm text-dim">{emptyMessage}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="flex gap-2">
              <select
                value={item.skuUuid}
                onChange={(e) => onUpdateItem(item.id, 'skuUuid', e.target.value)}
                className="input select flex-1"
                required
                disabled={disabled}
              >
                <option value="">Select SKU...</option>
                {skus.map((sku) => (
                  <option key={sku.uuid} value={sku.uuid}>
                    {sku.name} ({formatPrice(sku.base_price.amount, sku.base_price.denom, sku.unit)})
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                value={item.quantity}
                onChange={(e) =>
                  onUpdateItem(item.id, 'quantity', Math.max(1, parseInt(e.target.value, 10) || 1))
                }
                className="input w-20"
                disabled={disabled}
              />
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveItem(item.id)}
                  className="px-2 text-error hover:text-error/80"
                  disabled={disabled}
                >
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
