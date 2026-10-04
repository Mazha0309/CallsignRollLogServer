import { randomBytes, randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { Response, Router } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  ADMIN_ELEVATION_TTL_SECONDS,
  issueAdminElevation,
  requireActiveAdminAccess,
  requireAdminElevation,
} from '../admin/elevation';
import { appendGovernanceAudit, parseStoredObject } from '../admin/governance-audit';
import { usernameIdentity } from '../auth/username-identity';
import { validateWebClientUrl } from '../client-link';
import {
  findSession,
  MembershipRow,
  normalizeStableId,
  SessionRow,
} from '../collaboration/access';
import {
  computeRequestHash,
  readStoredResponse,
  requireIdempotencyKey,
  storeResponse,
} from '../collaboration/idempotency';
import {
  getLiveDraftLockManager,
  liveDraftHasActualContent,
} from '../collaboration/live-draft';
import { getRealtimeHub } from '../collaboration/realtime';
import { publicShareDto, PublicShareRow } from '../collaboration/public';
import { AppConfig, config } from '../config';
import { rememberBaseConfig } from '../config-overrides';
import {
  llmCredentialStatus,
  removeStoredLlmApiKey,
  storeLlmApiKey,
} from '../llm/credential-store';
import { findAuthUserById, PERSISTENT_LOGIN_EXPIRES_AT } from '../auth/service';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { getRequestId } from '../middleware/request-id';
import {
  logDto,
  liveDraftClearedFromEvent,
  LogRow,
  mutateLog,
  mutateSession,
  MutationOperation,
  MutationResult,
  readLog,
} from './collaboration-sync-v1';
import { requireCurrentAdmin } from './admin-v1';
import {
  rejectUnknownKeys,
  requireJsonObject,
  requireString,
} from '../utils/validation';

export interface AdminGovernanceV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

interface AdminUserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  auth_version: number;
  disabled_at: string | null;
  deleted_at: string | null;
}

interface StoredWriteResult {
  status: number;
  body: unknown;
  replay: boolean;
  event?: ReturnType<typeof mutateLog>['event'];
}

const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_LOGS = 1_000_000;
const EXPORT_PAGE_SIZE = 512;
const backupsInProgress = new WeakSet<Database.Database>();
const EDITABLE_CONFIG_KEYS = [
  'webClientUrl',
  'corsOrigins',
  'accessTokenTtlSeconds',
  'refreshTokenTtlSeconds',
  'rateLimitEnabled',
  'port',
  'trustProxy',
  'jsonBodyLimit',
  'llmProvider',
  'llmBaseUrl',
  'llmModel',
  'llmTimeoutSeconds',
] as const;
type EditableConfigKey = (typeof EDITABLE_CONFIG_KEYS)[number];
const RESTART_CONFIG_KEYS = new Set<EditableConfigKey>([
  'port',
  'trustProxy',
  'jsonBodyLimit',
  'rateLimitEnabled',
]);

function validationError(message: string, details?: unknown): AppError {
  return new AppError(422, 'VALIDATION_FAILED', message, details);
}

function uniqueDeletedUsername(db: Database.Database, userId: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `deleted-${randomUUID()}-${randomBytes(6).toString('hex')}`;
    const occupied = db.prepare(
      'SELECT 1 FROM users WHERE username_identity(username) = ? AND id <> ?',
    ).get(usernameIdentity(candidate), userId);
    if (!occupied) return candidate;
  }
  throw new AppError(503, 'USERNAME_RESERVATION_FAILED', 'Could not reserve a deleted-user identity');
}

function queryScalar(req: V1AuthRequest, field: string): string | undefined {
  const value = req.query[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw validationError(`${field} must be a string`, { field });
  return value;
}

function positiveQuery(
  req: V1AuthRequest,
  field: string,
  fallback: number,
  maximum: number,
): number {
  const raw = queryScalar(req, field);
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw validationError(`${field} must be a positive integer`, { field });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw validationError(`${field} is outside the allowed range`, { field, maximum });
  }
  return value;
}

function booleanQuery(req: V1AuthRequest, field: string, fallback = false): boolean {
  const raw = queryScalar(req, field);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw validationError(`${field} must be true or false`, { field });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  const formulaCandidate = text.replace(/^[\s\p{Cc}\p{Cf}]*/u, '');
  if (/^[=+\-@]/.test(formulaCandidate)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface ExportSnapshot {
  db: Database.Database;
  close: () => void;
}

function openExportSnapshot(source: Database.Database): ExportSnapshot {
  const filename = source.name;
  if (
    !filename ||
    filename === ':memory:' ||
    filename.startsWith('file::memory:') ||
    filename.includes('mode=memory')
  ) {
    return { db: source, close: () => undefined };
  }
  const snapshot = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    snapshot.pragma('query_only = ON');
    snapshot.exec('BEGIN');
  } catch (error) {
    snapshot.close();
    throw error;
  }
  return {
    db: snapshot,
    close: () => {
      try {
        if (snapshot.inTransaction) snapshot.exec('ROLLBACK');
      } finally {
        snapshot.close();
      }
    },
  };
}

function validateConfigValue(key: EditableConfigKey, value: unknown): unknown {
  if (key === 'webClientUrl') return validateWebClientUrl(value);
  if (key === 'corsOrigins') {
    if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string')) {
      throw validationError('corsOrigins must be an array of strings');
    }
    return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  }
  if (key === 'accessTokenTtlSeconds' || key === 'refreshTokenTtlSeconds') {
    if (!Number.isSafeInteger(value) || Number(value) < 60 || Number(value) > 365 * 86_400) {
      throw validationError(`${key} is outside the allowed range`);
    }
    return Number(value);
  }
  if (key === 'rateLimitEnabled') {
    if (typeof value !== 'boolean') throw validationError('rateLimitEnabled must be boolean');
    return value;
  }
  if (key === 'port') {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
      throw validationError('port must be between 1 and 65535');
    }
    return Number(value);
  }
  if (key === 'trustProxy') {
    if (typeof value !== 'boolean' && (!Number.isSafeInteger(value) || Number(value) < 0)) {
      throw validationError('trustProxy must be boolean or a non-negative hop count');
    }
    return value;
  }
  if (key === 'jsonBodyLimit') {
    if (typeof value !== 'string' || !/^\d+(?:kb|mb)$/i.test(value) || value.length > 16) {
      throw validationError('jsonBodyLimit must use a value such as 512kb or 2mb');
    }
    return value.toLowerCase();
  }
  if (key === 'llmProvider') {
    if (
      value !== 'disabled' &&
      value !== 'openai-responses' &&
      value !== 'openai-chat' &&
      value !== 'anthropic'
    ) {
      throw validationError(
        'llmProvider must be disabled, openai-responses, openai-chat, or anthropic',
      );
    }
    return value;
  }
  if (key === 'llmBaseUrl') {
    if (typeof value !== 'string' || value.length > 2_048) {
      throw validationError('llmBaseUrl must be an absolute HTTP URL');
    }
    const normalized = value.trim().replace(/\/+$/, '');
    if (normalized === '') return '';
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw validationError('llmBaseUrl must be an absolute HTTP URL');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw validationError(
        'llmBaseUrl must be an absolute HTTP URL without credentials, a query, or a fragment',
      );
    }
    return normalized;
  }
  if (key === 'llmModel') {
    if (typeof value !== 'string' || value.trim().length > 200) {
      throw validationError('llmModel must contain at most 200 characters');
    }
    return value.trim();
  }
  if (key === 'llmTimeoutSeconds') {
    if (!Number.isSafeInteger(value) || Number(value) < 10 || Number(value) > 300) {
      throw validationError('llmTimeoutSeconds must be between 10 and 300');
    }
    return Number(value);
  }
  throw validationError('Unsupported configuration key');
}

function adminUser(db: Database.Database, userId: string): AdminUserRow {
  const row = db.prepare(`
    SELECT id, username, password_hash, role, auth_version, disabled_at, deleted_at
    FROM users WHERE id = ?
  `).get(userId) as AdminUserRow | undefined;
  if (!row || row.role !== 'admin' || row.disabled_at || row.deleted_at) {
    throw new AppError(403, 'ADMIN_REQUIRED', 'Current administrator privileges are required');
  }
  return row;
}

function requiredReason(body: Record<string, unknown>): string {
  return requireString(body, 'reason', { min: 3, max: 500 });
}

function readConfigOverrides(db: Database.Database): Partial<Record<EditableConfigKey, unknown>> {
  const rows = db.prepare(
    'SELECT key, value_json FROM server_config_overrides ORDER BY key',
  ).all() as Array<{ key: string; value_json: string }>;
  const result: Partial<Record<EditableConfigKey, unknown>> = {};
  for (const row of rows) {
    if ((EDITABLE_CONFIG_KEYS as readonly string[]).includes(row.key)) {
      result[row.key as EditableConfigKey] = JSON.parse(row.value_json) as unknown;
    }
  }
  return result;
}

function applicableConfigOverrides(
  db: Database.Database,
  runtimeConfig: AppConfig,
): Partial<Record<EditableConfigKey, unknown>> {
  const overrides = readConfigOverrides(db);
  if (runtimeConfig.containerMode === true) delete overrides.port;
  return overrides;
}

function editableConfigSnapshot(value: AppConfig): Record<EditableConfigKey, unknown> {
  return {
    webClientUrl: value.webClientUrl ?? '',
    corsOrigins: value.corsOrigins,
    accessTokenTtlSeconds: value.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: value.refreshTokenTtlSeconds,
    rateLimitEnabled: value.rateLimitEnabled,
    port: value.port,
    trustProxy: value.trustProxy,
    jsonBodyLimit: value.jsonBodyLimit,
    llmProvider: value.llmProvider,
    llmBaseUrl: value.llmBaseUrl,
    llmModel: value.llmModel,
    llmTimeoutSeconds: value.llmTimeoutSeconds,
  };
}

