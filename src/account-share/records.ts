import Database from 'better-sqlite3';
import { canonicalLogPatch, canonicalLogValue, mutateLog } from '../api/collaboration-sync-v1';
import { findSession, normalizeStableId } from '../collaboration/access';
import { CollaborationEvent } from '../collaboration/events';
import { computeRequestHash, readStoredResponse, storeResponse, StoredResponse } from '../collaboration/idempotency';
import { getRealtimeHub } from '../collaboration/realtime';
import { AppError } from '../errors/app-error';
import { PersonalSnapshotLog, validatePersonalSnapshot } from '../personal-snapshot/model';
import { getValidatedPersonalSnapshot } from '../session-catalog/account-session-catalog';
import { getSocialRealtimeHub } from '../social/realtime';
import { rejectUnknownKeys } from '../utils/validation';
import { appendAccountShareAudit } from './audit';
import { requireSharedSession } from './catalog';
import { ShareSource } from './model';

/** A share grants record capabilities, not a membership or owner identity.
 * Authorization, version check, write, audit and idempotency commit together.
 */
export function mutateSharedRecord(db: Database.Database, input: {
  actorUserId: string; source: ShareSource; sessionId: string;
  mutationId: string; requestId: string; body: Record<string, unknown>;
}): StoredResponse {
  const { body } = input;
  const operation = body.operation;
  if (operation !== 'create' && operation !== 'update' && operation !== 'delete') {
    throw new AppError(422, 'VALIDATION_FAILED', 'Only record create, update and delete are allowed');
  }
  rejectUnknownKeys(body, ['grantId', 'syncId', 'operation',
    input.source === 'personal' ? 'expectedRevision' : 'baseVersion',
    ...(operation === 'create' ? ['value'] : operation === 'update' ? ['patch'] : [])]);
  const grantId = normalizeStableId(body.grantId, 'grantId');
  const syncId = normalizeStableId(body.syncId, 'syncId');
  const revision = input.source === 'personal' ? body.expectedRevision : body.baseVersion;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
    throw new AppError(422, 'VALIDATION_FAILED', 'The current record/snapshot version is required');
  }
  const path = `/api/v1/account/shared-sessions/${input.source}/${input.sessionId}/logs/mutations`;
  const requestHash = computeRequestHash('POST', path, body);
  let event: CollaborationEvent | undefined;
  let owner: string | undefined;
  const response = db.transaction(() => {
    const session = requireSharedSession(db, input.actorUserId, input.source, input.sessionId, grantId);
    if (!session.canEditLogs || (operation === 'delete' && !session.canDeleteLogs)) {
      throw new AppError(403, 'SHARE_PERMISSION_DENIED', 'This share does not allow this record operation');
    }
    // Never replay data from a grant that has since expired or been revoked.
    const stored = readStoredResponse(db, input.mutationId, input.actorUserId, requestHash);
    if (stored) return stored;
    owner = session.grantorUserId;
    let payload: object;
    if (input.source === 'collaboration') {
      const source = findSession(db, input.sessionId);
      if (!source || source.owner_user_id !== owner) throw new AppError(404, 'NOT_FOUND', 'Session not found');
      const result = mutateLog(db, source, { role: 'editor' }, {
        raw: body, mutationId: input.mutationId, entityType: 'log', entityId: syncId,
        operation, baseVersion: Number(revision),
      }, input.actorUserId, `shared:${input.actorUserId}`);
      if (result.result.status !== 'accepted') {
        throw new AppError(409, 'VERSION_CONFLICT', 'The record changed; reload before editing', result.result);
      }
      event = result.event;
      payload = { record: result.result.event.payload };
    } else {
      if (revision !== session.snapshotRevision) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The shared records changed; reload before editing');
      }
      const snapshot = getValidatedPersonalSnapshot(db, owner)!;
      const current = snapshot.logs.find(log => log.sync_id === syncId);
      const now = new Date().toISOString();
      const columns = {
        time: 'time', controller: 'controller', callsign: 'callsign', rstSent: 'rst_sent', rstRcvd: 'rst_rcvd',
        qth: 'qth', device: 'device', power: 'power', antenna: 'antenna', height: 'height', remarks: 'remarks',
      } as const;
      let log: PersonalSnapshotLog;
      if (operation === 'create') {
        if (current) throw new AppError(409, 'VERSION_CONFLICT', 'Record already exists');
        const value = canonicalLogValue(body.value, { sessionId: input.sessionId, syncId });
        log = {
          ...Object.fromEntries(Object.entries(value).map(([key, value]) => [columns[key as keyof typeof columns], value])),
          sync_id: syncId, session_id: input.sessionId, created_at: now, updated_at: now,
          deleted_at: null, source_device_id: `shared:${input.actorUserId}`,
        } as PersonalSnapshotLog;
        snapshot.logs.push(log);
      } else {
        if (!current || current.session_id !== input.sessionId || current.deleted_at) {
          throw new AppError(404, 'NOT_FOUND', 'Record not found in this shared session');
        }
        log = current;
        if (operation === 'delete') log.deleted_at = now;
        else {
          const patch = canonicalLogPatch(body.patch);
          Object.assign(log, Object.fromEntries(Object.entries(patch).map(([key, value]) => [columns[key as keyof typeof columns], value])));
        }
        log.updated_at = now;
        log.source_device_id = `shared:${input.actorUserId}`;
      }
      snapshot.sessions.find(row => row.session_id === input.sessionId)!.updated_at = now;
      snapshot.exportedAt = now;
      const valid = validatePersonalSnapshot(snapshot);
      const changed = db.prepare(`UPDATE personal_cloud_snapshots SET revision = revision + 1,
        snapshot_json = ?, session_count = ?, log_count = ?, byte_size = ?, checksum = ?, updated_at = ?
        WHERE user_id = ? AND revision = ?`).run(valid.serialized, valid.sessionCount, valid.logCount,
        valid.byteSize, valid.checksum, now, owner, revision);
      if (changed.changes !== 1) throw new AppError(409, 'VERSION_CONFLICT', 'The shared records changed');
      payload = { record: log, snapshotRevision: Number(revision) + 1 };
    }
    appendAccountShareAudit(db, {
      action: operation === 'create' ? 'account_share.log_created' : operation === 'update' ? 'account_share.log_updated' : 'account_share.log_deleted',
      actorUserId: input.actorUserId, targetUserId: owner, grantId,
      sessionId: input.sessionId, requestId: input.requestId, mutationId: input.mutationId,
      after: { source: input.source, syncId, operation }, occurredAt: new Date().toISOString(),
    });
    const result = { status: 200, body: payload };
    storeResponse(db, { ...result, userId: input.actorUserId, mutationId: input.mutationId, requestHash });
    return result;
  }).immediate();
  if (event) getRealtimeHub(db).publish(event);
  if (owner && !event) getSocialRealtimeHub(db).sharedCatalogChanged(owner);
  return response;
}
