import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { IncomingMessage, Server as HttpServer } from 'http';
import { Socket } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { AppConfig } from '../config';
import { readEventsAfter } from '../collaboration/events';
import {
  hashPublicWsTicket,
  projectPublicEvent,
  publicShareFeatureAvailable,
} from '../collaboration/public';
import {
  CollaborationRealtimeHub,
  getRealtimeHub,
  RealtimeConnection,
} from '../collaboration/realtime';
import { getRuntimeMetrics, RuntimeMetrics } from '../operations/metrics';
import { getSocialRealtimeHub } from '../social/realtime';
import { AppError } from '../errors/app-error';

interface MemberTicketRow {
  id: string;
  session_id: string;
  user_id: string;
  issued_role: string;
  issued_membership_version: number;
  device_id: string;
  auth_session_id: string | null;
  access_expires_at: string | null;
  after_seq: number;
  expires_at: string;
  consumed_at: string | null;
  role: string;
  membership_version: number;
  removed_at: string | null;
  status: string;
  deleted_at: string | null;
  event_seq: number;
  min_retained_seq: number;
  account_disabled_at: string | null;
  account_deleted_at: string | null;
  must_change_password: number;
  auth_session_active: number;
}

interface PublicTicketRow {
  id: string;
  public_share_id: string;
  access_token_id: string;
  view_session_hash: string | null;
  after_seq: number;
  expires_at: string;
  authorization_expires_at: string;
  consumed_at: string | null;
  session_id: string;
  share_expires_at: string;
  share_revoked_at: string | null;
  status: string;
  deleted_at: string | null;
  event_seq: number;
  min_retained_seq: number;
}

type ConsumedTicket =
  | { audience: 'member'; row: MemberTicketRow }
  | { audience: 'public'; row: PublicTicketRow };

export interface CollaborationWsDependencies {
  db: Database.Database;
  config: AppConfig;
  hub?: CollaborationRealtimeHub;
}

export interface CollaborationWsController {
  wss: WebSocketServer;
  close(): void;
}

interface AttemptCounter {
  count: number;
  resetAt: number;
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_CONNECTIONS_PER_SESSION = 100;
const MAX_CONNECTIONS_PER_USER = 8;
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_CONNECT_ATTEMPTS_PER_IP_MINUTE = 30;
const MAX_WS_BACKLOG_EVENTS = 1_000;
const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_PUBLIC_CONNECTIONS_PER_SESSION = 100;
const MAX_PUBLIC_CONNECTIONS_PER_SHARE = 50;
const MAX_PUBLIC_CONNECTIONS_PER_IP = 20;

function ticketHash(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

function forwardedValues(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(',') : value;
  return raw?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
}

function trustsForwardedHeaders(config: AppConfig): boolean {
  return config.trustProxy === true ||
    (typeof config.trustProxy === 'number' && config.trustProxy > 0);
}

function requestIp(req: IncomingMessage, config: AppConfig): string {
  const remote = req.socket.remoteAddress || 'unknown';
  if (!trustsForwardedHeaders(config)) return remote;
  const forwarded = forwardedValues(req.headers['x-forwarded-for']);
  if (forwarded.length === 0) return remote;
  if (config.trustProxy === true) return forwarded[0];
  const trustedHops = typeof config.trustProxy === 'number' ? config.trustProxy : 0;
  const closestFirst = [remote, ...forwarded.reverse()];
  return closestFirst[Math.min(trustedHops, closestFirst.length - 1)];
}

function forwardedProxyMetadata(
  value: string | string[] | undefined,
  config: AppConfig,
): string | undefined {
  const forwarded = forwardedValues(value);
  if (forwarded.length === 0 || !trustsForwardedHeaders(config)) return undefined;
  return config.trustProxy === true ? forwarded[0] : forwarded[forwarded.length - 1];
}

function isAllowedOrigin(req: IncomingMessage, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.corsOrigins.includes(origin)) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = forwardedProxyMetadata(req.headers['x-forwarded-host'], config);
    const host = forwardedHost || req.headers.host;
    if (!host) return false;
    const forwardedProtocol = forwardedProxyMetadata(req.headers['x-forwarded-proto'], config);
    const encrypted = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted);
    const protocol = forwardedProtocol || (encrypted ? 'https' : 'http');
    return originUrl.origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Socket, status: number, reason: string, retryAfter?: number): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const statusText: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    503: 'Service Unavailable',
  };
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${statusText[status] || 'Error'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      (retryAfter === undefined ? '' : `Retry-After: ${retryAfter}\r\n`) +
      '\r\n' +
      body,
  );
}

