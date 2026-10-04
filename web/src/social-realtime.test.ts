import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeSocialUpdates } from './social-realtime';

class Socket {
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  close = vi.fn(() => { this.readyState = 3; });
  emit(type: string, extra = {}) { this.onmessage?.({ data: JSON.stringify({ type, ...extra }) }); }
}

describe('account notifications', () => {
  const cleanup: Array<() => void> = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
  it('refreshes on connect/change/reconnect, never on heartbeat or a polling timer', async () => {
    const sockets: Socket[] = [];
    const ticket = vi.fn(async () => ({ ticket: 'one-time-ticket' }));
    const invalidate = vi.fn();
    cleanup.push(subscribeSocialUpdates({ userId: 'bob', ticket, invalidate,
      socket: url => { expect(url).toContain('/ws/social?ticket=one-time-ticket'); const s = new Socket(); sockets.push(s); return s as unknown as WebSocket; },
    }));
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emit('social.ready', { userId: 'bob' });
    sockets[0].emit('social.changed');
    await vi.advanceTimersByTimeAsync(31000);
    sockets[0].emit('social.ping');
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(ticket).toHaveBeenCalledTimes(1);
    sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(1300);
    sockets[1].emit('social.ready', { userId: 'bob' });
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(ticket).toHaveBeenCalledTimes(2);
  });
  it('rejects another account, cancels retries and ignores a late ticket after logout', async () => {
    const socket = new Socket();
    const invalidate = vi.fn();
    let resolve!: (value: { ticket: string }) => void;
    const ticket = vi.fn().mockResolvedValueOnce({ ticket: 'first' }).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const factory = vi.fn(() => socket as unknown as WebSocket);
    const stop = subscribeSocialUpdates({ userId: 'bob', ticket, invalidate, socket: factory });
    cleanup.push(stop);
    await vi.advanceTimersByTimeAsync(0);
    socket.emit('social.ready', { userId: 'alice' });
    expect(socket.close).toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1300);
    stop(); resolve({ ticket: 'late' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(ticket).toHaveBeenCalledTimes(2);
  });
  it('detects half-open connections through the heartbeat deadline', async () => {
    const socket = new Socket();
    const ticket = vi.fn(async () => ({ ticket: 'ticket' }));
    cleanup.push(subscribeSocialUpdates({ userId: 'bob', ticket, invalidate: () => {}, socket: () => socket as unknown as WebSocket }));
    await vi.advanceTimersByTimeAsync(0);
    socket.emit('social.ready', { userId: 'bob' });
    await vi.advanceTimersByTimeAsync(52000);
    expect(socket.close).toHaveBeenCalled();
    expect(ticket).toHaveBeenCalledTimes(2);
  });
});
