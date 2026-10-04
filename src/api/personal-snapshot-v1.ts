import Database from 'better-sqlite3';
import { Router } from 'express';
import { AppConfig, config } from '../config';
import { normalizeStableId } from '../collaboration/access';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import {
  CLIENT_DATABASE_BACKUP_FORMAT_VERSION,
  clientSessionDatabaseBackupV7Filename,
  createClientSessionDatabaseBackupV7,
  validatedStoredPersonalSnapshotForExport,
} from '../personal-snapshot/database-backup-v7';
import {
  PERSONAL_SNAPSHOT_FORMAT_VERSION,
  PERSONAL_SNAPSHOT_REPLACE_CONFIRMATION,
  PersonalSnapshot,
  validatePersonalSnapshot,
} from '../personal-snapshot/model';
import { rejectUnknownKeys, requireJsonObject } from '../utils/validation';
import { getSocialRealtimeHub } from '../social/realtime';
import { rejectPromotedPersonalSessions } from '../account-share/promotion';
import {
  getPersonalSessionDetail,
  listAccountSessionCatalog,
  listPersonalSessionLogs,
  parseAccountSessionCatalogQuery,
  parsePersonalSessionLogsQuery,
  personalLogDto,
  personalSessionDto,
} from '../session-catalog/account-session-catalog';

interface PersonalSnapshotV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

interface PersonalSnapshotRow {
  user_id: string;
  revision: number;
  format_version: number;
  snapshot_json: string;
  session_count: number;
  log_count: number;
  byte_size: number;
  checksum: string;
  created_at: string;
  updated_at: string;
}

const PUT_KEYS = ['expectedRevision', 'confirmation', 'snapshot'] as const;
const PERSONAL_SNAPSHOT_REPLACE_RATE_LIMIT = 12;

function readSnapshotRow(
  db: Database.Database,
  userId: string,
): PersonalSnapshotRow | undefined {
  return db.prepare(`
    SELECT *
    FROM personal_cloud_snapshots
    WHERE user_id = ?
  `).get(userId) as PersonalSnapshotRow | undefined;
}

