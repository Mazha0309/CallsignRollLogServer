import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { usernameIdentity } from '../auth/username-identity';
import { findMembership, findMembershipIncludingRemoved, membershipDto, requireMembership } from '../collaboration/access';
import { AppError } from '../errors/app-error';

type Db = Database.Database;
type RequestRow = {
  id: string; sender_id: string; recipient_id: string; status: string;
  created_at: string; updated_at: string; expires_at: string;
  session_id?: string; kind?: 'invitation' | 'application'; role?: 'editor' | 'viewer';
};
const pendingExpiry = () => new Date(Date.now() + 14 * 86400_000).toISOString();
const now = () => new Date().toISOString();
function fail(code: string, message: string, status = 409): never {
  throw new AppError(status, code, message);
}
function audit(db: Db, actor: string, action: string, target: string) {
  db.prepare('INSERT INTO social_audit_events VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), actor, action, target, now());
}
export function expireRequests(db: Db) {
  const recipients = new Set<string>();
  const timestamp = now();
  for (const table of ['friend_requests', 'session_access_requests']) {
    const rows = db.prepare(`SELECT sender_id, recipient_id FROM ${table} WHERE status = 'pending' AND expires_at <= ?`).all(timestamp) as RequestRow[];
    for (const row of rows) { recipients.add(row.sender_id); recipients.add(row.recipient_id); }
    db.prepare(`UPDATE ${table} SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?`).run(timestamp, timestamp);
  }
  return recipients;
}
function userByName(db: Db, username: string): { id: string; username: string } {
  const user = db.prepare(`SELECT id, username FROM users WHERE username_identity(username) = ? AND disabled_at IS NULL AND deleted_at IS NULL`)
    .get(usernameIdentity(username)) as { id: string; username: string } | undefined;
  if (!user) fail('USER_NOT_FOUND', 'User not found', 404);
  return user;
}
function blocked(db: Db, a: string, b: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM friend_blocks WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)`)
    .get(a, b, b, a));
}
function activePair(db: Db, a: string, b: string): RequestRow | undefined {
  return db.prepare(`SELECT * FROM friend_requests WHERE MIN(sender_id, recipient_id) = MIN(?, ?) AND MAX(sender_id, recipient_id) = MAX(?, ?) AND status IN ('pending','accepted')`)
    .get(a, b, a, b) as RequestRow | undefined;
}
function requireFriends(db: Db, a: string, b: string) {
  if (blocked(db, a, b) || activePair(db, a, b)?.status !== 'accepted') {
    fail('FRIEND_REQUIRED', 'Add each other as friends first', 403);
  }
  for (const id of [a, b]) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL').get(id)) {
      fail('USER_NOT_FOUND', 'User unavailable', 404);
    }
  }
}
function pendingCapacity(db: Db, table: string, a: string, b: string) {
  for (const id of [a, b]) {
    const count = Number(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE status = 'pending' AND (sender_id = ? OR recipient_id = ?)`).pluck().get(id, id));
    if (count >= 50) fail('REQUEST_LIMIT', 'Too many pending requests', 429);
  }
}
function loadRequest(db: Db, table: string, id: string, actor: string): RequestRow {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND (sender_id = ? OR recipient_id = ?)`).get(id, actor, actor) as RequestRow | undefined;
  if (!row) fail('NOT_FOUND', 'Request not found', 404);
  return row;
}
function requestDto(db: Db, row: RequestRow) {
  const username = (id: string) => (db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string }).username;
  return {
    id: row.id, senderId: row.sender_id, senderUsername: username(row.sender_id),
    recipientId: row.recipient_id, recipientUsername: username(row.recipient_id),
    status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
    ...(row.session_id ? {
      sessionId: row.session_id, kind: row.kind, role: row.role,
      sessionTitle: (db.prepare('SELECT title FROM sessions WHERE id = ?').get(row.session_id) as { title: string }).title,
    } : {}),
  };
}
export function requestFriend(db: Db, actor: string, username: string) {
  const user = userByName(db, username);
  if (user.id === actor) fail('FRIEND_SELF', 'You cannot add yourself', 422);
  if (blocked(db, actor, user.id)) fail('FRIEND_BLOCKED', 'Friend request unavailable', 403);
  const existing = activePair(db, actor, user.id);
  if (existing) return { request: requestDto(db, existing) };
  pendingCapacity(db, 'friend_requests', actor, user.id);
  const id = randomUUID();
  db.prepare(`INSERT INTO friend_requests VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(id, actor, user.id, now(), now(), pendingExpiry());
  audit(db, actor, 'friend.requested', id);
  return { request: requestDto(db, loadRequest(db, 'friend_requests', id, actor)) };
}
export function respondFriend(db: Db, actor: string, id: string, action: string) {
  const row = loadRequest(db, 'friend_requests', id, actor);
  const status = responseStatus(row, actor, action);
  if (action === 'accept') {
    if (blocked(db, row.sender_id, row.recipient_id)) fail('FRIEND_BLOCKED', 'Friend request unavailable', 403);
    for (const user of [row.sender_id, row.recipient_id]) {
      const count = Number(db.prepare(`SELECT COUNT(*) FROM friend_requests WHERE status = 'accepted' AND (sender_id = ? OR recipient_id = ?)`).pluck().get(user, user));
      if (count >= 200) fail('FRIEND_LIMIT', 'Friend limit reached', 429);
      if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL').get(user)) fail('USER_NOT_FOUND', 'User unavailable', 404);
    }
  }
  db.prepare('UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  audit(db, actor, `friend.${status}`, id);
  return { request: requestDto(db, loadRequest(db, 'friend_requests', id, actor)) };
}
function responseStatus(row: RequestRow, actor: string, action: string) {
  if (!['accept', 'reject', 'cancel'].includes(action)) fail('VALIDATION_FAILED', 'Invalid action', 422);
  if (actor !== (action === 'cancel' ? row.sender_id : row.recipient_id)) fail('FORBIDDEN', 'Only the recipient can respond and the sender can cancel', 403);
  if (row.status !== 'pending' || row.expires_at <= now()) fail('REQUEST_CLOSED', 'This request is no longer pending');
  return action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'cancelled';
}
export function removeFriend(db: Db, actor: string, other: string) {
  db.prepare(`UPDATE friend_requests SET status = CASE WHEN status = 'accepted' THEN 'removed' ELSE 'cancelled' END, updated_at = ? WHERE MIN(sender_id,recipient_id) = MIN(?,?) AND MAX(sender_id,recipient_id) = MAX(?,?) AND status IN ('pending','accepted')`).run(now(), actor, other, actor, other);
  db.prepare(`UPDATE session_access_requests SET status = 'cancelled', updated_at = ? WHERE status = 'pending' AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`).run(now(), actor, other, other, actor);
  audit(db, actor, 'friend.removed', other);
  // Accepted memberships are independent of the friendship. Owners manage them in the session.
  return { removed: true };
}
export function blockFriend(db: Db, actor: string, username: string, block: boolean) {
  const user = userByName(db, username);
  if (user.id === actor) fail('FRIEND_SELF', 'You cannot block yourself', 422);
  if (block) {
    removeFriend(db, actor, user.id);
    db.prepare('INSERT OR IGNORE INTO friend_blocks VALUES (?, ?)').run(actor, user.id);
  } else db.prepare('DELETE FROM friend_blocks WHERE user_id = ? AND blocked_user_id = ?').run(actor, user.id);
  audit(db, actor, block ? 'friend.blocked' : 'friend.unblocked', user.id);
  return { blocked: block };
}
export function sessionAccess(db: Db, actor: string, id: string, visibility?: unknown) {
  requireMembership(db, id, actor, ['owner']);
  if (visibility !== undefined) {
    if (visibility !== 'private' && visibility !== 'friends') fail('VALIDATION_FAILED', 'Invalid visibility', 422);
    db.prepare(`INSERT INTO session_friend_access VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET visibility = excluded.visibility, updated_at = excluded.updated_at`).run(id, visibility, now());
    if (visibility === 'private') db.prepare(`UPDATE session_access_requests SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND kind = 'application' AND status = 'pending'`).run(now(), id);
    audit(db, actor, `session.visibility.${visibility}`, id);
  }
  return { sessionId: id, visibility: (db.prepare('SELECT visibility FROM session_friend_access WHERE session_id = ?').get(id) as { visibility: string } | undefined)?.visibility ?? 'private' };
}
export function requestSession(db: Db, actor: string, id: string, kind: 'invitation' | 'application', role: unknown, username?: string) {
  if (role !== 'viewer' && role !== 'editor') fail('VALIDATION_FAILED', 'Choose viewer or editor', 422);
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL AND status = 'active'`).get(id) as { owner_user_id: string } | undefined;
  if (!session) fail('NOT_FOUND', 'Active session not found', 404);
  let recipient: string;
  if (kind === 'invitation') {
    requireMembership(db, id, actor, ['owner']);
    recipient = userByName(db, username!).id;
  } else {
    recipient = session.owner_user_id;
    if (!(db.prepare(`SELECT 1 FROM session_friend_access WHERE session_id = ? AND visibility = 'friends'`).get(id))) fail('NOT_FOUND', 'Session is private', 404);
  }
  requireFriends(db, actor, recipient);
  const subject = kind === 'invitation' ? recipient : actor;
  if (findMembership(db, id, subject)) fail('ALREADY_MEMBER', 'Already a participant');
  const existing = db.prepare(`SELECT * FROM session_access_requests WHERE session_id = ? AND (CASE WHEN kind = 'invitation' THEN recipient_id ELSE sender_id END) = ? AND status = 'pending'`).get(id, subject) as RequestRow | undefined;
  if (existing) return { request: requestDto(db, existing) };
  pendingCapacity(db, 'session_access_requests', actor, recipient);
  const requestId = randomUUID();
  db.prepare(`INSERT INTO session_access_requests VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(requestId, id, actor, recipient, kind, role, now(), now(), pendingExpiry());
  audit(db, actor, `session.${kind}.requested`, requestId);
  return { request: requestDto(db, loadRequest(db, 'session_access_requests', requestId, actor)) };
}
export function respondSession(db: Db, actor: string, id: string, action: string) {
  const row = loadRequest(db, 'session_access_requests', id, actor);
  const status = responseStatus(row, actor, action);
  let membership;
  if (action === 'accept') {
    requireFriends(db, row.sender_id, row.recipient_id);
    const owner = row.kind === 'invitation' ? row.sender_id : row.recipient_id;
    const { session } = requireMembership(db, row.session_id!, owner, ['owner']);
    if (session.status !== 'active') fail('SESSION_CLOSED', 'Session is closed');
    if (row.kind === 'application' && sessionAccess(db, owner, session.id).visibility !== 'friends') fail('REQUEST_CLOSED', 'Session is private');
    const subject = row.kind === 'invitation' ? row.recipient_id : row.sender_id;
    const existing = findMembershipIncludingRemoved(db, session.id, subject);
    if (!existing) {
      db.prepare(`INSERT INTO session_members (id, session_id, user_id, role, version, created_at, updated_at, join_source) VALUES (?, ?, ?, ?, 1, ?, ?, 'friend')`).run(randomUUID(), session.id, subject, row.role, now(), now());
    } else if (existing.removed_at) {
      db.prepare(`UPDATE session_members SET role = ?, removed_at = NULL, removed_by = NULL, version = version + 1, updated_at = ?, join_source = 'friend', account_share_grant_id = NULL WHERE id = ?`).run(row.role, now(), existing.id);
    }
    membership = membershipDto(findMembership(db, session.id, subject)!);
  }
  db.prepare('UPDATE session_access_requests SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  audit(db, actor, `session.${row.kind}.${status}`, id);
  return { request: requestDto(db, loadRequest(db, 'session_access_requests', id, actor)), ...(membership ? { membership } : {}) };
}
export function socialDashboard(db: Db, actor: string) {
  expireRequests(db);
  const friends = db.prepare(`SELECT u.id AS userId, u.username FROM friend_requests f JOIN users u ON u.id = CASE WHEN f.sender_id = ? THEN f.recipient_id ELSE f.sender_id END WHERE f.status = 'accepted' AND (f.sender_id = ? OR f.recipient_id = ?) AND u.disabled_at IS NULL AND u.deleted_at IS NULL ORDER BY u.username COLLATE NOCASE`).all(actor, actor, actor);
  const friendRequests = (db.prepare(`SELECT * FROM friend_requests WHERE status = 'pending' AND (sender_id = ? OR recipient_id = ?) ORDER BY created_at DESC`).all(actor, actor) as RequestRow[]).map(row => requestDto(db, row));
  const sessionRequests = (db.prepare(`SELECT r.* FROM session_access_requests r JOIN sessions s ON s.id = r.session_id WHERE (r.sender_id = ? OR r.recipient_id = ?) AND s.deleted_at IS NULL AND (r.status = 'pending' OR (r.status = 'accepted' AND r.updated_at > ?)) ORDER BY r.updated_at DESC LIMIT 200`).all(actor, actor, new Date(Date.now() - 30 * 86400_000).toISOString()) as RequestRow[]).map(row => requestDto(db, row));
  const sessions = db.prepare(`SELECT s.id AS sessionId, s.title, s.status, u.username AS ownerUsername, s.owner_user_id AS ownerId, COALESCE(v.visibility,'private') AS visibility FROM sessions s JOIN users u ON u.id = s.owner_user_id LEFT JOIN session_friend_access v ON v.session_id = s.id WHERE s.deleted_at IS NULL AND s.status = 'active' AND u.disabled_at IS NULL AND u.deleted_at IS NULL AND (s.owner_user_id = ? OR (v.visibility = 'friends' AND EXISTS (SELECT 1 FROM friend_requests f WHERE f.status = 'accepted' AND MIN(f.sender_id,f.recipient_id) = MIN(?,s.owner_user_id) AND MAX(f.sender_id,f.recipient_id) = MAX(?,s.owner_user_id)) AND NOT EXISTS (SELECT 1 FROM session_members m WHERE m.session_id = s.id AND m.user_id = ? AND m.removed_at IS NULL))) ORDER BY s.updated_at DESC LIMIT 500`).all(actor, actor, actor, actor);
  const blocks = db.prepare('SELECT u.id AS userId, u.username FROM friend_blocks b JOIN users u ON u.id = b.blocked_user_id WHERE b.user_id = ? ORDER BY u.username').all(actor);
  return { friends, friendRequests, sessionRequests, sessions, blocks };
}
