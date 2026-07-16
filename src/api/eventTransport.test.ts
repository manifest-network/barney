import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { browserEventTransport } from './eventTransport';

// Minimal native-WebSocket stub: captures the shaped URL and lets tests drive
// the browser events the EventSocket adapts. Exposes the OPEN/CONNECTING static
// constants eventTransport.close() reads.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  closeArgs: Array<number | undefined> = [];
  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, l: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(l);
  }
  emit(type: string, e?: unknown) {
    (this.listeners[type] ?? []).forEach((l) => l(e));
  }
  close(code?: number) {
    this.closeArgs.push(code);
    this.readyState = MockWebSocket.CLOSED;
  }
}

const PROVIDER_WS_URL = 'wss://fred.example.com/v1/leases/abc-123/events?token=TOK';

describe('browserEventTransport (dev)', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // vitest runs with import.meta.env.DEV === true, so these exercise the dev
  // /proxy-provider path. The prod branch (direct connect + SSRF validate) is
  // not unit-testable here (import.meta.env.DEV is not stubbable), matching the
  // pre-ENG-312 buildFredWsUrl coverage.
  it('reshapes the provider wss URL through /proxy-provider, preserving token + adding target', () => {
    browserEventTransport.open(PROVIDER_WS_URL);
    const ws = MockWebSocket.instances.at(-1)!;

    expect(ws.url).toContain('/proxy-provider/v1/leases/abc-123/events');
    expect(ws.url).toContain('token=TOK');
    expect(ws.url).toContain(`target=${encodeURIComponent('https://fred.example.com')}`);
    // Connects to the app origin, not straight to the provider host.
    expect(ws.url).not.toContain('fred.example.com/v1');
  });

  it('appends target with & when the SDK URL already has a query', () => {
    browserEventTransport.open('wss://p.example.com/v1/leases/x/events?token=T&foo=bar');
    const ws = MockWebSocket.instances.at(-1)!;
    expect(ws.url).toContain('token=T&foo=bar&target=');
  });

  it('forwards WebSocket events to the EventSocket listeners', () => {
    const socket = browserEventTransport.open(PROVIDER_WS_URL);
    const ws = MockWebSocket.instances.at(-1)!;

    const messages: string[] = [];
    let opened = false;
    let closed: [number, string] | null = null;
    let errored: Error | null = null;
    socket.onMessage((d) => messages.push(d));
    socket.onOpen(() => { opened = true; });
    socket.onClose((code, reason) => { closed = [code, reason]; });
    socket.onError((e) => { errored = e; });

    ws.emit('open');
    ws.emit('message', { data: '{"status":"ready"}' });
    ws.emit('error');
    ws.emit('close', { code: 1000, reason: 'done' });

    expect(opened).toBe(true);
    expect(messages).toEqual(['{"status":"ready"}']);
    expect(errored).toBeInstanceOf(Error);
    expect(closed).toEqual([1000, 'done']);
  });

  it('close() only closes an OPEN/CONNECTING socket and is idempotent', () => {
    const socket = browserEventTransport.open(PROVIDER_WS_URL);
    const ws = MockWebSocket.instances.at(-1)!;
    ws.readyState = MockWebSocket.OPEN;

    socket.close(1000);
    socket.close(1000); // already CLOSED → no-op

    expect(ws.closeArgs).toEqual([1000]);
  });
});
