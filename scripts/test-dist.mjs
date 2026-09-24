import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const databaseModuleUrl = pathToFileURL(join(projectRoot, 'dist', 'db', 'database.js')).href;
const appModuleUrl = pathToFileURL(join(projectRoot, 'dist', 'app.js')).href;
const wsModuleUrl = pathToFileURL(join(projectRoot, 'dist', 'ws', 'index.js')).href;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'openlogtool-dist-'));
const databasePath = join(temporaryDirectory, 'production.db');

let db;
let server;
let wsController;

function moduleExports(namespace) {
  const defaultExport = namespace.default;
  return {
    ...(defaultExport && typeof defaultExport === 'object' ? defaultExport : {}),
    ...namespace,
  };
}

function quoteIdentifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/);
  return `"${value}"`;
}

function tableNames(database) {
  return new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row.name)),
  );
}

function columnNames(database, table) {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => String(row.name)),
  );
}

function requireColumns(database, table, expected) {
  const actual = columnNames(database, table);
  for (const column of expected) {
    assert.ok(actual.has(column), `${table}.${column} is missing; found: ${[...actual].join(', ')}`);
  }
}

function requireTriggers(database, expected) {
  const actual = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => String(row.name)),
  );
  for (const trigger of expected) {
    assert.ok(actual.has(trigger), `production schema is missing trigger: ${trigger}`);
  }
}

function hasUniqueIndex(database, table, expectedColumns) {
  const indexes = database.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all();
  return indexes.some((index) => {
    if (Number(index.unique) !== 1) return false;
    const columns = database
      .prepare(`PRAGMA index_info(${quoteIdentifier(String(index.name))})`)
      .all()
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((row) => String(row.name));
    return (
      columns.length === expectedColumns.length &&
      columns.every((column, position) => column === expectedColumns[position])
    );
  });
}

