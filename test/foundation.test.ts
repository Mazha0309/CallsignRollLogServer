import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';

/**
 * Foundation contract for collaboration v1.
 *
 * The production implementation is expected to expose:
 *   - src/db/database.ts: openDatabase(path), runMigrations(db)
 *   - src/app.ts: createApp({ db, config })
 *
 * Tests intentionally use dynamic imports so the migration runner and app
 * factory can be introduced independently without importing src/index.ts
 * (which owns the production listener lifecycle).
 */

type Row = Record<string, unknown>;

interface Statement {
  all(...params: unknown[]): Row[];
  get(...params: unknown[]): Row | undefined;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): unknown;
  pragma(source: string, options?: unknown): unknown;
  prepare(sql: string): Statement;
}

interface DatabaseModule {
  openDatabase(path: string): SqliteDatabase | Promise<SqliteDatabase>;
  runMigrations(db: SqliteDatabase): unknown | Promise<unknown>;
}

interface AppConfig {
  jwtSecret: string;
  bootstrapSecret: string;
  publicShareHmacKey: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  registrationEnabled: boolean;
  rateLimitEnabled: boolean;
  environment: 'test';
}

interface AppModule {
  createApp(options: {
    db: SqliteDatabase;
    config: AppConfig;
  }): RequestListener | { app: RequestListener } | Promise<RequestListener | { app: RequestListener }>;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
  requestId: string;
}

const testConfig: AppConfig = {
  jwtSecret: 'foundation-test-jwt-secret-4e222f0d-20e8-44e5-b83b-d41c08da2f5e',
  bootstrapSecret: 'foundation-test-bootstrap-secret-5fcc686c-1975-4448-bf4e-953f9aa95ef2',
  publicShareHmacKey: 'foundation-test-public-share-key-10a10ef7-2707-42d3-9574',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  registrationEnabled: true,
  rateLimitEnabled: false,
  environment: 'test',
};

function moduleExports<T extends object>(namespace: Record<string, unknown>): T {
  const defaultExport = namespace.default;
  return {
    ...(defaultExport && typeof defaultExport === 'object' ? defaultExport : {}),
    ...namespace,
  } as T;
}

async function loadDatabaseModule(): Promise<DatabaseModule> {
  const url = pathToFileURL(resolve('src/db/database.ts')).href;
  const loaded = moduleExports<DatabaseModule>(await import(url));
  assert.equal(
    typeof loaded.openDatabase,
    'function',
    'src/db/database.ts must export openDatabase(path)',
  );
  assert.equal(
    typeof loaded.runMigrations,
    'function',
    'src/db/database.ts must export runMigrations(db)',
  );
  return loaded;
}

async function loadAppModule(): Promise<AppModule> {
  const url = pathToFileURL(resolve('src/app.ts')).href;
  const loaded = moduleExports<AppModule>(await import(url));
  assert.equal(
    typeof loaded.createApp,
    'function',
    'src/app.ts must export createApp({ db, config }) without starting a listener',
  );
  return loaded;
}

function quoteIdentifier(value: string): string {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/);
  return `"${value}"`;
}

function tableNames(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  return new Set(rows.map((row) => String(row.name)));
}

function columnNames(db: SqliteDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

function assertColumns(db: SqliteDatabase, table: string, expected: string[]): void {
  const actual = columnNames(db, table);
  for (const column of expected) {
    assert.ok(actual.has(column), `${table}.${column} is required; found: ${[...actual].join(', ')}`);
  }
}

function hasUniqueIndex(db: SqliteDatabase, table: string, columns: string[]): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all();
  for (const index of indexes) {
    if (Number(index.unique) !== 1) continue;
    const name = String(index.name);
    const indexedColumns = db
      .prepare(`PRAGMA index_info(${quoteIdentifier(name)})`)
      .all()
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((row) => String(row.name));
    if (
      indexedColumns.length === columns.length &&
      indexedColumns.every((column, indexPosition) => column === columns[indexPosition])
    ) {
      return true;
    }
  }
  return false;
}