function readTicket(
  db: Database.Database,
  hash: string,
  now: string,
): MemberTicketRow | undefined {
  return db.prepare(`
    SELECT
      t.*,
      sm.role,
      sm.version AS membership_version,
      sm.removed_at,
      s.status,
      s.deleted_at,
      s.event_seq,
      s.min_retained_seq,
      u.disabled_at AS account_disabled_at,
      u.deleted_at AS account_deleted_at,
      u.must_change_password,
      EXISTS (
        SELECT 1
        FROM refresh_tokens rt
        WHERE rt.user_id = t.user_id
          AND rt.auth_session_id = t.auth_session_id
          AND rt.revoked_at IS NULL
          AND rt.expires_at > ?
      ) AS auth_session_active
    FROM ws_tickets t
    JOIN session_members sm
      ON sm.session_id = t.session_id AND sm.user_id = t.user_id
    JOIN sessions s ON s.id = t.session_id
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(now, hash) as MemberTicketRow | undefined;
}

function memberTicketIsActive(
  row: MemberTicketRow | undefined,
  now: string,
): row is MemberTicketRow {
  return Boolean(
    row &&
    !row.consumed_at &&
    row.expires_at > now &&
    !row.removed_at &&
    row.issued_role === row.role &&
    Number(row.issued_membership_version) === Number(row.membership_version) &&
    !row.deleted_at &&
    !row.account_disabled_at &&
    !row.account_deleted_at &&
    Number(row.must_change_password) === 0 &&
    (row.auth_session_id === null || Number(row.auth_session_active) === 1) &&
    (row.auth_session_id !== null || (
      row.access_expires_at !== null && row.access_expires_at > now
    )) &&
    !(row.status === 'initializing' && row.role !== 'owner')
  );
}

function consumeTicket(db: Database.Database, hash: string): MemberTicketRow | undefined {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const row = readTicket(db, hash, now);
    if (!memberTicketIsActive(row, now)) return undefined;
    const consumed = db.prepare(`
      UPDATE ws_tickets SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).run(now, row.id, now);
    return consumed.changes === 1 ? row : undefined;
  }).immediate();
}

function readPublicTicket(
  db: Database.Database,
  hash: string,
): PublicTicketRow | undefined {
  return db.prepare(`
    SELECT
      t.*,
      ps.session_id,
      ps.expires_at AS share_expires_at,
      ps.revoked_at AS share_revoked_at,
      s.status,
      s.deleted_at,
      s.event_seq,
      s.min_retained_seq
    FROM public_ws_tickets t
    JOIN public_shares ps ON ps.id = t.public_share_id
    JOIN sessions s ON s.id = ps.session_id
    WHERE t.token_hash = ?
  `).get(hash) as PublicTicketRow | undefined;
}

function publicTicketIsActive(row: PublicTicketRow | undefined, now: string): row is PublicTicketRow {
  return Boolean(
    row &&
    !row.consumed_at &&
    row.expires_at > now &&
    row.authorization_expires_at > now &&
    !row.share_revoked_at &&
    row.share_expires_at > now &&
    !row.deleted_at &&
    (row.status === 'active' || row.status === 'closed'),
  );
}

function consumePublicTicket(
  db: Database.Database,
  hash: string,
): PublicTicketRow | undefined {
  return db.transaction(() => {
    const row = readPublicTicket(db, hash);
    const now = new Date().toISOString();
    if (!publicTicketIsActive(row, now)) return undefined;
    const consumed = db.prepare(`
      UPDATE public_ws_tickets
      SET consumed_at = ?
      WHERE id = ?
        AND consumed_at IS NULL
        AND expires_at > ?
        AND authorization_expires_at > ?
    `).run(now, row.id, now, now);
    if (consumed.changes !== 1) return undefined;
    db.prepare('DELETE FROM public_ws_tickets WHERE id = ?').run(row.id);
    return row;
  }).immediate();
}