function snapshotMetadata(row?: PersonalSnapshotRow) {
  if (!row) {
    return {
      exists: false,
      revision: 0,
      formatVersion: PERSONAL_SNAPSHOT_FORMAT_VERSION,
      sessionCount: 0,
      logCount: 0,
      byteSize: 0,
      checksum: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    exists: true,
    revision: Number(row.revision),
    formatVersion: Number(row.format_version),
    sessionCount: Number(row.session_count),
    logCount: Number(row.log_count),
    byteSize: Number(row.byte_size),
    checksum: row.checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function setRevisionEtag(res: { setHeader(name: string, value: string): void }, revision: number) {
  res.setHeader('ETag', `"${revision}"`);
}

function parseRevisionValue(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a non-negative integer`, {
      field,
    });
  }
  return Number(value);
}

function parseIfMatch(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^"(0|[1-9]\d*)"$/.exec(value.trim());
  if (!match) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'If-Match must contain exactly one quoted snapshot revision',
      { field: 'If-Match', example: '"0"' },
    );
  }
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'If-Match revision is outside the allowed range', {
      field: 'If-Match',
    });
  }
  return revision;
}

function expectedRevision(req: V1AuthRequest, body: Record<string, unknown>): number {
  const bodyRevision = parseRevisionValue(body.expectedRevision, 'expectedRevision');
  const headerRevision = parseIfMatch(req.header('if-match'));
  if (bodyRevision === undefined && headerRevision === undefined) {
    throw new AppError(
      428,
      'PERSONAL_SNAPSHOT_REVISION_REQUIRED',
      'expectedRevision or If-Match is required for a destructive snapshot replacement',
    );
  }
  if (
    bodyRevision !== undefined &&
    headerRevision !== undefined &&
    bodyRevision !== headerRevision
  ) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'expectedRevision and If-Match must identify the same revision',
      { expectedRevision: bodyRevision, ifMatchRevision: headerRevision },
    );
  }
  return bodyRevision ?? headerRevision!;
}

function requireReplaceConfirmation(body: Record<string, unknown>): void {
  if (body.confirmation !== PERSONAL_SNAPSHOT_REPLACE_CONFIRMATION) {
    throw new AppError(
      422,
      'PERSONAL_SNAPSHOT_REPLACE_CONFIRMATION_REQUIRED',
      'Explicit confirmation is required to replace the personal cloud snapshot',
      { requiredConfirmation: PERSONAL_SNAPSHOT_REPLACE_CONFIRMATION },
    );
  }
}

function conflict(current: PersonalSnapshotRow | undefined, expected: number): AppError {
  return new AppError(
    409,
    'PERSONAL_SNAPSHOT_REVISION_CONFLICT',
    'The personal cloud snapshot changed concurrently',
    {
      expectedRevision: expected,
      currentRevision: current?.revision ?? 0,
      currentChecksum: current?.checksum ?? null,
      updatedAt: current?.updated_at ?? null,
    },
  );
}

function replaceSnapshot(
  db: Database.Database,
  userId: string,
  expected: number,
  validated: ReturnType<typeof validatePersonalSnapshot>,
): { row: PersonalSnapshotRow; replaced: boolean } {
  return db.transaction(() => {
    const current = readSnapshotRow(db, userId);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expected) throw conflict(current, expected);
    rejectPromotedPersonalSessions(db, userId, validated.snapshot);
    if (current?.checksum === validated.checksum) {
      return { row: current, replaced: false };
    }

    const now = new Date().toISOString();
    if (!current) {
      db.prepare(`
        INSERT INTO personal_cloud_snapshots (
          user_id, revision, format_version, snapshot_json,
          session_count, log_count, byte_size, checksum, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        validated.snapshot.version,
        validated.serialized,
        validated.sessionCount,
        validated.logCount,
        validated.byteSize,
        validated.checksum,
        now,
        now,
      );
    } else {
      const result = db.prepare(`
        UPDATE personal_cloud_snapshots
        SET revision = revision + 1,
            format_version = ?, snapshot_json = ?, session_count = ?,
            log_count = ?, byte_size = ?, checksum = ?, updated_at = ?
        WHERE user_id = ? AND revision = ?
      `).run(
        validated.snapshot.version,
        validated.serialized,
        validated.sessionCount,
        validated.logCount,
        validated.byteSize,
        validated.checksum,
        now,
        userId,
        expected,
      );
      if (result.changes !== 1) {
        throw conflict(readSnapshotRow(db, userId), expected);
      }
    }
    const saved = readSnapshotRow(db, userId);
    if (!saved) {
      throw new AppError(500, 'PERSONAL_SNAPSHOT_WRITE_FAILED', 'Snapshot write did not persist');
    }
    return { row: saved, replaced: true };
  }).immediate();
}

