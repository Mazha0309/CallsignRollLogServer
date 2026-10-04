import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import { RuntimeMetrics } from '../src/operations/metrics';
import {
  createCollaborationWsServer,
  type CollaborationWsController,
} from '../src/ws';

type JsonObject = Record<string, unknown>;

interface HttpResult {
  status: number;
  headers: Headers;
  body: JsonObject;
  text: string;
}

const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'collaboration-metrics-jwt-secret-596ca777-4eb4-42c9-a52f-60163aed5022',
  jwtIssuer: 'openlogtool-collaboration-metrics-test',
  bootstrapSecret: 'collaboration-metrics-bootstrap-464718ad-9e2c-46fc',
  inviteHmacKey: 'collaboration-metrics-invite-key-abf9ca2a-7a34-49b2-b532',
  publicShareHmacKey: 'collaboration-metrics-public-key-674dd9df-1024-4ebc-bb1d',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

const ADMIN_ID = 'metrics-secret-admin-id';
const OWNER_ID = 'metrics-secret-owner-id';
const VIEWER_ID = 'metrics-secret-viewer-id';
const FORMER_ADMIN_ID = 'metrics-secret-former-admin-id';
const ACTIVE_SESSION_ID = 'metrics-secret-active-session-id';
const INITIALIZING_SESSION_ID = 'metrics-secret-initializing-session-id';
const CLOSED_SESSION_ID = 'metrics-secret-closed-session-id';
const DELETED_SESSION_ID = 'metrics-secret-deleted-session-id';
const EXISTING_LOG_ID = 'metrics-secret-existing-log-id';
const DELETED_LOG_ID = 'metrics-secret-deleted-log-id';
const DEVICE_ID = '4ddb2bad-a83a-4ad4-9ec8-0a9781e143f5';

const REQUEST_SURFACES = [
  'sessionCatalog',
  'sessionLifecycle',
  'snapshot',
  'events',
  'mutations',
  'liveDraft',
  'memberWsTicket',
  'membership',
  'invites',
  'publicShareAdmin',
  'publicExchange',
  'publicSnapshot',
  'publicWsTicket',
  'otherCollaboration',
  'otherApi',
] as const;

const SENSITIVE_SENTINELS = [
  ADMIN_ID,
  OWNER_ID,
  VIEWER_ID,
  FORMER_ADMIN_ID,
  ACTIVE_SESSION_ID,
  INITIALIZING_SESSION_ID,
  CLOSED_SESSION_ID,
  DELETED_SESSION_ID,
  EXISTING_LOG_ID,
  DELETED_LOG_ID,
  DEVICE_ID,
  'METRICS_SECRET_ADMIN_USERNAME',
  'METRICS_SECRET_OWNER_USERNAME',
  'METRICS_SECRET_VIEWER_USERNAME',
  'METRICS_SECRET_FORMER_ADMIN_USERNAME',
  'METRICS_SECRET_PASSWORD_HASH',
  'METRICS_SECRET_ACTIVE_TITLE',
  'METRICS_SECRET_INITIALIZING_TITLE',
  'METRICS_SECRET_CLOSED_TITLE',
  'METRICS_SECRET_DELETED_TITLE',
  'METRICS_SECRET_CONTROLLER',
  'METRICS_SECRET_CALLSIGN',
  'METRICS_SECRET_QTH',
  'METRICS_SECRET_RADIO_DEVICE',
  'METRICS_SECRET_ANTENNA',
  'METRICS_SECRET_REMARKS',
  'METRICS_SECRET_INVITE_HINT',
  'METRICS_SECRET_ACCESS_TOKEN_ID',
  'METRICS_SECRET_TICKET_DEVICE',
  '203.0.113.77',
  '198.51.100.42',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
] as const;

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function exactKeys(value: JsonObject, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertNoStore(result: HttpResult): void {
  assert.equal(result.headers.get('cache-control'), 'no-store');
}

function assertError(result: HttpResult, status: number, code: string): void {
  assert.equal(result.status, status, result.text);
  assertObject(result.body.error, 'error');
  assert.equal(result.body.error.code, code, result.text);
}

function metricNumber(value: JsonObject, key: string, label: string): number {
  const metric = value[key];
  assert.equal(typeof metric, 'number', `${label}.${key} must be a number`);
  assert.ok(Number.isSafeInteger(metric), `${label}.${key} must be a safe integer`);
  assert.ok(metric >= 0, `${label}.${key} must be non-negative`);
  return metric;
}

function finiteMetric(value: JsonObject, key: string, label: string): number {
  const metric = value[key];
  assert.equal(typeof metric, 'number', `${label}.${key} must be a number`);
  assert.ok(Number.isFinite(metric), `${label}.${key} must be finite`);
  assert.ok(Number(metric) >= 0, `${label}.${key} must be non-negative`);
  return Number(metric);
}

function nestedObject(value: JsonObject, key: string, label: string): JsonObject {
  const nested = value[key];
  assertObject(nested, `${label}.${key}`);
  return nested;
}

function mutationStatus(body: JsonObject): string {
  assert.ok(Array.isArray(body.results), 'mutation response.results must be an array');
  assert.equal(body.results.length, 1);
  assertObject(body.results[0], 'mutation result');
  assert.equal(typeof body.results[0].status, 'string');
  return body.results[0].status;
}

class MetricsResponseStub extends EventEmitter {
  statusCode = 200;

  getHeader(): undefined {
    return undefined;
  }
}

function recordSyntheticRequest(
  metrics: RuntimeMetrics,
  originalUrl: string,
  method: string,
): void {
  const response = new MetricsResponseStub();
  metrics.requestMiddleware()(
    { originalUrl, method } as unknown as Request,
    response as unknown as Response,
    (() => response.emit('finish')) as NextFunction,
  );
}

test('runtime request metrics use cumulative latency buckets and canonical route surfaces', () => {
  const metrics = new RuntimeMetrics();
  recordSyntheticRequest(metrics, '/api/v1/sessions/', 'GET');
  recordSyntheticRequest(metrics, '/api/v1/sessions/new-session/', 'PUT');

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requests.bySurface.sessionCatalog.total, 1);
  assert.equal(snapshot.requests.bySurface.sessionLifecycle.total, 1);
  assert.equal(snapshot.requests.bySurface.otherCollaboration.total, 0);

  for (const surface of [
    snapshot.requests.bySurface.sessionCatalog,
    snapshot.requests.bySurface.sessionLifecycle,
  ]) {
    const cumulative = [
      surface.durationBucketsMs.le10,
      surface.durationBucketsMs.le50,
      surface.durationBucketsMs.le100,
      surface.durationBucketsMs.le250,
      surface.durationBucketsMs.le500,
      surface.durationBucketsMs.le1000,
      surface.durationBucketsMs.le2500,
      surface.durationBucketsMs.le5000,
    ];
    assert.equal(cumulative.at(-1), 1);
    for (let index = 1; index < cumulative.length; index += 1) {
      assert.ok(
        cumulative[index] >= cumulative[index - 1],
        'le* latency buckets must be cumulative',
      );
    }
    assert.equal(surface.durationBucketsMs.gt5000, 0);
  }
});

