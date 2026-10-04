/** WebSocket only signals invalidation. Re-fetch after every handshake so
 * connection gaps never require replaying private invitation payloads. */
export function subscribeSocialUpdates(options: {
  userId: string;
  ticket: () => Promise<{ ticket: string }>;
  invalidate: () => void;
  socket?: (url: string) => WebSocket;
}): () => void {
  let stopped = false, generation = 0, attempts = 0;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const disposeSocket = () => {
    clearTimeout(watchdog);
    if (socket) { socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); socket = undefined; }
  };
  const connect = async () => {
    const epoch = ++generation;
    let ready = false;
    const current = () => !stopped && generation === epoch;
    const lost = () => {
      if (!current()) return;
      generation++;
      disposeSocket();
      clearTimeout(retry);
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
      retry = setTimeout(() => void connect(), delay + Math.random() * delay / 4);
    };
    // Covers a stalled ticket request, socket handshake and a silent transport.
    const arm = (ms: number) => { clearTimeout(watchdog); watchdog = setTimeout(lost, ms); };
    arm(12000);
    try {
      const ticket = await options.ticket();
      if (!current()) return;
      const url = new URL('/ws/social', window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', ticket.ticket);
      socket = (options.socket ?? (url => new WebSocket(url)))(url.toString());
      socket.onclose = lost;
      socket.onerror = lost;
      socket.onmessage = event => {
        if (!current()) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 4096) throw new Error('Invalid frame');
          const data = JSON.parse(event.data) as { type: string; userId?: string };
          if (data.type === 'social.ready') {
            if (data.userId !== options.userId) throw new Error('Account changed');
            ready = true; attempts = 0; options.invalidate();
          } else if (ready && data.type === 'social.changed') options.invalidate();
          else if (!ready || data.type !== 'social.ping') throw new Error('Unknown message');
          arm(50000);
        } catch { lost(); }
      };
    } catch { lost(); }
  };
  const resume = () => {
    if (stopped || document.visibilityState === 'hidden') return;
    options.invalidate();
    if (!socket || socket.readyState > 1) { clearTimeout(retry); void connect(); }
  };
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', resume);
  void connect();
  return () => {
    stopped = true; generation++;
    clearTimeout(retry); disposeSocket();
    window.removeEventListener('online', resume);
    document.removeEventListener('visibilitychange', resume);
  };
}
