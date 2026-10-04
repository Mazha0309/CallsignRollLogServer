import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import {
  collaborationWsInternals,
  createCollaborationWsServer,
  CollaborationWsController,
} from '../src/ws';
import { getRealtimeHub } from '../src/collaboration/realtime';

type JsonObject = Record<string, unknown>;

interface Actor {
  id: string;
  accessToken: string;
}

interface HttpResult {
  status: number;
  body: JsonObject;
  text: string;
}

const deviceId = '8aa56a31-5854-49b0-a8e7-3a6609153de7';

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function success(result: HttpResult, expected = 200): JsonObject {
  assert.equal(result.status, expected, result.text);
  return result.body;
}

function errorCode(result: HttpResult, status: number, code: string): void {
  assert.equal(result.status, status, result.text);
  assertObject(result.body.error, 'error');
  assert.equal(result.body.error.code, code, result.text);
}

function authActor(body: JsonObject): Actor {
  assertObject(body.user, 'user');
  assert.equal(typeof body.accessToken, 'string');
  return { id: String(body.user.id), accessToken: String(body.accessToken) };
}

class WsInbox {
  readonly messages: JsonObject[] = [];
  private readonly waiters: Array<(message: JsonObject) => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as JsonObject;
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.messages.push(parsed);
    });
  }

  async next(): Promise<JsonObject> {
    const queued = this.messages.shift();
    if (queued) return queued;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), 3_000);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

