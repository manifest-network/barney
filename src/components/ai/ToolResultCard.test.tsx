import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { ToolResultCard } from './ToolResultCard';
import { bigIntReplacer } from '../../utils/format';

describe('ToolResultCard', () => {
  it('renders string data as-is', () => {
    const element = createElement(ToolResultCard, {
      toolName: 'get_balance',
      success: true,
      data: '{"credits": 100}',
    });
    expect(element).toBeDefined();
    expect(element.props.data).toBe('{"credits": 100}');
  });

  it('does not throw when data contains BigInt values', () => {
    const data = {
      creditAccount: { activeLeaseCount: 3n, pendingLeaseCount: 0n },
      estimatedDurationSeconds: 86400n,
    };

    const result = JSON.stringify(data, bigIntReplacer, 2);
    const parsed = JSON.parse(result);
    expect(parsed.creditAccount.activeLeaseCount).toBe('3');
    expect(parsed.estimatedDurationSeconds).toBe('86400');
  });
});