export function createPersonalSnapshotV1Router(
  dependencies: PersonalSnapshotV1Dependencies = {},
): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const replaceLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: PERSONAL_SNAPSHOT_REPLACE_RATE_LIMIT,
    maxKeys: 20_000,
    keyGenerator: (req) => {
      const auth = (req as V1AuthRequest).auth;
      return `${auth?.userId ?? 'anonymous'}:${req.ip}`;
    },
    message: 'Too many personal snapshot replacements; retry later',
  });
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(createAccessTokenMiddleware(runtimeConfig, database));

  router.get('/session-catalog', (req: V1AuthRequest, res, next) => {
    try {
      const userId = req.auth!.userId;
      const user = database().prepare(`
        SELECT username FROM users
        WHERE id = ? AND deleted_at IS NULL
      `).get(userId) as { username: string } | undefined;
      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'The current account no longer exists');
      }
      const query = parseAccountSessionCatalogQuery(
        req.query as Record<string, unknown>,
      );
      res.json(listAccountSessionCatalog(database(), userId, user.username, query));
    } catch (error) {
      next(error);
    }
  });

  router.get('/personal-snapshot', (req: V1AuthRequest, res, next) => {
    try {
      const row = readSnapshotRow(database(), req.auth!.userId);
      setRevisionEtag(res, row?.revision ?? 0);
      res.json({ personalSnapshot: snapshotMetadata(row) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/personal-snapshot/download', (req: V1AuthRequest, res, next) => {
    try {
      const row = readSnapshotRow(database(), req.auth!.userId);
      if (!row) {
        throw new AppError(
          404,
          'PERSONAL_SNAPSHOT_NOT_FOUND',
          'No personal cloud snapshot has been uploaded for this account',
        );
      }
      let snapshot: PersonalSnapshot;
      try {
        snapshot = JSON.parse(row.snapshot_json) as PersonalSnapshot;
      } catch (error) {
        throw new AppError(
          500,
          'PERSONAL_SNAPSHOT_CORRUPT',
          'The stored personal cloud snapshot cannot be decoded',
          undefined,
          { cause: error },
        );
      }
      setRevisionEtag(res, row.revision);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="openlogtool-personal-snapshot-r${row.revision}.json"`,
      );
      res.json({
        personalSnapshot: {
          ...snapshotMetadata(row),
          snapshot,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/personal-snapshot/sessions/:sessionId',
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const detail = getPersonalSessionDetail(
          database(),
          req.auth!.userId,
          sessionId,
        );
        res.json({
          session: personalSessionDto(detail.session),
          snapshot: detail.snapshot,
          counts: {
            logs: detail.logCount,
            deletedLogs: detail.deletedLogCount,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/personal-snapshot/sessions/:sessionId/logs',
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const query = parsePersonalSessionLogsQuery(
          req.query as Record<string, unknown>,
        );
        const page = listPersonalSessionLogs(
          database(),
          req.auth!.userId,
          sessionId,
          query,
        );
        res.json({ ...page, items: page.items.map(personalLogDto) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/personal-snapshot/sessions/:sessionId/database-backup-v7',
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const stored = readSnapshotRow(database(), req.auth!.userId);
        if (!stored) {
          throw new AppError(
            404,
            'PERSONAL_SNAPSHOT_NOT_FOUND',
            'No personal cloud snapshot has been uploaded for this account',
          );
        }
        const records = validatedStoredPersonalSnapshotForExport(stored);
        const backup = createClientSessionDatabaseBackupV7(records, sessionId);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${clientSessionDatabaseBackupV7Filename(
            sessionId,
            Number(stored.revision),
          )}"`,
        );
        res.setHeader(
          'X-OpenLogTool-Backup-Format-Version',
          String(CLIENT_DATABASE_BACKUP_FORMAT_VERSION),
        );
        res.setHeader('X-Personal-Snapshot-Revision', String(stored.revision));
        res.setHeader('X-Personal-Snapshot-Session-Id', sessionId);
        res.json(backup);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/personal-snapshot/database-backup-v7', (_req, _res, next) => {
    next(
      new AppError(
        422,
        'PERSONAL_SNAPSHOT_SESSION_REQUIRED',
        'Export one Session through the session-scoped database backup endpoint',
      ),
    );
  });

  router.put(
    '/personal-snapshot',
    ...(runtimeConfig.rateLimitEnabled ? [replaceLimiter] : []),
    (req: V1AuthRequest, res, next) => {
      try {
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, PUT_KEYS);
        const expected = expectedRevision(req, body);
        requireReplaceConfirmation(body);
        const validated = validatePersonalSnapshot(body.snapshot);
        const result = replaceSnapshot(
          database(),
          req.auth!.userId,
          expected,
          validated,
        );
        setRevisionEtag(res, result.row.revision);
        if (result.replaced) getSocialRealtimeHub(database()).sharedCatalogChanged(req.auth!.userId);
        res.json({
          replaced: result.replaced,
          personalSnapshot: snapshotMetadata(result.row),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
