import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolResultCard } from './ToolResultCard';

describe('ToolResultCard', () => {
  it('renders string data as-is', () => {
    const html = renderToStaticMarkup(
      createElement(ToolResultCard, { toolName: 'get_balance', success: true, data: '{"credits": 100}' })
    );
    expect(html).toContain('{&quot;credits&quot;: 100}');
  });

  it('renders BigInt-containing data without throwing', () => {
    const data = {
      creditAccount: { activeLeaseCount: 3n, pendingLeaseCount: 0n },
      estimatedDurationSeconds: 86400n,
    };

    const html = renderToStaticMarkup(
      createElement(ToolResultCard, { toolName: 'cosmos_query', success: true, data })
    );

    expect(html).toContain('&quot;activeLeaseCount&quot;: &quot;3&quot;');
    expect(html).toContain('&quot;pendingLeaseCount&quot;: &quot;0&quot;');
    expect(html).toContain('&quot;estimatedDurationSeconds&quot;: &quot;86400&quot;');
  });
});