function applyImmediateConfig(
  runtimeConfig: AppConfig,
  key: EditableConfigKey,
  value: unknown,
): void {
  if (RESTART_CONFIG_KEYS.has(key)) return;
  if (key === 'webClientUrl') runtimeConfig.webClientUrl = value as string;
  if (key === 'corsOrigins') runtimeConfig.corsOrigins = value as string[];
  if (key === 'accessTokenTtlSeconds') runtimeConfig.accessTokenTtlSeconds = value as number;
  if (key === 'refreshTokenTtlSeconds') runtimeConfig.refreshTokenTtlSeconds = value as number;
  if (key === 'rateLimitEnabled') runtimeConfig.rateLimitEnabled = value as boolean;
  if (key === 'llmProvider') runtimeConfig.llmProvider = value as AppConfig['llmProvider'];
  if (key === 'llmBaseUrl') runtimeConfig.llmBaseUrl = value as string;
  if (key === 'llmModel') runtimeConfig.llmModel = value as string;
  if (key === 'llmTimeoutSeconds') runtimeConfig.llmTimeoutSeconds = value as number;
}

function deviceId(req: V1AuthRequest): string {
  const raw = req.header('x-device-id');
  return raw ? normalizeStableId(raw, 'X-Device-Id') : 'admin-web';
}

function syntheticOwner(session: SessionRow, userId: string): MembershipRow {
  const now = new Date().toISOString();
  return {
    id: `admin:${userId}`,
    session_id: session.id,
    user_id: userId,
    role: 'owner',
    version: 1,
    created_at: now,
    updated_at: now,
    removed_at: null,
  };
}

function sendStored(res: Response, result: StoredWriteResult): void {
  if (result.replay) res.setHeader('Idempotent-Replay', 'true');
  res.status(result.status).json(result.body);
}

function currentSession(db: Database.Database, sessionId: string): SessionRow {
  const session = findSession(db, sessionId);
  if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session does not exist');
  return session;
}

function governableSession(db: Database.Database, sessionId: string): SessionRow {
  const session = currentSession(db, sessionId);
  if (session.deleted_at) {
    throw new AppError(410, 'SESSION_DELETED', 'Deleted Sessions are immutable; recover a copy instead');
  }
  return session;
}

function revokeUserRealtime(db: Database.Database, userId: string, reason: string): void {
  getRealtimeHub(db).revokeUser(userId, reason);
}

function auditSensitiveRead(
  db: Database.Database,
  req: V1AuthRequest,
  sessionId: string,
  action: string,
): void {
  const supplied = req.header('x-admin-access-id');
  const accessId = supplied ? normalizeStableId(supplied, 'X-Admin-Access-Id') : randomUUID();
  const bucketMs = 15 * 60_000;
  const bucketStart = new Date(Math.floor(Date.now() / bucketMs) * bucketMs).toISOString();
  const bucketEnd = new Date(Date.parse(bucketStart) + bucketMs).toISOString();
  const exists = db.prepare(`
    SELECT 1
    FROM admin_governance_audit_events
    WHERE action = ? AND actor_user_id = ?
      AND target_type = 'session' AND target_id = ? AND session_id = ?
      AND occurred_at >= ? AND occurred_at < ?
      AND json_extract(details_json, '$.accessId') = ?
    LIMIT 1
  `).get(
    action,
    req.auth!.userId,
    sessionId,
    sessionId,
    bucketStart,
    bucketEnd,
    accessId,
  );
  if (exists) return;
  appendGovernanceAudit(db, {
    action,
    actorUserId: req.auth!.userId,
    requestId: getRequestId(req),
    mutationId: `read:${randomUUID()}`,
    targetType: 'session',
    targetId: sessionId,
    sessionId,
    details: { accessId },
  });
}

export function auditSensitiveUserRead(
  db: Database.Database,
  req: V1AuthRequest,
  userId: string,
  action = 'user.detail.viewed',
  additionalDetails: Record<string, unknown> = {},
): void {
  const supplied = req.header('x-admin-access-id');
  const accessId = supplied ? normalizeStableId(supplied, 'X-Admin-Access-Id') : randomUUID();
  const details = { accessId, ...additionalDetails };
  const bucketMs = 15 * 60_000;
  const bucketStart = new Date(Math.floor(Date.now() / bucketMs) * bucketMs).toISOString();
  const bucketEnd = new Date(Date.parse(bucketStart) + bucketMs).toISOString();
  if (db.prepare(`
    SELECT 1
    FROM admin_governance_audit_events
    WHERE action = ? AND actor_user_id = ?
      AND target_type = 'user' AND target_id = ? AND session_id IS NULL
      AND occurred_at >= ? AND occurred_at < ?
      AND details_json = ?
    LIMIT 1
  `).get(
    action,
    req.auth!.userId,
    userId,
    bucketStart,
    bucketEnd,
    JSON.stringify(details),
  )) return;
  appendGovernanceAudit(db, {
    action,
    actorUserId: req.auth!.userId,
    requestId: getRequestId(req),
    mutationId: `read:${randomUUID()}`,
    targetType: 'user',
    targetId: userId,
    details,
  });
}

function mutationResponse(result: MutationResult): { status: number; body: unknown } {
  if (result.status === 'conflict') {
    return { status: 409, body: result };
  }
  if (result.status === 'rejected') {
    return { status: 422, body: result };
  }
  return { status: 200, body: result };
}

function applyAdministrativeMutation(input: {
  db: Database.Database;
  req: V1AuthRequest;
  sessionId: string;
  operation: MutationOperation;
  auditAction: string;
  reason?: string;
  auditDetails?: Record<string, unknown> | ((event: StoredWriteResult['event']) =>
    Record<string, unknown>);
  sessionMutationOptions?: { discardLiveDraftOnClose?: boolean };
  idempotencyContext?: Record<string, unknown>;
}): StoredWriteResult {
  const { db, req, sessionId, operation } = input;
  const hash = computeRequestHash(req.method, req.baseUrl + req.path, {
    entityType: operation.entityType,
    entityId: operation.entityId,
    operation: operation.operation,
    baseVersion: operation.baseVersion,
    payload: operation.raw,
    ...(input.idempotencyContext
      ? { administrativeContext: input.idempotencyContext }
      : {}),
  });
  const transaction = db.transaction(() => {
    requireActiveAdminAccess(db, req);
    const replay = readStoredResponse(db, operation.mutationId, req.auth!.userId, hash);
    if (replay) {
      return { status: replay.status, body: replay.body, replay: true } satisfies StoredWriteResult;
    }
    const session = currentSession(db, sessionId);
    if (session.deleted_at) {
      throw new AppError(410, 'SESSION_DELETED', 'Deleted Sessions cannot be modified');
    }
    const before = operation.entityType === 'log'
      ? (() => {
          const row = readLog(db, sessionId, operation.entityId);
          return row ? logDto(row) : null;
        })()
      : {
          sessionId: session.id,
          title: session.title,
          status: session.status,
          version: Number(session.version),
          deletedAt: session.deleted_at,
        };
    const membership = syntheticOwner(session, req.auth!.userId);
    const outcome = operation.entityType === 'log'
      ? mutateLog(
          db,
          session,
          membership,
          operation,
          req.auth!.userId,
          deviceId(req),
          { administrative: true },
        )
      : mutateSession(
          db,
          session,
          membership,
          operation,
          req.auth!.userId,
          deviceId(req),
          getRequestId(req),
          {
            administrative: true,
            ...input.sessionMutationOptions,
          },
        );
    const mapped = mutationResponse(outcome.result);
    let auditEventId: string | null = null;
    if (outcome.result.status === 'accepted') {
      const after = operation.entityType === 'log'
        ? (() => {
            const row = readLog(db, sessionId, operation.entityId);
            return row ? logDto(row) : null;
          })()
        : (() => {
            const row = currentSession(db, sessionId);
            return {
              sessionId: row.id,
              title: row.title,
              status: row.status,
              version: Number(row.version),
              deletedAt: row.deleted_at,
            };
          })();
      auditEventId = appendGovernanceAudit(db, {
        action: input.auditAction,
        actorUserId: req.auth!.userId,
        requestId: getRequestId(req),
        mutationId: operation.mutationId,
        targetType: operation.entityType,
        targetId: operation.entityId,
        sessionId,
        reason: input.reason,
        before: before as Record<string, unknown> | null,
        after: after as Record<string, unknown> | null,
        details: typeof input.auditDetails === 'function'
          ? input.auditDetails(outcome.event)
          : input.auditDetails,
      });
    }
    const body = { result: outcome.result, auditEventId };
    storeResponse(db, {
      mutationId: operation.mutationId,
      sessionId,
      userId: req.auth!.userId,
      deviceId: deviceId(req),
      requestHash: hash,
      status: mapped.status,
      body,
    });
    return {
      status: mapped.status,
      body,
      replay: false,
      event: outcome.event,
    } satisfies StoredWriteResult;
  });
  return transaction.immediate();
}

function runGovernanceCommand<T>(input: {
  db: Database.Database;
  req: V1AuthRequest;
  requestBody: Record<string, unknown>;
  action: string;
  targetType: string;
  targetId: string;
  sessionId?: string;
  reason?: string;
  successStatus?: number;
  execute: () => {
    response: T;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    details?: Record<string, unknown>;
  };
}): StoredWriteResult {
  const mutationId = requireIdempotencyKey(input.req);
  const hash = computeRequestHash(
    input.req.method,
    input.req.baseUrl + input.req.path,
    input.requestBody,
  );
  return input.db.transaction(() => {
    requireActiveAdminAccess(input.db, input.req);
    const replay = readStoredResponse(input.db, mutationId, input.req.auth!.userId, hash);
    if (replay) {
      return { status: replay.status, body: replay.body, replay: true } satisfies StoredWriteResult;
    }
    const changed = input.execute();
    const auditEventId = appendGovernanceAudit(input.db, {
      action: input.action,
      actorUserId: input.req.auth!.userId,
      requestId: getRequestId(input.req),
      mutationId,
      targetType: input.targetType,
      targetId: input.targetId,
      sessionId: input.sessionId,
      reason: input.reason,
      before: changed.before,
      after: changed.after,
      details: changed.details,
    });
    const body = { ...changed.response as object, auditEventId };
    const successStatus = input.successStatus ?? 200;
    storeResponse(input.db, {
      mutationId,
      sessionId: input.sessionId,
      userId: input.req.auth!.userId,
      deviceId: deviceId(input.req),
      requestHash: hash,
      status: successStatus,
      body,
    });
    return { status: successStatus, body, replay: false } satisfies StoredWriteResult;
  }).immediate();
}

