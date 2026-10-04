import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import { validatePersonalDictionarySnapshot } from '../src/personal-dictionary-snapshot/model';
import {
  type PersonalSnapshot,
  validatePersonalSnapshot,
} from '../src/personal-snapshot/model';

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
  jwtSecret: 'admin-personal-snapshot-test-secret-503a83b1-0c74-4efa-b4a5',
  jwtIssuer: 'admin-personal-snapshot-test',
  bootstrapSecret: 'admin-personal-snapshot-bootstrap-6cf77e95',
  inviteHmacKey: 'admin-personal-snapshot-invite-9892ad06',
  publicShareHmacKey: 'admin-personal-snapshot-share-fd910c55',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function exactKeys(value: JsonObject, expected: string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertError(result: HttpResult, status: number, code: string): void {
  assert.equal(result.status, status, result.text);
  assertObject(result.body.error, 'error');
  assert.equal(result.body.error.code, code, result.text);
}

function snapshotFixture(suffix: string): PersonalSnapshot {
  return {
    version: 1,
    exportedAt: '2026-07-18T12:00:00.000+08:00',
    sessions: [
      {
        session_id: `session-${suffix}`,
        title: `Personal net ${suffix}`,
        status: 'closed',
        created_at: '2026-07-18T10:00:00.000+08:00',
        updated_at: '2026-07-18T11:00:00.000+08:00',
        closed_at: '2026-07-18T11:00:00.000+08:00',
        deleted_at: null,
      },
      {
        session_id: `session-${suffix}-other`,
        title: `Other personal net ${suffix}`,
        status: 'active',
        created_at: '2026-07-18T12:00:00.000+08:00',
        updated_at: '2026-07-18T12:30:00.000+08:00',
        closed_at: null,
        deleted_at: null,
      },
    ],
    logs: [
      {
        sync_id: `log-${suffix}`,
        session_id: `session-${suffix}`,
        time: '20:15:59',
        controller: 'BG5CRL',
        callsign: `BG5${suffix.toUpperCase()}`,
        rst_sent: '59',
        rst_rcvd: '59',
        qth: 'Zhejiang',
        device: null,
        power: '5W',
        antenna: null,
        height: null,
        remarks: 'private personal note',
        created_at: '2026-07-18T10:15:59.000+08:00',
        updated_at: '2026-07-18T10:15:59.000+08:00',
        deleted_at: null,
        source_device_id: null,
      },
      {
        sync_id: `log-${suffix}-other`,
        session_id: `session-${suffix}-other`,
        time: '20:16:59',
        controller: 'BG5CRL',
        callsign: `BG5${suffix.toUpperCase()}X`,
        rst_sent: '59',
        rst_rcvd: '59',
        qth: 'Ningbo',
        device: null,
        power: '5W',
        antenna: null,
        height: null,
        remarks: 'other private personal note',
        created_at: '2026-07-18T12:16:59.000+08:00',
        updated_at: '2026-07-18T12:16:59.000+08:00',
        deleted_at: null,
        source_device_id: null,
      },
    ],
  };
}

describe('administrator personal cloud snapshot read API', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;

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
    options: { token?: string; headers?: Record<string, string> } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    assertObject(parsed, 'HTTP response');
    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-admin-personal-snapshots-'));
    const databasePath = join(directory, 'admin-personal-snapshots.db');
    db = openDatabase(databasePath);
    config.dbPath = databasePath;

    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'NOT_EXPOSED', ?, ?, ?)
    `);
    const createdAt = '2026-07-01T00:00:00.000Z';
    for (const [id, username, role] of [
      ['admin-root', 'rootadmin', 'admin'],
      ['member', 'ordinarymember', 'user'],
      ['user-a', 'AlphaUser', 'user'],
      ['user-b', 'BravoUser', 'user'],
      ['literal-percent', 'literal%mark', 'user'],
      ['literal-underscore', 'literal_mark', 'user'],
      ['unicode-composed', 'ÉCHOUser', 'user'],
      ['no-snapshot', 'NoSnapshot', 'user'],
    ] as const) {
      insertUser.run(id, username, role, createdAt, createdAt);
    }
    db.prepare(`
      INSERT INTO sessions (id, title, status, owner_user_id, created_at, updated_at)
      VALUES ('admin-catalog-shared', 'Shared admin catalog net', 'active', 'user-a', ?, ?)
    `).run(createdAt, createdAt);
    const insertMember = db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, 'admin-catalog-shared', ?, ?, 1, ?, ?)
    `);
    insertMember.run('admin-catalog-owner', 'user-a', 'owner', createdAt, createdAt);
    insertMember.run('admin-catalog-editor', 'user-b', 'editor', createdAt, createdAt);

    const insertSnapshot = db.prepare(`
      INSERT INTO personal_cloud_snapshots (
        user_id, revision, format_version, snapshot_json,
        session_count, log_count, byte_size, checksum, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const fixtures = [
      ['user-a', 'a', '2026-07-03T00:00:00.000Z'],
      ['user-b', 'b', '2026-07-04T00:00:00.000Z'],
      ['literal-percent', 'percent', '2026-07-02T00:00:00.000Z'],
      ['literal-underscore', 'underscore', '2026-07-01T00:00:00.000Z'],
      ['unicode-composed', 'unicode', '2026-06-30T00:00:00.000Z'],
    ] as const;
    for (const [userId, suffix, updatedAt] of fixtures) {
      const validated = validatePersonalSnapshot(snapshotFixture(suffix));
      insertSnapshot.run(
        userId,
        1,
        validated.snapshot.version,
        validated.serialized,
        validated.sessionCount,
        validated.logCount,
        validated.byteSize,
        validated.checksum,
        updatedAt,
        updatedAt,
      );
    }

    const dictionary = validatePersonalDictionarySnapshot({
      version: 1,
      exportedAt: '2026-07-03T01:02:03.456Z',
      items: [
        {
          dictType: 'qth',
          raw: 'Cloud QTH',
          origin: 'user',
          state: 'active',
          pinyin: 'cloud qth',
          abbreviation: 'CQ',
        },
      ],
    });
    db.prepare(`
      INSERT INTO personal_dictionary_snapshots (
        user_id, revision, format_version, snapshot_json,
        item_count, active_count, deleted_count,
        byte_size, checksum, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'user-a',
      dictionary.snapshot.version,
      dictionary.serialized,
      dictionary.itemCount,
      dictionary.activeCount,
      dictionary.deletedCount,
      dictionary.byteSize,
      dictionary.checksum,
      '2026-07-03T01:02:03.456Z',
      '2026-07-03T01:02:03.456Z',
    );

    const app = createApp({ db, config });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('requires a current administrator and never caches responses', async () => {
    assertError(await request('/api/v1/admin/personal-snapshots'), 401, 'AUTH_REQUIRED');
    assertError(
      await request('/api/v1/admin/personal-snapshots', {
        token: accessToken('member', 'user'),
      }),
      403,
      'ADMIN_REQUIRED',
    );
    assertError(
      await request('/api/v1/admin/personal-snapshots/user-a/sessions/session-a/database-backup-v7', {
        token: accessToken('member', 'user'),
      }),
      403,
      'ADMIN_REQUIRED',
    );

    const result = await request('/api/v1/admin/personal-snapshots', {
      token: accessToken('admin-root', 'admin'),
    });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  });

  test('lists exact non-content metadata with deterministic pagination', async () => {
    const token = accessToken('admin-root', 'admin');
    const auditBefore = Number(db.prepare(
      'SELECT COUNT(*) FROM admin_governance_audit_events',
    ).pluck().get());
    const first = await request('/api/v1/admin/personal-snapshots?page=1&pageSize=2', {
      token,
    });
    assert.equal(first.status, 200, first.text);
    exactKeys(first.body, ['items', 'page', 'pageSize', 'total', 'totalPages']);
    assert.deepEqual(
      {
        page: first.body.page,
        pageSize: first.body.pageSize,
        total: first.body.total,
        totalPages: first.body.totalPages,
      },
      { page: 1, pageSize: 2, total: 5, totalPages: 3 },
    );
    assert.ok(Array.isArray(first.body.items));
    assert.deepEqual(first.body.items.map((item: JsonObject) => {
      assertObject(item.user, 'user');
      return item.user.id;
    }), ['user-b', 'user-a']);
    for (const item of first.body.items as JsonObject[]) {
      exactKeys(item, ['user', 'personalSnapshot']);
      assertObject(item.user, 'user');
      assertObject(item.personalSnapshot, 'personalSnapshot');
      exactKeys(item.user, ['id', 'username']);
      exactKeys(item.personalSnapshot, [
        'exists',
        'revision',
        'formatVersion',
        'sessionCount',
        'logCount',
        'byteSize',
        'checksum',
        'createdAt',
        'updatedAt',
      ]);
      assert.equal(item.personalSnapshot.exists, true);
      assert.equal('snapshot' in item.personalSnapshot, false);
    }
    assert.equal(first.text.includes('private personal note'), false);
    assert.equal(first.text.includes('snapshot_json'), false);
    assert.equal(first.text.includes('NOT_EXPOSED'), false);
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) FROM admin_governance_audit_events').pluck().get()),
      auditBefore,
      'metadata listing must not create a per-snapshot sensitive read audit',
    );
  });

  test('lists every account first and exposes its unified session catalog', async () => {
    const token = accessToken('admin-root', 'admin');
    const accounts = await request('/api/v1/admin/session-accounts?pageSize=20', {
      token,
    });
    assert.equal(accounts.status, 200, accounts.text);
    assert.equal(accounts.body.total, 8);
    const rows = accounts.body.items as JsonObject[];
    const noSnapshot = rows.find((row) => {
      assertObject(row.user, 'user');
      return row.user.id === 'no-snapshot';
    });
    assert.ok(noSnapshot, 'zero-session accounts must remain visible');
    assert.equal(noSnapshot.totalSessionCount, 0);

    const accessId = `session-catalog-${randomUUID()}`;
    const userA = await request(
      '/api/v1/admin/session-accounts/user-a/sessions?pageSize=20',
      { token, headers: { 'x-admin-access-id': accessId } },
    );
    assert.equal(userA.status, 200, userA.text);
    assertObject(userA.body.catalog, 'catalog');
    assert.equal(userA.body.catalog.total, 3);
    assert.deepEqual(
      (userA.body.catalog.items as JsonObject[]).map((item) => [
        item.source,
        item.sessionId,
        item.role,
      ]),
      [
        ['personal', 'session-a-other', null],
        ['personal', 'session-a', null],
        ['collaboration', 'admin-catalog-shared', 'owner'],
      ],
    );

    const userB = await request(
      '/api/v1/admin/session-accounts/user-b/sessions?source=collaboration',
      { token, headers: { 'x-admin-access-id': `session-catalog-${randomUUID()}` } },
    );
    assert.equal(userB.status, 200, userB.text);
    assert.equal(userB.body.catalog.total, 1);
    assert.equal(userB.body.catalog.items[0].role, 'editor');

    const byId = await request('/api/v1/admin/session-accounts?q=user-a', { token });
    assert.equal(byId.status, 200, byId.text);
    assert.equal(byId.body.total, 1);
  });

  test('serves audited personal session details and paged logs', async () => {
    const token = accessToken('admin-root', 'admin');
    const accessId = `personal-session-${randomUUID()}`;
    const detail = await request(
      '/api/v1/admin/personal-snapshots/user-a/sessions/session-a',
      { token, headers: { 'x-admin-access-id': accessId } },
    );
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.session.source, 'personal');
    assert.deepEqual(detail.body.counts, { logs: 1, deletedLogs: 0 });

    const logs = await request(
      '/api/v1/admin/personal-snapshots/user-a/sessions/session-a/logs?q=BG5A&sort=updatedDesc',
      { token, headers: { 'x-admin-access-id': accessId } },
    );
    assert.equal(logs.status, 200, logs.text);
    assert.equal(logs.body.total, 1);
    assert.equal(logs.body.items[0].canMutate, false);
  });

  test('filters username by Unicode NFC identity and treats LIKE wildcards literally', async () => {
    const token = accessToken('admin-root', 'admin');
    const alpha = await request('/api/v1/admin/personal-snapshots?q=alpha', { token });
    assert.equal(alpha.status, 200, alpha.text);
    assert.equal(alpha.body.total, 1);
    assert.deepEqual((alpha.body.items as JsonObject[]).map((item) => {
      assertObject(item.user, 'user');
      return item.user.id;
    }), ['user-a']);

    const unicode = await request(
      `/api/v1/admin/personal-snapshots?q=${encodeURIComponent('e\u0301chouser')}`,
      { token },
    );
    assert.equal(unicode.status, 200, unicode.text);
    assert.equal(unicode.body.total, 1);
    assertObject((unicode.body.items as JsonObject[])[0].user, 'user');
    assert.equal((unicode.body.items as JsonObject[])[0].user.id, 'unicode-composed');

    for (const [query, expectedId] of [
      ['%25', 'literal-percent'],
      ['_', 'literal-underscore'],
    ] as const) {
      const result = await request(`/api/v1/admin/personal-snapshots?q=${query}`, { token });
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.total, 1);
      assertObject((result.body.items as JsonObject[])[0].user, 'user');
      assert.equal((result.body.items as JsonObject[])[0].user.id, expectedId);
    }
  });

  test('rejects unknown, repeated, and out-of-range list query parameters', async () => {
    const token = accessToken('admin-root', 'admin');
    for (const query of [
      'unknown=true',
      'page=0',
      'page=1000001',
      'pageSize=0',
      'pageSize=101',
      'q=a&q=b',
      `q=${'x'.repeat(65)}`,
    ]) {
      assertError(
        await request(`/api/v1/admin/personal-snapshots?${query}`, { token }),
        422,
        'VALIDATION_FAILED',
      );
    }
  });

  test('returns a fully validated snapshot and deduplicates its sensitive-read audit', async () => {
    const token = accessToken('admin-root', 'admin');
    const accessId = `personal-read-${randomUUID()}`;
    let latest: HttpResult | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      latest = await request('/api/v1/admin/personal-snapshots/user-a', {
        token,
        headers: { 'x-admin-access-id': accessId },
      });
      assert.equal(latest.status, 200, latest.text);
    }
    assert.ok(latest);
    exactKeys(latest.body, ['user', 'personalSnapshot']);
    assert.deepEqual(latest.body.user, { id: 'user-a', username: 'AlphaUser' });
    assertObject(latest.body.personalSnapshot, 'personalSnapshot');
    exactKeys(latest.body.personalSnapshot, [
      'exists',
      'revision',
      'formatVersion',
      'sessionCount',
      'logCount',
      'byteSize',
      'checksum',
      'createdAt',
      'updatedAt',
      'snapshot',
    ]);
    assert.deepEqual(latest.body.personalSnapshot.snapshot, snapshotFixture('a'));

    const audits = db.prepare(`
      SELECT action, actor_user_id, target_type, target_id, session_id,
             reason, before_json, after_json, details_json
      FROM admin_governance_audit_events
      WHERE action = 'personal_snapshot.detail.viewed' AND target_id = 'user-a'
    `).all() as Array<Record<string, unknown>>;
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0], {
      action: 'personal_snapshot.detail.viewed',
      actor_user_id: 'admin-root',
      target_type: 'user',
      target_id: 'user-a',
      session_id: null,
      reason: null,
      before_json: null,
      after_json: null,
      details_json: JSON.stringify({ accessId }),
    });
    assert.equal(JSON.stringify(audits).includes('BG5A'), false);
    assert.equal(JSON.stringify(audits).includes('private personal note'), false);

    const anotherAccessId = `personal-read-${randomUUID()}`;
    const another = await request('/api/v1/admin/personal-snapshots/user-a', {
      token,
      headers: { 'x-admin-access-id': anotherAccessId },
    });
    assert.equal(another.status, 200, another.text);
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM admin_governance_audit_events
      WHERE action = 'personal_snapshot.detail.viewed' AND target_id = 'user-a'
    `).pluck().get()), 2);
  });

  test('exports one audited Session as a client-compatible v7 database backup', async () => {
    const accessId = `personal-v7-export-${randomUUID()}`;
    assertError(
      await request('/api/v1/admin/personal-snapshots/user-a/database-backup-v7', {
        token: accessToken('admin-root', 'admin'),
      }),
      422,
      'PERSONAL_SNAPSHOT_SESSION_REQUIRED',
    );
    const result = await request(
      '/api/v1/admin/personal-snapshots/user-a/sessions/session-a/database-backup-v7',
      {
        token: accessToken('admin-root', 'admin'),
        headers: { 'x-admin-access-id': accessId },
      },
    );
    assert.equal(result.status, 200, result.text);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-openlogtool-backup-format-version'), '7');
    assert.equal(result.headers.get('x-personal-snapshot-revision'), '1');
    assert.equal(result.headers.get('x-personal-snapshot-session-id'), 'session-a');
    assert.match(
      result.headers.get('content-disposition') ?? '',
      /openlogtool-session-session-a-r1-v7\.json/,
    );
    exactKeys(result.body, [
      'version',
      'exportedAt',
      'logs',
      'sessions',
      'dictionary_items',
      'settings',
      'oplog',
      'collaboration_bindings',
      'entity_shadows',
      'sync_outbox',
      'applied_events',
      'sync_conflicts',
      'collaboration_live_drafts',
      'collaboration_offline_records',
    ]);
    assert.equal(result.body.version, 7);
    const accountSnapshot = snapshotFixture('a');
    assert.deepEqual(result.body.sessions, [accountSnapshot.sessions[0]]);
    assert.deepEqual(result.body.logs, [accountSnapshot.logs[0]]);
    assert.deepEqual(result.body.dictionary_items, []);
    for (const table of [
      'settings',
      'oplog',
      'collaboration_bindings',
      'entity_shadows',
      'sync_outbox',
      'applied_events',
      'sync_conflicts',
      'collaboration_live_drafts',
      'collaboration_offline_records',
    ]) {
      assert.deepEqual(result.body[table], [], `${table} must be empty`);
    }

    const audits = db.prepare(`
      SELECT action, actor_user_id, target_type, target_id, details_json
      FROM admin_governance_audit_events
      WHERE action = 'personal_snapshot.session_database_v7.exported'
        AND target_id = 'user-a'
    `).all() as Array<Record<string, unknown>>;
    assert.deepEqual(audits, [{
      action: 'personal_snapshot.session_database_v7.exported',
      actor_user_id: 'admin-root',
      target_type: 'user',
      target_id: 'user-a',
      details_json: JSON.stringify({
        accessId,
        personalSnapshotSessionId: 'session-a',
      }),
    }]);
    assert.equal(JSON.stringify(audits).includes('BG5A'), false);
    assert.equal(JSON.stringify(audits).includes('private personal note'), false);

    assertError(
      await request(
        '/api/v1/admin/personal-snapshots/user-a/sessions/missing-session/database-backup-v7',
        { token: accessToken('admin-root', 'admin') },
      ),
      404,
      'PERSONAL_SNAPSHOT_SESSION_NOT_FOUND',
    );
  });

  test('reports missing and corrupt snapshots without creating a read audit', async () => {
    const token = accessToken('admin-root', 'admin');
    assertError(
      await request('/api/v1/admin/personal-snapshots/no-snapshot', { token }),
      404,
      'PERSONAL_SNAPSHOT_NOT_FOUND',
    );
    assertError(
      await request('/api/v1/admin/personal-snapshots/missing-user', { token }),
      404,
      'PERSONAL_SNAPSHOT_NOT_FOUND',
    );

    const original = db.prepare(`
      SELECT snapshot_json, byte_size FROM personal_cloud_snapshots WHERE user_id = 'user-b'
    `).get() as { snapshot_json: string; byte_size: number };
    db.prepare(`
      UPDATE personal_cloud_snapshots SET byte_size = byte_size + 1 WHERE user_id = 'user-b'
    `).run();
    assertError(
      await request('/api/v1/admin/personal-snapshots/user-b', { token }),
      500,
      'PERSONAL_SNAPSHOT_CORRUPT',
    );
    db.prepare(`
      UPDATE personal_cloud_snapshots SET snapshot_json = ?, byte_size = ? WHERE user_id = 'user-b'
    `).run('{}', original.byte_size);
    assertError(
      await request('/api/v1/admin/personal-snapshots/user-b', { token }),
      500,
      'PERSONAL_SNAPSHOT_CORRUPT',
    );
    db.prepare(`
      UPDATE personal_cloud_snapshots SET snapshot_json = ? WHERE user_id = 'user-b'
    `).run(original.snapshot_json);

    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM admin_governance_audit_events
      WHERE action = 'personal_snapshot.detail.viewed' AND target_id = 'user-b'
    `).pluck().get()), 0);
  });

  test('validates X-Admin-Access-Id before exposing snapshot content', async () => {
    assertError(
      await request('/api/v1/admin/personal-snapshots/user-a', {
        token: accessToken('admin-root', 'admin'),
        headers: { 'x-admin-access-id': 'contains spaces' },
      }),
      422,
      'VALIDATION_FAILED',
    );
  });
});
