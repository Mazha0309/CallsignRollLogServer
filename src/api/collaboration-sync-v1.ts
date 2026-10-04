import { createHash, randomBytes, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { RequestHandler, Router } from 'express';
import { AppConfig } from '../config';
import {
  findMembershipIncludingRemoved,
  findSession,
  MembershipRow,
  normalizeStableId,
  requireMembership,
  SessionRole,
  SessionRow,
} from '../collaboration/access';
import {
  appendSessionEvent,
  CollaborationEvent,
  readEventsAfter,
} from '../collaboration/events';
import {
  computeRequestHash,
  readStoredResponse,
  storeResponse,
} from '../collaboration/idempotency';
import { appendCollaborationAudit } from '../collaboration/audit';
import { getRealtimeHub } from '../collaboration/realtime';
import {
  EMPTY_FIELD_REVISIONS,
  getLiveDraftLockManager,
  liveDraftHasActualContent,
} from '../collaboration/live-draft';
import { AppError } from '../errors/app-error';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { getRequestId } from '../middleware/request-id';
import { getRuntimeMetrics } from '../operations/metrics';
import {
  optionalUuid,
  rejectUnknownKeys,
  requireJsonObject,
  requireString,
} from '../utils/validation';

export interface CollaborationSyncV1Dependencies {
  db: Database.Database;
  config: AppConfig;
}

export interface LogRow {
  sync_id: string;
  session_id: string;
  version: number;
  time: string;
  controller: string;
  callsign: string;
  rst_sent: string | null;
  rst_rcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MutationOperation {
  raw: Record<string, unknown>;
  mutationId: string;
  entityType: 'log' | 'session';
  entityId: string;
  operation: string;
  baseVersion: number;
}

export type MutationResult =
  | { mutationId: string; status: 'accepted'; event: CollaborationEvent }
  | {
      mutationId: string;
      status: 'conflict';
      code: 'VERSION_CONFLICT';
      currentVersion: number;
      currentEntity: unknown;
    }
  | {
      mutationId: string;
      status: 'rejected';
      code: string;
      message: string;
      details?: unknown;
    };

export interface LiveDraftClearedProjection {
  terminal: true;
  discardedDraftId: string;
  discardedDraftVersion: number;
  discardedDeviceStateCount: number;
  nextDraft: {
    draftId: string;
    sessionId: string;
    version: number;
    fields: Record<string, string | null>;
    fieldRevisions: Record<string, number>;
    lastUpdatedBy: null;
    createdAt: string;
    lastUpdatedAt: string;
  };
}

export function liveDraftClearedFromEvent(
  event: CollaborationEvent | undefined,
): LiveDraftClearedProjection | undefined {
  if (!event || event.type !== 'session.closed' || !event.payload ||
      typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return undefined;
  }
  const value = (event.payload as Record<string, unknown>).liveDraftCleared;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as LiveDraftClearedProjection
    : undefined;
}

export interface CanonicalLogValue {
  time: string;
  controller: string;
  callsign: string;
  rstSent: string | null;
  rstRcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
}

const OPERATION_KEYS = [
  'mutationId',
  'entityType',
  'entityId',
  'operation',
  'baseVersion',
  'observedSeq',
  'queuedAt',
  'value',
  'patch',
  'confirm',
] as const;

const LOG_VALUE_KEYS = [
  'syncId',
  'sessionId',
  'time',
  'controller',
  'callsign',
  'rstSent',
  'rstRcvd',
  'qth',
  'device',
  'power',
  'antenna',
  'height',
  'remarks',
] as const;

const LOG_PATCH_KEYS = [
  'time',
  'controller',
  'callsign',
  'rstSent',
  'rstRcvd',
  'qth',
  'device',
  'power',
  'antenna',
  'height',
  'remarks',
] as const;

function noLimit(): RequestHandler {
  return (_req, _res, next) => next();
}

function uuidField(value: Record<string, unknown>, field: string): string {
  const result = optionalUuid(value, field);
  if (!result) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} is required`, { field });
  }
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a non-negative integer`, {
      field,
    });
  }
  return Number(value);
}

function parseQueryInteger(
  raw: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum?: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be an integer`, { field });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} is outside the allowed range`, {
      field,
      minimum,
      ...(maximum === undefined ? {} : { maximum }),
    });
  }
  return value;
}

function nullableText(
  value: Record<string, unknown>,
  field: string,
  max: number,
): string | null {
  const raw = value[field];
  if (raw == null) return null;
  if (typeof raw !== 'string') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a string or null`, {
      field,
    });
  }
  if (raw.length > max) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} is too long`, { field, max });
  }
  const normalized = raw.trim();
  return normalized === '' ? null : normalized;
}