function publicConnectionIsActive(
  db: Database.Database,
  config: AppConfig,
  publicShareId: string,
  authorizationExpiresAt: string,
): boolean {
  const now = new Date().toISOString();
  if (
    authorizationExpiresAt <= now ||
    !publicShareFeatureAvailable(db, config)
  ) return false;
  return Boolean(db.prepare(`
    SELECT 1
    FROM public_shares ps
    JOIN sessions s ON s.id = ps.session_id
    WHERE ps.id = ?
      AND ps.revoked_at IS NULL
      AND ps.expires_at > ?
      AND s.deleted_at IS NULL
      AND s.status IN ('active', 'closed')
  `).get(publicShareId, now));
}

function memberConnectionIsActive(
  db: Database.Database,
  sessionId: string,
  userId: string,
  authSessionId?: string,
): boolean {
  const now = new Date().toISOString();
  return Boolean(db.prepare(`
    SELECT 1
    FROM users u
    JOIN session_members sm
      ON sm.user_id = u.id AND sm.session_id = ? AND sm.removed_at IS NULL
    JOIN sessions s ON s.id = sm.session_id
    WHERE u.id = ?
      AND u.disabled_at IS NULL
      AND u.deleted_at IS NULL
      AND u.must_change_password = 0
      AND s.deleted_at IS NULL
      AND (s.status <> 'initializing' OR sm.role = 'owner')
      AND (
        ? IS NULL OR EXISTS (
          SELECT 1
          FROM refresh_tokens rt
          WHERE rt.user_id = u.id
            AND rt.auth_session_id = ?
            AND rt.revoked_at IS NULL
            AND rt.expires_at > ?
        )
      )
  `).get(sessionId, userId, authSessionId ?? null, authSessionId ?? null, now));
}

class WebSocketRealtimeConnection implements RealtimeConnection {
  private cursor: number;
  private catchingUp = true;
  private readonly buffered = new Map<number, Parameters<RealtimeConnection['deliver']>[0]>();
  private unsubscribe?: () => void;
  private alive = true;
  private expiryTimer?: NodeJS.Timeout;
  readonly audience: 'member' | 'public';
  readonly sessionId: string;
  readonly userId?: string;
  readonly authSessionId?: string;
  readonly publicShareId?: string;
  readonly publicViewSessionHash?: string;
  readonly ipAddress: string;
  readonly authorizationExpiresAt?: string;

  constructor(
    private readonly ws: WebSocket,
    private readonly metrics: RuntimeMetrics,
    input: {
      audience: 'member' | 'public';
      sessionId: string;
      userId?: string;
      authSessionId?: string;
      publicShareId?: string;
      publicViewSessionHash?: string;
      ipAddress: string;
      afterSeq: number;
      authorizationExpiresAt?: string;
    },
  ) {
    this.audience = input.audience;
    this.sessionId = input.sessionId;
    this.userId = input.userId;
    this.authSessionId = input.authSessionId;
    this.publicShareId = input.publicShareId;
    this.publicViewSessionHash = input.publicViewSessionHash;
    this.ipAddress = input.ipAddress;
    this.authorizationExpiresAt = input.authorizationExpiresAt;
    this.cursor = input.afterSeq;
    if (input.authorizationExpiresAt) {
      const delay = Math.max(0, Date.parse(input.authorizationExpiresAt) - Date.now());
      this.expiryTimer = setTimeout(
        () => this.revoke(
          this.audience === 'public' ? 'PUBLIC_ACCESS_EXPIRED' : 'ACCESS_TOKEN_EXPIRED',
        ),
        delay,
      );
      this.expiryTimer.unref();
    }
  }

  setUnsubscribe(unsubscribe: () => void): void {
    this.unsubscribe = unsubscribe;
  }