function assertFoundationSchema(db: SqliteDatabase): void {
  const tables = tableNames(db);
  for (const table of [
    'schema_migrations',
    'users',
    'server_settings',
    'sessions',
    'logs',
    'shares',
    'refresh_tokens',
    'admin_audit_events',
    'collaboration_audit_events',
    'public_shares',
    'public_ws_tickets',
    'personal_cloud_snapshots',
    'account_excel_export_settings',
    'llm_excel_correction_previews',
    'server_llm_credentials',
  ]) {
    assert.ok(tables.has(table), `missing required table: ${table}`);
  }

  assertColumns(db, 'schema_migrations', ['version', 'name', 'checksum', 'applied_at']);
  assertColumns(db, 'server_settings', [
    'instance_id',
    'registration_enabled',
    'invite_hmac_fingerprint',
    'public_share_hmac_fingerprint',
  ]);
  assertColumns(db, 'users', [
    'id',
    'username',
    'password_hash',
    'role',
    'login_never_expires',
    'created_at',
    'updated_at',
  ]);
  assertColumns(db, 'sessions', [
    'id',
    'title',
    'status',
    'owner_user_id',
    'version',
    'event_seq',
    'created_at',
    'updated_at',
    'deleted_at',
  ]);
  assertColumns(db, 'logs', [
    'id',
    'sync_id',
    'session_id',
    'controller',
    'callsign',
    'time',
    'rst_sent',
    'rst_rcvd',
    'qth',
    'device',
    'power',
    'antenna',
    'height',
    'remarks',
    'version',
    'created_at',
    'updated_at',
    'deleted_at',
  ]);
  assertColumns(db, 'refresh_tokens', [
    'id',
    'user_id',
    'token_hash',
    'created_at',
    'expires_at',
    'revoked_at',
  ]);
  assertColumns(db, 'admin_audit_events', [
    'id',
    'action',
    'actor_user_id',
    'target_user_id',
    'request_id',
    'mutation_id',
    'before_json',
    'after_json',
    'details_json',
    'occurred_at',
  ]);
  assertColumns(db, 'collaboration_audit_events', [
    'id',
    'session_id',
    'action',
    'actor_user_id',
    'target_user_id',
    'request_id',
    'mutation_id',
    'before_json',
    'after_json',
    'details_json',
    'occurred_at',
  ]);
  assertColumns(db, 'public_shares', [
    'id',
    'session_id',
    'credential_version',
    'secret_hash',
    'created_by',
    'created_at',
    'expires_at',
    'revoked_at',
    'revoked_by',
  ]);
  assertColumns(db, 'public_ws_tickets', [
    'id',
    'token_hash',
    'public_share_id',
    'access_token_id',
    'after_seq',
    'created_at',
    'expires_at',
    'authorization_expires_at',
    'consumed_at',
  ]);
  assertColumns(db, 'personal_cloud_snapshots', [
    'user_id',
    'revision',
    'format_version',
    'snapshot_json',
    'session_count',
    'log_count',
    'byte_size',
    'checksum',
    'created_at',
    'updated_at',
  ]);
  assert.ok(
    hasUniqueIndex(db, 'logs', ['session_id', 'sync_id']),
    'logs must have a UNIQUE(session_id, sync_id) index',
  );
}

