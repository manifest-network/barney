import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressCard } from './ProgressCard';

describe('ProgressCard unknown maintenance outcome', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => vi.unstubAllGlobals());

  it.each(['restart', 'update'] as const)('shows a settled neutral %s outcome rather than success or failure', (operation) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const interval = vi.spyOn(globalThis, 'setInterval');
    try {
      act(() => root.render(<ProgressCard progress={{ phase: 'unconfirmed', operation,
        detail: 'Recover the original command before another request.',
        batch: [{ name: 'web', phase: 'unconfirmed', detail: 'Response lost' }] }} />));
      expect(container.querySelector('.progress-card__title')?.textContent).toBe('Outcome unknown');
      expect(container.textContent).toContain('Response lost');
      expect(container.textContent).not.toContain('Restarted!');
      expect(container.textContent).not.toContain('Updated!');
      expect(container.textContent).not.toContain('Failed');
      expect(container.querySelector('.animate-spin')).toBeNull();
      expect(container.querySelector('.text-success-400')).toBeNull();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      interval.mockRestore();
    }
  });
});