  markPong(): void {
    this.alive = true;
  }

  ping(): void {
    if (!this.alive) {
      this.ws.terminate();
      return;
    }
    this.alive = false;
    try {
      this.ws.ping();
    } catch {
      this.ws.terminate();
    }
  }

  private send(message: unknown, kind: 'control' | 'event' = 'control'): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      this.ws.close(4009, 'Slow consumer must resynchronize');
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      if (kind === 'event') this.metrics.recordEventDeliveryFailure();
      else this.metrics.recordWebSocketControlDeliveryFailure(this.audience);
      this.ws.terminate();
      return false;
    }
  }

  private sendResyncRequired(minAvailableSeq: number, closeReason: string): void {
    if (!this.send({ type: 'resyncRequired', minAvailableSeq })) return;
    this.metrics.recordWebSocketResync(this.audience);
    this.ws.close(4009, closeReason);
  }

  sendHello(headSeq: number): void {
    this.send({
      type: 'hello',
      sessionId: this.sessionId,
      headSeq,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });
  }

  sendBacklog(events: ReturnType<typeof readEventsAfter>, headSeq: number): void {
    for (const event of events) {
      if (event.seq <= this.cursor) continue;
      if (event.seq !== this.cursor + 1) {
        this.sendResyncRequired(event.seq, 'Event sequence gap');
        return;
      }
      if (!this.send({ type: 'event', event: this.wireEvent(event) }, 'event')) return;
      this.metrics.recordWsBacklogSent(this.audience);
      this.cursor = event.seq;
    }
    if (this.cursor !== headSeq) {
      this.sendResyncRequired(this.cursor + 1, 'Event sequence gap');
      return;
    }
    this.send({ type: 'ready', cursor: this.cursor });
    this.catchingUp = false;
    const buffered = [...this.buffered.values()].sort((left, right) => left.seq - right.seq);
    this.buffered.clear();
    for (const event of buffered) this.deliver(event);
  }

  resyncRequired(minAvailableSeq: number): void {
    this.sendResyncRequired(minAvailableSeq, 'Cursor expired');
  }

  deliver(event: Parameters<RealtimeConnection['deliver']>[0]): void {
    if (this.catchingUp) {
      this.buffered.set(event.seq, event);
      return;
    }
    if (event.seq <= this.cursor) return;
    if (event.seq !== this.cursor + 1) {
      this.sendResyncRequired(this.cursor + 1, 'Event sequence gap');
      return;
    }
    try {
      if (this.send({ type: 'event', event: this.wireEvent(event) }, 'event')) {
        this.metrics.recordWsLiveSent(this.audience);
        this.cursor = event.seq;
      }
    } catch (error) {
      this.metrics.recordEventDeliveryFailure();
      throw error;
    }
  }

  deliverControl(message: Parameters<RealtimeConnection['deliverControl']>[0]): void {
    // Live-draft messages are member-only and deliberately have no Session event
    // sequence. They are an invalidation/low-latency channel; reconnecting clients
    // recover the authoritative persisted draft through HTTP.
    if (this.audience !== 'member') return;
    if (!this.send(message, 'control')) {
      throw new Error('Could not deliver member control message');
    }
  }

  private wireEvent(event: Parameters<RealtimeConnection['deliver']>[0]) {
    return this.audience === 'public' ? projectPublicEvent(event) : event;
  }

  revoke(reason: string): void {
    this.metrics.recordWebSocketRevoked(this.audience);
    this.send({ type: 'accessRevoked', reason });
    this.ws.close(4003, reason.slice(0, 123));
  }

  membershipChanged(role: string, membershipVersion: number): void {
    this.send({ type: 'membershipChanged', role, membershipVersion });
    this.ws.close(4003, 'Membership changed');
  }

  sessionDeleted(): void {
    this.dispose();
    this.ws.close(1000, 'Session deleted');
  }

  streamFailed(): void {
    this.metrics.recordEventDeliveryFailure();
    this.dispose();
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1011, 'Event stream unavailable');
    } else {
      this.ws.terminate();
    }
  }

  dispose(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  close(): void {
    this.dispose();
    this.ws.terminate();
  }
}

