import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { AccessIdentity } from '../middleware/auth-v1';
import { AppError } from '../errors/app-error';
import { expireRequests } from './service';
import { expireShareGrants } from '../account-share/service';
import { PENDING_TTL_MS } from '../account-share/model';

interface Ticket { identity: AccessIdentity; expiresAt: number }
interface Connection { ws: WebSocket; identity: AccessIdentity; ipAddress: string; alive: boolean }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Account notifications are invalidations, never session data or permissions.
 * Tickets are short-lived, single-use and process-local, like the live sockets.
 * After a restart/reconnect the client obtains a new ticket and reloads REST.
 */
export class SocialRealtimeHub {
  private readonly tickets = new Map<string, Ticket>();
  private readonly connections = new Set<Connection>();
  constructor(private readonly db: Database.Database) {}

  private authorized(identity: AccessIdentity): boolean {
    if (identity.expiresAtEpochSeconds * 1000 <= Date.now()) return false;
    const user = this.db.prepare(`SELECT disabled_at, deleted_at, must_change_password, auth_version FROM users WHERE id = ?`)
      .get(identity.userId) as { disabled_at: string | null; deleted_at: string | null; must_change_password: number; auth_version: number } | undefined;
    if (!user || user.disabled_at || user.deleted_at || user.must_change_password || user.auth_version !== (identity.authVersion ?? 1)) return false;
    return !identity.authSessionId || Boolean(this.db.prepare(`SELECT 1 FROM refresh_tokens WHERE user_id = ?
      AND (auth_session_id = ? OR (auth_session_id IS NULL AND id = ?)) AND revoked_at IS NULL AND expires_at > ?`)
      .get(identity.userId, identity.authSessionId, identity.authSessionId, new Date().toISOString()));
  }