async function withTemporaryDatabase(
  run: (db: SqliteDatabase, directory: string, module: DatabaseModule) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-foundation-'));
  const databaseModule = await loadDatabaseModule();
  let db: SqliteDatabase | undefined;
  try {
    db = await databaseModule.openDatabase(join(directory, 'test.db'));
    await run(db, directory, databaseModule);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('migration runner creates the foundation schema and is idempotent', async () => {
  await withTemporaryDatabase(async (db, _directory, databaseModule) => {
    await databaseModule.runMigrations(db);
    assertFoundationSchema(db);

    const firstCount = Number(
      db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count,
    );
    assert.ok(firstCount > 0, 'at least one numbered migration must be recorded');

    await databaseModule.runMigrations(db);
    const secondCount = Number(
      db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()?.count,
    );
    assert.equal(secondCount, firstCount, 'rerunning migrations must not add duplicate records');

    assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
    assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
  });
});

test('migration runner rejects a changed checksum', async () => {
  await withTemporaryDatabase(async (db, _directory, databaseModule) => {
    const applied = db
      .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version LIMIT 1')
      .get();
    assert.ok(applied, 'an applied migration is required for the checksum test');
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(
      'tampered-checksum',
      applied.version,
    );

    await assert.rejects(
      Promise.resolve().then(() => databaseModule.runMigrations(db)),
      /checksum|changed|modified/i,
    );
  });
});

test('legacy duplicate logs migrate without data loss and receive unique sync ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-legacy-'));
  const databasePath = join(directory, 'legacy.db');
  let migrated: SqliteDatabase | undefined;
  try {
    const legacy = new Database(databasePath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE server_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        registration_enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        controller TEXT NOT NULL,
        callsign TEXT NOT NULL,
        time TEXT NOT NULL,
        rst_sent TEXT,
        rst_rcvd TEXT,
        qth TEXT,
        device TEXT,
        power TEXT,
        antenna TEXT,
        height TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE shares (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        code TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
    `);

    const now = '2026-07-11T08:00:00.000Z';
    legacy.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('legacy-user', 'legacy', 'hash', 'user', now, now);
    legacy.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('legacy-admin', 'legacy-admin', 'hash', 'admin', now, now);
    legacy.prepare(
      'INSERT INTO sessions (id, title, status, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('legacy-session', 'Legacy session', 'active', 'legacy-user', now, now);
    const insert = legacy.prepare(`
      INSERT INTO logs (
        sync_id, session_id, controller, callsign, time, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('duplicate-sync-id', 'legacy-session', 'BG5AAA', 'BA4AAA', now, now, now);
    insert.run('duplicate-sync-id', 'legacy-session', 'BG5AAA', 'BA4AAB', now, now, now);
    insert.run('duplicate-sync-id', 'legacy-session', 'BG5AAA', 'BA4AAA', now, now, now);
    legacy.close();

    const databaseModule = await loadDatabaseModule();
    migrated = await databaseModule.openDatabase(databasePath);
    assertFoundationSchema(migrated);

    const counts = migrated
      .prepare(
        'SELECT COUNT(*) AS total, COUNT(DISTINCT sync_id) AS distinct_ids FROM logs WHERE session_id = ?',
      )
      .get('legacy-session');
    assert.equal(Number(counts?.total), 2, 'migration must preserve both legacy rows');
    assert.equal(Number(counts?.distinct_ids), 2, 'conflicting duplicate rows need distinct sync ids');
    assert.equal(
      migrated.prepare(
        "SELECT login_never_expires FROM users WHERE id = 'legacy-user'",
      ).pluck().get(),
      0,
      'existing accounts must default to normal login expiration',
    );

    const audit = migrated
      .prepare('SELECT action, COUNT(*) AS count FROM migration_audit GROUP BY action')
      .all();
    const auditCounts = new Map(audit.map((row) => [String(row.action), Number(row.count)]));
    assert.equal(auditCounts.get('merge_identical_duplicate_log'), 1);
    assert.equal(auditCounts.get('reassign_duplicate_log_sync_id'), 1);
  } finally {
    migrated?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function assertRecord(value: unknown, label: string): asserts value is Row {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function assertErrorEnvelope(result: HttpResult, expectedStatus: number, expectedCode?: string): Row {
  assert.equal(result.status, expectedStatus, result.text);
  assertRecord(result.body, 'error response');
  assertRecord(result.body.error, 'error response.error');
  const error = result.body.error;
  assert.equal(typeof error.code, 'string');
  assert.match(String(error.code), /^[A-Z][A-Z0-9_]+$/);
  if (expectedCode) assert.equal(error.code, expectedCode);
  assert.equal(typeof error.message, 'string');
  assert.ok(String(error.message).length > 0);
  assert.equal(error.requestId, result.requestId, 'request id must be echoed in the error envelope');
  assert.equal(result.headers.get('x-request-id'), result.requestId);
  return error;
}

function decodeJwtPayload(token: string): Row {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'access token must be a JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Row;
}

function assertAuthResponse(body: unknown, expectedRole: 'admin' | 'user'): {
  accessToken: string;
  refreshToken: string;
  user: Row;
} {
  assertRecord(body, 'auth response');
  assert.equal(typeof body.accessToken, 'string');
  assert.equal(typeof body.refreshToken, 'string');
  assert.ok(String(body.refreshToken).length >= 32);
  assertRecord(body.user, 'auth response.user');
  assert.equal(body.user.role, expectedRole);

  const jwt = decodeJwtPayload(String(body.accessToken));
  assert.equal(typeof jwt.iat, 'number');
  assert.equal(typeof jwt.exp, 'number');
  assert.ok(Number(jwt.exp) > Number(jwt.iat), 'access token must expire');

  return {
    accessToken: String(body.accessToken),
    refreshToken: String(body.refreshToken),
    user: body.user,
  };
}

describe('v1 HTTP foundation', { concurrency: false }, () => {
  let directory: string;
  let db: SqliteDatabase;
  let server: Server;
  let baseUrl: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-api-'));
    const databaseModule = await loadDatabaseModule();
    db = await databaseModule.openDatabase(join(directory, 'api.db'));
    await databaseModule.runMigrations(db);

    const appModule = await loadAppModule();
    const created = await appModule.createApp({ db, config: testConfig });
    const app =
      typeof created === 'function'
        ? created
        : created && typeof created === 'object' && 'app' in created
          ? created.app
          : undefined;
    assert.equal(typeof app, 'function', 'createApp must return an Express app or { app }');

    server = createServer(app);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
      requestId?: string;
    } = {},
  ): Promise<HttpResult> {
    const requestId = options.requestId ?? randomUUID();
    const hasBody = options.body !== undefined || options.rawBody !== undefined;
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': requestId,
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      body:
        options.rawBody !== undefined
          ? options.rawBody
          : options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, headers: response.headers, body, text, requestId };
  }

  test('server-info advertises a stable protocol-1 server identity', async () => {
    const first = await request('/api/v1/server-info');
    assert.equal(first.status, 200, first.text);
    assertRecord(first.body, 'server-info');
    assert.match(String(first.body.serverInstanceId), /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    assert.equal(first.body.serverVersion, '0.12.0');
    assert.equal(first.body.protocolMin, 1);
    assert.equal(first.body.protocolMax, 1);
    assert.ok(Array.isArray(first.body.features));
    assert.ok(first.body.features.every((feature) => typeof feature === 'string'));
    assert.equal(
      first.body.features.includes('collaboration'),
      true,
      'server-info must advertise collaboration once the Stage 2 server protocol is complete',
    );
    assert.equal(
      first.body.features.includes('collaborationSharedLogEditing'),
      true,
      'server-info must advertise shared editing for collaboration Logs',
    );
    assert.equal(
      first.body.features.includes('personalCloudSnapshots'),
      true,
      'server-info must advertise account-scoped personal cloud snapshots',
    );
    assert.equal(
      first.body.features.includes('sessionSnapshotTombstones'),
      true,
      'server-info must advertise tombstone snapshots for cursor recovery',
    );
    assert.equal(
      first.body.features.includes('sessionDeletion'),
      true,
      'server-info must advertise the terminal Session deletion mutation',
    );
    assert.equal(
      first.body.features.includes('serverAdministration'),
      true,
      'server-info must advertise the v1 server administration control plane',
    );
    assert.equal(
      first.body.features.includes('serverAdministrationAudit'),
      true,
      'server-info must advertise runtime administrator audit support',
    );
    assert.equal(
      first.body.features.includes('collaborationSecurityAudit'),
      true,
      'server-info must advertise collaboration security audit support',
    );
    assert.equal(
      first.body.features.includes('publicLiveshare'),
      true,
      'server-info must advertise public Liveshare support when its key is configured',
    );
    assert.equal(
      first.body.features.includes('publicLivesharePage'),
      true,
      'server-info must advertise the public Liveshare page when its key is configured',
    );
    assert.ok(Number.isFinite(Date.parse(String(first.body.serverTime))));

    const second = await request('/api/v1/server-info');
    assert.equal(second.status, 200, second.text);
    assertRecord(second.body, 'server-info');
    assert.equal(second.body.serverInstanceId, first.body.serverInstanceId);
  });

  test('legacy authentication, administration and collaboration routes are not exposed', async () => {
    for (const path of [
      '/api/auth/login',
      '/api/admin/settings',
      '/api/sessions',
      '/api/sessions/session-1/logs',
      '/api/shares',
      '/api/shares/join',
    ]) {
      const response = await request(path);
      assertErrorEnvelope(response, 404, 'NOT_FOUND');
    }
  });

  test('bootstrap, register, login, refresh rotation and logout form one auth lifecycle', async () => {
    const invalidBootstrap = await request('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'x-bootstrap-secret': 'incorrect-secret' },
      body: { username: 'foundation-admin', password: 'Admin-password-123!' },
    });
    assertErrorEnvelope(invalidBootstrap, 403, 'BOOTSTRAP_FORBIDDEN');

    const bootstrap = await request('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'x-bootstrap-secret': testConfig.bootstrapSecret },
      body: { username: 'foundation-admin', password: 'Admin-password-123!' },
    });
    assert.equal(bootstrap.status, 201, bootstrap.text);
    const adminAuth = assertAuthResponse(bootstrap.body, 'admin');
    assert.equal(adminAuth.user.username, 'foundation-admin');

    const repeatedBootstrap = await request('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'x-bootstrap-secret': testConfig.bootstrapSecret },
      body: { username: 'another-admin', password: 'Admin-password-456!' },
    });
    assertErrorEnvelope(repeatedBootstrap, 409, 'BOOTSTRAP_ALREADY_COMPLETED');

    const register = await request('/api/v1/auth/register', {
      method: 'POST',
      body: { username: 'foundation-user', password: 'User-password-123!' },
    });
    assert.equal(register.status, 201, register.text);
    const registered = assertAuthResponse(register.body, 'user');
    assert.equal(registered.user.username, 'foundation-user');

    const duplicate = await request('/api/v1/auth/register', {
      method: 'POST',
      body: { username: 'foundation-user', password: 'Different-password-123!' },
    });
    assertErrorEnvelope(duplicate, 409, 'USERNAME_TAKEN');

    const invalidLogin = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'foundation-user', password: 'wrong-password' },
    });
    assertErrorEnvelope(invalidLogin, 401, 'INVALID_CREDENTIALS');

    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'foundation-user', password: 'User-password-123!' },
    });
    assert.equal(login.status, 200, login.text);
    const loggedIn = assertAuthResponse(login.body, 'user');

    const me = await request('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${loggedIn.accessToken}` },
    });
    assert.equal(me.status, 200, me.text);
    assertRecord(me.body, 'me response');
    assert.equal(me.body.id, registered.user.id);
    assert.equal(me.body.username, 'foundation-user');
    assert.equal(me.body.role, 'user');
    assert.equal('passwordHash' in me.body || 'password_hash' in me.body, false);

    const refresh = await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: loggedIn.refreshToken },
    });
    assert.equal(refresh.status, 200, refresh.text);
    const rotated = assertAuthResponse(refresh.body, 'user');
    assert.notEqual(rotated.refreshToken, loggedIn.refreshToken, 'refresh token must rotate');

    const oldHash = createHash('sha256').update(loggedIn.refreshToken).digest('hex');
    const newHash = createHash('sha256').update(rotated.refreshToken).digest('hex');
    const rotation = db.prepare(`
      SELECT old.replaced_by_id AS replacement_id, replacement.id AS actual_replacement_id
      FROM refresh_tokens old
      JOIN refresh_tokens replacement ON replacement.token_hash = ?
      WHERE old.token_hash = ?
    `).get(newHash, oldHash);
    assert.equal(rotation?.replacement_id, rotation?.actual_replacement_id);

    const replayOldRefresh = await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: loggedIn.refreshToken },
    });
    assertErrorEnvelope(replayOldRefresh, 409, 'REFRESH_TOKEN_ROTATED');
    const replacementAfterReplay = db
      .prepare('SELECT revoked_at FROM refresh_tokens WHERE token_hash = ?')
      .get(newHash);
    assert.equal(
      replacementAfterReplay?.revoked_at,
      null,
      'a near-simultaneous refresh retry must not revoke the active token family',
    );

    const logout = await request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${rotated.accessToken}` },
      body: { refreshToken: rotated.refreshToken },
    });
    assert.equal(logout.status, 204, logout.text);
    assert.equal(logout.text, '');

    const refreshAfterLogout = await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: rotated.refreshToken },
    });
    assertErrorEnvelope(refreshAfterLogout, 401, 'REFRESH_TOKEN_INVALID');
  });

  test('malformed JSON, validation failures and unknown routes use the same error envelope', async () => {
    const malformed = await request('/api/v1/auth/login', {
      method: 'POST',
      rawBody: '{',
    });
    assertErrorEnvelope(malformed, 400, 'INVALID_JSON');

    const validation = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: '' },
    });
    assertErrorEnvelope(validation, 422, 'VALIDATION_FAILED');

    const missing = await request('/api/v1/definitely-missing');
    assertErrorEnvelope(missing, 404, 'NOT_FOUND');
  });
});