export function createCollaborationWsServer(
  server: HttpServer,
  dependencies: CollaborationWsDependencies,
): CollaborationWsController {
  const { db, config } = dependencies;
  const hub = dependencies.hub ?? getRealtimeHub(db);
  const socialHub = getSocialRealtimeHub(db);
  const metrics = getRuntimeMetrics(db);
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    // Clients never send business messages on this event-only channel. Keep the
    // parser ceiling tiny so a valid ticket cannot be used to buffer large frames.
    maxPayload: 4_096,
  });
  const attempts = new Map<string, AttemptCounter>();
  const liveConnections = new Set<WebSocketRealtimeConnection>();
  let lastUntrustedProxyWarningAt = 0;

  const heartbeat = setInterval(() => {
    socialHub.heartbeat();
    for (const connection of [...liveConnections]) {
      if (
        connection.audience === 'member' &&
        connection.userId &&
        !memberConnectionIsActive(
          db,
          connection.sessionId,
          connection.userId,
          connection.authSessionId,
        )
      ) {
        connection.revoke('AUTHENTICATION_EXPIRED');
        continue;
      }
      if (
        connection.audience === 'public' &&
        connection.publicShareId &&
        connection.authorizationExpiresAt &&
        !publicConnectionIsActive(
          db,
          config,
          connection.publicShareId,
          connection.authorizationExpiresAt,
        )
      ) {
        connection.revoke('PUBLIC_ACCESS_EXPIRED');
        continue;
      }
      connection.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const upgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Invalid WebSocket URL');
      return;
    }
    const audience = url.pathname === '/ws/social'
      ? 'social'
      : url.pathname === '/ws/public'
      ? 'public'
      : url.pathname === '/ws/collaboration'
        ? 'member'
        : undefined;
    if (!audience) {
      rejectUpgrade(socket, 404, 'WebSocket route not found');
      return;
    }
    if (audience !== 'social') metrics.recordWebSocketAttempt(audience);
    const rejectKnownUpgrade = (status: number, reason: string, retryAfter?: number) => {
      if (audience !== 'social') metrics.recordWebSocketRejected(audience);
      rejectUpgrade(socket, status, reason, retryAfter);
    };
    if (audience === 'public' && !req.headers.origin) {
      rejectKnownUpgrade(403, 'Public WebSocket Origin is required');
      return;
    }
    if (!isAllowedOrigin(req, config)) {
      const forwardedOriginHeadersPresent = Boolean(
        req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'],
      );
      if (!trustsForwardedHeaders(config) && forwardedOriginHeadersPresent) {
        const now = Date.now();
        if (now - lastUntrustedProxyWarningAt >= 60_000) {
          lastUntrustedProxyWarningAt = now;
          console.warn(
            '[WebSocket] Rejected an Origin because reverse-proxy headers are not trusted. ' +
            'Set TRUST_PROXY to the exact trusted proxy hop count and verify /ws Upgrade forwarding.',
          );
        }
        rejectKnownUpgrade(
          403,
          'WebSocket Origin is not allowed; reverse-proxy headers are not trusted',
        );
        return;
      }
      rejectKnownUpgrade(403, 'WebSocket Origin is not allowed');
      return;
    }

    const ipAddress = requestIp(req, config);
    if (config.rateLimitEnabled) {
      const now = Date.now();
      const attemptKey = `${audience}:${ipAddress}`;
      let counter = attempts.get(attemptKey);
      if (!counter || counter.resetAt <= now) {
        counter = { count: 0, resetAt: now + 60_000 };
        attempts.set(attemptKey, counter);
      }
      counter.count += 1;
      if (counter.count > MAX_CONNECT_ATTEMPTS_PER_IP_MINUTE) {
        const retryAfter = Math.max(1, Math.ceil((counter.resetAt - now) / 1_000));
        rejectKnownUpgrade(429, 'Too many WebSocket connection attempts', retryAfter);
        return;
      }
      if (attempts.size > 10_000) {
        for (const [key, value] of attempts) {
          if (value.resetAt <= now) attempts.delete(key);
          if (attempts.size <= 10_000) break;
        }
        while (attempts.size > 10_000) {
          const oldest = attempts.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          attempts.delete(oldest);
        }
      }
    }

    const ticket = url.searchParams.get('ticket');
    if (!ticket || ticket.length > 256) {
      rejectKnownUpgrade(401, 'A valid one-time ticket is required');
      return;
    }
    const nowIso = new Date().toISOString();
    if (audience === 'social') {
      try {
        const identity = socialHub.consume(ticket, ipAddress);
        if (!identity) { rejectKnownUpgrade(401, 'A valid one-time ticket is required'); return; }
        wss.handleUpgrade(req, socket, head, ws => socialHub.accept(ws, identity, ipAddress));
      } catch (error) {
        rejectKnownUpgrade(error instanceof AppError ? error.status : 503, 'Account notifications unavailable');
      }
      return;
    }
    let consumedTicket: ConsumedTicket;
    if (audience === 'public') {
      if (!publicShareFeatureAvailable(db, config)) {
        rejectKnownUpgrade(503, 'Public Liveshare is unavailable');
        return;
      }
      const hash = hashPublicWsTicket(ticket);
      const preview = readPublicTicket(db, hash);
      if (!publicTicketIsActive(preview, nowIso)) {
        rejectKnownUpgrade(401, 'A valid one-time ticket is required');
        return;
      }
      if (preview.event_seq - preview.after_seq > MAX_WS_BACKLOG_EVENTS) {
        rejectKnownUpgrade(409, 'Public WebSocket backlog requires a new snapshot');
        return;
      }
      if (
        hub.connectionCount({ sessionId: preview.session_id, audience: 'public' }) >=
        MAX_PUBLIC_CONNECTIONS_PER_SESSION
      ) {
        rejectKnownUpgrade(429, 'Public Session connection limit reached', 30);
        return;
      }
      if (
        hub.connectionCount({ publicShareId: preview.public_share_id }) >=
        MAX_PUBLIC_CONNECTIONS_PER_SHARE
      ) {
        rejectKnownUpgrade(429, 'Public share connection limit reached', 30);
        return;
      }
      if (
        hub.connectionCount({ ipAddress, audience: 'public' }) >=
        MAX_PUBLIC_CONNECTIONS_PER_IP
      ) {
        rejectKnownUpgrade(429, 'Public IP connection limit reached', 30);
        return;
      }
      const consumed = consumePublicTicket(db, hash);
      if (!consumed) {
        rejectKnownUpgrade(401, 'A valid one-time ticket is required');
        return;
      }
      consumedTicket = { audience: 'public', row: consumed };
    } else {
      const hash = ticketHash(ticket);
      const preview = readTicket(db, hash, nowIso);
      if (!memberTicketIsActive(preview, nowIso)) {
        rejectKnownUpgrade(401, 'A valid one-time ticket is required');
        return;
      }
      if (preview.event_seq - preview.after_seq > MAX_WS_BACKLOG_EVENTS) {
        rejectKnownUpgrade(409, 'WebSocket backlog is too large; catch up through REST first');
        return;
      }
      if (
        hub.connectionCount({ sessionId: preview.session_id, audience: 'member' }) >=
        MAX_CONNECTIONS_PER_SESSION
      ) {
        rejectKnownUpgrade(429, 'Session WebSocket connection limit reached', 30);
        return;
      }
      if (hub.connectionCount({ userId: preview.user_id }) >= MAX_CONNECTIONS_PER_USER) {
        rejectKnownUpgrade(429, 'User WebSocket connection limit reached', 30);
        return;
      }
      if (
        hub.connectionCount({ ipAddress, audience: 'member' }) >= MAX_CONNECTIONS_PER_IP
      ) {
        rejectKnownUpgrade(429, 'IP WebSocket connection limit reached', 30);
        return;
      }
      const consumed = consumeTicket(db, hash);
      if (!consumed) {
        rejectKnownUpgrade(401, 'A valid one-time ticket is required');
        return;
      }
      consumedTicket = { audience: 'member', row: consumed };
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, consumedTicket, ipAddress);
    });
  };

  server.on('upgrade', upgrade);
  wss.on(
    'connection',
    (
      ws: WebSocket,
      _req: IncomingMessage,
      ticket: ConsumedTicket,
      ipAddress: string,
    ) => {
      const row = ticket.row;
      const connection = new WebSocketRealtimeConnection(ws, metrics, {
        audience: ticket.audience,
        sessionId: row.session_id,
        ...(ticket.audience === 'member'
          ? {
              userId: ticket.row.user_id,
              ...(ticket.row.auth_session_id
                ? { authSessionId: ticket.row.auth_session_id }
                : { authorizationExpiresAt: ticket.row.access_expires_at ?? undefined }),
            }
          : {
              publicShareId: ticket.row.public_share_id,
              ...(ticket.row.view_session_hash
                ? { publicViewSessionHash: ticket.row.view_session_hash }
                : {}),
              authorizationExpiresAt: ticket.row.authorization_expires_at,
            }),
        ipAddress,
        afterSeq: row.after_seq,
      });
      metrics.recordWebSocketAccepted(ticket.audience, row.after_seq > 0);
      liveConnections.add(connection);
      connection.setUnsubscribe(hub.add(connection));
      ws.on('pong', () => connection.markPong());
      ws.on('message', () => ws.close(1008, 'WebSocket is an event-only transport'));
      ws.on('error', () => undefined);
      ws.once('close', () => {
        connection.dispose();
        liveConnections.delete(connection);
        metrics.recordWebSocketClosed(ticket.audience);
      });

      if (
        ticket.audience === 'public' &&
        !publicConnectionIsActive(
          db,
          config,
          ticket.row.public_share_id,
          ticket.row.authorization_expires_at,
        )
      ) {
        connection.revoke('PUBLIC_SHARE_REVOKED');
        return;
      }

      try {
        const snapshot = db.transaction(() => {
          const current = db.prepare(`
            SELECT event_seq, min_retained_seq, deleted_at FROM sessions WHERE id = ?
          `).get(row.session_id) as {
            event_seq: number;
            min_retained_seq: number;
            deleted_at: string | null;
          } | undefined;
          if (!current) return undefined;
          if (
            row.after_seq < current.min_retained_seq ||
            current.event_seq - row.after_seq > MAX_WS_BACKLOG_EVENTS
          ) {
            return { current, events: [], requiresResync: true };
          }
          const events = readEventsAfter(
            db,
            row.session_id,
            row.after_seq,
            MAX_WS_BACKLOG_EVENTS + 1,
          );
          return { current, events, requiresResync: false };
        }).deferred();
        if (!snapshot) {
          connection.revoke('SESSION_DELETED');
          return;
        }
        const { current, events, requiresResync } = snapshot;
        connection.sendHello(current.event_seq);
        if (requiresResync || events.length > MAX_WS_BACKLOG_EVENTS) {
          connection.resyncRequired(current.min_retained_seq);
          return;
        }
        connection.sendBacklog(events, current.event_seq);
        if (current.deleted_at) connection.sessionDeleted();
      } catch {
        // Stored events are projected through a strict public allowlist. A malformed
        // or future-incompatible row must fail closed for this socket, never escape
        // the EventEmitter listener or fall back to the member event representation.
        connection.streamFailed();
        return;
      }
    },
  );

  return {
    wss,
    close() {
      clearInterval(heartbeat);
      socialHub.closeAll();
      server.off('upgrade', upgrade);
      for (const connection of [...liveConnections]) connection.close();
      liveConnections.clear();
      wss.close();
      attempts.clear();
    },
  };
}

/**
 * The legacy unversioned Log routes remain in the source tree for the old admin
 * bundle, but are not mounted. Their former unauthenticated broadcast channel is
 * deliberately a no-op so importing those modules cannot re-enable it.
 */
export function broadcast(_sessionId: string, _message: object): void {
  // Intentionally disabled.
}

export const collaborationWsInternals = {
  isAllowedOrigin,
  requestIp,
  ticketHash,
  MAX_WS_BACKLOG_EVENTS,
};