function validateTimestamp(value: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
    value,
  );
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    !match ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be an RFC 3339 timestamp`, {
      field,
    });
  }
  return value;
}

export function canonicalLogValue(
  raw: unknown,
  identity: { sessionId: string; syncId: string },
): CanonicalLogValue {
  const value = requireJsonObject(raw);
  rejectUnknownKeys(value, LOG_VALUE_KEYS);
  if (value.syncId !== undefined && normalizeStableId(value.syncId, 'value.syncId') !== identity.syncId) {
    throw new AppError(422, 'VALIDATION_FAILED', 'value.syncId must match entityId');
  }
  if (
    value.sessionId !== undefined &&
    normalizeStableId(value.sessionId, 'value.sessionId') !== identity.sessionId
  ) {
    throw new AppError(422, 'VALIDATION_FAILED', 'value.sessionId must match the request Session');
  }
  return {
    time: validateTimestamp(requireString(value, 'time', { min: 1, max: 64 }), 'value.time'),
    controller: requireString(value, 'controller', { min: 1, max: 32 }).toUpperCase(),
    callsign: requireString(value, 'callsign', { min: 1, max: 32 }).toUpperCase(),
    rstSent: nullableText(value, 'rstSent', 16),
    rstRcvd: nullableText(value, 'rstRcvd', 16),
    qth: nullableText(value, 'qth', 200),
    device: nullableText(value, 'device', 200),
    power: nullableText(value, 'power', 64),
    antenna: nullableText(value, 'antenna', 200),
    height: nullableText(value, 'height', 64),
    remarks: nullableText(value, 'remarks', 2_000),
  };
}

export function canonicalLogPatch(raw: unknown): Partial<CanonicalLogValue> {
  const patch = requireJsonObject(raw);
  rejectUnknownKeys(patch, LOG_PATCH_KEYS);
  if (Object.keys(patch).length === 0) {
    throw new AppError(422, 'VALIDATION_FAILED', 'patch must change at least one field');
  }
  const result: Partial<CanonicalLogValue> = {};
  if (patch.time !== undefined) {
    result.time = validateTimestamp(
      requireString(patch, 'time', { min: 1, max: 64 }),
      'patch.time',
    );
  }
  if (patch.controller !== undefined) {
    result.controller = requireString(patch, 'controller', { min: 1, max: 32 }).toUpperCase();
  }
  if (patch.callsign !== undefined) {
    result.callsign = requireString(patch, 'callsign', { min: 1, max: 32 }).toUpperCase();
  }
  const optional: ReadonlyArray<readonly [keyof CanonicalLogValue, number]> = [
    ['rstSent', 16],
    ['rstRcvd', 16],
    ['qth', 200],
    ['device', 200],
    ['power', 64],
    ['antenna', 200],
    ['height', 64],
    ['remarks', 2_000],
  ];
  for (const [field, max] of optional) {
    if (patch[field] !== undefined) result[field] = nullableText(patch, field, max) as never;
  }
  return result;
}

export function logDto(row: LogRow) {
  return {
    syncId: row.sync_id,
    sessionId: row.session_id,
    version: Number(row.version),
    time: row.time,
    controller: row.controller,
    callsign: row.callsign,
    rstSent: row.rst_sent,
    rstRcvd: row.rst_rcvd,
    qth: row.qth,
    device: row.device,
    power: row.power,
    antenna: row.antenna,
    height: row.height,
    remarks: row.remarks,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function sessionEventDto(row: SessionRow) {
  return {
    sessionId: row.id,
    title: row.title,
    status: row.status,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    deletedAt: row.deleted_at,
  };
}

export function readLog(db: Database.Database, sessionId: string, syncId: string): LogRow | undefined {
  return db.prepare('SELECT * FROM logs WHERE session_id = ? AND sync_id = ?').get(
    sessionId,
    syncId,
  ) as LogRow | undefined;
}

function conflict(
  mutationId: string,
  currentVersion: number,
  currentEntity: unknown,
): MutationResult {
  return {
    mutationId,
    status: 'conflict',
    code: 'VERSION_CONFLICT',
    currentVersion,
    currentEntity,
  };
}

function rejectMutation(mutationId: string, error: AppError): MutationResult {
  return {
    mutationId,
    status: 'rejected',
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

function assertOnlyPayload(
  operation: MutationOperation,
  allowed: readonly ('value' | 'patch' | 'confirm')[],
): void {
  for (const field of ['value', 'patch', 'confirm'] as const) {
    if (operation.raw[field] !== undefined && !allowed.includes(field)) {
      throw new AppError(422, 'VALIDATION_FAILED', `${field} is not allowed for this operation`, {
        field,
      });
    }
  }
}

function assertLogWritable(
  session: SessionRow,
  role: SessionRole,
  options: { administrative?: boolean } = {},
): void {
  if (role === 'viewer') {
    throw new AppError(403, 'FORBIDDEN', 'Viewer membership cannot mutate Logs');
  }
  if (session.status === 'closed' && !options.administrative) {
    throw new AppError(409, 'SESSION_CLOSED', 'The Session is closed');
  }
  if (session.status !== 'active' && !(options.administrative && session.status === 'closed')) {
    throw new AppError(409, 'SESSION_NOT_ACTIVE', 'The Session is not active');
  }
}

function accepted(
  db: Database.Database,
  operation: MutationOperation,
  input: {
    sessionId: string;
    eventType: Parameters<typeof appendSessionEvent>[1]['type'];
    entityType: 'session' | 'log';
    entityVersion: number;
    actorUserId: string;
    actorDeviceId: string;
    payload: unknown;
    occurredAt: string;
  },
): { result: MutationResult; event: CollaborationEvent } {
  const event = appendSessionEvent(db, {
    sessionId: input.sessionId,
    type: input.eventType,
    entityType: input.entityType,
    entityId: operation.entityId,
    entityVersion: input.entityVersion,
    mutationId: operation.mutationId,
    actorUserId: input.actorUserId,
    actorDeviceId: input.actorDeviceId,
    payload: input.payload,
    occurredAt: input.occurredAt,
  });
  return {
    result: { mutationId: operation.mutationId, status: 'accepted', event },
    event,
  };
}

export function mutateLog(
  db: Database.Database,
  session: SessionRow,
  membership: Pick<MembershipRow, 'role'>,
  operation: MutationOperation,
  userId: string,
  deviceId: string,
  options: { administrative?: boolean } = {},
): { result: MutationResult; event?: CollaborationEvent } {
  assertLogWritable(session, membership.role, options);
  if (!['create', 'update', 'delete', 'restore'].includes(operation.operation)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Unsupported Log operation', {
      operation: operation.operation,
    });
  }
  const current = readLog(db, session.id, operation.entityId);
  const now = new Date().toISOString();

  if (operation.operation === 'create') {
    assertOnlyPayload(operation, ['value']);
    if (operation.baseVersion !== 0) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Log create requires baseVersion 0');
    }
    const value = canonicalLogValue(operation.raw.value, {
      sessionId: session.id,
      syncId: operation.entityId,
    });
    if (current) return { result: conflict(operation.mutationId, current.version, logDto(current)) };
    db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, version, time, controller, callsign, rst_sent, rst_rcvd,
        qth, device, power, antenna, height, remarks, created_at, updated_at,
        created_by, updated_by, source_device_id
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operation.entityId,
      session.id,
      value.time,
      value.controller,
      value.callsign,
      value.rstSent,
      value.rstRcvd,
      value.qth,
      value.device,
      value.power,
      value.antenna,
      value.height,
      value.remarks,
      now,
      now,
      userId,
      userId,
      deviceId,
    );
    const created = readLog(db, session.id, operation.entityId)!;
    return accepted(db, operation, {
      sessionId: session.id,
      eventType: 'log.created',
      entityType: 'log',
      entityVersion: created.version,
      actorUserId: userId,
      actorDeviceId: deviceId,
      payload: logDto(created),
      occurredAt: now,
    });
  }

  if (!current) {
    throw new AppError(404, 'NOT_FOUND', 'The Log does not exist');
  }
  if (operation.baseVersion !== current.version) {
    return { result: conflict(operation.mutationId, current.version, logDto(current)) };
  }

  if (operation.operation === 'update') {
    assertOnlyPayload(operation, ['patch']);
    if (current.deleted_at) {
      return { result: conflict(operation.mutationId, current.version, logDto(current)) };
    }
    const patch = canonicalLogPatch(operation.raw.patch);
    const columns: Record<keyof CanonicalLogValue, string> = {
      time: 'time',
      controller: 'controller',
      callsign: 'callsign',
      rstSent: 'rst_sent',
      rstRcvd: 'rst_rcvd',
      qth: 'qth',
      device: 'device',
      power: 'power',
      antenna: 'antenna',
      height: 'height',
      remarks: 'remarks',
    };
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of Object.entries(patch) as Array<
      [keyof CanonicalLogValue, unknown]
    >) {
      assignments.push(`${columns[field]} = ?`);
      values.push(value);
    }
    db.prepare(`
      UPDATE logs
      SET ${assignments.join(', ')}, version = version + 1, updated_at = ?,
          updated_by = ?, source_device_id = ?
      WHERE session_id = ? AND sync_id = ? AND version = ? AND deleted_at IS NULL
    `).run(...values, now, userId, deviceId, session.id, operation.entityId, current.version);
    const updated = readLog(db, session.id, operation.entityId)!;
    return accepted(db, operation, {
      sessionId: session.id,
      eventType: 'log.updated',
      entityType: 'log',
      entityVersion: updated.version,
      actorUserId: userId,
      actorDeviceId: deviceId,
      payload: logDto(updated),
      occurredAt: now,
    });
  }

  if (operation.operation === 'delete') {
    assertOnlyPayload(operation, []);
    if (current.deleted_at) {
      return { result: conflict(operation.mutationId, current.version, logDto(current)) };
    }
    db.prepare(`
      UPDATE logs
      SET version = version + 1, updated_at = ?, updated_by = ?, source_device_id = ?,
          deleted_at = ?, deleted_by = ?
      WHERE session_id = ? AND sync_id = ? AND version = ? AND deleted_at IS NULL
    `).run(
      now,
      userId,
      deviceId,
      now,
      userId,
      session.id,
      operation.entityId,
      current.version,
    );
    const deleted = readLog(db, session.id, operation.entityId)!;
    return accepted(db, operation, {
      sessionId: session.id,
      eventType: 'log.deleted',
      entityType: 'log',
      entityVersion: deleted.version,
      actorUserId: userId,
      actorDeviceId: deviceId,
      payload: logDto(deleted),
      occurredAt: now,
    });
  }

  if (operation.operation === 'restore') {
    assertOnlyPayload(operation, ['value', 'confirm']);
    if (!current.deleted_at) {
      return { result: conflict(operation.mutationId, current.version, logDto(current)) };
    }
    const hasValue = operation.raw.value !== undefined;
    const confirmed = operation.raw.confirm === true;
    if (operation.raw.confirm !== undefined && operation.raw.confirm !== true) {
      throw new AppError(422, 'VALIDATION_FAILED', 'confirm must be true when provided');
    }
    if (hasValue === confirmed) {
      throw new AppError(
        422,
        'VALIDATION_FAILED',
        'Log restore requires either a full value or confirm: true',
      );
    }
    const value = hasValue
      ? canonicalLogValue(operation.raw.value, {
          sessionId: session.id,
          syncId: operation.entityId,
        })
      : undefined;
    db.prepare(`
      UPDATE logs
      SET time = ?, controller = ?, callsign = ?, rst_sent = ?, rst_rcvd = ?,
          qth = ?, device = ?, power = ?, antenna = ?, height = ?, remarks = ?,
          version = version + 1, updated_at = ?, updated_by = ?, source_device_id = ?,
          deleted_at = NULL, deleted_by = NULL
      WHERE session_id = ? AND sync_id = ? AND version = ? AND deleted_at IS NOT NULL
    `).run(
      value?.time ?? current.time,
      value?.controller ?? current.controller,
      value?.callsign ?? current.callsign,
      value ? value.rstSent : current.rst_sent,
      value ? value.rstRcvd : current.rst_rcvd,
      value ? value.qth : current.qth,
      value ? value.device : current.device,
      value ? value.power : current.power,
      value ? value.antenna : current.antenna,
      value ? value.height : current.height,
      value ? value.remarks : current.remarks,
      now,
      userId,
      deviceId,
      session.id,
      operation.entityId,
      current.version,
    );
    const restored = readLog(db, session.id, operation.entityId)!;
    return accepted(db, operation, {
      sessionId: session.id,
      eventType: 'log.restored',
      entityType: 'log',
      entityVersion: restored.version,
      actorUserId: userId,
      actorDeviceId: deviceId,
      payload: logDto(restored),
      occurredAt: now,
    });
  }

  throw new AppError(422, 'VALIDATION_FAILED', 'Unsupported Log operation', {
    operation: operation.operation,
  });
}

export function mutateSession(
  db: Database.Database,
  session: SessionRow,
  membership: MembershipRow,
  operation: MutationOperation,
  userId: string,
  deviceId: string,
  requestId: string,
  options: {
    administrative?: boolean;
    discardLiveDraftOnClose?: boolean;
    now?: Date;
  } = {},
): { result: MutationResult; event?: CollaborationEvent } {
  if (membership.role !== 'owner') {
    throw new AppError(403, 'FORBIDDEN', 'Only the Session owner can change Session metadata');
  }
  if (operation.entityId !== session.id) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Session entityId must match the route Session');
  }
  if (!['update', 'close', 'reopen', 'delete'].includes(operation.operation)) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Unsupported Session operation', {
      operation: operation.operation,
    });
  }
  if (operation.baseVersion !== session.version) {
    return {
      result: conflict(operation.mutationId, session.version, sessionEventDto(session)),
    };
  }
  const operationTime = options.now ?? new Date();
  if (!Number.isFinite(operationTime.getTime())) {
    throw new Error('SESSION_OPERATION_TIME_INVALID');
  }
  const now = operationTime.toISOString();
  let eventType:
    | 'session.updated'
    | 'session.closed'
    | 'session.reopened'
    | 'session.deleted';
  let revokedInviteCount = 0;
  let revokedWsTicketCount = 0;
  let revokedPublicShareCount = 0;
  let revokedPublicWsTicketCount = 0;
  let liveDraftCleared: LiveDraftClearedProjection | undefined;

  if (operation.operation === 'update') {
    assertOnlyPayload(operation, ['patch']);
    if (session.status === 'closed' && !options.administrative) {
      throw new AppError(409, 'SESSION_CLOSED', 'The Session is closed');
    }
    if (session.status !== 'active' && !(options.administrative && session.status === 'closed')) {
      throw new AppError(409, 'SESSION_NOT_ACTIVE', 'The Session is not active');
    }
    const patch = requireJsonObject(operation.raw.patch);
    rejectUnknownKeys(patch, ['title']);
    if (!Object.prototype.hasOwnProperty.call(patch, 'title')) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Session update requires patch.title');
    }
    const title = requireString(patch, 'title', { min: 1, max: 200 });
    db.prepare(`
      UPDATE sessions
      SET title = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status IN ('active', 'closed') AND deleted_at IS NULL
    `).run(title, now, session.id, session.version);
    eventType = 'session.updated';
  } else if (operation.operation === 'close') {
    assertOnlyPayload(operation, []);
    if (session.status === 'closed') {
      throw new AppError(409, 'SESSION_CLOSED', 'The Session is already closed');
    }
    if (session.status !== 'active') {
      throw new AppError(409, 'SESSION_NOT_ACTIVE', 'The Session is not active');
    }
    const discardLiveDraft = options.administrative === true &&
      options.discardLiveDraftOnClose === true;
    if (!discardLiveDraft && liveDraftHasActualContent(db, session.id)) {
      throw new AppError(
        409,
        'LIVE_DRAFT_NOT_EMPTY',
        'Commit or explicitly discard the live draft before closing the Session',
      );
    }
    if (!discardLiveDraft && getLiveDraftLockManager(db).list(session.id).length > 0) {
      throw new AppError(
        409,
        'LIVE_DRAFT_BUSY',
        'Release active live draft field locks before closing the Session',
      );
    }
    if (discardLiveDraft) {
      const discardedDraft = db.prepare(`
        SELECT draft_id, version
        FROM session_live_drafts
        WHERE session_id = ?
      `).get(session.id) as { draft_id: string; version: number } | undefined;
      const discardedDeviceStateCount = db.prepare(
        'DELETE FROM live_draft_device_state WHERE session_id = ?',
      ).run(session.id).changes;
      const discardedDraftCount = db.prepare(
        'DELETE FROM session_live_drafts WHERE session_id = ?',
      ).run(session.id).changes;
      if (discardedDraft && discardedDraftCount !== 1) {
        throw new AppError(
          500,
          'LIVE_DRAFT_DISCARD_FAILED',
          'The live draft could not be discarded atomically',
        );
      }
      if (discardedDraft) {
        liveDraftCleared = {
          terminal: true,
          discardedDraftId: discardedDraft.draft_id,
          discardedDraftVersion: Number(discardedDraft.version),
          discardedDeviceStateCount: Number(discardedDeviceStateCount),
          nextDraft: {
            draftId: randomUUID(),
            sessionId: session.id,
            version: Number(discardedDraft.version) + 1,
            fields: {
              time: null,
              controller: null,
              callsign: null,
              rstSent: '59',
              rstRcvd: '59',
              qth: null,
              device: null,
              power: null,
              antenna: null,
              height: null,
              remarks: null,
            },
            fieldRevisions: { ...EMPTY_FIELD_REVISIONS },
            lastUpdatedBy: null,
            createdAt: now,
            lastUpdatedAt: now,
          },
        };
      }
    }
    db.prepare(`
      UPDATE sessions
      SET status = 'closed', version = version + 1, updated_at = ?,
          closed_at = ?, closed_by = ?
      WHERE id = ? AND version = ? AND status = 'active' AND deleted_at IS NULL
    `).run(now, now, userId, session.id, session.version);
    eventType = 'session.closed';
  } else if (operation.operation === 'reopen') {
    assertOnlyPayload(operation, []);
    if (session.status !== 'closed') {
      throw new AppError(409, 'INVALID_SESSION_STATE', 'Only a closed Session can be reopened');
    }
    db.prepare(`
      UPDATE sessions
      SET status = 'active', version = version + 1, updated_at = ?,
          closed_at = NULL, closed_by = NULL
      WHERE id = ? AND version = ? AND status = 'closed' AND deleted_at IS NULL
    `).run(now, session.id, session.version);
    eventType = 'session.reopened';
  } else if (operation.operation === 'delete') {
    assertOnlyPayload(operation, []);
    if (session.status === 'active') {
      throw new AppError(
        409,
        'SESSION_MUST_BE_CLOSED',
        'Close the Session before deleting it',
      );
    }
    if (session.status !== 'closed' && session.status !== 'initializing') {
      throw new AppError(409, 'INVALID_SESSION_STATE', 'The Session cannot be deleted');
    }
    db.prepare(`
      UPDATE sessions
      SET version = version + 1, updated_at = ?, deleted_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL
    `).run(now, now, session.id, session.version);
    revokedInviteCount = db.prepare(`
      UPDATE collaboration_invites
      SET revoked_at = ?, revoked_by = ?
      WHERE session_id = ? AND revoked_at IS NULL
    `).run(now, userId, session.id).changes;
    revokedWsTicketCount = db.prepare(
      'DELETE FROM ws_tickets WHERE session_id = ?',
    ).run(session.id).changes;
    revokedPublicWsTicketCount = db.prepare(`
      DELETE FROM public_ws_tickets
      WHERE public_share_id IN (
        SELECT id FROM public_shares WHERE session_id = ?
      )
    `).run(session.id).changes;
    revokedPublicShareCount = db.prepare(`
      UPDATE public_shares
      SET revoked_at = ?, revoked_by = ?
      WHERE session_id = ? AND revoked_at IS NULL
    `).run(now, userId, session.id).changes;
    db.prepare('DELETE FROM live_draft_device_state WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM session_live_drafts WHERE session_id = ?').run(session.id);
    eventType = 'session.deleted';
  } else {
    throw new AppError(422, 'VALIDATION_FAILED', 'Unsupported Session operation', {
      operation: operation.operation,
    });
  }

  const updated = findSession(db, session.id)!;
  const outcome = accepted(db, operation, {
    sessionId: session.id,
    eventType,
    entityType: 'session',
    entityVersion: updated.version,
    actorUserId: userId,
    actorDeviceId: deviceId,
    payload: {
      ...sessionEventDto(updated),
      ...(liveDraftCleared ? { liveDraftCleared } : {}),
    },
    occurredAt: now,
  });
  if (eventType === 'session.deleted') {
    appendCollaborationAudit(db, {
      action: 'session.deleted',
      sessionId: session.id,
      actorUserId: userId,
      requestId,
      mutationId: operation.mutationId,
      occurredAt: now,
      beforeStatus: session.status,
      beforeVersion: session.version,
      beforeEventSeq: session.event_seq,
      afterStatus: updated.status,
      afterVersion: updated.version,
      afterEventSeq: outcome.event.seq,
      deletedAt: updated.deleted_at!,
      revokedInviteCount,
      revokedWsTicketCount,
      revokedPublicShareCount,
      revokedPublicWsTicketCount,
    });
  }
  return outcome;
}

export function parseOperations(body: Record<string, unknown>): MutationOperation[] {
  if (body.protocolVersion !== 1) {
    throw new AppError(422, 'VALIDATION_FAILED', 'protocolVersion must be 1');
  }
  if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 100) {
    throw new AppError(422, 'VALIDATION_FAILED', 'operations must contain between 1 and 100 items');
  }
  const entityKeys = new Set<string>();
  const mutationIds = new Set<string>();
  return body.operations.map((raw, index) => {
    const value = requireJsonObject(raw);
    rejectUnknownKeys(value, OPERATION_KEYS);
    const mutationId = uuidField(value, 'mutationId');
    if (mutationIds.has(mutationId)) {
      throw new AppError(422, 'VALIDATION_FAILED', 'A batch cannot repeat mutationId', {
        index,
        mutationId,
      });
    }
    mutationIds.add(mutationId);
    const entityTypeValue = requireString(value, 'entityType', { min: 3, max: 7 });
    if (entityTypeValue !== 'log' && entityTypeValue !== 'session') {
      throw new AppError(422, 'VALIDATION_FAILED', 'entityType must be log or session', { index });
    }
    const entityId = normalizeStableId(value.entityId, `operations[${index}].entityId`);
    const entityKey = `${entityTypeValue}\0${entityId}`;
    if (entityKeys.has(entityKey)) {
      throw new AppError(422, 'VALIDATION_FAILED', 'A batch can mutate an entity only once', {
        index,
        entityType: entityTypeValue,
        entityId,
      });
    }
    entityKeys.add(entityKey);
    const operation = requireString(value, 'operation', { min: 3, max: 16 });
    const baseVersion = nonNegativeInteger(value.baseVersion, `operations[${index}].baseVersion`);
    if (value.observedSeq !== undefined) {
      nonNegativeInteger(value.observedSeq, `operations[${index}].observedSeq`);
    }
    if (value.queuedAt !== undefined) {
      validateTimestamp(
        requireString(value, 'queuedAt', { min: 1, max: 64 }),
        `operations[${index}].queuedAt`,
      );
    }
    return {
      raw: value,
      mutationId,
      entityType: entityTypeValue,
      entityId,
      operation,
      baseVersion,
    };
  });
}

function readSessionAccessIncludingDeleted(
  db: Database.Database,
  sessionId: string,
  userId: string,
): { session: SessionRow; membership: MembershipRow } {
  const session = findSession(db, sessionId);
  const membership = findMembershipIncludingRemoved(db, sessionId, userId);
  if (!session || !membership) throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  if (membership.removed_at) {
    throw new AppError(403, 'MEMBERSHIP_REVOKED', 'Session membership has been revoked', {
      removedAt: membership.removed_at,
    });
  }
  if (
    session.status === 'initializing' &&
    !session.deleted_at &&
    membership.role !== 'owner'
  ) {
    throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  }
  return { session, membership };
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

export function createCollaborationSyncV1Router(
  dependencies: CollaborationSyncV1Dependencies,
): Router {
  const { db, config } = dependencies;
  const router = Router();
  const hub = getRealtimeHub(db);
  const metrics = getRuntimeMetrics(db);
  const mutationLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 120,
    keyGenerator: (req) => {
      const auth = (req as V1AuthRequest).auth;
      return `${auth?.userId ?? 'anonymous'}:${req.ip}:${req.params.sessionId ?? ''}`;
    },
    message: 'Too many collaboration mutations; retry later',
  });
  const ticketLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyGenerator: (req) => {
      const auth = (req as V1AuthRequest).auth;
      return `${auth?.userId ?? 'anonymous'}:${req.ip}:${req.params.sessionId ?? ''}`;
    },
    message: 'Too many WebSocket tickets; retry later',
  });
  router.use(createAccessTokenMiddleware(config, db));

  router.get('/:sessionId/events', (req: V1AuthRequest, res, next) => {
    try {
      const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
      const afterSeq = parseQueryInteger(req.query.afterSeq, 'afterSeq', 0, 0);
      const limit = parseQueryInteger(req.query.limit, 'limit', 500, 1, 500);
      const response = db.transaction(() => {
        const { session } = readSessionAccessIncludingDeleted(db, sessionId, req.auth!.userId);
        if (afterSeq < session.min_retained_seq) {
          throw new AppError(410, 'CURSOR_EXPIRED', 'The event cursor is no longer available', {
            minAvailableSeq: session.min_retained_seq,
            headSeq: session.event_seq,
          });
        }
        if (afterSeq > session.event_seq) {
          throw new AppError(422, 'VALIDATION_FAILED', 'afterSeq cannot be ahead of the Session', {
            afterSeq,
            headSeq: session.event_seq,
          });
        }
        const events = readEventsAfter(db, sessionId, afterSeq, limit);
        const toSeq = events.length > 0 ? events[events.length - 1].seq : afterSeq;
        return {
          afterSeq,
          toSeq,
          headSeq: session.event_seq,
          minAvailableSeq: session.min_retained_seq,
          hasMore: toSeq < session.event_seq,
          events,
        };
      }).deferred();
      res.setHeader('Cache-Control', 'no-store');
      res.once('finish', () => metrics.recordRestCatchupSent(response.events.length));
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/:sessionId/mutations',
    config.rateLimitEnabled ? mutationLimiter : noLimit(),
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['protocolVersion', 'deviceId', 'operations']);
        if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 1_048_576) {
          throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Mutation batch exceeds 1 MiB');
        }
        const deviceId = uuidField(body, 'deviceId');
        const operations = parseOperations(body);
        readSessionAccessIncludingDeleted(db, sessionId, req.auth!.userId);
        metrics.recordMutationsReceived(operations.length);

        const results: MutationResult[] = [];
        for (const operation of operations) {
          const requestHash = computeRequestHash('MUTATION', `/api/v1/sessions/${sessionId}`, {
            protocolVersion: 1,
            deviceId,
            operation: operation.raw,
          });
          const committed = db.transaction(() => {
            let stored;
            try {
              stored = readStoredResponse(
                db,
                operation.mutationId,
                req.auth!.userId,
                requestHash,
              );
            } catch (error) {
              if (error instanceof AppError && error.code === 'MUTATION_ID_REUSED') {
                return {
                  result: rejectMutation(operation.mutationId, error),
                  replayed: false,
                };
              }
              throw error;
            }
            if (stored) {
              return { result: stored.body as MutationResult, replayed: true };
            }

            if (operation.entityType === 'session') {
              const currentAccess = readSessionAccessIncludingDeleted(
                db,
                sessionId,
                req.auth!.userId,
              );
              if (currentAccess.membership.role !== 'owner') {
                const result = rejectMutation(
                  operation.mutationId,
                  new AppError(
                    403,
                    'FORBIDDEN',
                    'Only the current Session owner can change Session metadata',
                  ),
                );
                storeResponse(db, {
                  mutationId: operation.mutationId,
                  sessionId,
                  userId: req.auth!.userId,
                  deviceId,
                  requestHash,
                  status: 200,
                  body: result,
                });
                return { result, replayed: false };
              }
            }

            let outcome: { result: MutationResult; event?: CollaborationEvent };
            try {
              const { session, membership } = requireMembership(
                db,
                sessionId,
                req.auth!.userId,
              );
              outcome = operation.entityType === 'log'
                ? mutateLog(
                    db,
                    session,
                    membership,
                    operation,
                    req.auth!.userId,
                    deviceId,
                  )
                : mutateSession(
                    db,
                    session,
                    membership,
                    operation,
                    req.auth!.userId,
                    deviceId,
                    getRequestId(req),
                  );
            } catch (error) {
              if (!(error instanceof AppError) || error.status >= 500) throw error;
              outcome = { result: rejectMutation(operation.mutationId, error) };
            }
            storeResponse(db, {
              mutationId: operation.mutationId,
              sessionId,
              userId: req.auth!.userId,
              deviceId,
              requestHash,
              status: 200,
              body: outcome.result,
            });
            return { ...outcome, replayed: false };
          }).immediate();
          results.push(committed.result);
          metrics.recordMutationResult(committed.result.status, committed.replayed);
          if (committed.event) {
            hub.publish(committed.event);
            if (committed.event.type === 'session.closed') {
              getLiveDraftLockManager(db).clearSession(sessionId);
              hub.publishControl({
                type: 'liveDraft.lockChanged',
                sessionId,
                occurredAt: committed.event.occurredAt,
                action: 'sessionClosed',
                locks: [],
              });
            }
            if (committed.event.type === 'session.deleted') {
              getLiveDraftLockManager(db).clearSession(sessionId);
              hub.sessionDeleted(sessionId);
            }
          }
        }
        const head = findSession(db, sessionId);
        res.json({ headSeq: head?.event_seq ?? 0, results });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/:sessionId/ws-ticket',
    config.rateLimitEnabled ? ticketLimiter : noLimit(),
    (req: V1AuthRequest, res, next) => {
      try {
        const sessionId = normalizeStableId(req.params.sessionId, 'sessionId');
        const body = requireJsonObject(req.body);
        rejectUnknownKeys(body, ['deviceId', 'afterSeq']);
        const requestedDeviceId = uuidField(body, 'deviceId');
        // Bind real auth-issued tickets to the server-generated authentication
        // Session family. Legacy test/manual tokens without sid remain explicitly
        // unbound for the duration of their short access-token lifetime.
        const authSessionId = req.auth!.authSessionId ?? null;
        const accessExpiresAt = new Date(
          req.auth!.expiresAtEpochSeconds * 1000,
        ).toISOString();
        const afterSeq = nonNegativeInteger(body.afterSeq, 'afterSeq');
        const ticket = randomBytes(32).toString('base64url');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 60_000).toISOString();
        const issuedMembership = db.transaction(() => {
          const { session, membership } = requireMembership(
            db,
            sessionId,
            req.auth!.userId,
          );
          if (session.status === 'initializing' && membership.role !== 'owner') {
            throw new AppError(404, 'NOT_FOUND', 'Resource not found');
          }
          if (afterSeq < session.min_retained_seq) {
            throw new AppError(410, 'CURSOR_EXPIRED', 'The event cursor is no longer available', {
              minAvailableSeq: session.min_retained_seq,
              headSeq: session.event_seq,
            });
          }
          if (afterSeq > session.event_seq) {
            throw new AppError(
              422,
              'VALIDATION_FAILED',
              'afterSeq cannot be ahead of the Session',
            );
          }
          db.prepare(`
            DELETE FROM ws_tickets
            WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)
          `).run(
            new Date(now.getTime() - 86_400_000).toISOString(),
            new Date(now.getTime() - 86_400_000).toISOString(),
          );
          db.prepare(`
            INSERT INTO ws_tickets (
              id, token_hash, session_id, user_id,
              issued_role, issued_membership_version,
              device_id, auth_session_id, access_expires_at,
              after_seq, issued_ip, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            hashTicket(ticket),
            sessionId,
            req.auth!.userId,
            membership.role,
            membership.version,
            requestedDeviceId,
            authSessionId,
            accessExpiresAt,
            afterSeq,
            req.ip,
            now.toISOString(),
            expiresAt,
          );
          return {
            role: membership.role,
            membershipVersion: membership.version,
          };
        }).immediate();
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ticket,
          expiresAt,
          sessionId,
          role: issuedMembership.role,
          membershipVersion: issuedMembership.membershipVersion,
          afterSeq,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export const collaborationSyncInternals = {
  hashTicket,
  logDto,
  sessionEventDto,
};