try {
  const databaseModule = moduleExports(await import(databaseModuleUrl));
  assert.equal(
    typeof databaseModule.openDatabase,
    'function',
    'dist/db/database.js must export openDatabase(path)',
  );
  assert.equal(
    typeof databaseModule.runMigrations,
    'function',
    'dist/db/database.js must export runMigrations(db)',
  );

  db = await databaseModule.openDatabase(databasePath);
  await databaseModule.runMigrations(db);

  const tables = tableNames(db);
  for (const table of [
    'schema_migrations',
    'users',
    'server_settings',
    'sessions',
    'logs',
    'shares',
    'refresh_tokens',
    'session_members',
    'collaboration_invites',
    'invite_redemptions',
    'processed_mutations',
    'session_events',
    'ws_tickets',
    'admin_audit_events',
    'collaboration_audit_events',
    'public_shares',
    'public_ws_tickets',
    'public_share_view_totals',
    'public_share_view_sessions',
    'session_live_drafts',
    'live_draft_device_state',
    'admin_governance_audit_events',
    'server_config_overrides',
    'public_archive_lists',
    'public_archive_list_members',
    'public_archive_list_sources',
    'public_archive_list_sessions',
    'public_archive_list_logs',
    'public_archive_aliases',
    'account_excel_export_settings',
    'llm_excel_correction_previews',
    'server_llm_credentials',
  ]) {
    assert.ok(tables.has(table), `production dist migration did not create table: ${table}`);
  }

  requireColumns(db, 'schema_migrations', ['version', 'name', 'checksum', 'applied_at']);
  requireColumns(db, 'server_settings', [
    'instance_id',
    'registration_enabled',
    'invite_hmac_fingerprint',
    'public_share_hmac_fingerprint',
  ]);
  requireColumns(db, 'users', [
    'id',
    'username',
    'role',
    'disabled_at',
    'deleted_at',
    'must_change_password',
    'login_never_expires',
    'auth_version',
    'password_changed_at',
    'username_changed_at',
  ]);
  requireColumns(db, 'sessions', [
    'id',
    'status',
    'owner_user_id',
    'version',
    'event_seq',
    'created_at',
    'updated_at',
    'deleted_at',
  ]);
  requireColumns(db, 'logs', [
    'sync_id',
    'session_id',
    'rst_sent',
    'rst_rcvd',
    'remarks',
    'version',
    'created_by',
    'updated_by',
    'created_at',
    'updated_at',
    'deleted_at',
  ]);
  requireColumns(db, 'refresh_tokens', [
    'id',
    'user_id',
    'token_hash',
    'created_at',
    'expires_at',
    'revoked_at',
    'auth_session_id',
    'issued_auth_version',
  ]);
  requireColumns(db, 'session_members', [
    'id',
    'session_id',
    'user_id',
    'role',
    'version',
    'removed_at',
  ]);
  requireColumns(db, 'collaboration_invites', [
    'id',
    'session_id',
    'code_hash',
    'role',
    'max_uses',
    'used_count',
    'expires_at',
    'revoked_at',
  ]);
  requireColumns(db, 'invite_redemptions', [
    'join_request_id',
    'device_id',
    'request_hash',
    'response_json',
  ]);
  requireColumns(db, 'session_events', [
    'id',
    'session_id',
    'seq',
    'type',
    'entity_type',
    'entity_id',
    'entity_version',
    'mutation_id',
    'payload_json',
  ]);
  requireColumns(db, 'ws_tickets', [
    'id',
    'token_hash',
    'session_id',
    'user_id',
    'device_id',
    'after_seq',
    'expires_at',
    'consumed_at',
    'auth_session_id',
    'access_expires_at',
  ]);
  requireTriggers(db, [
    'trg_refresh_tokens_auth_session_insert',
    'trg_refresh_tokens_auth_session_immutable',
    'trg_refresh_tokens_issued_auth_version_insert',
    'trg_refresh_tokens_issued_auth_version_immutable',
    'trg_ws_tickets_auth_session_insert',
    'trg_ws_tickets_auth_session_immutable',
    'trg_ws_tickets_legacy_expiry_insert',
    'trg_ws_tickets_legacy_expiry_immutable',
  ]);
  requireColumns(db, 'admin_audit_events', [
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
  requireColumns(db, 'collaboration_audit_events', [
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
  requireColumns(db, 'public_shares', [
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
  requireColumns(db, 'public_ws_tickets', [
    'id',
    'token_hash',
    'public_share_id',
    'access_token_id',
    'after_seq',
    'issued_ip',
    'created_at',
    'expires_at',
    'authorization_expires_at',
    'consumed_at',
    'view_session_hash',
  ]);
  requireColumns(db, 'public_share_view_totals', [
    'public_share_id',
    'total_opens',
    'first_opened_at',
    'last_opened_at',
    'last_accessed_at',
    'count_saturated_at',
  ]);
  requireColumns(db, 'public_share_view_sessions', [
    'public_share_id',
    'view_session_hash',
    'first_seen_at',
    'last_seen_at',
    'last_ip_address',
  ]);
  requireColumns(db, 'personal_cloud_snapshots', [
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
  requireColumns(db, 'personal_dictionary_snapshots', [
    'user_id',
    'revision',
    'format_version',
    'snapshot_json',
    'item_count',
    'active_count',
    'deleted_count',
    'byte_size',
    'checksum',
    'created_at',
    'updated_at',
  ]);
  requireColumns(db, 'session_live_drafts', [
    'session_id',
    'draft_id',
    'version',
    'time',
    'controller',
    'callsign',
    'rst_sent',
    'rst_rcvd',
    'qth',
    'device',
    'power',
    'antenna',
    'height',
    'remarks',
    'field_revisions_json',
    'last_updated_by',
    'created_at',
    'last_updated_at',
  ]);
  requireColumns(db, 'live_draft_device_state', [
    'session_id',
    'user_id',
    'device_id',
    'last_client_seq',
    'request_hash',
    'response_json',
    'updated_at',
  ]);
  requireColumns(db, 'public_archive_aliases', ['display_alias']);
  requireColumns(db, 'account_excel_export_settings', [
    'user_id',
    'format_version',
    'settings_json',
    'created_at',
    'updated_at',
  ]);
  requireColumns(db, 'llm_excel_correction_previews', [
    'id',
    'session_id',
    'created_by',
    'provider',
    'model',
    'preview_json',
    'created_at',
    'expires_at',
    'applied_at',
  ]);
  requireColumns(db, 'server_llm_credentials', [
    'id',
    'encrypted_api_key',
    'key_fingerprint',
    'updated_by',
    'created_at',
    'updated_at',
  ]);

  assert.ok(
    hasUniqueIndex(db, 'logs', ['session_id', 'sync_id']),
    'production schema requires UNIQUE(session_id, sync_id)',
  );
  assert.ok(
    Number(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count) > 0,
    'production migrations must record at least one applied migration',
  );
  assert.equal(
    Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version),
    28,
    'production dist must include the latest migration',
  );
  assert.deepEqual(
    db.prepare('SELECT version, name FROM schema_migrations WHERE version = 24').get(),
    { version: 24, name: 'public_share_visitor_ip' },
    'production dist must include the public share visitor IP migration',
  );
  assert.deepEqual(
    db.prepare('SELECT version, name FROM schema_migrations WHERE version = 25').get(),
    { version: 25, name: 'public_archive_lists' },
    'production dist must include the public archive lists migration',
  );
  assert.deepEqual(
    db.prepare('SELECT version, name FROM schema_migrations WHERE version = 26').get(),
    { version: 26, name: 'public_archive_alias_display_case' },
    'production dist must include the archive alias display migration',
  );
  assert.deepEqual(
    db.prepare('SELECT version, name FROM schema_migrations WHERE version = 27').get(),
    { version: 27, name: 'account_excel_export_settings' },
    'production dist must include the account Excel export settings migration',
  );
  assert.deepEqual(
    db.prepare('SELECT version, name FROM schema_migrations WHERE version = 28').get(),
    { version: 28, name: 'llm_excel_correction_previews' },
    'production dist must include the LLM Excel correction migration',
  );
  assert.deepEqual(
    db.prepare('SELECT version, name FROM schema_migrations WHERE version = 29').get(),
    { version: 29, name: 'account_session_sharing' },
    'production dist must include the account session sharing migration',
  );
  assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
  assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');

  const appModule = moduleExports(await import(appModuleUrl));
  assert.equal(typeof appModule.createApp, 'function', 'dist/app.js must export createApp(options)');
  const runtimeConfig = {
    port: 0,
    dbPath: databasePath,
    jwtSecret: 'dist-smoke-jwt-secret-that-is-at-least-32-bytes',
    jwtIssuer: 'openlogtool-dist-smoke',
    bootstrapSecret: 'dist-smoke-bootstrap-secret',
    inviteHmacKey: 'dist-smoke-invite-hmac-key-at-least-32-bytes',
    publicShareHmacKey: 'dist-smoke-public-share-hmac-key-at-least-32-bytes',
    accessTokenTtlSeconds: 300,
    refreshTokenTtlSeconds: 3_600,
    corsOrigins: [],
    trustProxy: false,
    jsonBodyLimit: '1mb',
    rateLimitEnabled: false,
    environment: 'test',
  };
  const app = appModule.createApp({ db, config: runtimeConfig });
  server = createServer(app);
  const wsModule = moduleExports(await import(wsModuleUrl));
  assert.equal(
    typeof wsModule.createCollaborationWsServer,
    'function',
    'dist/ws/index.js must export createCollaborationWsServer(server, options)',
  );
  wsController = wsModule.createCollaborationWsServer(server, { db, config: runtimeConfig });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/server-info`);
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.serverInstanceId, db.prepare('SELECT instance_id FROM server_settings WHERE id = 1').get().instance_id);
  for (const feature of [
    'collaboration',
    'webCookieAuth',
    'accountManagement',
    'requiredPasswordChange',
    'memberCatalogPagination',
    'logAuthorship',
    'administratorGovernance',
    'operationalSettings',
    'databaseBackup',
    'serverAdministration',
    'collaborationSecurityAudit',
    'sessionMutations',
    'sessionEvents',
    'collaborationWebSocket',
    'publicLiveshare',
    'collaborationOperationalMetrics',
    'sessionEventRetention',
    'collaborationLiveDraft',
  ]) {
    assert.ok(info.features.includes(feature), `server-info is missing ${feature}`);
  }

  console.log('dist database and HTTP smoke test passed');
} finally {
  wsController?.close();
  if (server?.listening) {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
  db?.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
