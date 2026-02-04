/**
 * Modal for creating a new lease with SKU selection and optional payload upload.
 */

import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { truncateAddress } from '../../../utils/address';
import { useLeaseItems } from '../../../hooks/useLeaseItems';
import { calculateEstimatedCost, isValidLeaseItem } from '../../../utils/pricing';
import { sha256, toHex, validatePayloadSize, getPayloadSize, MAX_PAYLOAD_SIZE } from '../../../utils/hash';
import { validateFile } from '../../../utils/fileValidation';
import { LeaseItemsEditor } from '../../ui/LeaseItemsEditor';
import type { CreateLeaseModalProps } from './types';

export function CreateLeaseModal({
  providers,
  skus,
  onClose,
  onSubmit,
  loading,
}: CreateLeaseModalProps) {
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const { items, addItem, removeItem, updateItem, resetItems, getItemsForSubmit } = useLeaseItems();
  const [payloadText, setPayloadText] = useState('');
  const [payloadHash, setPayloadHash] = useState<string | null>(null);
  const [payloadError, setPayloadError] = useState<string | null>(null);

  const payloadHashBytesRef = useRef<Uint8Array | null>(null);
  const hashedPayloadTextRef = useRef<string | null>(null);

  const providerSKUs = selectedProvider
    ? skus.filter((s) => s.providerUuid === selectedProvider)
    : [];

  useEffect(() => {
    const computeHash = async () => {
      if (!payloadText) {
        setPayloadHash(null);
        setPayloadError(null);
        payloadHashBytesRef.current = null;
        hashedPayloadTextRef.current = null;
        return;
      }

      if (!validatePayloadSize(payloadText)) {
        setPayloadHash(null);
        setPayloadError(`Payload exceeds maximum size of ${MAX_PAYLOAD_SIZE / 1024}KB`);
        payloadHashBytesRef.current = null;
        hashedPayloadTextRef.current = null;
        return;
      }

      try {
        const hash = await sha256(payloadText);
        setPayloadHash(toHex(hash));
        payloadHashBytesRef.current = hash;
        hashedPayloadTextRef.current = payloadText;
        setPayloadError(null);
      } catch {
        setPayloadHash(null);
        setPayloadError('Failed to compute hash');
        payloadHashBytesRef.current = null;
        hashedPayloadTextRef.current = null;
      }
    };

    computeHash();
  }, [payloadText]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validation = validateFile(file);
    if (!validation.valid) {
      setPayloadError(validation.error || 'Invalid file');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result === 'string') {
        setPayloadText(result);
      } else {
        setPayloadError('Failed to read file as text');
      }
    };
    reader.onerror = () => {
      setPayloadError('Failed to read file');
    };
    reader.readAsText(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Button is disabled until all items are valid, so no filtering needed
    const submitItems = getItemsForSubmit();
    if (payloadText && payloadHash && payloadHashBytesRef.current) {
      if (hashedPayloadTextRef.current !== payloadText) {
        const hash = await sha256(payloadText);
        payloadHashBytesRef.current = hash;
        hashedPayloadTextRef.current = payloadText;
      }

      const payloadBytes = new TextEncoder().encode(hashedPayloadTextRef.current!);
      onSubmit(submitItems, payloadBytes, payloadHashBytesRef.current, selectedProvider);
    } else {
      onSubmit(submitItems);
    }
  };

  const estimatedCost = calculateEstimatedCost(items, skus);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card-static w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-surface-700 bg-surface-900/95 backdrop-blur">
          <h3 className="text-lg font-heading font-semibold">Create Lease</h3>
          <button
            onClick={onClose}
            className="text-muted hover:text-primary p-1"
            disabled={loading}
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Provider Selection */}
          <div>
            <label className="mb-1 block text-sm text-muted">Provider</label>
            <select
              value={selectedProvider}
              onChange={(e) => {
                setSelectedProvider(e.target.value);
                resetItems();
              }}
              className="input select w-full"
              required
              disabled={loading}
            >
              <option value="">Select a provider...</option>
              {providers.map((p) => (
                <option key={p.uuid} value={p.uuid}>
                  {truncateAddress(p.address)}
                </option>
              ))}
            </select>
          </div>

          {/* SKU Items */}
          {selectedProvider && (
            <LeaseItemsEditor
              items={items}
              skus={providerSKUs}
              onAddItem={addItem}
              onRemoveItem={removeItem}
              onUpdateItem={updateItem}
              disabled={loading}
              emptyMessage="No active SKUs for this provider"
            />
          )}

          {/* Deployment Payload */}
          {selectedProvider && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-sm text-muted">Deployment Payload (optional)</label>
                <label className="cursor-pointer text-sm text-primary-400 hover:text-primary-300">
                  <input
                    type="file"
                    onChange={handleFileUpload}
                    className="hidden"
                    accept=".yaml,.yml,.json,.txt"
                    disabled={loading}
                  />
                  Upload File
                </label>
              </div>
              <textarea
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                placeholder="Paste your deployment manifest here..."
                rows={4}
                className="input w-full font-mono text-sm"
                disabled={loading}
              />
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className={payloadError ? 'text-error' : 'text-dim'}>
                  {payloadError || `${getPayloadSize(payloadText).toLocaleString()} / ${(MAX_PAYLOAD_SIZE / 1024).toFixed(0)}KB`}
                </span>
                {payloadHash && (
                  <span className="font-mono text-dim" title={payloadHash}>
                    SHA-256: {payloadHash.slice(0, 12)}...
                  </span>
                )}
              </div>
            </div>
          )}

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
              disabled={loading || !selectedProvider || !items.every(isValidLeaseItem) || !!payloadError}
              className="btn btn-primary"
            >
              {loading ? 'Creating...' : 'Create Lease'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