describe('collaboration Stage 2 realtime protocol', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let wsController: CollaborationWsController;
  let baseUrl: string;
  let wsBaseUrl: string;
  const actors = new Map<string, Actor>();
  let sessionId: string;
  let logId: string;

  const config: AppConfig = {
    port: 0,
    dbPath: ':memory:',
    jwtSecret: 'stage2-test-jwt-secret-ecaf8872-f154-489e-8aca-709fb2d42035',
    jwtIssuer: 'openlogtool-stage2-test',
    bootstrapSecret: 'stage2-bootstrap-secret-2ca8ee57-05a4-42ee-bf57-f937127d761a',
    inviteHmacKey: 'stage2-invite-hmac-key-70529038-bec6-4059-80e0-9bffb336388d',
    publicShareHmacKey: 'stage2-public-share-key-10581e39-b42c-4fb4-9792',
    accessTokenTtlSeconds: 300,
    refreshTokenTtlSeconds: 3_600,
    corsOrigins: ['https://allowed.example'],
    trustProxy: false,
    jsonBodyLimit: '1mb',
    rateLimitEnabled: true,
    environment: 'test',
  };

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-stage2-'));
    db = openDatabase(join(directory, 'stage2.db'));
    config.dbPath = join(directory, 'stage2.db');
    server = createServer(createApp({ db, config }));
    wsController = createCollaborationWsServer(server, { db, config });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;

    actors.set(
      'admin',
      authActor(
        success(
          await request('/api/v1/auth/bootstrap', {
            method: 'POST',
            headers: { 'x-bootstrap-secret': config.bootstrapSecret },
            body: { username: 'stage2-admin', password: 'Admin-password-123!' },
          }),
          201,
        ),
      ),
    );
    for (const name of ['owner', 'editor', 'viewer', 'outsider']) {
      actors.set(
        name,
        authActor(
          success(
            await request('/api/v1/auth/register', {
              method: 'POST',
              body: { username: `stage2-${name}`, password: 'User-password-123!' },
            }),
            201,
          ),
        ),
      );
    }
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

  function actor(name: string): Actor {
    const value = actors.get(name);
    assert.ok(value, `missing actor ${name}`);
    return value;
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
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as JsonObject) : {},
      text,
    };
  }

  async function inviteAndJoin(name: 'editor' | 'viewer'): Promise<void> {
    const invitation = success(
      await request(`/api/v1/sessions/${sessionId}/invites`, {
        method: 'POST',
        token: actor('owner').accessToken,
        headers: { 'idempotency-key': randomUUID() },
        body: { role: name, maxUses: 1, expiresInHours: 24 },
      }),
      201,
    );
    assertObject(invitation.invite, 'invite');
    const joinRequestId = randomUUID();
    success(
      await request('/api/v1/collaboration-invites/redeem', {
        method: 'POST',
        token: actor(name).accessToken,
        headers: { 'idempotency-key': joinRequestId },
        body: {
          code: invitation.invite.code,
          linkToken: null,
          joinRequestId,
          deviceId,
        },
      }),
      201,
    );
  }

  async function mutation(
    name: string,
    operations: JsonObject[],
  ): Promise<JsonObject> {
    return success(
      await request(`/api/v1/sessions/${sessionId}/mutations`, {
        method: 'POST',
        token: actor(name).accessToken,
        body: { protocolVersion: 1, deviceId, operations },
      }),
    );
  }

  async function wsTicket(name: string, afterSeq: number): Promise<string> {
    const response = success(
      await request(`/api/v1/sessions/${sessionId}/ws-ticket`, {
        method: 'POST',
        token: actor(name).accessToken,
        body: { deviceId, afterSeq },
      }),
    );
    assert.equal(response.afterSeq, afterSeq);
    assert.equal(typeof response.ticket, 'string');
    return String(response.ticket);
  }

  async function connect(
    ticket: string,
    headers: Record<string, string> = {},
  ): Promise<WsInbox> {
    const ws = new WebSocket(`${wsBaseUrl}/ws/collaboration?ticket=${encodeURIComponent(ticket)}`, {
      headers,
    });
    const inbox = new WsInbox(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return inbox;
  }

  async function rejectedConnection(
    ticket: string,
    expectedStatus: number,
    headers: Record<string, string> = {},
  ): Promise<void> {
    const ws = new WebSocket(`${wsBaseUrl}/ws/collaboration?ticket=${encodeURIComponent(ticket)}`, {
      headers,
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('unexpected-response', (_request, response) => {
        response.resume();
        try {
          assert.equal(response.statusCode, expectedStatus);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      ws.once('open', () => reject(new Error('WebSocket unexpectedly connected')));
      ws.once('error', () => undefined);
    });
  }

  test('migration v8 remains installed alongside the latest schema', () => {
    assert.equal(
      db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(),
      30,
    );
    assert.equal(
      db.prepare('SELECT name FROM schema_migrations WHERE version = 8').pluck().get(),
      'collaboration_realtime_events',
    );
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_events', 'ws_tickets')
      ORDER BY name
    `).pluck().all();
    assert.deepEqual(tables, ['session_events', 'ws_tickets']);
    const ticketColumns = (db.pragma('table_info(ws_tickets)') as Array<{ name: string }>)
      .map((column) => column.name);
    assert.ok(ticketColumns.includes('issued_role'));
    assert.ok(ticketColumns.includes('issued_membership_version'));
  });

  test('numeric TRUST_PROXY uses the configured nearest hop instead of spoofable leftmost values', () => {
    const proxiedConfig = { ...config, trustProxy: 1 };
    const request = {
      headers: {
        origin: 'https://app.example',
        host: 'internal.example',
        'x-forwarded-for': '203.0.113.200, 198.51.100.20',
        'x-forwarded-host': 'attacker.example, app.example',
        'x-forwarded-proto': 'http, https',
      },
      socket: { remoteAddress: '192.0.2.10' },
    } as unknown as IncomingMessage;
    assert.equal(collaborationWsInternals.requestIp(request, proxiedConfig), '198.51.100.20');
    assert.equal(collaborationWsInternals.isAllowedOrigin(request, proxiedConfig), true);
  });

  test('activation starts the canonical sequence and members join without adding data events', async () => {
    sessionId = randomUUID();
    success(
      await request(`/api/v1/sessions/${sessionId}`, {
        method: 'PUT',
        token: actor('owner').accessToken,
        headers: { 'idempotency-key': randomUUID(), 'x-device-id': deviceId },
        body: { title: 'Stage 2 session' },
      }),
      201,
    );
    const activated = success(
      await request(`/api/v1/sessions/${sessionId}/activate`, {
        method: 'POST',
        token: actor('owner').accessToken,
        headers: { 'idempotency-key': randomUUID(), 'x-device-id': deviceId },
        body: { expectedLogCount: 0 },
      }),
    );
    assert.equal(activated.highWatermarkSeq, 1);
    await inviteAndJoin('editor');
    await inviteAndJoin('viewer');

    const page = success(
      await request(`/api/v1/sessions/${sessionId}/events?afterSeq=0&limit=10`, {
        token: actor('viewer').accessToken,
      }),
    );
    assert.equal(page.afterSeq, 0);
    assert.equal(page.toSeq, 1);
    assert.equal(page.headSeq, 1);
    assert.equal(page.hasMore, false);
    assert.ok(Array.isArray(page.events));
    assert.equal((page.events as JsonObject[])[0].type, 'session.activated');
  });

  test('each mutation is independently atomic, durably replayed, and broadcast-safe', async () => {
    logId = randomUUID();
    const createId = randomUUID();
    const invalidId = randomUUID();
    const operations: JsonObject[] = [
      {
        mutationId: createId,
        entityType: 'log',
        entityId: logId,
        operation: 'create',
        baseVersion: 0,
        observedSeq: 1,
        queuedAt: '2026-07-12T08:00:00.123456Z',
        value: {
          syncId: logId,
          sessionId,
          time: '2026-07-12T07:59:00.123456789Z',
          controller: ' bg5crl ',
          callsign: ' ba4aaa ',
          rstSent: '59',
          rstRcvd: '57',
          qth: ' 上海 ',
          device: 'IC-705',
          power: '10W',
          antenna: 'DP',
          height: '8m',
          remarks: ' 移动台 ',
        },
      },
      {
        mutationId: invalidId,
        entityType: 'log',
        entityId: randomUUID(),
        operation: 'create',
        baseVersion: 1,
        value: {
          time: '2026-07-12T08:00:00Z',
          controller: 'BG5CRL',
          callsign: 'BA4BBB',
        },
      },
    ];
    const first = await mutation('editor', operations);
    assert.equal(first.headSeq, 2);
    const results = first.results as JsonObject[];
    assert.equal(results[0].status, 'accepted');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].code, 'VALIDATION_FAILED');
    assertObject(results[0].event, 'accepted event');
    const event = results[0].event;
    assert.equal(event.seq, 2);
    assert.equal(event.type, 'log.created');
    assertObject(event.payload, 'event payload');
    assert.equal(event.payload.controller, 'BG5CRL');
    assert.equal(event.payload.callsign, 'BA4AAA');
    assert.equal(event.payload.qth, '上海');
    assert.equal(event.payload.remarks, '移动台');

    const stored = db.prepare(`
      SELECT payload_json FROM session_events WHERE mutation_id = ?
    `).get(createId) as { payload_json: string };
    assert.deepEqual(JSON.parse(stored.payload_json), event);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id IN (?, ?)').pluck().get(
        createId,
        invalidId,
      ),
      2,
    );

    const replay = await mutation('editor', operations);
    assert.deepEqual(replay.results, first.results);
    assert.equal(replay.headSeq, 2);
    const reused = await mutation('editor', [
      {
        ...operations[0],
        value: { ...(operations[0].value as JsonObject), remarks: 'different' },
      },
    ]);
    assert.equal((reused.results as JsonObject[])[0].status, 'rejected');
    assert.equal((reused.results as JsonObject[])[0].code, 'MUTATION_ID_REUSED');

    const viewer = await mutation('viewer', [
      {
        mutationId: randomUUID(),
        entityType: 'log',
        entityId: randomUUID(),
        operation: 'create',
        baseVersion: 0,
        value: {
          time: '2026-07-12T08:00:00Z',
          controller: 'BG5CRL',
          callsign: 'BA4CCC',
        },
      },
    ]);
    assert.equal((viewer.results as JsonObject[])[0].code, 'FORBIDDEN');
    assert.equal(viewer.headSeq, 2);

    let brokenTransportClosed = false;
    const unsubscribe = getRealtimeHub(db).add({
      sessionId,
      userId: 'broken-transport',
      ipAddress: 'test',
      deliver() {
        assert.equal(db.inTransaction, false, 'broadcast must happen only after commit');
        throw new Error('simulated WebSocket send failure');
      },
      revoke() {
        throw new Error('simulated WebSocket send failure');
      },
      membershipChanged() {
        throw new Error('simulated WebSocket send failure');
      },
      sessionDeleted() {
        throw new Error('simulated WebSocket send failure');
      },
      close() {
        brokenTransportClosed = true;
      },
    });
    const independent = await mutation('editor', [
      ...['BA4D01', 'BA4D02'].map((callsign) => ({
        mutationId: randomUUID(),
        entityType: 'log',
        entityId: randomUUID(),
        operation: 'create',
        baseVersion: 0,
        value: {
          time: '2026-07-12T08:02:00Z',
          controller: 'BG5CRL',
          callsign,
        },
      })),
    ]);
    unsubscribe();
    assert.equal(brokenTransportClosed, true);
    assert.deepEqual(
      (independent.results as JsonObject[]).map((result) => result.status),
      ['accepted', 'accepted'],
      'a failed broadcast must not abort later operations in the batch',
    );
    assert.equal(independent.headSeq, 4);

    const concurrentId = randomUUID();
    const concurrentOperation = {
      mutationId: concurrentId,
      entityType: 'log',
      entityId: randomUUID(),
      operation: 'create',
      baseVersion: 0,
      value: {
        time: '2026-07-12T08:03:00Z',
        controller: 'BG5CRL',
        callsign: 'BA4D03',
      },
    };
    const [concurrentLeft, concurrentRight] = await Promise.all([
      mutation('editor', [concurrentOperation]),
      mutation('editor', [concurrentOperation]),
    ]);
    assert.deepEqual(concurrentLeft.results, concurrentRight.results);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM session_events WHERE mutation_id = ?').pluck().get(
        concurrentId,
      ),
      1,
    );
  });

  test('strict baseVersion controls update/delete/restore and close/reopen', async () => {
    const updateId = randomUUID();
    const updated = await mutation('editor', [
      {
        mutationId: updateId,
        entityType: 'log',
        entityId: logId,
        operation: 'update',
        baseVersion: 1,
        patch: { qth: '杭州', remarks: null },
      },
    ]);
    const updateResult = (updated.results as JsonObject[])[0];
    assert.equal(updateResult.status, 'accepted');
    assertObject(updateResult.event, 'update event');
    assert.equal(updateResult.event.entityVersion, 2);

    const stale = await mutation('editor', [
      {
        mutationId: randomUUID(),
        entityType: 'log',
        entityId: logId,
        operation: 'update',
        baseVersion: 1,
        patch: { power: '5W' },
      },
    ]);
    const staleResult = (stale.results as JsonObject[])[0];
    assert.equal(staleResult.status, 'conflict');
    assert.equal(staleResult.code, 'VERSION_CONFLICT');
    assert.equal(staleResult.currentVersion, 2);

    const deleted = await mutation('editor', [
      {
        mutationId: randomUUID(),
        entityType: 'log',
        entityId: logId,
        operation: 'delete',
        baseVersion: 2,
      },
    ]);
    assert.equal(((deleted.results as JsonObject[])[0].event as JsonObject).entityVersion, 3);

    const ordinarySnapshot = success(
      await request(`/api/v1/sessions/${sessionId}/snapshot`, {
        token: actor('viewer').accessToken,
      }),
    );
    assert.equal(ordinarySnapshot.includesDeletedLogs, false);
    assert.ok(
      !(ordinarySnapshot.logs as JsonObject[]).some((log) => log.syncId === logId),
      'ordinary join snapshots continue to omit tombstones',
    );
    const resyncSnapshot = success(
      await request(`/api/v1/sessions/${sessionId}/snapshot?includeDeleted=true`, {
        token: actor('viewer').accessToken,
      }),
    );
    assert.equal(resyncSnapshot.includesDeletedLogs, true);
    const tombstone = (resyncSnapshot.logs as JsonObject[]).find((log) => log.syncId === logId);
    assertObject(tombstone, 'resync tombstone');
    assert.equal(tombstone.version, 3);
    assert.equal(typeof tombstone.deletedAt, 'string');
    errorCode(
      await request(`/api/v1/sessions/${sessionId}/snapshot?includeDeleted=false`, {
        token: actor('viewer').accessToken,
      }),
      422,
      'VALIDATION_FAILED',
    );

    const oldUpdate = await mutation('editor', [
      {
        mutationId: randomUUID(),
        entityType: 'log',
        entityId: logId,
        operation: 'update',
        baseVersion: 3,
        patch: { power: '1W' },
      },
    ]);
    assert.equal((oldUpdate.results as JsonObject[])[0].status, 'conflict');
    const restored = await mutation('editor', [
      {
        mutationId: randomUUID(),
        entityType: 'log',
        entityId: logId,
        operation: 'restore',
        baseVersion: 3,
        confirm: true,
      },
    ]);
    assert.equal(((restored.results as JsonObject[])[0].event as JsonObject).entityVersion, 4);

    const nonOwnerSession = await mutation('editor', [
      {
        mutationId: randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        operation: 'update',
        baseVersion: 2,
        patch: { title: 'forbidden' },
      },
    ]);
    assert.equal((nonOwnerSession.results as JsonObject[])[0].code, 'FORBIDDEN');
    const renamed = await mutation('owner', [
      {
        mutationId: randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        operation: 'update',
        baseVersion: 2,
        patch: { title: '实时点名' },
      },
    ]);
    assert.equal(((renamed.results as JsonObject[])[0].event as JsonObject).entityVersion, 3);
    const closed = await mutation('owner', [
      {
        mutationId: randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        operation: 'close',
        baseVersion: 3,
      },
    ]);
    assert.equal(((closed.results as JsonObject[])[0].event as JsonObject).entityVersion, 4);
    const closedWrite = await mutation('editor', [
      {
        mutationId: randomUUID(),
        entityType: 'log',
        entityId: randomUUID(),
        operation: 'create',
        baseVersion: 0,
        value: {
          time: '2026-07-12T08:01:00Z',
          controller: 'BG5CRL',
          callsign: 'BA4DDD',
        },
      },
    ]);
    assert.equal((closedWrite.results as JsonObject[])[0].code, 'SESSION_CLOSED');
    const reopened = await mutation('owner', [
      {
        mutationId: randomUUID(),
        entityType: 'session',
        entityId: sessionId,
        operation: 'reopen',
        baseVersion: 4,
      },
    ]);
    assert.equal(((reopened.results as JsonObject[])[0].event as JsonObject).entityVersion, 5);
  });

  test('event pagination is continuous, object-scoped, and rejects invalid cursors', async () => {
    const head = Number(
      db.prepare('SELECT event_seq FROM sessions WHERE id = ?').pluck().get(sessionId),
    );
    let cursor = 0;
    const collected: JsonObject[] = [];
    while (cursor < head) {
      const page = success(
        await request(`/api/v1/sessions/${sessionId}/events?afterSeq=${cursor}&limit=2`, {
          token: actor('viewer').accessToken,
        }),
      );
      const events = page.events as JsonObject[];
      for (const event of events) {
        assert.equal(event.seq, cursor + 1);
        cursor = Number(event.seq);
        collected.push(event);
      }
      assert.equal(page.toSeq, cursor);
      assert.equal(page.hasMore, cursor < head);
    }
    assert.equal(collected.length, head);

    errorCode(
      await request(`/api/v1/sessions/${sessionId}/events?afterSeq=${head + 1}`, {
        token: actor('viewer').accessToken,
      }),
      422,
      'VALIDATION_FAILED',
    );
    errorCode(
      await request(`/api/v1/sessions/${sessionId}/events?afterSeq=0`, {
        token: actor('outsider').accessToken,
      }),
      404,
      'NOT_FOUND',
    );
    db.prepare('UPDATE sessions SET min_retained_seq = 2 WHERE id = ?').run(sessionId);
    errorCode(
      await request(`/api/v1/sessions/${sessionId}/events?afterSeq=1`, {
        token: actor('viewer').accessToken,
      }),
      410,
      'CURSOR_EXPIRED',
    );
  });

  test('one-time ticket authenticates backlog/live WS, enforces Origin and isolates broadcasts', async () => {
    const headBefore = Number(
      db.prepare('SELECT event_seq FROM sessions WHERE id = ?').pluck().get(sessionId),
    );
    const ticket = await wsTicket('viewer', headBefore - 1);
    const storedTicket = db.prepare(`
      SELECT token_hash FROM ws_tickets ORDER BY created_at DESC LIMIT 1
    `).get() as { token_hash: string };
    assert.match(storedTicket.token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(storedTicket.token_hash, ticket, 'the raw ticket must never be stored');
    const inbox = await connect(ticket);
    const hello = await inbox.next();
    assert.deepEqual(hello, {
      type: 'hello',
      sessionId,
      headSeq: headBefore,
      heartbeatIntervalMs: 20_000,
    });
    const backlog = await inbox.next();
    assert.equal(backlog.type, 'event');
    assertObject(backlog.event, 'backlog event');
    assert.equal(backlog.event.seq, headBefore);
    assert.deepEqual(await inbox.next(), { type: 'ready', cursor: headBefore });
    await rejectedConnection(ticket, 401);

    const rejectedOriginTicket = await wsTicket('owner', headBefore);
    await rejectedConnection(rejectedOriginTicket, 403, { origin: 'https://evil.example' });
    const sameOriginTicket = await wsTicket('owner', headBefore);
    const sameOrigin = await connect(sameOriginTicket, { origin: baseUrl });
    assert.equal((await sameOrigin.next()).type, 'hello');
    assert.equal((await sameOrigin.next()).type, 'ready');
    const eventOnlyClose = new Promise<number>((resolve) => {
      sameOrigin.ws.once('close', (code) => resolve(code));
    });
    sameOrigin.ws.send(JSON.stringify({ type: 'mutation', payload: 'forbidden' }));
    assert.equal(await eventOnlyClose, 1008);

    const liveMutation = await mutation('editor', [
      {
        mutationId: randomUUID(),
        entityType: 'log',
        entityId: logId,
        operation: 'update',
        baseVersion: 4,
        patch: { power: '20W' },
      },
    ]);
    const acceptedEvent = ((liveMutation.results as JsonObject[])[0].event as JsonObject);
    const liveMessage = await inbox.next();
    assert.equal(liveMessage.type, 'event');
    assert.deepEqual(liveMessage.event, acceptedEvent);
    const stored = db.prepare('SELECT payload_json FROM session_events WHERE id = ?').get(
      acceptedEvent.eventId,
    ) as { payload_json: string };
    assert.deepEqual(JSON.parse(stored.payload_json), acceptedEvent);
    inbox.ws.close();
  });

  test('oversized WS backlog is rejected before loading or queueing the event history', async () => {
    const originalHead = Number(
      db.prepare('SELECT event_seq FROM sessions WHERE id = ?').pluck().get(sessionId),
    );
    const insert = db.prepare(`
      INSERT INTO session_events (
        id, session_id, seq, type, entity_type, entity_id, entity_version,
        mutation_id, actor_user_id, actor_device_id, payload_json, occurred_at
      ) VALUES (?, ?, ?, 'session.updated', 'session', ?, 1, NULL, ?, ?, '{}', ?)
    `);
    const occurredAt = new Date().toISOString();
    db.transaction(() => {
      for (let offset = 1; offset <= 1_001; offset += 1) {
        insert.run(
          randomUUID(),
          sessionId,
          originalHead + offset,
          sessionId,
          actor('owner').id,
          deviceId,
          occurredAt,
        );
      }
      db.prepare('UPDATE sessions SET event_seq = ? WHERE id = ?').run(
        originalHead + 1_001,
        sessionId,
      );
    }).immediate();

    try {
      const ticket = await wsTicket('viewer', originalHead);
      await rejectedConnection(ticket, 409);
    } finally {
      db.transaction(() => {
        const syntheticHead = originalHead + 1_001;
        db.prepare(`
          UPDATE sessions SET min_retained_seq = ?
          WHERE id = ? AND event_seq = ?
        `).run(syntheticHead, sessionId, syntheticHead);
        db.prepare(`
          DELETE FROM session_events WHERE session_id = ? AND seq <= ?
        `).run(sessionId, syntheticHead);
      }).immediate();
    }
  });

  test('role changes force reconnect; removal revokes immediately; user limit releases on close', async () => {
    const head = Number(
      db.prepare('SELECT event_seq FROM sessions WHERE id = ?').pluck().get(sessionId),
    );
    const staleEditorTicket = await wsTicket('editor', head);
    const editorInbox = await connect(await wsTicket('editor', head));
    await editorInbox.next();
    await editorInbox.next();
    success(
      await request(`/api/v1/sessions/${sessionId}/members/${actor('editor').id}`, {
        method: 'PATCH',
        token: actor('owner').accessToken,
        headers: { 'idempotency-key': randomUUID() },
        body: { role: 'viewer' },
      }),
    );
    const roleControl = await editorInbox.next();
    assert.equal(roleControl.type, 'membershipChanged');
    assert.equal(roleControl.role, 'viewer');
    await new Promise<void>((resolve) => editorInbox.ws.once('close', () => resolve()));
    await rejectedConnection(staleEditorTicket, 401);

    const viewerInbox = await connect(await wsTicket('viewer', head));
    await viewerInbox.next();
    await viewerInbox.next();
    success(
      await request(`/api/v1/sessions/${sessionId}/members/${actor('viewer').id}`, {
        method: 'DELETE',
        token: actor('owner').accessToken,
        headers: { 'idempotency-key': randomUUID() },
      }),
    );
    assert.deepEqual(await viewerInbox.next(), {
      type: 'accessRevoked',
      reason: 'MEMBERSHIP_REVOKED',
    });
    await new Promise<void>((resolve) => viewerInbox.ws.once('close', () => resolve()));
    errorCode(
      await request(`/api/v1/sessions/${sessionId}/ws-ticket`, {
        method: 'POST',
        token: actor('viewer').accessToken,
        body: { deviceId, afterSeq: head },
      }),
      403,
      'MEMBERSHIP_REVOKED',
    );

    const sockets: WsInbox[] = [];
    for (let index = 0; index < 8; index += 1) {
      const connection = await connect(await wsTicket('owner', head));
      await connection.next();
      await connection.next();
      sockets.push(connection);
    }
    const ninthTicket = await wsTicket('owner', head);
    await rejectedConnection(ninthTicket, 429);
    const closed = sockets.pop()!;
    const closedPromise = new Promise<void>((resolve) => closed.ws.once('close', () => resolve()));
    closed.ws.close();
    await closedPromise;
    const replacement = await connect(ninthTicket);
    await replacement.next();
    await replacement.next();
    replacement.ws.close();
    for (const socket of sockets) socket.ws.close();
  });

  test('mutation request rate limiting is scoped after authentication', async () => {
    let last: HttpResult | undefined;
    for (let index = 0; index <= 120; index += 1) {
      last = await request(`/api/v1/sessions/${sessionId}/mutations`, {
        method: 'POST',
        token: actor('outsider').accessToken,
        body: {
          protocolVersion: 1,
          deviceId,
          operations: [
            {
              mutationId: randomUUID(),
              entityType: 'log',
              entityId: randomUUID(),
              operation: 'delete',
              baseVersion: 1,
            },
          ],
        },
      });
      if (index < 120) errorCode(last, 404, 'NOT_FOUND');
    }
    assert.ok(last);
    errorCode(last, 429, 'RATE_LIMITED');
  });
});
