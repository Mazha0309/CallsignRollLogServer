import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import Database from 'better-sqlite3';
import { Router } from 'express';
import { requireActiveAdminAccess, requireAdminElevation } from '../admin/elevation';
import { appendGovernanceAudit } from '../admin/governance-audit';
import {
  acceptedInstanceIds, databaseInstanceId, ensureRecoveryDirectory, hashFile, inspectRestoreFileIsolated,
  MAX_RESTORE_BYTES, readRecoveryJson, RESTORE_PREVIEW_TTL_MS, RestoreJob, RestoreResult,
  schemaHash, writeRecoveryJson, restoreSourcePath,
} from '../admin/database-recovery';
import { AppConfig } from '../config';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { getRequestId } from '../middleware/request-id';
import { requireIdempotencyKey } from '../collaboration/idempotency';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

function requireFreshAuditKey(db: Database.Database, mutationId: string): void {
  if (db.prepare('SELECT 1 FROM admin_governance_audit_events WHERE mutation_id = ? UNION ALL SELECT 1 FROM processed_mutations WHERE mutation_id = ? LIMIT 1').get(mutationId, mutationId)) {
    throw new AppError(409, 'MUTATION_ID_REUSED', 'Use a fresh idempotency key for this operation');
  }
}

export function createAdminDatabaseRecoveryRouter({ db, config, onRestoreQueued }: {
  db: Database.Database; config: AppConfig; onRestoreQueued?: () => void;
}): Router {
  const router = Router();
  let uploading = false;
  router.use(createAccessTokenMiddleware(config, () => db));
  router.use((req: V1AuthRequest, _res, next) => {
    try { requireActiveAdminAccess(db, req); next(); } catch (error) { next(error); }
  });
  const enabled = () => {
    if (!onRestoreQueued) throw new AppError(409, 'RESTORE_UNAVAILABLE', 'This process does not support restart recovery');
  };
  router.get('/', (_req, res, next) => {
    try {
      if (!db.name || db.name === ':memory:') {
        res.json({ maxBytes: MAX_RESTORE_BYTES, restoreAvailable: false, automaticRestart: false, pending: false, lastResult: null });
        return;
      }
      const directory = ensureRecoveryDirectory(db);
      res.json({ maxBytes: MAX_RESTORE_BYTES, restoreAvailable: Boolean(onRestoreQueued),
        automaticRestart: Boolean(config.containerMode),
        pending: Boolean(readRecoveryJson(directory, 'pending.json')),
        lastResult: readRecoveryJson<RestoreResult>(directory, 'last-result.json') });
    } catch (error) { next(error); }
  });
  router.post('/preview', async (req: V1AuthRequest, res, next) => {
    let file: string | undefined;
    let ownsUpload = false;
    try {
      enabled();
      requireAdminElevation(db, config, req);
      if (!req.is('application/octet-stream')) throw new AppError(415, 'RESTORE_INVALID_FILE', 'Upload a SQLite file as application/octet-stream');
      const directory = ensureRecoveryDirectory(db);
      if (uploading || readRecoveryJson(directory, 'pending.json')) throw new AppError(409, 'RESTORE_BUSY', 'Another recovery operation is in progress');
      const length = Number(req.header('content-length'));
      if (length > MAX_RESTORE_BYTES) throw new AppError(413, 'RESTORE_TOO_LARGE', 'Backup exceeds 64 MiB');
      uploading = true;
      ownsUpload = true;
      const id = randomUUID();
      file = path.join(directory, `${id}.upload`);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 120_000);
      let bytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_RESTORE_BYTES) callback(new AppError(413, 'RESTORE_TOO_LARGE', 'Backup exceeds 64 MiB'));
        else callback(null, chunk);
      } });
      try { await pipeline(req, limit, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: controller.signal }); }
      finally { clearTimeout(deadline); }
      const expected = { schemaHash: schemaHash(db), instanceId: databaseInstanceId(db), actorUserId: req.auth!.userId, acceptedInstanceIds: acceptedInstanceIds(db) };
      let inspection;
      try { inspection = await inspectRestoreFileIsolated(file, expected); }
      catch (error) { throw new AppError(422, 'RESTORE_INVALID_FILE', error instanceof Error ? error.message : 'Invalid SQLite backup'); }
      // Upload/validation can outlive the access/elevation token or a revocation.
      requireAdminElevation(db, config, req);
      const admin = requireActiveAdminAccess(db, req);
      const preview: RestoreJob = { ...inspection, id, expiresAt: new Date(Date.now() + RESTORE_PREVIEW_TTL_MS).toISOString(),
        actorUserId: admin.id, authVersion: admin.auth_version, authSessionId: req.auth!.authSessionId ?? req.auth!.tokenId,
        schemaHash: expected.schemaHash, serverInstanceId: expected.instanceId };
      fs.renameSync(file, restoreSourcePath(directory, id));
      file = undefined;
      writeRecoveryJson(directory, 'preview.json', preview);
      appendGovernanceAudit(db, { action: 'database.restore.validated', actorUserId: admin.id, requestId: getRequestId(req), mutationId: id,
        targetType: 'database', targetId: 'primary', details: { sha256: preview.sha256, bytes: preview.bytes } });
      res.status(201).json({ ...inspection, id, expiresAt: preview.expiresAt });
    } catch (error) { next(error); }
    finally {
      if (file) fs.rmSync(file, { force: true });
      if (ownsUpload) uploading = false;
    }
  });
  router.post('/confirm', (req: V1AuthRequest, res, next) => {
    try {
      enabled();
      requireAdminElevation(db, config, req);
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['id', 'sha256', 'confirmation', 'reason']);
      if (body.confirmation !== 'RESTORE') throw new AppError(422, 'RESTORE_CONFIRMATION_REQUIRED', 'Type RESTORE to confirm replacement');
      const reason = requireString(body, 'reason', { min: 3, max: 1000 });
      const mutationId = requireIdempotencyKey(req);
      const directory = ensureRecoveryDirectory(db);
      const job = readRecoveryJson<RestoreJob>(directory, 'preview.json');
      if (!job || job.id !== body.id || job.sha256 !== body.sha256 || Date.parse(job.expiresAt) <= Date.now()) throw new AppError(409, 'RESTORE_PREVIEW_EXPIRED', 'Upload and validate the backup again');
      const admin = requireActiveAdminAccess(db, req);
      if (job.actorUserId !== admin.id || job.authVersion !== admin.auth_version || job.authSessionId !== (req.auth!.authSessionId ?? req.auth!.tokenId)) throw new AppError(403, 'RESTORE_PREVIEW_OWNER', 'Backup preview belongs to a different administrator session');
      const pending = readRecoveryJson<RestoreJob>(directory, 'pending.json');
      if (uploading || (pending && (pending.id !== job.id || pending.mutationId !== mutationId || pending.reason !== reason))) throw new AppError(409, 'RESTORE_BUSY', 'Another recovery operation is in progress');
      if (hashFile(restoreSourcePath(directory, job.id)) !== job.sha256) throw new AppError(409, 'RESTORE_INVALID_FILE', 'Backup checksum changed');
      if (!pending) {
        requireFreshAuditKey(db, mutationId);
        appendGovernanceAudit(db, { action: 'database.restore.queued', actorUserId: admin.id, requestId: getRequestId(req), mutationId,
          reason, targetType: 'database', targetId: 'primary', details: { sha256: job.sha256, previewId: job.id } });
        writeRecoveryJson(directory, 'pending.json', { ...job, reason, mutationId, requestId: getRequestId(req), newInstanceId: randomUUID() });
      }
      // Restart is scheduled even if the client disconnects before reading 202.
      setTimeout(() => onRestoreQueued!(), 250).unref();
      res.status(202).json({ status: 'queued', automaticRestart: Boolean(config.containerMode) });
    } catch (error) { next(error); }
  });
  router.post('/safety-backup', (req: V1AuthRequest, res, next) => {
    try {
      requireAdminElevation(db, config, req);
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['reason']);
      const reason = requireString(body, 'reason', { min: 3, max: 1000 });
      const mutationId = requireIdempotencyKey(req);
      requireFreshAuditKey(db, mutationId);
      const directory = ensureRecoveryDirectory(db);
      const result = readRecoveryJson<RestoreResult>(directory, 'last-result.json');
      if (!result?.safetyBackup || !/^before-[0-9a-f-]{36}\.sqlite3$/.test(result.safetyBackup)) throw new AppError(404, 'RESTORE_BACKUP_NOT_FOUND', 'No automatic safety backup is available');
      appendGovernanceAudit(db, { action: 'database.backup.safety-downloaded', actorUserId: req.auth!.userId, requestId: getRequestId(req),
        mutationId, reason, targetType: 'database', targetId: result.id });
      res.download(path.join(directory, result.safetyBackup), result.safetyBackup);
    } catch (error) { next(error); }
  });
  return router;
}