describe('collaboration operational metrics API', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let wsController: CollaborationWsController;
  let baseUrl: string;
  let wsBaseUrl: string;
  let serverInstanceId: string;

  function accessToken(userId: string, role: 'admin' | 'user'): string {
    return jwt.sign(
      { type: 'access', role },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        subject: userId,
        jwtid: randomUUID(),
        issuer: config.jwtIssuer,
        audience: 'openlogtool-v1',
        expiresIn: 300,
      },
    );
  }

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    assertObject(parsed, 'HTTP response');
    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  async function metrics(): Promise<JsonObject> {
    const result = await request('/api/v1/admin/collaboration-metrics', {
      token: accessToken(ADMIN_ID, 'admin'),
    });
    assert.equal(result.status, 200, result.text);
    assertNoStore(result);
    return result.body;
  }

  function metricsSections(body: JsonObject): {
    http: JsonObject;
    mutations: JsonObject;
    events: JsonObject;
    webSockets: JsonObject;
    database: JsonObject;
  } {
    const runtime = nestedObject(body, 'runtime', 'metrics');
    const gauges = nestedObject(body, 'gauges', 'metrics');
    return {
      http: nestedObject(runtime, 'http', 'runtime'),
      mutations: nestedObject(runtime, 'mutations', 'runtime'),
      events: nestedObject(runtime, 'events', 'runtime'),
      webSockets: nestedObject(runtime, 'webSockets', 'runtime'),
      database: nestedObject(gauges, 'database', 'gauges'),
    };
  }

  function mutationSurface(body: JsonObject): JsonObject {
    const http = metricsSections(body).http;
    const bySurface = nestedObject(http, 'bySurface', 'runtime.http');
    return nestedObject(bySurface, 'mutations', 'runtime.http.bySurface');
  }

  function webSocketMetric(
    body: JsonObject,
    counter: string,
    audience: 'member' | 'public',
  ): number {
    const webSockets = metricsSections(body).webSockets;
    const audiences = nestedObject(webSockets, counter, 'runtime.webSockets');
    return metricNumber(audiences, audience, `runtime.webSockets.${counter}`);
  }

  async function memberWsTicket(afterSeq: number): Promise<string> {
    const result = await request(`/api/v1/sessions/${ACTIVE_SESSION_ID}/ws-ticket`, {
      method: 'POST',
      token: accessToken(OWNER_ID, 'user'),
      body: { deviceId: DEVICE_ID, afterSeq },
    });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.afterSeq, afterSeq);
    assert.equal(typeof result.body.ticket, 'string');
    return String(result.body.ticket);
  }

  async function openMemberSocket(ticket: string): Promise<WebSocket> {
    const ws = new WebSocket(
      `${wsBaseUrl}/ws/collaboration?ticket=${encodeURIComponent(ticket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  }

  async function closeSocket(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve, reject) => {
      ws.once('close', () => resolve());
      ws.once('error', reject);
      ws.close(1000, 'test complete');
    });
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-collaboration-metrics-'));
    const databasePath = join(directory, 'metrics.db');
    db = openDatabase(databasePath);
    config.dbPath = databasePath;

    const now = new Date();
    const nowIso = now.toISOString();
    const futureMinute = new Date(now.getTime() + 60_000).toISOString();
    const futureFiveMinutes = new Date(now.getTime() + 300_000).toISOString();
    const futureHour = new Date(now.getTime() + 3_600_000).toISOString();

    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertUser.run(
      ADMIN_ID,
      'METRICS_SECRET_ADMIN_USERNAME',
      'METRICS_SECRET_PASSWORD_HASH_ADMIN',
      'admin',
      nowIso,
      nowIso,
    );
    insertUser.run(
      OWNER_ID,
      'METRICS_SECRET_OWNER_USERNAME',
      'METRICS_SECRET_PASSWORD_HASH_OWNER',
      'user',
      nowIso,
      nowIso,
    );
    insertUser.run(
      VIEWER_ID,
      'METRICS_SECRET_VIEWER_USERNAME',
      'METRICS_SECRET_PASSWORD_HASH_VIEWER',
      'user',
      nowIso,
      nowIso,
    );
    insertUser.run(
      FORMER_ADMIN_ID,
      'METRICS_SECRET_FORMER_ADMIN_USERNAME',
      'METRICS_SECRET_PASSWORD_HASH_FORMER_ADMIN',
      'user',
      nowIso,
      nowIso,
    );

    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at, closed_at, deleted_at
      ) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?)
    `);
    insertSession.run(
      ACTIVE_SESSION_ID,
      'METRICS_SECRET_ACTIVE_TITLE',
      'active',
      OWNER_ID,
      nowIso,
      nowIso,
      null,
      null,
    );
    insertSession.run(
      INITIALIZING_SESSION_ID,
      'METRICS_SECRET_INITIALIZING_TITLE',
      'initializing',
      OWNER_ID,
      nowIso,
      nowIso,
      null,
      null,
    );
    insertSession.run(
      CLOSED_SESSION_ID,
      'METRICS_SECRET_CLOSED_TITLE',
      'closed',
      OWNER_ID,
      nowIso,
      nowIso,
      nowIso,
      null,
    );
    insertSession.run(
      DELETED_SESSION_ID,
      'METRICS_SECRET_DELETED_TITLE',
      'closed',
      OWNER_ID,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
    );

    const insertMembership = db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at, removed_at, removed_by
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `);
    insertMembership.run(randomUUID(), ACTIVE_SESSION_ID, OWNER_ID, 'owner', nowIso, nowIso, null, null);
    insertMembership.run(randomUUID(), ACTIVE_SESSION_ID, VIEWER_ID, 'viewer', nowIso, nowIso, null, null);
    insertMembership.run(
      randomUUID(),
      CLOSED_SESSION_ID,
      FORMER_ADMIN_ID,
      'viewer',
      nowIso,
      nowIso,
      nowIso,
      OWNER_ID,
    );

    const insertLog = db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, version, time, controller, callsign, rst_sent, rst_rcvd,
        qth, device, power, antenna, height, remarks, created_at, updated_at,
        created_by, updated_by, source_device_id, deleted_at, deleted_by
      ) VALUES (?, ?, 1, ?, ?, ?, '59', '59', ?, ?, '100W', ?, '10M', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLog.run(
      EXISTING_LOG_ID,
      ACTIVE_SESSION_ID,
      nowIso,
      'METRICS_SECRET_CONTROLLER',
      'METRICS_SECRET_CALLSIGN',
      'METRICS_SECRET_QTH',
      'METRICS_SECRET_RADIO_DEVICE',
      'METRICS_SECRET_ANTENNA',
      'METRICS_SECRET_REMARKS',
      nowIso,
      nowIso,
      OWNER_ID,
      OWNER_ID,
      DEVICE_ID,
      null,
      null,
    );
    insertLog.run(
      DELETED_LOG_ID,
      ACTIVE_SESSION_ID,
      nowIso,
      'METRICS_SECRET_CONTROLLER',
      'METRICS_SECRET_CALLSIGN',
      'METRICS_SECRET_QTH',
      'METRICS_SECRET_RADIO_DEVICE',
      'METRICS_SECRET_ANTENNA',
      'METRICS_SECRET_REMARKS',
      nowIso,
      nowIso,
      OWNER_ID,
      OWNER_ID,
      DEVICE_ID,
      nowIso,
      OWNER_ID,
    );

    db.prepare(`
      INSERT INTO collaboration_invites (
        id, session_id, code_hash, link_token_hash, code_hint, role,
        max_uses, used_count, expires_at, created_by, created_at
      ) VALUES (?, ?, ?, NULL, ?, 'viewer', 2, 0, ?, ?, ?)
    `).run(
      'metrics-secret-invite-id',
      ACTIVE_SESSION_ID,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'METRICS_SECRET_INVITE_HINT',
      futureHour,
      OWNER_ID,
      nowIso,
    );

    db.prepare(`
      INSERT INTO public_shares (
        id, session_id, credential_version, secret_hash, created_by, created_at, expires_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(
      'metrics-secret-public-share-id',
      ACTIVE_SESSION_ID,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      OWNER_ID,
      nowIso,
      futureHour,
    );

    db.prepare(`
      INSERT INTO ws_tickets (
        id, token_hash, session_id, user_id, issued_role, issued_membership_version,
        device_id, access_expires_at, after_seq, issued_ip, created_at, expires_at
      ) VALUES (?, ?, ?, ?, 'owner', 1, ?, ?, 0, ?, ?, ?)
    `).run(
      'metrics-secret-member-ticket-id',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ACTIVE_SESSION_ID,
      OWNER_ID,
      'METRICS_SECRET_TICKET_DEVICE',
      futureMinute,
      '203.0.113.77',
      nowIso,
      futureMinute,
    );

    db.prepare(`
      INSERT INTO public_ws_tickets (
        id, token_hash, public_share_id, access_token_id, after_seq, issued_ip,
        created_at, expires_at, authorization_expires_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      'metrics-secret-public-ticket-id',
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      'metrics-secret-public-share-id',
      'METRICS_SECRET_ACCESS_TOKEN_ID',
      '198.51.100.42',
      nowIso,
      futureMinute,
      futureFiveMinutes,
    );

    const settings = db.prepare(`
      SELECT instance_id FROM server_settings WHERE id = 1
    `).get() as { instance_id: string };
    serverInstanceId = settings.instance_id;

    server = createServer(createApp({ db, config }));
    wsController = createCollaborationWsServer(server, { db, config });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
  });

  after(async () => {
    wsController?.close();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('requires a current administrator, rejects query filters and is always no-store', async () => {
    const cases: Array<[string, string | undefined, number, string]> = [
      ['missing token', undefined, 401, 'AUTH_REQUIRED'],
      ['ordinary user', accessToken(OWNER_ID, 'user'), 403, 'ADMIN_REQUIRED'],
      [
        'stale token claiming a demoted administrator',
        accessToken(FORMER_ADMIN_ID, 'admin'),
        403,
        'ADMIN_REQUIRED',
      ],
      ['deleted token subject', accessToken('metrics-secret-deleted-user-id', 'admin'), 401, 'TOKEN_INVALID'],
    ];

    for (const [label, token, status, code] of cases) {
      const result = await request('/api/v1/admin/collaboration-metrics', { token });
      assertError(result, status, code);
      assertNoStore(result);
      assert.ok(label);
    }

    const filtered = await request(
      `/api/v1/admin/collaboration-metrics?sessionId=${ACTIVE_SESSION_ID}`,
      { token: accessToken(ADMIN_ID, 'admin') },
    );
    assertError(filtered, 422, 'VALIDATION_FAILED');
    assertNoStore(filtered);

    const success = await request('/api/v1/admin/collaboration-metrics', {
      token: accessToken(ADMIN_ID, 'admin'),
    });
    assert.equal(success.status, 200, success.text);
    assertNoStore(success);
  });

  test('returns a bounded v3 schema, version, fixed surfaces, resource health, basic gauges and no sensitive values', async () => {
    const body = await metrics();
    exactKeys(body, [
      'schemaVersion',
      'serverInstanceId',
      'serverVersion',
      'generatedAt',
      'scope',
      'runtime',
      'gauges',
    ]);
    assert.equal(body.schemaVersion, 3);
    assert.equal(body.serverInstanceId, serverInstanceId);
    assert.equal(body.serverVersion, '0.12.0');
    assert.equal(typeof body.generatedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(String(body.generatedAt))));

    const scope = nestedObject(body, 'scope', 'metrics');
    assert.equal(scope.runtimeCounters, 'current-process');
    assert.equal(scope.databaseGauges, 'current-database');
    assert.equal(scope.singleProcessOnly, true);
    assert.equal(typeof scope.countersStartedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(String(scope.countersStartedAt))));

    const runtime = nestedObject(body, 'runtime', 'metrics');
    for (const key of ['system', 'http', 'mutations', 'events', 'webSockets', 'liveDraft']) {
      assertObject(runtime[key], `runtime.${key}`);
    }
    const processMetrics = nestedObject(runtime, 'process', 'runtime');
    exactKeys(processMetrics, ['memoryBytes', 'cpu']);
    const memoryBytes = nestedObject(processMetrics, 'memoryBytes', 'runtime.process');
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'external']) {
      metricNumber(memoryBytes, key, 'runtime.process.memoryBytes');
    }
    const processCpu = nestedObject(processMetrics, 'cpu', 'runtime.process');
    for (const key of ['sampleWindowMs', 'userMicroseconds', 'systemMicroseconds', 'logicalCpuCount']) {
      finiteMetric(processCpu, key, 'runtime.process.cpu');
    }
    for (const key of ['percentOfOneCore', 'percentOfMachineCapacity']) {
      finiteMetric(processCpu, key, 'runtime.process.cpu');
    }
    const system = nestedObject(runtime, 'system', 'runtime');
    assert.equal(system.scope, 'node-visible-runtime');
    finiteMetric(system, 'logicalCpuCount', 'runtime.system');
    const systemCpu = nestedObject(system, 'cpu', 'runtime.system');
    for (const key of [
      'sampleWindowMs',
      'percentOfOneCore',
      'percentOfMachineCapacity',
      'logicalCpuCount',
    ]) {
      finiteMetric(systemCpu, key, 'runtime.system.cpu');
    }
    const systemMemory = nestedObject(system, 'memoryBytes', 'runtime.system');
    for (const key of ['total', 'free', 'used']) {
      finiteMetric(systemMemory, key, 'runtime.system.memoryBytes');
    }
    const loadAverage = nestedObject(system, 'loadAverage', 'runtime.system');
    for (const key of ['oneMinute', 'fiveMinutes', 'fifteenMinutes']) {
      finiteMetric(loadAverage, key, 'runtime.system.loadAverage');
    }
    const cgroup = nestedObject(system, 'cgroupV2', 'runtime.system');
    assert.equal(typeof cgroup.available, 'boolean');
    const { http, mutations, events, webSockets, database } = metricsSections(body);

    const bySurface = nestedObject(http, 'bySurface', 'runtime.http');
    exactKeys(bySurface, REQUEST_SURFACES);
    for (const surfaceName of REQUEST_SURFACES) {
      const surface = nestedObject(bySurface, surfaceName, 'runtime.http.bySurface');
      for (const key of [
        'total',
        'success',
        'clientError',
        'rateLimited',
        'serverError',
        'aborted',
        'idempotentReplays',
      ]) {
        metricNumber(surface, key, `runtime.http.bySurface.${surfaceName}`);
      }
      const buckets = nestedObject(
        surface,
        'durationBucketsMs',
        `runtime.http.bySurface.${surfaceName}`,
      );
      for (const key of [
        'le10',
        'le50',
        'le100',
        'le250',
        'le500',
        'le1000',
        'le2500',
        'le5000',
        'gt5000',
      ]) {
        metricNumber(buckets, key, `durationBucketsMs.${surfaceName}`);
      }
    }

    for (const key of ['operationsReceived', 'accepted', 'conflict', 'rejected', 'replayed']) {
      metricNumber(mutations, key, 'runtime.mutations');
    }
    for (const key of ['published', 'session', 'log']) {
      metricNumber(events, key, 'runtime.events');
    }
    for (const key of [
      'attempts',
      'accepted',
      'cursorResumeAccepted',
      'rejected',
      'closed',
      'active',
      'resyncRequired',
      'accessRevoked',
      'controlDeliveryFailures',
    ]) {
      const audience = nestedObject(webSockets, key, 'runtime.webSockets');
      metricNumber(audience, 'member', `runtime.webSockets.${key}`);
      metricNumber(audience, 'public', `runtime.webSockets.${key}`);
    }

    const gauges = nestedObject(body, 'gauges', 'metrics');
    exactKeys(gauges, ['runtime', 'database']);
    const runtimeGauges = nestedObject(gauges, 'runtime', 'gauges');
    const activeWebSockets = nestedObject(
      runtimeGauges,
      'activeWebSockets',
      'gauges.runtime',
    );
    assert.deepEqual(activeWebSockets, { total: 0, member: 0, public: 0 });

    const sessions = nestedObject(database, 'sessions', 'gauges.database');
    assert.deepEqual(sessions, {
      total: 4,
      initializing: 1,
      active: 1,
      closed: 1,
      deleted: 1,
    });
    const logs = nestedObject(database, 'logs', 'gauges.database');
    assert.deepEqual(logs, { live: 1, tombstone: 1 });
    const memberships = nestedObject(database, 'memberships', 'gauges.database');
    assert.deepEqual(memberships, { active: 2, removed: 1 });
    assert.equal(database.activeInvites, 1);
    assert.equal(database.activePublicShares, 1);
    const authorizableWsTickets = nestedObject(
      database,
      'authorizableWsTickets',
      'gauges.database',
    );
    assert.deepEqual(authorizableWsTickets, { member: 1, public: 1 });
    const storedRows = nestedObject(database, 'storedRows', 'gauges.database');
    assert.deepEqual(storedRows, {
      sessionEvents: 0,
      processedMutations: 0,
      liveDrafts: 0,
      liveDraftDeviceStates: 0,
    });

    const serialized = JSON.stringify(body);
    for (const sentinel of SENSITIVE_SENTINELS) {
      assert.equal(serialized.includes(sentinel), false, `metrics leaked sentinel: ${sentinel}`);
    }
  });

  test('reports no authorizable public ticket when the Public Liveshare key is incompatible', async () => {
    db.prepare(`
      UPDATE server_settings
      SET public_share_hmac_fingerprint = 'metrics-intentionally-mismatched-fingerprint'
      WHERE id = 1
    `).run();
    try {
      const body = await metrics();
      const database = metricsSections(body).database;
      const tickets = nestedObject(
        database,
        'authorizableWsTickets',
        'gauges.database',
      );
      assert.deepEqual(tickets, { member: 1, public: 0 });
    } finally {
      db.prepare(`
        UPDATE server_settings SET public_share_hmac_fingerprint = NULL WHERE id = 1
      `).run();
    }
  });

  test('counts HTTP outcomes and accepted/conflict/rejected/replayed mutations without replaying events', async () => {
    const beforeMetrics = await metrics();
    const beforeSections = metricsSections(beforeMetrics);
    const beforeSurface = mutationSurface(beforeMetrics);
    const acceptedMutationId = randomUUID();
    const acceptedEntityId = `metrics-created-log-${randomUUID()}`;
    const acceptedOperation = {
      mutationId: acceptedMutationId,
      entityType: 'log',
      entityId: acceptedEntityId,
      operation: 'create',
      baseVersion: 0,
      value: {
        syncId: acceptedEntityId,
        sessionId: ACTIVE_SESSION_ID,
        time: '2026-07-12T12:00:00.000Z',
        controller: 'METRICS TEST',
        callsign: 'MTRC1',
        rstSent: '59',
        rstRcvd: '59',
        qth: null,
        device: null,
        power: null,
        antenna: null,
        height: null,
        remarks: null,
      },
    };

    const accepted = await request(`/api/v1/sessions/${ACTIVE_SESSION_ID}/mutations`, {
      method: 'POST',
      token: accessToken(OWNER_ID, 'user'),
      body: { protocolVersion: 1, deviceId: DEVICE_ID, operations: [acceptedOperation] },
    });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(mutationStatus(accepted.body), 'accepted');

    const conflict = await request(`/api/v1/sessions/${ACTIVE_SESSION_ID}/mutations`, {
      method: 'POST',
      token: accessToken(OWNER_ID, 'user'),
      body: {
        protocolVersion: 1,
        deviceId: DEVICE_ID,
        operations: [
          {
            mutationId: randomUUID(),
            entityType: 'log',
            entityId: EXISTING_LOG_ID,
            operation: 'update',
            baseVersion: 0,
            patch: { callsign: 'CONFLICT1' },
          },
        ],
      },
    });
    assert.equal(conflict.status, 200, conflict.text);
    assert.equal(mutationStatus(conflict.body), 'conflict');

    const rejected = await request(`/api/v1/sessions/${ACTIVE_SESSION_ID}/mutations`, {
      method: 'POST',
      token: accessToken(VIEWER_ID, 'user'),
      body: {
        protocolVersion: 1,
        deviceId: DEVICE_ID,
        operations: [
          {
            mutationId: randomUUID(),
            entityType: 'log',
            entityId: `metrics-rejected-log-${randomUUID()}`,
            operation: 'create',
            baseVersion: 0,
            value: {
              time: '2026-07-12T12:01:00.000Z',
              controller: 'METRICS TEST',
              callsign: 'MTRC2',
            },
          },
        ],
      },
    });
    assert.equal(rejected.status, 200, rejected.text);
    assert.equal(mutationStatus(rejected.body), 'rejected');

    const replay = await request(`/api/v1/sessions/${ACTIVE_SESSION_ID}/mutations`, {
      method: 'POST',
      token: accessToken(OWNER_ID, 'user'),
      body: { protocolVersion: 1, deviceId: DEVICE_ID, operations: [acceptedOperation] },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(mutationStatus(replay.body), 'accepted');

    const mutationIdCollision = await request(
      `/api/v1/sessions/${ACTIVE_SESSION_ID}/mutations`,
      {
        method: 'POST',
        token: accessToken(VIEWER_ID, 'user'),
        body: {
          protocolVersion: 1,
          deviceId: DEVICE_ID,
          operations: [
            {
              mutationId: acceptedMutationId,
              entityType: 'session',
              entityId: ACTIVE_SESSION_ID,
              operation: 'update',
              baseVersion: 1,
              patch: { title: 'A collision is not an idempotent replay' },
            },
          ],
        },
      },
    );
    assert.equal(mutationIdCollision.status, 200, mutationIdCollision.text);
    assert.equal(mutationStatus(mutationIdCollision.body), 'rejected');
    assert.ok(Array.isArray(mutationIdCollision.body.results));
    assertObject(mutationIdCollision.body.results[0], 'collision result');
    assert.equal(mutationIdCollision.body.results[0].code, 'MUTATION_ID_REUSED');

    const invalid = await request(`/api/v1/sessions/${ACTIVE_SESSION_ID}/mutations`, {
      method: 'POST',
      token: accessToken(OWNER_ID, 'user'),
      body: {},
    });
    assertError(invalid, 422, 'VALIDATION_FAILED');

    const afterMetrics = await metrics();
    const afterSections = metricsSections(afterMetrics);
    const afterSurface = mutationSurface(afterMetrics);

    assert.equal(
      metricNumber(afterSurface, 'total', 'after mutation surface') -
        metricNumber(beforeSurface, 'total', 'before mutation surface'),
      6,
    );
    assert.equal(
      metricNumber(afterSurface, 'success', 'after mutation surface') -
        metricNumber(beforeSurface, 'success', 'before mutation surface'),
      5,
    );
    assert.equal(
      metricNumber(afterSurface, 'clientError', 'after mutation surface') -
        metricNumber(beforeSurface, 'clientError', 'before mutation surface'),
      1,
    );
    assert.equal(
      metricNumber(afterSurface, 'serverError', 'after mutation surface') -
        metricNumber(beforeSurface, 'serverError', 'before mutation surface'),
      0,
    );

    for (const [key, expectedDelta] of [
      ['operationsReceived', 5],
      ['accepted', 2],
      ['conflict', 1],
      ['rejected', 2],
      ['replayed', 1],
    ] as const) {
      assert.equal(
        metricNumber(afterSections.mutations, key, 'after mutations') -
          metricNumber(beforeSections.mutations, key, 'before mutations'),
        expectedDelta,
        `unexpected mutation counter delta for ${key}`,
      );
    }
    assert.equal(
      metricNumber(afterSections.events, 'published', 'after events') -
        metricNumber(beforeSections.events, 'published', 'before events'),
      1,
    );
    assert.equal(
      metricNumber(afterSections.events, 'log', 'after events') -
        metricNumber(beforeSections.events, 'log', 'before events'),
      1,
    );

    const database = afterSections.database;
    const logs = nestedObject(database, 'logs', 'gauges.database');
    assert.deepEqual(logs, { live: 2, tombstone: 1 });
    const storedRows = nestedObject(database, 'storedRows', 'gauges.database');
    assert.deepEqual(storedRows, {
      sessionEvents: 1,
      processedMutations: 3,
      liveDrafts: 0,
      liveDraftDeviceStates: 0,
    });

    const serialized = JSON.stringify(afterMetrics);
    for (const sentinel of SENSITIVE_SENTINELS) {
      assert.equal(serialized.includes(sentinel), false, `metrics leaked sentinel: ${sentinel}`);
    }
  });

  test('tracks cursor resume, active cleanup and each emitted WS resync exactly once', async () => {
    const headBeforeResume = Number(db.prepare(`
      SELECT event_seq FROM sessions WHERE id = ?
    `).pluck().get(ACTIVE_SESSION_ID));
    assert.ok(headBeforeResume > 0, 'the mutation test must leave a resumable cursor');

    const beforeResume = await metrics();
    const resumeTicket = await memberWsTicket(headBeforeResume);
    const resumed = await openMemberSocket(resumeTicket);
    const whileResumed = await metrics();
    assert.equal(
      webSocketMetric(whileResumed, 'accepted', 'member') -
        webSocketMetric(beforeResume, 'accepted', 'member'),
      1,
    );
    assert.equal(
      webSocketMetric(whileResumed, 'cursorResumeAccepted', 'member') -
        webSocketMetric(beforeResume, 'cursorResumeAccepted', 'member'),
      1,
    );
    assert.equal(
      webSocketMetric(whileResumed, 'active', 'member') -
        webSocketMetric(beforeResume, 'active', 'member'),
      1,
    );
    assert.equal(
      webSocketMetric(whileResumed, 'resyncRequired', 'member') -
        webSocketMetric(beforeResume, 'resyncRequired', 'member'),
      0,
    );

    await closeSocket(resumed);
    const afterResumeClose = await metrics();
    assert.equal(
      webSocketMetric(afterResumeClose, 'active', 'member'),
      webSocketMetric(beforeResume, 'active', 'member'),
    );
    assert.equal(
      webSocketMetric(afterResumeClose, 'closed', 'member') -
        webSocketMetric(beforeResume, 'closed', 'member'),
      1,
    );

    const oldHead = Number(db.prepare(`
      SELECT event_seq FROM sessions WHERE id = ?
    `).pluck().get(ACTIVE_SESSION_ID));
    const missingSeq = oldHead + 1;
    db.prepare(`
      UPDATE sessions SET event_seq = ? WHERE id = ?
    `).run(missingSeq, ACTIVE_SESSION_ID);

    const beforeGap = await metrics();
    const gapTicket = await memberWsTicket(oldHead);
    const gapSocket = new WebSocket(
      `${wsBaseUrl}/ws/collaboration?ticket=${encodeURIComponent(gapTicket)}`,
    );
    let resyncMessages = 0;
    let closeCode = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for the resync socket to close')),
          3_000,
        );
        gapSocket.on('message', (data) => {
          const parsed = JSON.parse(data.toString()) as JsonObject;
          if (parsed.type === 'resyncRequired') resyncMessages += 1;
        });
        gapSocket.once('close', (code) => {
          clearTimeout(timer);
          closeCode = code;
          resolve();
        });
        gapSocket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } finally {
      const occurredAt = new Date().toISOString();
      const repairedEvent = {
        protocolVersion: 1,
        eventId: randomUUID(),
        sessionId: ACTIVE_SESSION_ID,
        seq: missingSeq,
        type: 'session.updated',
        entityType: 'session',
        entityId: ACTIVE_SESSION_ID,
        entityVersion: 1,
        mutationId: null,
        actor: {
          userId: OWNER_ID,
          deviceId: DEVICE_ID,
          displayName: 'METRICS_SECRET_OWNER_USERNAME',
        },
        occurredAt,
        payload: {
          sessionId: ACTIVE_SESSION_ID,
          title: 'METRICS_SECRET_ACTIVE_TITLE',
          status: 'active',
          version: 1,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          closedAt: null,
          deletedAt: null,
        },
      };
      db.prepare(`
        INSERT OR IGNORE INTO session_events (
          id, session_id, seq, type, entity_type, entity_id, entity_version,
          mutation_id, actor_user_id, actor_device_id, payload_json, occurred_at
        ) VALUES (?, ?, ?, 'session.updated', 'session', ?, 1, NULL, ?, ?, ?, ?)
      `).run(
        repairedEvent.eventId,
        ACTIVE_SESSION_ID,
        missingSeq,
        ACTIVE_SESSION_ID,
        OWNER_ID,
        DEVICE_ID,
        JSON.stringify(repairedEvent),
        occurredAt,
      );
    }

    assert.equal(closeCode, 4009);
    assert.equal(resyncMessages, 1);
    const afterGap = await metrics();
    assert.equal(
      webSocketMetric(afterGap, 'resyncRequired', 'member') -
        webSocketMetric(beforeGap, 'resyncRequired', 'member'),
      1,
    );
    assert.equal(
      webSocketMetric(afterGap, 'cursorResumeAccepted', 'member') -
        webSocketMetric(beforeGap, 'cursorResumeAccepted', 'member'),
      1,
    );
    assert.equal(
      webSocketMetric(afterGap, 'active', 'member'),
      webSocketMetric(beforeGap, 'active', 'member'),
    );

    db.prepare(`
      UPDATE sessions SET min_retained_seq = event_seq WHERE id = ?
    `).run(ACTIVE_SESSION_ID);
    const beforeRestCursorExpiry = await metrics();
    const expiredCursor = await request(
      `/api/v1/sessions/${ACTIVE_SESSION_ID}/events?afterSeq=0`,
      { token: accessToken(OWNER_ID, 'user') },
    );
    assertError(expiredCursor, 410, 'CURSOR_EXPIRED');
    const afterRestCursorExpiry = await metrics();
    assert.equal(
      webSocketMetric(afterRestCursorExpiry, 'resyncRequired', 'member'),
      webSocketMetric(beforeRestCursorExpiry, 'resyncRequired', 'member'),
      'a REST cursor expiry must not be counted as a WebSocket resync message',
    );
  });
});