  issue(identity: AccessIdentity): { ticket: string; expiresAt: string } {
    if (!this.authorized(identity)) throw new AppError(401, 'TOKEN_REVOKED', 'Authentication expired');
    for (const [key, value] of this.tickets) if (value.expiresAt <= Date.now()) this.tickets.delete(key);
    const own = [...this.tickets].filter(([, value]) => value.identity.userId === identity.userId);
    // Bound abandoned handshakes without evicting another account's tickets.
    for (const [key] of own.slice(0, Math.max(0, own.length - 7))) this.tickets.delete(key);
    if (this.tickets.size >= 10_000) throw new AppError(503, 'REALTIME_BUSY', 'Try connecting again shortly');
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(Date.now() + 60_000, identity.expiresAtEpochSeconds * 1000);
    this.tickets.set(hash(ticket), { identity: { ...identity }, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(ticket: string, ipAddress: string): AccessIdentity | undefined {
    const key = hash(ticket);
    const issued = this.tickets.get(key);
    this.tickets.delete(key);
    if (!issued || issued.expiresAt <= Date.now() || !this.authorized(issued.identity)) return undefined;
    if ([...this.connections].filter(c => c.identity.userId === issued.identity.userId).length >= 8 ||
        [...this.connections].filter(c => c.ipAddress === ipAddress).length >= 20) {
      throw new AppError(429, 'REALTIME_LIMIT', 'Too many account notification connections');
    }
    return issued.identity;
  }

  accept(ws: WebSocket, identity: AccessIdentity, ipAddress: string): void {
    const connection: Connection = { ws, identity, ipAddress, alive: true };
    ws.on('error', () => undefined);
    ws.on('message', () => ws.close(1008, 'Notifications are receive-only'));
    ws.on('pong', () => { connection.alive = true; });
    ws.once('close', () => this.connections.delete(connection));
    if (!this.authorized(identity)) { ws.close(1008, 'Authentication expired'); return; }
    this.connections.add(connection);
    const server = this.db.prepare('SELECT instance_id FROM server_settings WHERE id = 1').get() as { instance_id: string };
    this.send(connection, { type: 'social.ready', userId: identity.userId, serverInstanceId: server.instance_id });
  }

  private send(connection: Connection, message: object): void {
    try {
      if (connection.ws.readyState !== WebSocket.OPEN || connection.ws.bufferedAmount > 64 * 1024) {
        this.drop(connection); return;
      }
      connection.ws.send(JSON.stringify(message));
    } catch { this.drop(connection); }
  }
  private drop(connection: Connection): void {
    this.connections.delete(connection);
    try { connection.ws.terminate(); } catch { /* Transport cleanup cannot fail a committed mutation. */ }
  }

  notify(recipients: Iterable<string>): void {
    const users = new Set(recipients);
    for (const connection of [...this.connections]) {
      if (!users.has(connection.identity.userId)) continue;
      if (!this.authorized(connection.identity)) { this.drop(connection); continue; }
      this.send(connection, { type: 'social.changed' });
    }
  }

  /** Called only after the surrounding business transaction commits. */
  sharedCatalogChanged(owner: string): void {
    this.notify(this.sharedRecipients(owner));
  }

  private sharedRecipients(owner: string): Set<string> {
    return new Set([owner, ...(this.db.prepare(`SELECT grantee_user_id FROM account_share_grants
      WHERE grantor_user_id = ? AND status = 'accepted'`).all(owner) as { grantee_user_id: string }[]).map(row => row.grantee_user_id)]);
  }

  /** Called only after the surrounding business transaction commits. */
  sessionChanged(sessionId: string): void {
    const owner = this.db.prepare('SELECT owner_user_id FROM sessions WHERE id = ?').pluck().get(sessionId) as string | undefined;
    const recipients = owner ? socialRecipients(this.db, owner) : new Set<string>();
    if (owner) for (const user of this.sharedRecipients(owner)) recipients.add(user);
    for (const row of this.db.prepare(`SELECT user_id FROM session_members WHERE session_id = ?`).all(sessionId) as { user_id: string }[]) recipients.add(row.user_id);
    for (const row of this.db.prepare(`SELECT sender_id, recipient_id FROM session_access_requests WHERE session_id = ? AND status = 'pending'`).all(sessionId) as { sender_id: string; recipient_id: string }[]) {
      recipients.add(row.sender_id); recipients.add(row.recipient_id);
    }
    this.notify(recipients);
  }

  revokeUser(userId: string, authSessionId?: string): void {
    const matches = (identity: AccessIdentity) => identity.userId === userId && (!authSessionId || identity.authSessionId === authSessionId);
    for (const [key, ticket] of this.tickets) if (matches(ticket.identity)) this.tickets.delete(key);
    for (const connection of [...this.connections]) if (matches(connection.identity)) {
      this.connections.delete(connection);
      try { connection.ws.close(1008, 'Authentication revoked'); } catch { this.drop(connection); }
    }
  }

  heartbeat(): void {
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= Date.now()) this.tickets.delete(key);
    if (this.connections.size) {
      // Expiration changes are pushed too, without periodic client reads.
      const expired = this.db.transaction(() => expireRequests(this.db)).immediate();
      this.notify(expired);
      const expiredShares = this.db.prepare(`SELECT grantor_user_id, grantee_user_id FROM account_share_grants
        WHERE status IN ('pending','accepted') AND ((expires_at IS NOT NULL AND expires_at <= ?)
          OR (status = 'pending' AND created_at <= ?))`).all(new Date().toISOString(), new Date(Date.now() - PENDING_TTL_MS).toISOString()) as { grantor_user_id: string; grantee_user_id: string }[];
      if (expiredShares.length) {
        expireShareGrants(this.db);
        this.notify(expiredShares.flatMap(g => [g.grantor_user_id, g.grantee_user_id]));
      }
    }
    for (const connection of [...this.connections]) {
      if (!connection.alive || !this.authorized(connection.identity)) { this.drop(connection); continue; }
      connection.alive = false;
      try { connection.ws.ping(); } catch { this.drop(connection); continue; }
      this.send(connection, { type: 'social.ping' });
    }
  }

  closeAll(): void {
    for (const connection of [...this.connections]) this.drop(connection);
    this.tickets.clear();
  }
}

/** Include the actor's affected peers before and after relationship changes. */
export function socialRecipients(db: Database.Database, actor: string): Set<string> {
  const users = new Set([actor]);
  for (const row of db.prepare(`SELECT sender_id, recipient_id FROM friend_requests WHERE status IN ('pending', 'accepted') AND (sender_id = ? OR recipient_id = ?)
    UNION SELECT sender_id, recipient_id FROM session_access_requests WHERE status = 'pending' AND (sender_id = ? OR recipient_id = ?)`)
    .all(actor, actor, actor, actor) as { sender_id: string; recipient_id: string }[]) {
    users.add(row.sender_id); users.add(row.recipient_id);
  }
  return users;
}
const hubs = new WeakMap<Database.Database, SocialRealtimeHub>();
export function getSocialRealtimeHub(db: Database.Database): SocialRealtimeHub {
  let hub = hubs.get(db);
  if (!hub) { hub = new SocialRealtimeHub(db); hubs.set(db, hub); }
  return hub;
}