export function createAdminGovernanceV1Router(
  dependencies: AdminGovernanceV1Dependencies = {},
): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const baseConfig = rememberBaseConfig(runtimeConfig);
  const auth = createAccessTokenMiddleware(runtimeConfig);
  const elevationLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 5,
    maxKeys: 10_000,
    keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'unknown'}:${req.ip}`,
    message: 'Too many administrator re-authentication attempts',
  });

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(auth);
  router.use((req: V1AuthRequest, _res, next) => {
    try {
      requireCurrentAdmin(database(), req);
      adminUser(database(), req.auth!.userId);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/elevate',
    ...(runtimeConfig.rateLimitEnabled ? [elevationLimiter] : []),
    async (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['password']);
      const password = requireString(body, 'password', { min: 1, max: 4_096, trim: false });
      const db = database();
      const user = adminUser(db, req.auth!.userId);
      if (!(await bcrypt.compare(password, user.password_hash))) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Administrator password is incorrect');
      }
      const current = requireActiveAdminAccess(db, req);
      if (current.password_hash !== user.password_hash) {
        throw new AppError(401, 'TOKEN_REVOKED', 'Administrator credentials changed');
      }
      res.json({
        elevationToken: issueAdminElevation(runtimeConfig, current),
        expiresIn: ADMIN_ELEVATION_TTL_SECONDS,
      });
    } catch (error) {
      next(error);
    }
    },
  );

  router.get('/users/:userId', (req: V1AuthRequest, res, next) => {
    try {
      const userId = normalizeStableId(req.params.userId, 'userId');
      const db = database();
      const user = findAuthUserById(db, userId);
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User does not exist');
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM sessions WHERE owner_user_id = ? AND deleted_at IS NULL) AS owned_sessions,
          (SELECT COUNT(*) FROM session_members WHERE user_id = ? AND removed_at IS NULL) AS memberships,
          (SELECT COUNT(*) FROM refresh_tokens
           WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) AS active_device_sessions,
          COALESCE((SELECT byte_size FROM personal_cloud_snapshots WHERE user_id = ?), 0) AS personal_record_snapshot_bytes,
          COALESCE((SELECT byte_size FROM personal_dictionary_snapshots WHERE user_id = ?), 0) AS personal_dictionary_snapshot_bytes
      `).get(
        userId,
        userId,
        userId,
        new Date().toISOString(),
        userId,
        userId,
      ) as Record<string, number>;
      const deviceSessions = db.prepare(`
        SELECT id, device_id, created_at, expires_at, last_used_at, user_agent, ip_address
        FROM refresh_tokens
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC
      `).all(
        userId,
        new Date().toISOString(),
      ) as Array<Record<string, unknown>>;
      auditSensitiveUserRead(db, req, userId);
      res.json({
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          disabledAt: user.disabled_at,
          deletedAt: user.deleted_at,
          mustChangePassword: Number(user.must_change_password) === 1,
          loginNeverExpires: Number(user.login_never_expires) === 1,
          authVersion: Number(user.auth_version),
          passwordChangedAt: user.password_changed_at,
          usernameChangedAt: user.username_changed_at,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
        counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
        deviceSessions: deviceSessions.map((row) => ({
          sessionId: row.id,
          deviceId: row.device_id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastUsedAt: row.last_used_at,
          userAgent: row.user_agent,
          ipAddress: row.ip_address,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/users/:userId/reset-password', async (req: V1AuthRequest, res, next) => {
    try {
      const userId = normalizeStableId(req.params.userId, 'userId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['reason']);
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      const initialUser = findAuthUserById(db, userId);
      if (!initialUser || initialUser.deleted_at) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User does not exist');
      }
      const expectedAuthVersion = Number(initialUser.auth_version);
      const temporaryPassword = randomBytes(18).toString('base64url');
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(req.method, req.baseUrl + req.path, body);
      const result = db.transaction(() => {
        requireAdminElevation(db, runtimeConfig, req);
        const replay = readStoredResponse(db, mutationId, req.auth!.userId, requestHash);
        if (replay) {
          throw new AppError(
            409,
            'ONE_TIME_SECRET_ALREADY_ISSUED',
            'The temporary password was already issued and cannot be displayed again',
            replay.body,
          );
        }
        const user = findAuthUserById(db, userId);
        if (!user || user.deleted_at) throw new AppError(404, 'USER_NOT_FOUND', 'User does not exist');
        const now = new Date().toISOString();
        const updated = db.prepare(`
          UPDATE users
          SET password_hash = ?, must_change_password = 1,
              auth_version = auth_version + 1, password_changed_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND auth_version = ?
        `).run(passwordHash, now, now, userId, expectedAuthVersion);
        if (Number(updated.changes) !== 1) {
          throw new AppError(
            409,
            'ACCOUNT_CHANGED',
            'The account changed while the temporary password was being prepared',
          );
        }
        const revoked = db.prepare(`
          UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?)
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        `).run(now, userId, now);
        const sanitized = {
          userId,
          mustChangePassword: true,
          temporaryPasswordIssued: true,
          revokedDeviceSessionCount: Number(revoked.changes),
        };
        const auditEventId = appendGovernanceAudit(db, {
          action: 'user.password.reset',
          actorUserId: req.auth!.userId,
          requestId: getRequestId(req),
          mutationId,
          targetType: 'user',
          targetId: userId,
          reason,
          before: { mustChangePassword: Number(user.must_change_password) === 1 },
          after: { mustChangePassword: true },
          details: { revokedDeviceSessionCount: Number(revoked.changes) },
        });
        const storedBody = { ...sanitized, auditEventId };
        storeResponse(db, {
          mutationId,
          userId: req.auth!.userId,
          deviceId: deviceId(req),
          requestHash,
          status: 200,
          body: storedBody,
        });
        return { ...storedBody, temporaryPassword };
      }).immediate();
      revokeUserRealtime(db, userId, 'CREDENTIALS_CHANGED');
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/users/:userId/login-expiration', (req: V1AuthRequest, res, next) => {
    try {
      const userId = normalizeStableId(req.params.userId, 'userId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['loginNeverExpires', 'reason']);
      if (typeof body.loginNeverExpires !== 'boolean') {
        throw validationError('loginNeverExpires must be boolean', {
          field: 'loginNeverExpires',
        });
      }
      const loginNeverExpires = body.loginNeverExpires;
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      if (userId === req.auth!.userId) {
        throw new AppError(
          409,
          'SELF_LOGIN_EXPIRATION_FORBIDDEN',
          'Administrators cannot change their own login expiration policy',
        );
      }
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'user.login_expiration.updated',
        targetType: 'user',
        targetId: userId,
        reason,
        execute: () => {
          const user = findAuthUserById(db, userId);
          if (!user || user.deleted_at) {
            throw new AppError(404, 'USER_NOT_FOUND', 'User does not exist');
          }
          const previous = Number(user.login_never_expires) === 1;
          const changedAt = new Date();
          const now = changedAt.toISOString();
          let changed = false;
          let updatedDeviceSessionCount = 0;
          if (previous !== loginNeverExpires) {
            const update = db.prepare(`
              UPDATE users
              SET login_never_expires = ?, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL AND login_never_expires = ?
            `).run(loginNeverExpires ? 1 : 0, now, userId, previous ? 1 : 0);
            if (Number(update.changes) !== 1) {
              throw new AppError(
                409,
                'ACCOUNT_CHANGED',
                'The account changed while updating its login expiration policy',
              );
            }
            const sessionUpdate = loginNeverExpires
              ? db.prepare(`
                  UPDATE refresh_tokens
                  SET expires_at = ?
                  WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
                `).run(PERSISTENT_LOGIN_EXPIRES_AT, userId, now)
              : db.prepare(`
                  UPDATE refresh_tokens
                  SET expires_at = ?
                  WHERE user_id = ? AND revoked_at IS NULL AND expires_at = ?
                `).run(
                  new Date(
                    changedAt.getTime() + runtimeConfig.refreshTokenTtlSeconds * 1000,
                  ).toISOString(),
                  userId,
                  PERSISTENT_LOGIN_EXPIRES_AT,
                );
            updatedDeviceSessionCount = Number(sessionUpdate.changes);
            changed = true;
          }
          return {
            response: {
              userId,
              loginNeverExpires,
              changed,
              updatedDeviceSessionCount,
            },
            before: { loginNeverExpires: previous },
            after: { loginNeverExpires },
            details: {
              updatedDeviceSessionCount,
              existingExpiredSessionsRemainInvalid: true,
            },
          };
        },
      });
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  for (const command of ['disable', 'enable'] as const) {
    router.post(`/users/:userId/${command}`, (req: V1AuthRequest, res, next) => {
      try {
        const userId = normalizeStableId(req.params.userId, 'userId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['reason']);
        const reason = requiredReason(body);
        const db = database();
        requireAdminElevation(db, runtimeConfig, req);
        if (userId === req.auth!.userId) {
          throw new AppError(409, 'SELF_ACCOUNT_STATE_FORBIDDEN', 'Administrators cannot change their own account state');
        }
        const result = runGovernanceCommand({
          db,
          req,
          requestBody: body,
          action: `user.${command === 'disable' ? 'disabled' : 'enabled'}`,
          targetType: 'user',
          targetId: userId,
          reason,
          execute: () => {
            const user = findAuthUserById(db, userId);
            if (!user || user.deleted_at) throw new AppError(404, 'USER_NOT_FOUND', 'User does not exist');
            if (command === 'disable' && user.disabled_at) {
              throw new AppError(409, 'ACCOUNT_ALREADY_DISABLED', 'Account is already disabled');
            }
            if (command === 'enable' && !user.disabled_at) {
              throw new AppError(409, 'ACCOUNT_ALREADY_ENABLED', 'Account is already enabled');
            }
            if (command === 'disable' && user.role === 'admin') {
              const activeAdmins = db.prepare(`
                SELECT COUNT(*) AS count FROM users
                WHERE role = 'admin' AND disabled_at IS NULL AND deleted_at IS NULL
              `).get() as { count: number };
              if (Number(activeAdmins.count) <= 1) {
                throw new AppError(409, 'LAST_ADMIN_REQUIRED', 'The server must retain an active administrator');
              }
            }
            const now = new Date().toISOString();
            const disabledAt = command === 'disable' ? now : null;
            db.prepare(`
              UPDATE users
              SET disabled_at = ?, auth_version = auth_version + 1, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL
            `).run(disabledAt, now, userId);
            const revoked = command === 'disable'
              ? db.prepare(`
                  UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?)
                  WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
                `).run(now, userId, now)
              : { changes: 0 };
            return {
              response: {
                userId,
                disabledAt,
                revokedDeviceSessionCount: Number(revoked.changes),
              },
              before: { disabledAt: user.disabled_at },
              after: { disabledAt },
              details: { revokedDeviceSessionCount: Number(revoked.changes) },
            };
          },
        });
        if (!result.replay && command === 'disable') revokeUserRealtime(db, userId, 'ACCOUNT_DISABLED');
        sendStored(res, result);
      } catch (error) {
        next(error);
      }
    });
  }

  router.delete('/users/:userId', async (req: V1AuthRequest, res, next) => {
    try {
      const userId = normalizeStableId(req.params.userId, 'userId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['reason']);
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      if (userId === req.auth!.userId) {
        throw new AppError(409, 'SELF_DELETE_FORBIDDEN', 'Administrators cannot delete their own account');
      }
      const randomPasswordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10);
      requireAdminElevation(db, runtimeConfig, req);
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'user.deleted',
        targetType: 'user',
        targetId: userId,
        reason,
        execute: () => {
          const user = findAuthUserById(db, userId);
          if (!user || user.deleted_at) throw new AppError(404, 'USER_NOT_FOUND', 'User does not exist');
          if (!user.disabled_at) {
            throw new AppError(409, 'ACCOUNT_MUST_BE_DISABLED', 'Disable the account before deletion');
          }
          const owned = db.prepare(`
            SELECT id, title FROM sessions
            WHERE owner_user_id = ? AND deleted_at IS NULL LIMIT 20
          `).all(userId) as Array<{ id: string; title: string }>;
          if (owned.length > 0) {
            throw new AppError(409, 'OWNED_SESSIONS_REMAIN', 'Transfer owned Sessions before deletion', {
              sessions: owned.map((session) => ({ sessionId: session.id, title: session.title })),
            });
          }
          const ownedArchiveLists = Number(db.prepare(`
            SELECT COUNT(*) FROM public_archive_lists
            WHERE owner_user_id = ? AND deleted_at IS NULL
          `).pluck().get(userId));
          if (ownedArchiveLists > 0) {
            throw new AppError(
              409,
              'ARCHIVE_LIST_OWNERSHIP_REQUIRED',
              'Delete owned public archive lists before deleting the account',
              { archiveListCount: ownedArchiveLists },
            );
          }
          const personalSnapshot = db.prepare(`
            SELECT byte_size
            FROM personal_cloud_snapshots
            WHERE user_id = ?
          `).get(userId) as { byte_size: number } | undefined;
          const personalDictionarySnapshot = db.prepare(`
            SELECT byte_size
            FROM personal_dictionary_snapshots
            WHERE user_id = ?
          `).get(userId) as { byte_size: number } | undefined;
          const now = new Date().toISOString();
          const tombstoneUsername = uniqueDeletedUsername(db, user.id);
          db.prepare(`
            UPDATE users
            SET username = ?, password_hash = ?, role = 'user', deleted_at = ?,
                must_change_password = 0, login_never_expires = 0,
                auth_version = auth_version + 1, updated_at = ?
            WHERE id = ? AND disabled_at IS NOT NULL AND deleted_at IS NULL
          `).run(tombstoneUsername, randomPasswordHash, now, now, userId);
          db.prepare(`
            UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?)
            WHERE user_id = ? AND revoked_at IS NULL
          `).run(now, userId);
          const removedDeviceSessions = db.prepare(
            'DELETE FROM refresh_tokens WHERE user_id = ?',
          ).run(userId);
          const removedPersonalSnapshot = db.prepare(
            'DELETE FROM personal_cloud_snapshots WHERE user_id = ?',
          ).run(userId);
          const removedPersonalDictionarySnapshot = db.prepare(
            'DELETE FROM personal_dictionary_snapshots WHERE user_id = ?',
          ).run(userId);
          return {
            response: {
              userId,
              deletedAt: now,
              tombstoneUsername,
              removedDeviceSessionCount: Number(removedDeviceSessions.changes),
            },
            before: { username: user.username, role: user.role, disabledAt: user.disabled_at },
            after: { username: tombstoneUsername, role: 'user', deletedAt: now },
            details: {
              removedDeviceSessionCount: Number(removedDeviceSessions.changes),
              removedPersonalSnapshot: Number(removedPersonalSnapshot.changes) === 1,
              removedPersonalSnapshotBytes: personalSnapshot
                ? Number(personalSnapshot.byte_size)
                : 0,
              removedPersonalDictionarySnapshot:
                Number(removedPersonalDictionarySnapshot.changes) === 1,
              removedPersonalDictionarySnapshotBytes: personalDictionarySnapshot
                ? Number(personalDictionarySnapshot.byte_size)
                : 0,
              removedPersonalCloudBytes:
                Number(personalSnapshot?.byte_size ?? 0) +
                Number(personalDictionarySnapshot?.byte_size ?? 0),
              originalIdentityRetainedInGovernanceAudit: true,
            },
          };
        },
      });
      if (!result.replay) revokeUserRealtime(db, userId, 'ACCOUNT_DELETED');
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions', (req: V1AuthRequest, res, next) => {
    try {
      const page = positiveQuery(req, 'page', 1, 1_000_000);
      const pageSize = positiveQuery(req, 'pageSize', 20, MAX_PAGE_SIZE);
      const q = queryScalar(req, 'q')?.trim();
      const status = queryScalar(req, 'status');
      const ownerUserId = queryScalar(req, 'ownerUserId');
      const includeDeleted = booleanQuery(req, 'includeDeleted');
      if (status && !['initializing', 'active', 'closed'].includes(status)) {
        throw validationError('status is invalid', { field: 'status' });
      }
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (!includeDeleted) clauses.push('s.deleted_at IS NULL');
      if (q) {
        clauses.push("s.title LIKE ? ESCAPE '\\' COLLATE NOCASE");
        params.push(`%${escapeLike(q)}%`);
      }
      if (status) {
        clauses.push('s.status = ?');
        params.push(status);
      }
      if (ownerUserId) {
        clauses.push('s.owner_user_id = ?');
        params.push(normalizeStableId(ownerUserId, 'ownerUserId'));
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const db = database();
      const total = db.prepare(`SELECT COUNT(*) AS count FROM sessions s ${where}`)
        .get(...params) as { count: number };
      const rows = db.prepare(`
        SELECT s.*, u.username AS owner_username,
          (SELECT COUNT(*) FROM logs l WHERE l.session_id = s.id AND l.deleted_at IS NULL) AS log_count,
          (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id AND sm.removed_at IS NULL) AS member_count,
          (SELECT COUNT(*) FROM public_shares ps WHERE ps.session_id = s.id AND ps.revoked_at IS NULL AND ps.expires_at > ?) AS active_share_count
        FROM sessions s
        JOIN users u ON u.id = s.owner_user_id
        ${where}
        ORDER BY s.updated_at DESC, s.id DESC
        LIMIT ? OFFSET ?
      `).all(new Date().toISOString(), ...params, pageSize, (page - 1) * pageSize) as Array<
        SessionRow & {
          owner_username: string;
          log_count: number;
          member_count: number;
          active_share_count: number;
        }
      >;
      res.json({
        items: rows.map((row) => ({
          sessionId: row.id,
          title: row.title,
          status: row.status,
          version: Number(row.version),
          ownerUserId: row.owner_user_id,
          ownerUsername: row.owner_username,
          logCount: Number(row.log_count),
          memberCount: Number(row.member_count),
          activePublicShareCount: Number(row.active_share_count),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          closedAt: row.closed_at,
          deletedAt: row.deleted_at,
        })),
        page,
        pageSize,
        total: Number(total.count),
        totalPages: Math.ceil(Number(total.count) / pageSize),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const db = database();
      const session = currentSession(db, sessionId);
      const owner = db.prepare('SELECT id, username FROM users WHERE id = ?')
        .get(session.owner_user_id) as { id: string; username: string };
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logs WHERE session_id = ?) AS logs,
          (SELECT COUNT(*) FROM logs WHERE session_id = ? AND deleted_at IS NOT NULL) AS deleted_logs,
          (SELECT COUNT(*) FROM session_members WHERE session_id = ? AND removed_at IS NULL) AS members,
          (SELECT COUNT(*) FROM collaboration_invites WHERE session_id = ? AND revoked_at IS NULL) AS invites,
          (SELECT COUNT(*) FROM public_shares WHERE session_id = ? AND revoked_at IS NULL) AS public_shares
      `).get(sessionId, sessionId, sessionId, sessionId, sessionId) as Record<string, number>;
      auditSensitiveRead(db, req, sessionId, 'session.detail.viewed');
      res.json({
        session: {
          sessionId: session.id,
          title: session.title,
          status: session.status,
          version: Number(session.version),
          highWatermarkSeq: Number(session.event_seq),
          minRetainedSeq: Number(session.min_retained_seq),
          ownerUserId: owner.id,
          ownerUsername: owner.username,
          createdAt: session.created_at,
          updatedAt: session.updated_at,
          closedAt: session.closed_at,
          deletedAt: session.deleted_at,
        },
        counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])),
        liveDraft: {
          exists: Boolean(db.prepare('SELECT 1 FROM session_live_drafts WHERE session_id = ?').get(sessionId)),
          hasActualContent: liveDraftHasActualContent(db, sessionId),
          activeLockCount: getLiveDraftLockManager(db).list(sessionId).length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId/logs', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const page = positiveQuery(req, 'page', 1, 1_000_000);
      const pageSize = positiveQuery(req, 'pageSize', 50, MAX_PAGE_SIZE);
      const q = queryScalar(req, 'q')?.trim();
      const controller = queryScalar(req, 'controller')?.trim();
      const includeDeleted = booleanQuery(req, 'includeDeleted');
      const db = database();
      currentSession(db, sessionId);
      const clauses = ['l.session_id = ?'];
      const params: Array<string | number> = [sessionId];
      if (!includeDeleted) clauses.push('l.deleted_at IS NULL');
      if (q) {
        clauses.push("(l.callsign LIKE ? ESCAPE '\\' COLLATE NOCASE OR l.qth LIKE ? ESCAPE '\\' COLLATE NOCASE OR l.remarks LIKE ? ESCAPE '\\' COLLATE NOCASE)");
        const pattern = `%${escapeLike(q)}%`;
        params.push(pattern, pattern, pattern);
      }
      if (controller) {
        clauses.push("l.controller LIKE ? ESCAPE '\\' COLLATE NOCASE");
        params.push(`%${escapeLike(controller)}%`);
      }
      const where = clauses.join(' AND ');
      const total = db.prepare(`SELECT COUNT(*) AS count FROM logs l WHERE ${where}`)
        .get(...params) as { count: number };
      const rows = db.prepare(`
        SELECT * FROM logs l WHERE ${where}
        ORDER BY l.time ASC, l.sync_id ASC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, (page - 1) * pageSize) as LogRow[];
      auditSensitiveRead(db, req, sessionId, includeDeleted
        ? 'session.deleted_records.viewed'
        : 'session.records.viewed');
      res.json({
        items: rows.map(logDto),
        page,
        pageSize,
        total: Number(total.count),
        totalPages: Math.ceil(Number(total.count) / pageSize),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId/members', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const db = database();
      currentSession(db, sessionId);
      const rows = db.prepare(`
        SELECT sm.*, u.username, u.disabled_at, u.deleted_at
        FROM session_members sm JOIN users u ON u.id = sm.user_id
        WHERE sm.session_id = ?
        ORDER BY sm.removed_at IS NOT NULL, CASE sm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.username
      `).all(sessionId) as Array<Record<string, unknown>>;
      auditSensitiveRead(db, req, sessionId, 'session.detail.viewed');
      res.json({
        items: rows.map((row) => ({
          membershipId: row.id,
          userId: row.user_id,
          username: row.username,
          role: row.role,
          version: Number(row.version),
          joinedAt: row.created_at,
          updatedAt: row.updated_at,
          removedAt: row.removed_at,
          accountDisabledAt: row.disabled_at,
          accountDeletedAt: row.deleted_at,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/sessions/:sessionId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['expectedVersion', 'title']);
      if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        throw validationError('expectedVersion must be a positive integer');
      }
      const title = requireString(body, 'title', { min: 1, max: 200 });
      const mutationId = requireIdempotencyKey(req);
      const result = applyAdministrativeMutation({
        db: database(),
        req,
        sessionId,
        operation: {
          raw: { patch: { title } },
          mutationId,
          entityType: 'session',
          entityId: sessionId,
          operation: 'update',
          baseVersion: Number(body.expectedVersion),
        },
        auditAction: 'session.updated',
      });
      if (result.event && !result.replay) getRealtimeHub(database()).publish(result.event);
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  for (const command of ['close', 'reopen'] as const) {
    router.post(`/sessions/:sessionId/${command}`, (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['expectedVersion']);
        if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
          throw validationError('expectedVersion must be a positive integer');
        }
        const result = applyAdministrativeMutation({
          db: database(),
          req,
          sessionId,
          operation: {
            raw: {},
            mutationId: requireIdempotencyKey(req),
            entityType: 'session',
            entityId: sessionId,
            operation: command,
            baseVersion: Number(body.expectedVersion),
          },
          auditAction: `session.${command === 'close' ? 'closed' : 'reopened'}`,
        });
        if (result.event && !result.replay) {
          const hub = getRealtimeHub(database());
          hub.publish(result.event);
          if (command === 'close') {
            getLiveDraftLockManager(database()).clearSession(sessionId);
            hub.publishControl({
              type: 'liveDraft.lockChanged',
              sessionId,
              occurredAt: result.event.occurredAt,
              action: 'sessionClosed',
              locks: [],
            });
          }
        }
        sendStored(res, result);
      } catch (error) {
        next(error);
      }
    });
  }

  router.post(
    '/sessions/:sessionId/close-discarding-live-draft',
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['expectedVersion', 'reason']);
        const reason = requiredReason(body);
        if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
          throw validationError('expectedVersion must be a positive integer');
        }
        const db = database();
        requireAdminElevation(db, runtimeConfig, req);
        const activeLockCount = getLiveDraftLockManager(db).list(sessionId).length;
        const result = applyAdministrativeMutation({
          db,
          req,
          sessionId,
          operation: {
            raw: {},
            mutationId: requireIdempotencyKey(req),
            entityType: 'session',
            entityId: sessionId,
            operation: 'close',
            baseVersion: Number(body.expectedVersion),
          },
          auditAction: 'session.closed_with_live_draft_discard',
          reason,
          idempotencyContext: { reason, discardLiveDraftOnClose: true },
          auditDetails: (event) => {
            const cleared = liveDraftClearedFromEvent(event);
            return {
              discardedLiveDraft: Boolean(cleared),
              discardedDraftId: cleared?.discardedDraftId ?? null,
              discardedDraftVersion: cleared?.discardedDraftVersion ?? null,
              discardedDeviceStateCount: cleared?.discardedDeviceStateCount ?? 0,
              clearedActiveLockCount: activeLockCount,
            };
          },
          sessionMutationOptions: { discardLiveDraftOnClose: true },
        });
        if (result.event && !result.replay) {
          const hub = getRealtimeHub(db);
          hub.publish(result.event);
          getLiveDraftLockManager(db).clearSession(sessionId);
          const cleared = liveDraftClearedFromEvent(result.event);
          if (cleared) {
            hub.publishControl({
              type: 'liveDraft.cleared',
              sessionId,
              occurredAt: result.event.occurredAt,
              discardedBy: {
                userId: result.event.actor.userId,
                username: result.event.actor.displayName,
              },
              discardedDraftId: cleared.discardedDraftId,
              discardedDraftVersion: cleared.discardedDraftVersion,
              nextDraft: cleared.nextDraft,
              terminal: true,
            });
          } else {
            hub.publishControl({
              type: 'liveDraft.lockChanged',
              sessionId,
              occurredAt: result.event.occurredAt,
              action: 'sessionClosed',
              locks: [],
            });
          }
        }
        sendStored(res, result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete('/sessions/:sessionId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['expectedVersion', 'reason']);
      const reason = requiredReason(body);
      if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        throw validationError('expectedVersion must be a positive integer');
      }
      requireAdminElevation(database(), runtimeConfig, req);
      const result = applyAdministrativeMutation({
        db: database(),
        req,
        sessionId,
        operation: {
          raw: {},
          mutationId: requireIdempotencyKey(req),
          entityType: 'session',
          entityId: sessionId,
          operation: 'delete',
          baseVersion: Number(body.expectedVersion),
        },
        auditAction: 'session.deleted',
        reason,
      });
      if (result.event && !result.replay) {
        const hub = getRealtimeHub(database());
        hub.publish(result.event);
        hub.sessionDeleted(sessionId);
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionId/recover', (req: V1AuthRequest, res, next) => {
    try {
      const sourceSessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['title', 'ownerUserId', 'reason']);
      const title = requireString(body, 'title', { min: 1, max: 200 });
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      const source = currentSession(db, sourceSessionId);
      if (!source.deleted_at) {
        throw new AppError(409, 'SESSION_NOT_DELETED', 'Only a deleted Session can be recovered');
      }
      const ownerUserId = body.ownerUserId === undefined
        ? source.owner_user_id
        : normalizeStableId(body.ownerUserId, 'ownerUserId');
      const newSessionId = randomUUID();
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'session.recovered_as_copy',
        targetType: 'session',
        targetId: sourceSessionId,
        sessionId: sourceSessionId,
        reason,
        successStatus: 201,
        execute: () => {
          const owner = db.prepare(`
            SELECT id, disabled_at, deleted_at FROM users WHERE id = ?
          `).get(ownerUserId) as {
            id: string;
            disabled_at: string | null;
            deleted_at: string | null;
          } | undefined;
          if (!owner || owner.disabled_at || owner.deleted_at) {
            throw new AppError(409, 'TARGET_OWNER_INVALID', 'Recovery owner must be active');
          }
          const now = new Date().toISOString();
          db.prepare(`
            INSERT INTO sessions (
              id, title, status, owner_user_id, version, event_seq, min_retained_seq,
              created_at, updated_at, closed_at, closed_by, deleted_at
            ) VALUES (?, ?, 'closed', ?, 1, 0, 0, ?, ?, ?, ?, NULL)
          `).run(newSessionId, title, ownerUserId, now, now, now, req.auth!.userId);
          db.prepare(`
            INSERT INTO session_members (
              id, session_id, user_id, role, version, created_at, updated_at
            ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
          `).run(randomUUID(), newSessionId, ownerUserId, now, now);
          const members = db.prepare(`
            SELECT sm.user_id, sm.role
            FROM session_members sm JOIN users u ON u.id = sm.user_id
            WHERE sm.session_id = ? AND sm.removed_at IS NULL
              AND sm.user_id <> ? AND u.disabled_at IS NULL AND u.deleted_at IS NULL
          `).all(sourceSessionId, ownerUserId) as Array<{ user_id: string; role: string }>;
          const insertMember = db.prepare(`
            INSERT INTO session_members (
              id, session_id, user_id, role, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?)
          `);
          for (const member of members) {
            insertMember.run(
              randomUUID(),
              newSessionId,
              member.user_id,
              member.role === 'owner' ? 'editor' : member.role,
              now,
              now,
            );
          }
          const copied = db.prepare(`
            INSERT INTO logs (
              sync_id, session_id, version, time, controller, callsign,
              rst_sent, rst_rcvd, qth, device, power, antenna, height, remarks,
              created_at, updated_at, created_by, updated_by, source_device_id,
              deleted_at, deleted_by
            )
            SELECT
              sync_id, ?, 1, time, controller, callsign,
              rst_sent, rst_rcvd, qth, device, power, antenna, height, remarks,
              created_at, ?, created_by, ?, 'admin-recovery', NULL, NULL
            FROM logs WHERE session_id = ? AND deleted_at IS NULL
          `).run(newSessionId, now, req.auth!.userId, sourceSessionId);
          return {
            response: {
              sourceSessionId,
              recoveredSessionId: newSessionId,
              status: 'closed',
              ownerUserId,
              copiedLogCount: Number(copied.changes),
              copiedMemberCount: members.length + 1,
            },
            before: {
              sourceSessionId,
              deletedAt: source.deleted_at,
              finalSeq: Number(source.event_seq),
            },
            after: {
              sessionId: newSessionId,
              title,
              status: 'closed',
              ownerUserId,
            },
            details: {
              copiedLogCount: Number(copied.changes),
              copiedMemberCount: members.length + 1,
            },
          };
        },
      });
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionId/logs', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['syncId', 'value', 'reason']);
      const syncId = normalizeStableId(body.syncId, 'syncId');
      const reason = requiredReason(body);
      requireAdminElevation(database(), runtimeConfig, req);
      const result = applyAdministrativeMutation({
        db: database(),
        req,
        sessionId,
        operation: {
          raw: { value: body.value },
          mutationId: requireIdempotencyKey(req),
          entityType: 'log',
          entityId: syncId,
          operation: 'create',
          baseVersion: 0,
        },
        auditAction: 'log.created',
        reason,
      });
      if (result.event && !result.replay) getRealtimeHub(database()).publish(result.event);
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/sessions/:sessionId/logs/:syncId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const syncId = normalizeStableId(req.params.syncId, 'syncId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['expectedVersion', 'patch']);
      if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        throw validationError('expectedVersion must be a positive integer');
      }
      const result = applyAdministrativeMutation({
        db: database(),
        req,
        sessionId,
        operation: {
          raw: { patch: body.patch },
          mutationId: requireIdempotencyKey(req),
          entityType: 'log',
          entityId: syncId,
          operation: 'update',
          baseVersion: Number(body.expectedVersion),
        },
        auditAction: 'log.updated',
      });
      if (result.event && !result.replay) getRealtimeHub(database()).publish(result.event);
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sessions/:sessionId/logs/:syncId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const syncId = normalizeStableId(req.params.syncId, 'syncId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['expectedVersion', 'reason']);
      const reason = requiredReason(body);
      if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        throw validationError('expectedVersion must be a positive integer');
      }
      requireAdminElevation(database(), runtimeConfig, req);
      const result = applyAdministrativeMutation({
        db: database(),
        req,
        sessionId,
        operation: {
          raw: {},
          mutationId: requireIdempotencyKey(req),
          entityType: 'log',
          entityId: syncId,
          operation: 'delete',
          baseVersion: Number(body.expectedVersion),
        },
        auditAction: 'log.deleted',
        reason,
      });
      if (result.event && !result.replay) getRealtimeHub(database()).publish(result.event);
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionId/logs/:syncId/restore', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const syncId = normalizeStableId(req.params.syncId, 'syncId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['expectedVersion', 'value', 'reason']);
      const reason = requiredReason(body);
      if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        throw validationError('expectedVersion must be a positive integer');
      }
      requireAdminElevation(database(), runtimeConfig, req);
      const raw = body.value === undefined ? { confirm: true } : { value: body.value };
      const result = applyAdministrativeMutation({
        db: database(),
        req,
        sessionId,
        operation: {
          raw,
          mutationId: requireIdempotencyKey(req),
          entityType: 'log',
          entityId: syncId,
          operation: 'restore',
          baseVersion: Number(body.expectedVersion),
        },
        auditAction: 'log.restored',
        reason,
      });
      if (result.event && !result.replay) getRealtimeHub(database()).publish(result.event);
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionId/public-shares', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const db = database();
      currentSession(db, sessionId);
      const rows = db.prepare(`
        SELECT * FROM public_shares WHERE session_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 500
      `).all(sessionId) as PublicShareRow[];
      auditSensitiveRead(db, req, sessionId, 'session.detail.viewed');
      res.json({ items: rows.map(publicShareDto) });
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    '/sessions/:sessionId/public-shares/:publicShareId',
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const publicShareId = normalizeStableId(req.params.publicShareId, 'publicShareId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['reason']);
        const reason = requiredReason(body);
        const db = database();
        requireAdminElevation(db, runtimeConfig, req);
        currentSession(db, sessionId);
        const result = runGovernanceCommand({
          db,
          req,
          requestBody: body,
          action: 'public_share.revoked',
          targetType: 'publicShare',
          targetId: publicShareId,
          sessionId,
          reason,
          execute: () => {
            const current = db.prepare(`
              SELECT * FROM public_shares WHERE id = ? AND session_id = ?
            `).get(publicShareId, sessionId) as PublicShareRow | undefined;
            if (!current) throw new AppError(404, 'PUBLIC_SHARE_NOT_FOUND', 'Public share not found');
            if (current.revoked_at) {
              throw new AppError(409, 'PUBLIC_SHARE_REVOKED', 'Public share is already revoked');
            }
            const now = new Date().toISOString();
            db.prepare(`
              UPDATE public_shares SET revoked_at = ?, revoked_by = ?
              WHERE id = ? AND revoked_at IS NULL
            `).run(now, req.auth!.userId, publicShareId);
            const tickets = db.prepare('DELETE FROM public_ws_tickets WHERE public_share_id = ?')
              .run(publicShareId);
            const updated = db.prepare('SELECT * FROM public_shares WHERE id = ?')
              .get(publicShareId) as PublicShareRow;
            return {
              response: { publicShare: publicShareDto(updated) },
              before: publicShareDto(current),
              after: publicShareDto(updated),
              details: { revokedTicketCount: Number(tickets.changes) },
            };
          },
        });
        if (!result.replay) getRealtimeHub(db).revokePublicShare(publicShareId);
        sendStored(res, result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/sessions/:sessionId/invites', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const db = database();
      currentSession(db, sessionId);
      const rows = db.prepare(`
        SELECT id, session_id, code_hint, role, max_uses, used_count,
               expires_at, created_by, created_at, revoked_at, revoked_by
        FROM collaboration_invites WHERE session_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 500
      `).all(sessionId) as Array<Record<string, unknown>>;
      auditSensitiveRead(db, req, sessionId, 'session.detail.viewed');
      res.json({
        items: rows.map((row) => ({
          inviteId: row.id,
          sessionId: row.session_id,
          codeHint: row.code_hint,
          role: row.role,
          maxUses: Number(row.max_uses),
          usedCount: Number(row.used_count),
          expiresAt: row.expires_at,
          createdBy: row.created_by,
          createdAt: row.created_at,
          revokedAt: row.revoked_at,
          revokedBy: row.revoked_by,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sessions/:sessionId/invites/:inviteId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const inviteId = normalizeStableId(req.params.inviteId, 'inviteId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['reason']);
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      currentSession(db, sessionId);
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'invite.revoked',
        targetType: 'invite',
        targetId: inviteId,
        sessionId,
        reason,
        execute: () => {
          const current = db.prepare(`
            SELECT id, role, max_uses, used_count, expires_at, revoked_at
            FROM collaboration_invites WHERE id = ? AND session_id = ?
          `).get(inviteId, sessionId) as Record<string, unknown> | undefined;
          if (!current) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invite not found');
          if (current.revoked_at) throw new AppError(409, 'INVITE_REVOKED', 'Invite is already revoked');
          const now = new Date().toISOString();
          db.prepare(`
            UPDATE collaboration_invites SET revoked_at = ?, revoked_by = ?
            WHERE id = ? AND revoked_at IS NULL
          `).run(now, req.auth!.userId, inviteId);
          return {
            response: { inviteId, revokedAt: now },
            before: current,
            after: { ...current, revoked_at: now, revoked_by: req.auth!.userId },
          };
        },
      });
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/llm-credential', (_req: V1AuthRequest, res, next) => {
    try {
      res.json(llmCredentialStatus(database(), runtimeConfig));
    } catch (error) {
      next(error);
    }
  });

  router.put('/llm-credential', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['apiKey', 'reason']);
      const apiKey = requireString(body, 'apiKey', { min: 1, max: 8_192, trim: false });
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      const before = llmCredentialStatus(db, runtimeConfig);
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'server.llm_credential.updated',
        targetType: 'server-secret',
        targetId: 'llm-api-key',
        reason,
        execute: () => {
          const after = storeLlmApiKey(db, runtimeConfig, apiKey, req.auth!.userId);
          return { response: after, before: { ...before }, after: { ...after } };
        },
      });
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/llm-credential', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['reason']);
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      const before = llmCredentialStatus(db, runtimeConfig);
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'server.llm_credential.removed',
        targetType: 'server-secret',
        targetId: 'llm-api-key',
        reason,
        execute: () => {
          const after = removeStoredLlmApiKey(db, runtimeConfig);
          return { response: after, before: { ...before }, after: { ...after } };
        },
      });
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/operational-settings', (req: V1AuthRequest, res, next) => {
    try {
      const db = database();
      const overrides = applicableConfigOverrides(db, runtimeConfig);
      const effective = editableConfigSnapshot(runtimeConfig);
      const desired = { ...editableConfigSnapshot(baseConfig), ...overrides };
      const restartRequiredKeys = [...RESTART_CONFIG_KEYS].filter(
        (key) => JSON.stringify(desired[key]) !== JSON.stringify(effective[key]),
      );
      const llmCredential = llmCredentialStatus(db, runtimeConfig);
      res.json({
        effective,
        desired,
        overrides,
        restartRequired: restartRequiredKeys.length > 0,
        restartRequiredKeys,
        readOnly: {
          databasePath: runtimeConfig.dbPath,
          environment: runtimeConfig.environment,
          containerMode: runtimeConfig.containerMode === true,
          jwtIssuer: runtimeConfig.jwtIssuer,
          secrets: {
            jwtConfigured: Buffer.byteLength(runtimeConfig.jwtSecret, 'utf8') >= 32,
            bootstrapConfigured: Buffer.byteLength(runtimeConfig.bootstrapSecret, 'utf8') >= 24,
            inviteHmacConfigured: Buffer.byteLength(runtimeConfig.inviteHmacKey, 'utf8') >= 32,
            publicShareHmacConfigured: Buffer.byteLength(runtimeConfig.publicShareHmacKey, 'utf8') >= 32,
            llmApiKeyConfigured: llmCredential.configured,
            llmApiKeySource: llmCredential.source,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/operational-settings', (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['updates', 'reason']);
      const updates = requireJsonObject(body.updates);
      rejectUnknownKeys(updates, EDITABLE_CONFIG_KEYS);
      if (Object.keys(updates).length === 0) {
        throw validationError('updates must contain at least one setting');
      }
      if (
        runtimeConfig.containerMode === true &&
        Object.prototype.hasOwnProperty.call(updates, 'port')
      ) {
        throw validationError('port is managed by the container and cannot be overridden');
      }
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      const normalized: Partial<Record<EditableConfigKey, unknown>> = {};
      for (const [rawKey, rawValue] of Object.entries(updates)) {
        const key = rawKey as EditableConfigKey;
        normalized[key] = rawValue === null ? null : validateConfigValue(key, rawValue);
      }
      const before = applicableConfigOverrides(db, runtimeConfig);
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'server.operational_settings.updated',
        targetType: 'server',
        targetId: 'primary',
        reason,
        execute: () => {
          const now = new Date().toISOString();
          const upsert = db.prepare(`
            INSERT INTO server_config_overrides (key, value_json, updated_by, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_by = excluded.updated_by,
              updated_at = excluded.updated_at
          `);
          for (const [rawKey, value] of Object.entries(normalized)) {
            const key = rawKey as EditableConfigKey;
            if (value === null) {
              db.prepare('DELETE FROM server_config_overrides WHERE key = ?').run(key);
            } else {
              upsert.run(key, JSON.stringify(value), req.auth!.userId, now);
            }
          }
          const after = applicableConfigOverrides(db, runtimeConfig);
          const effective = { ...editableConfigSnapshot(runtimeConfig) };
          for (const [rawKey, value] of Object.entries(normalized)) {
            const key = rawKey as EditableConfigKey;
            if (RESTART_CONFIG_KEYS.has(key)) continue;
            effective[key] = value === null
              ? editableConfigSnapshot(baseConfig)[key]
              : value;
          }
          const desired = { ...editableConfigSnapshot(baseConfig), ...after };
          const restartRequiredKeys = [...RESTART_CONFIG_KEYS].filter(
            (key) => JSON.stringify(desired[key]) !== JSON.stringify(effective[key]),
          );
          return {
            response: {
              effective,
              desired,
              overrides: after,
              restartRequired: restartRequiredKeys.length > 0,
              restartRequiredKeys,
            },
            before,
            after,
          };
        },
      });
      if (!result.replay) {
        for (const [rawKey, value] of Object.entries(normalized)) {
          const key = rawKey as EditableConfigKey;
          applyImmediateConfig(
            runtimeConfig,
            key,
            value === null ? editableConfigSnapshot(baseConfig)[key] : value,
          );
        }
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/governance-audit-events', (req: V1AuthRequest, res, next) => {
    try {
      const page = positiveQuery(req, 'page', 1, 1_000_000);
      const pageSize = positiveQuery(req, 'pageSize', 50, MAX_PAGE_SIZE);
      const action = queryScalar(req, 'action');
      const actorUserId = queryScalar(req, 'actorUserId');
      const sessionId = queryScalar(req, 'sessionId');
      const targetId = queryScalar(req, 'targetId');
      const clauses: string[] = [];
      const params: string[] = [];
      if (action) {
        clauses.push('action = ?');
        params.push(action);
      }
      if (actorUserId) {
        clauses.push('actor_user_id = ?');
        params.push(normalizeStableId(actorUserId, 'actorUserId'));
      }
      if (sessionId) {
        clauses.push('session_id = ?');
        params.push(normalizeStableId(sessionId, 'sessionId'));
      }
      if (targetId) {
        clauses.push('target_id = ?');
        params.push(normalizeStableId(targetId, 'targetId'));
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const db = database();
      const total = db.prepare(`
        SELECT COUNT(*) AS count FROM admin_governance_audit_events ${where}
      `).get(...params) as { count: number };
      const rows = db.prepare(`
        SELECT * FROM admin_governance_audit_events ${where}
        ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?
      `).all(...params, pageSize, (page - 1) * pageSize) as Array<{
        id: string;
        action: string;
        actor_user_id: string;
        target_type: string | null;
        target_id: string | null;
        session_id: string | null;
        request_id: string;
        mutation_id: string;
        reason: string | null;
        before_json: string | null;
        after_json: string | null;
        details_json: string;
        occurred_at: string;
      }>;
      res.json({
        items: rows.map((row) => ({
          auditEventId: row.id,
          action: row.action,
          actorUserId: row.actor_user_id,
          targetType: row.target_type,
          targetId: row.target_id,
          sessionId: row.session_id,
          requestId: row.request_id,
          mutationId: row.mutation_id,
          reason: row.reason,
          before: parseStoredObject(row.before_json),
          after: parseStoredObject(row.after_json),
          details: parseStoredObject(row.details_json) ?? {},
          occurredAt: row.occurred_at,
        })),
        page,
        pageSize,
        total: Number(total.count),
        totalPages: Math.ceil(Number(total.count) / pageSize),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionId/export', async (req: V1AuthRequest, res, next) => {
    let exportSnapshot: ExportSnapshot | undefined;
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['format', 'includeDeleted', 'reason']);
      if (body.format !== 'csv' && body.format !== 'json') {
        throw validationError('format must be csv or json');
      }
      if (body.includeDeleted !== undefined && typeof body.includeDeleted !== 'boolean') {
        throw validationError('includeDeleted must be boolean');
      }
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      exportSnapshot = openExportSnapshot(db);
      const exportDb = exportSnapshot.db;
      const session = currentSession(exportDb, sessionId);
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(req.method, req.baseUrl + req.path, body);
      if (readStoredResponse(db, mutationId, req.auth!.userId, requestHash)) {
        throw new AppError(
          409,
          'DOWNLOAD_ALREADY_ISSUED',
          'Start a new export with a fresh Idempotency-Key so every download is audited',
        );
      }
      const includeDeleted = body.includeDeleted === true;
      const logCount = Number(exportDb.prepare(`
        SELECT COUNT(*)
        FROM logs
        WHERE session_id = ? AND (? = 1 OR deleted_at IS NULL)
      `).pluck().get(sessionId, includeDeleted ? 1 : 0));
      if (logCount > MAX_EXPORT_LOGS) {
        throw new AppError(
          413,
          'EXPORT_TOO_LARGE',
          `A single export is limited to ${MAX_EXPORT_LOGS} Logs`,
          { logCount, maximum: MAX_EXPORT_LOGS },
        );
      }
      db.transaction(() => {
        requireAdminElevation(db, runtimeConfig, req);
        const stored = readStoredResponse(db, mutationId, req.auth!.userId, requestHash);
        if (stored) {
          throw new AppError(
            409,
            'DOWNLOAD_ALREADY_ISSUED',
            'Start a new export with a fresh Idempotency-Key so every download is audited',
          );
        }
        const auditEventId = appendGovernanceAudit(db, {
          action: 'session.exported',
          actorUserId: req.auth!.userId,
          requestId: getRequestId(req),
          mutationId,
          targetType: 'session',
          targetId: sessionId,
          sessionId,
          reason,
          details: {
            format: body.format,
            includeDeleted,
            logCount,
          },
        });
        storeResponse(db, {
          mutationId,
          sessionId,
          userId: req.auth!.userId,
          deviceId: deviceId(req),
          requestHash,
          status: 200,
          body: { auditEventId, exportAuthorized: true },
        });
      }).immediate();
      const safeName = session.title.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'session';
      const pageStatement = exportDb.prepare(`
        SELECT * FROM logs
        WHERE session_id = ? AND (? = 1 OR deleted_at IS NULL)
          AND (
            ? IS NULL OR time > ? OR (time = ? AND sync_id > ?)
          )
        ORDER BY time ASC, sync_id ASC
        LIMIT ?
      `);
      const columns = [
        'syncId', 'version', 'time', 'controller', 'callsign', 'rstSent', 'rstRcvd',
        'qth', 'device', 'power', 'antenna', 'height', 'remarks', 'createdAt',
        'updatedAt', 'createdBy', 'updatedBy', 'deletedAt',
      ] as const;
      async function* rows(): AsyncGenerator<LogRow> {
        let afterTime: string | null = null;
        let afterSyncId = '';
        while (true) {
          const page = pageStatement.all(
            sessionId,
            includeDeleted ? 1 : 0,
            afterTime,
            afterTime,
            afterTime,
            afterSyncId,
            EXPORT_PAGE_SIZE,
          ) as LogRow[];
          if (page.length === 0) return;
          for (const row of page) yield row;
          const last = page[page.length - 1];
          afterTime = last.time;
          afterSyncId = last.sync_id;
        }
      }
      async function* exportChunks(): AsyncGenerator<string> {
        if (body.format === 'json') {
          const metadata = {
          exportedAt: new Date().toISOString(),
          session: {
            sessionId: session.id,
            title: session.title,
            status: session.status,
            version: Number(session.version),
            ownerUserId: session.owner_user_id,
            createdAt: session.created_at,
            updatedAt: session.updated_at,
            closedAt: session.closed_at,
            deletedAt: session.deleted_at,
          },
            includesDeletedLogs: includeDeleted,
          };
          yield `${JSON.stringify(metadata).slice(0, -1)},"logs":[`;
          let index = 0;
          for await (const row of rows()) {
            yield `${index === 0 ? '' : ','}${JSON.stringify(logDto(row))}`;
            index += 1;
            if (index % 512 === 0) {
              await new Promise<void>((resolve) => setImmediate(resolve));
              requireActiveAdminAccess(db, req);
            }
          }
          yield ']}';
          return;
        }
        yield `\uFEFF${columns.join(',')}\r\n`;
        let index = 0;
        for await (const row of rows()) {
          const dto = logDto(row);
          yield `${columns.map((column) => csvCell(dto[column])).join(',')}\r\n`;
          index += 1;
          if (index % 512 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            requireActiveAdminAccess(db, req);
          }
        }
      }
      const extension = body.format === 'json' ? 'json' : 'csv';
      res.setHeader(
        'Content-Type',
        body.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${extension}"`);
      res.setHeader('X-Export-Log-Count', String(logCount));
      await pipeline(Readable.from(exportChunks()), res);
    } catch (error) {
      if (!res.headersSent) next(error);
    } finally {
      exportSnapshot?.close();
    }
  });

  router.post('/database-backup', async (req: V1AuthRequest, res, next) => {
    let temporaryDirectory: string | undefined;
    const db = database();
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['reason']);
      const reason = requiredReason(body);
      requireAdminElevation(db, runtimeConfig, req);
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(req.method, req.baseUrl + req.path, body);
      const replay = readStoredResponse(db, mutationId, req.auth!.userId, requestHash);
      if (replay) {
        throw new AppError(
          409,
          'DOWNLOAD_ALREADY_ISSUED',
          'Start a new backup with a fresh Idempotency-Key so every download is audited',
        );
      }
      if (backupsInProgress.has(db)) {
        throw new AppError(409, 'BACKUP_IN_PROGRESS', 'A database backup is already in progress');
      }
      backupsInProgress.add(db);
      temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'openlogtool-backup-'));
      const backupPath = path.join(temporaryDirectory, 'openlogtool.db');
      await db.backup(backupPath);
      db.transaction(() => {
          requireAdminElevation(db, runtimeConfig, req);
          if (readStoredResponse(db, mutationId, req.auth!.userId, requestHash)) {
            throw new AppError(
              409,
              'DOWNLOAD_ALREADY_ISSUED',
              'Start a new backup with a fresh Idempotency-Key so every download is audited',
            );
          }
          const auditEventId = appendGovernanceAudit(db, {
            action: 'database.backup.prepared',
            actorUserId: req.auth!.userId,
            requestId: getRequestId(req),
            mutationId,
            targetType: 'database',
            targetId: 'primary',
            reason,
          });
          storeResponse(db, {
            mutationId,
            userId: req.auth!.userId,
            deviceId: deviceId(req),
            requestHash,
            status: 200,
            body: { auditEventId, backupAuthorized: true },
          });
        }).immediate();
      const directory = temporaryDirectory;
      temporaryDirectory = undefined;
      res.download(
        backupPath,
        `openlogtool-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
        async (error) => {
          backupsInProgress.delete(db);
          await rm(directory, { recursive: true, force: true });
          if (error && !res.headersSent) next(error);
        },
      );
    } catch (error) {
      backupsInProgress.delete(db);
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      next(error);
    }
  });

  router.post('/sessions/:sessionId/members', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['userId', 'role', 'reason']);
      const userId = normalizeStableId(body.userId, 'userId');
      if (body.role !== 'editor' && body.role !== 'viewer') {
        throw validationError('role must be editor or viewer');
      }
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      governableSession(db, sessionId);
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'membership.added',
        targetType: 'user',
        targetId: userId,
        sessionId,
        reason,
        execute: () => {
          const user = db.prepare(`
            SELECT id, username, disabled_at, deleted_at FROM users WHERE id = ?
          `).get(userId) as {
            id: string;
            username: string;
            disabled_at: string | null;
            deleted_at: string | null;
          } | undefined;
          if (!user || user.disabled_at || user.deleted_at) {
            throw new AppError(404, 'USER_NOT_FOUND', 'An active target user is required');
          }
          const existing = db.prepare(
            'SELECT * FROM session_members WHERE session_id = ? AND user_id = ?',
          ).get(sessionId, userId) as MembershipRow | undefined;
          if (existing && !existing.removed_at) {
            throw new AppError(409, 'MEMBERSHIP_EXISTS', 'User is already a Session member');
          }
          const now = new Date().toISOString();
          if (existing) {
            db.prepare(`
              UPDATE session_members
              SET role = ?, version = version + 1, updated_at = ?, removed_at = NULL, removed_by = NULL
              WHERE id = ? AND removed_at IS NOT NULL
            `).run(body.role, now, existing.id);
          } else {
            db.prepare(`
              INSERT INTO session_members (
                id, session_id, user_id, role, version, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 1, ?, ?)
            `).run(randomUUID(), sessionId, userId, body.role, now, now);
          }
          const membership = db.prepare(
            'SELECT * FROM session_members WHERE session_id = ? AND user_id = ?',
          ).get(sessionId, userId) as MembershipRow;
          return {
            response: {
              membership: {
                membershipId: membership.id,
                userId,
                username: user.username,
                role: membership.role,
                version: Number(membership.version),
                removedAt: membership.removed_at,
              },
            },
            before: existing ? {
              role: existing.role,
              version: Number(existing.version),
              removedAt: existing.removed_at,
            } : null,
            after: {
              role: membership.role,
              version: Number(membership.version),
              removedAt: membership.removed_at,
            },
          };
        },
      });
      if (!result.replay) {
        const membership = db.prepare(
          'SELECT role, version FROM session_members WHERE session_id = ? AND user_id = ?',
        ).get(sessionId, userId) as { role: string; version: number };
        getRealtimeHub(db).roleChanged(sessionId, userId, membership.role, membership.version);
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/sessions/:sessionId/members/:userId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const userId = normalizeStableId(req.params.userId, 'userId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['role', 'expectedVersion', 'reason']);
      if (body.role !== 'editor' && body.role !== 'viewer') {
        throw validationError('role must be editor or viewer');
      }
      if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        throw validationError('expectedVersion must be a positive integer');
      }
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      governableSession(db, sessionId);
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'membership.role.updated',
        targetType: 'user',
        targetId: userId,
        sessionId,
        reason,
        execute: () => {
          const current = db.prepare(`
            SELECT * FROM session_members
            WHERE session_id = ? AND user_id = ? AND removed_at IS NULL
          `).get(sessionId, userId) as MembershipRow | undefined;
          if (!current) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found');
          if (current.role === 'owner') {
            throw new AppError(409, 'OWNER_ROLE_IMMUTABLE', 'Transfer ownership instead');
          }
          if (Number(current.version) !== Number(body.expectedVersion)) {
            throw new AppError(409, 'MEMBERSHIP_VERSION_CONFLICT', 'Membership changed concurrently', {
              currentVersion: Number(current.version),
              currentRole: current.role,
            });
          }
          const now = new Date().toISOString();
          db.prepare(`
            UPDATE session_members SET role = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND removed_at IS NULL
          `).run(body.role, now, current.id, current.version);
          const updated = db.prepare('SELECT * FROM session_members WHERE id = ?')
            .get(current.id) as MembershipRow;
          return {
            response: { membership: { userId, role: updated.role, version: Number(updated.version) } },
            before: { role: current.role, version: Number(current.version) },
            after: { role: updated.role, version: Number(updated.version) },
          };
        },
      });
      if (!result.replay) {
        const membership = db.prepare(
          'SELECT role, version FROM session_members WHERE session_id = ? AND user_id = ?',
        ).get(sessionId, userId) as { role: string; version: number };
        getRealtimeHub(db).roleChanged(sessionId, userId, membership.role, membership.version);
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sessions/:sessionId/members/:userId', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const userId = normalizeStableId(req.params.userId, 'userId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['expectedVersion', 'reason']);
      if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
        throw validationError('expectedVersion must be a positive integer');
      }
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      governableSession(db, sessionId);
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'membership.removed',
        targetType: 'user',
        targetId: userId,
        sessionId,
        reason,
        execute: () => {
          const current = db.prepare(`
            SELECT * FROM session_members
            WHERE session_id = ? AND user_id = ? AND removed_at IS NULL
          `).get(sessionId, userId) as MembershipRow | undefined;
          if (!current) throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found');
          if (current.role === 'owner') {
            throw new AppError(409, 'OWNER_CANNOT_BE_REMOVED', 'Transfer ownership first');
          }
          if (Number(current.version) !== Number(body.expectedVersion)) {
            throw new AppError(409, 'MEMBERSHIP_VERSION_CONFLICT', 'Membership changed concurrently');
          }
          const now = new Date().toISOString();
          db.prepare(`
            UPDATE session_members
            SET version = version + 1, updated_at = ?, removed_at = ?, removed_by = ?
            WHERE id = ? AND version = ? AND removed_at IS NULL
          `).run(now, now, req.auth!.userId, current.id, current.version);
          db.prepare('DELETE FROM ws_tickets WHERE session_id = ? AND user_id = ?')
            .run(sessionId, userId);
          return {
            response: { userId, removedAt: now },
            before: { role: current.role, version: Number(current.version), removedAt: null },
            after: { role: current.role, version: Number(current.version) + 1, removedAt: now },
          };
        },
      });
      if (!result.replay) getRealtimeHub(db).revoke(sessionId, userId);
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionId/transfer-ownership', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['targetUserId', 'reason']);
      const targetUserId = normalizeStableId(body.targetUserId, 'targetUserId');
      const reason = requiredReason(body);
      const db = database();
      requireAdminElevation(db, runtimeConfig, req);
      const session = governableSession(db, sessionId);
      const previousOwnerId = session.owner_user_id;
      const result = runGovernanceCommand({
        db,
        req,
        requestBody: body,
        action: 'session.ownership.transferred',
        targetType: 'session',
        targetId: sessionId,
        sessionId,
        reason,
        execute: () => {
          const target = db.prepare(`
            SELECT sm.*, u.disabled_at, u.deleted_at
            FROM session_members sm JOIN users u ON u.id = sm.user_id
            WHERE sm.session_id = ? AND sm.user_id = ? AND sm.removed_at IS NULL
          `).get(sessionId, targetUserId) as (MembershipRow & {
            disabled_at: string | null;
            deleted_at: string | null;
          }) | undefined;
          if (!target || target.disabled_at || target.deleted_at) {
            throw new AppError(409, 'TARGET_OWNER_INVALID', 'Target must be an active Session member');
          }
          if (target.role === 'owner') {
            throw new AppError(409, 'ALREADY_OWNER', 'Target user already owns the Session');
          }
          const previous = db.prepare(`
            SELECT * FROM session_members
            WHERE session_id = ? AND user_id = ? AND role = 'owner' AND removed_at IS NULL
          `).get(sessionId, previousOwnerId) as MembershipRow | undefined;
          if (!previous) throw new AppError(500, 'OWNER_MEMBERSHIP_MISSING', 'Owner membership is missing');
          const now = new Date().toISOString();
          db.prepare(`
            UPDATE session_members SET role = 'editor', version = version + 1, updated_at = ?
            WHERE id = ?
          `).run(now, previous.id);
          db.prepare(`
            UPDATE session_members SET role = 'owner', version = version + 1, updated_at = ?
            WHERE id = ?
          `).run(now, target.id);
          db.prepare('UPDATE sessions SET owner_user_id = ?, updated_at = ? WHERE id = ?')
            .run(targetUserId, now, sessionId);
          return {
            response: { previousOwnerUserId: previousOwnerId, ownerUserId: targetUserId },
            before: { ownerUserId: previousOwnerId },
            after: { ownerUserId: targetUserId },
          };
        },
      });
      if (!result.replay) {
        const hub = getRealtimeHub(db);
        const oldRow = db.prepare('SELECT version FROM session_members WHERE session_id = ? AND user_id = ?')
          .get(sessionId, previousOwnerId) as { version: number };
        const newRow = db.prepare('SELECT version FROM session_members WHERE session_id = ? AND user_id = ?')
          .get(sessionId, targetUserId) as { version: number };
        hub.roleChanged(sessionId, previousOwnerId, 'editor', Number(oldRow.version));
        hub.roleChanged(sessionId, targetUserId, 'owner', Number(newRow.version));
      }
      sendStored(res, result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const adminGovernanceV1Router = createAdminGovernanceV1Router();
