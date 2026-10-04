import Database from 'better-sqlite3';
import { AppError } from '../errors/app-error';
import { getValidatedPersonalSnapshot } from '../session-catalog/account-session-catalog';
import { PersonalSnapshot, validatePersonalSnapshot } from '../personal-snapshot/model';
import { appendAccountShareAudit } from './audit';

export function promotedPersonalSessionIds(db: Database.Database, owner: string): Set<string> {
  return new Set((db.prepare('SELECT session_id FROM personal_session_promotions WHERE owner_user_id = ?')
    .all(owner) as Array<{ session_id: string }>).map(row => row.session_id));
}

export function rejectPromotedPersonalSessions(db: Database.Database, owner: string, snapshot: PersonalSnapshot): void {
  const promoted = promotedPersonalSessionIds(db, owner);
  const conflicts = snapshot.sessions.filter(row => promoted.has(row.session_id));
  if (conflicts.length) throw new AppError(409, 'PERSONAL_SESSION_PROMOTED',
    'These sessions have been upgraded to collaboration. Open their collaboration replicas before synchronizing this device.',
    { sessionIds: conflicts.map(row => row.session_id) });
}

/** Called inside activation's IMMEDIATE transaction, before any grant can write
 * the canonical session. No recipient membership is created or widened. */
export function completePersonalPromotion(db: Database.Database, input: {
  owner: string; sessionId: string; expectedRevision: number; mutationId: string; requestId: string;
}): void {
  if (!db.inTransaction) throw new Error('Promotion must run inside the activation transaction');
  const { owner, sessionId } = input;
  if (promotedPersonalSessionIds(db, owner).has(sessionId)) return;
  const remote = db.prepare('SELECT title, status, owner_user_id FROM sessions WHERE id = ?').get(sessionId) as
    { title: string; status: string; owner_user_id: string } | undefined;
  if (!remote || remote.owner_user_id !== owner || !['initializing', 'active'].includes(remote.status)) {
    throw new AppError(409, 'PERSONAL_PROMOTION_STATE_INVALID', 'Only the owner can upgrade an initializing personal session');
  }
  const revision = db.prepare('SELECT revision FROM personal_cloud_snapshots WHERE user_id = ?').pluck().get(owner);
  if (revision !== input.expectedRevision) throw new AppError(409, 'VERSION_CONFLICT', 'Personal snapshot changed during publication');
  const snapshot = getValidatedPersonalSnapshot(db, owner);
  const session = snapshot?.sessions.find(row => row.session_id === sessionId && !row.deleted_at);
  if (!snapshot || !session || session.status !== 'active' || session.title.trim() !== remote.title) {
    throw new AppError(409, 'PERSONAL_PROMOTION_CONTENT_MISMATCH', 'Only the synchronized active personal session can be upgraded');
  }
  const sourceLogs = snapshot.logs.filter(row => row.session_id === sessionId);
  const liveLogs = sourceLogs.filter(row => !row.deleted_at);
  const remoteLogs = db.prepare('SELECT * FROM logs WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
  const byId = new Map(remoteLogs.map(row => [row.sync_id, row]));
  const textFields = ['rst_sent', 'rst_rcvd', 'qth', 'device', 'power', 'antenna', 'height', 'remarks'] as const;
  const nullable = (value: unknown) => typeof value === 'string' && value.trim() === '' ? null : value;
  if (liveLogs.length !== remoteLogs.length || liveLogs.some(row => {
    const uploaded = byId.get(row.sync_id);
    return !uploaded || uploaded.deleted_at != null ||
      !Number.isFinite(Date.parse(row.time)) || Date.parse(String(uploaded.time)) !== Date.parse(row.time) ||
      uploaded.controller !== row.controller.trim().toUpperCase() ||
      uploaded.callsign !== row.callsign.trim().toUpperCase() ||
      textFields.some(field => nullable(uploaded[field]) !== nullable(row[field]));
  })) throw new AppError(409, 'PERSONAL_PROMOTION_CONTENT_MISMATCH', 'Uploaded records differ from the synchronized personal session');

  const now = new Date().toISOString();
  // Retain the original, including deleted rows, for recovery/audit. This is not
  // an editable second session and is never exposed through recipient APIs.
  db.prepare(`INSERT INTO personal_session_promotions
    (owner_user_id, session_id, original_snapshot_json, promoted_at) VALUES (?, ?, ?, ?)`)
    .run(owner, sessionId, JSON.stringify({ ...snapshot, sessions: [session], logs: sourceLogs }), now);
  const updateTimes = db.prepare('UPDATE logs SET created_at = ?, updated_at = ?, source_device_id = ? WHERE session_id = ? AND sync_id = ?');
  for (const row of liveLogs) updateTimes.run(row.created_at, row.updated_at, row.source_device_id, sessionId, row.sync_id);
  db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(session.created_at, sessionId);
  const remaining = validatePersonalSnapshot({ ...snapshot,
    sessions: snapshot.sessions.filter(row => row.session_id !== sessionId),
    logs: snapshot.logs.filter(row => row.session_id !== sessionId),
  });
  db.prepare(`UPDATE personal_cloud_snapshots SET revision = revision + 1,
    snapshot_json = ?, session_count = ?, log_count = ?, byte_size = ?, checksum = ?, updated_at = ?
    WHERE user_id = ? AND revision = ?`).run(remaining.serialized, remaining.sessionCount,
    remaining.logCount, remaining.byteSize, remaining.checksum, now, owner, input.expectedRevision);
  appendAccountShareAudit(db, { action: 'account_share.session_promoted', actorUserId: owner,
    sessionId, requestId: input.requestId, mutationId: input.mutationId,
    before: { source: 'personal', revision }, after: { source: 'collaboration' }, occurredAt: now });
}
