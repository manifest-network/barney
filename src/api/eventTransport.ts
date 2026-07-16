/**
 * Browser `EventTransport` for the SDK's `waitForLeaseStatus` live-status path.
 *
 * This is the ONLY barney-local WebSocket code that survives ENG-312: the SDK
 * owns the reconnect / backoff / liveness / poll-fallback state machine and
 * hands us one URL to open per connection. We only reshape that URL for the dev
 * CORS proxy (prod connects directly, SSRF-validated) and adapt the native
 * browser `WebSocket` to the SDK's minimal `EventSocket` handle.
 *
 * The SDK supplies `wss://<provider>/v1/leases/{uuid}/events?token=<adr036>`
 * (auth rides in the query string — WebSocket clients can't set headers).
 */

import type { EventTransport, EventSocket } from '@manifest-network/manifest-sdk';
import { validateProviderUrl } from '@manifest-network/manifest-sdk/deploy';

export const browserEventTransport: EventTransport = {
  open(url: string): EventSocket {
    const u = new URL(url);
    const httpBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    let shaped: string;

    if (import.meta.env.DEV) {
      // Dev: tunnel through rsbuild's /proxy-provider (the router reads the
      // `target` query param when the X-Proxy-Target header is absent — WS
      // can't set headers). Preserve the SDK's path + existing query (`token`).
      const wsBase = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
      const sep = u.search ? '&' : '?';
      shaped = `${wsBase}/proxy-provider${u.pathname}${u.search}${sep}target=${encodeURIComponent(httpBase)}`;
    } else {
      // Prod: SSRF-validate the http-equivalent, then connect directly.
      validateProviderUrl(httpBase, { allowLoopback: false });
      shaped = u.toString();
    }

    const ws = new WebSocket(shaped);
    return {
      onMessage: (l) => ws.addEventListener('message', (e) => l(String(e.data))),
      onOpen: (l) => ws.addEventListener('open', () => l()),
      onClose: (l) => ws.addEventListener('close', (e) => l(e.code, e.reason)),
      onError: (l) => ws.addEventListener('error', () => l(new Error('WebSocket error'))),
      close: (code) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code);
      },
    };
  },
};
