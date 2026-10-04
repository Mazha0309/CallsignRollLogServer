import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../src/db/database';

const NOW = '2026-07-12T08:00:00.000Z';

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

interface AdminAuditRow {
  id: string;
  action: string;
  actor_user_id: string;
  target_user_id: string | null;
  request_id: string;
  mutation_id: string;
  before_json: string | null;
  after_json: string | null;
  details_json: string;
  occurred_at: string;
}

const V11_MIGRATION_PREFIX: readonly MigrationRow[] = [
  {
    version: 1,
    name: 'initial_schema',
    checksum: 'de6a32dd40a135ce99719755c6229919ecf43e2ff3a6d7d4709fc2fade24bce5',
  },
  {
    version: 2,
    name: 'operational_metadata_and_refresh_tokens',
    checksum: '2eb4521ad11f2263797665935220c8c21153796c2b94efbb6bfbcad36fec9a6d',
  },
  {
    version: 3,
    name: 'collaboration_foundation',
    checksum: 'a0bda09bf648d25d7dd6094d8f3681c11d6112f2c796b0458c78607a028bb3de',
  },
  {
    version: 4,
    name: 'collaboration_access_and_idempotency',
    checksum: 'aec0ad1f539d06966bbc155b52133e3fb52ff0602266fde3bdc1b3b516404206',
  },
  {
    version: 5,
    name: 'bind_invite_hmac_instance_key',
    checksum: '922e60bd4ee5c16e9b865b01c209ce44d3b36307a9b936c99a9ed469f0fd27d3',
  },
  {
    version: 6,
    name: 'disable_legacy_collaboration_channels',
    checksum: 'af6c36d1af192c8ca8e6d20a99674ae85a7f4463204def199f15ede5e870f504',
  },
  {
    version: 7,
    name: 'stable_invite_redemption_replays',
    checksum: '1dc6d85a63624faf1d5c821ef9f75735e3809466e56f5f817dc363bbf9ff9417',
  },
  {
    version: 8,
    name: 'collaboration_realtime_events',
    checksum: '61c72d6704d2402b0e2eb7b93cfb1dc5029b1fe6cce1d8dacac26164f3e9cf66',
  },
  {
    version: 9,
    name: 'runtime_admin_audit',
    checksum: 'f6c1ca982b7b70a28a259b18ddd4f67a3a01e18c6d10550f557b12618b076c39',
  },
  {
    version: 10,
    name: 'collaboration_security_audit',
    checksum: 'e60f784185d4ed7afa489791a1f79b39050731e298a6a46c9b23f6e452b2cea0',
  },
  {
    version: 11,
    name: 'public_liveshare_capabilities',
    checksum: 'f7d79ed7549d26ae039a9b122bff2f106aa936ba7e3e121e457838569d2bd243',
  },
];

const V11_ADMIN_AUDIT_SQL = `
CREATE TABLE admin_audit_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN (
    'settings.registration.updated',
    'user.role.updated',
    'user.refresh_tokens.revoked'
  )),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL UNIQUE CHECK (length(mutation_id) BETWEEN 1 AND 128),
  before_json TEXT CHECK (
    before_json IS NULL OR
    (json_valid(before_json) AND json_type(before_json) = 'object')
  ),
  after_json TEXT CHECK (
    after_json IS NULL OR
    (json_valid(after_json) AND json_type(after_json) = 'object')
  ),
  details_json TEXT NOT NULL CHECK (
    json_valid(details_json) AND json_type(details_json) = 'object'
  ),
  occurred_at TEXT NOT NULL,
  CHECK (
    (action = 'settings.registration.updated' AND target_user_id IS NULL) OR
    (
      action IN ('user.role.updated', 'user.refresh_tokens.revoked') AND
      target_user_id IS NOT NULL
    )
  )
);

CREATE INDEX idx_admin_audit_events_occurred
ON admin_audit_events(occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_action_occurred
ON admin_audit_events(action, occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_actor_occurred
ON admin_audit_events(actor_user_id, occurred_at DESC, id DESC);

CREATE INDEX idx_admin_audit_events_target_occurred
ON admin_audit_events(target_user_id, occurred_at DESC, id DESC)
WHERE target_user_id IS NOT NULL;

CREATE TRIGGER trg_admin_audit_events_append_only_update
BEFORE UPDATE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'administrator audit events are append-only');
END;

CREATE TRIGGER trg_admin_audit_events_append_only_delete
BEFORE DELETE ON admin_audit_events
BEGIN
  SELECT RAISE(ABORT, 'administrator audit events are append-only');
END;
`;

function restoreV11Fixture(db: Database.Database): void {
  db.exec(`
    DROP TABLE llm_excel_correction_previews;
    DROP TABLE server_llm_credentials;
    DROP TABLE account_excel_export_settings;
    DROP TABLE public_share_view_sessions;
    DROP TABLE public_share_view_totals;
    DROP TABLE public_archive_aliases;
    DROP TABLE public_archive_list_logs;
    DROP TABLE public_archive_list_sessions;
    DROP TABLE public_archive_list_sources;
    DROP TABLE public_archive_list_members;
    DROP TABLE public_archive_lists;
    DROP INDEX idx_users_username_identity;
    DROP INDEX idx_personal_dictionary_snapshots_updated;
    DROP TABLE personal_dictionary_snapshots;
    DROP TABLE personal_cloud_snapshots;
    DROP TABLE server_config_overrides;
    DROP TABLE admin_governance_audit_events;
    DROP TABLE live_draft_device_state;
    DROP TABLE session_live_drafts;
    DROP TABLE account_share_audit_events;
      DROP TRIGGER trg_session_friend_owner_changed;
      DROP TABLE friend_requests;
    DROP TABLE friend_blocks;
    DROP TABLE session_friend_access;
    DROP TABLE session_access_requests;
    DROP TABLE social_audit_events;
    DROP TABLE session_join_passphrases;
    DROP TABLE account_share_blocks;
    DROP TABLE account_share_grants;
    DROP TRIGGER trg_sessions_event_cursor_valid_insert;
    DROP TRIGGER trg_sessions_event_cursor_monotonic_update;
    DROP TABLE admin_audit_events;
  `);
  db.prepare('DELETE FROM schema_migrations WHERE version IN (12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30)').run();
  db.exec(V11_ADMIN_AUDIT_SQL);
}

function adminAuditRows(db: Database.Database): AdminAuditRow[] {
  return db.prepare(`
    SELECT
      id, action, actor_user_id, target_user_id, request_id, mutation_id,
      before_json, after_json, details_json, occurred_at
    FROM admin_audit_events
    ORDER BY id
  `).all() as AdminAuditRow[];
}

test('migration v12 preserves v11 administrator audit rows and installs retention guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-retention-migration-'));
  const databasePath = join(directory, 'v11.db');
  let db: Database.Database | undefined;
  try {
    db = openDatabase(databasePath);
    restoreV11Fixture(db);

    assert.deepEqual(
      db.prepare(`
        SELECT version, name, checksum
        FROM schema_migrations
        ORDER BY version
      `).all(),
      V11_MIGRATION_PREFIX,
      'the fixture must expose the released v1-v11 migration prefix',
    );

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'hash', 'admin', ?, ?)
    `).run('retention-admin', 'retention-admin', NOW, NOW);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'hash', 'user', ?, ?)
    `).run('retention-target', 'retention-target', NOW, NOW);
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES (?, 'Retention Migration', 'active', ?, 1, 2, 0, ?, ?)
    `).run('retention-session', 'retention-admin', NOW, NOW);

    const insertAudit = db.prepare(`
      INSERT INTO admin_audit_events (
        id, action, actor_user_id, target_user_id, request_id, mutation_id,
        before_json, after_json, details_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAudit.run(
      'audit-registration',
      'settings.registration.updated',
      'retention-admin',
      null,
      'request-registration',
      'mutation-registration',
      '{ "registrationEnabled": true }',
      '{ "registrationEnabled": false }',
      '{ "source": "migration fixture" }',
      NOW,
    );
    insertAudit.run(
      'audit-role',
      'user.role.updated',
      'retention-admin',
      'retention-target',
      'request-role',
      'mutation-role',
      '{"role":"user"}',
      '{"role":"admin"}',
      '{"revokedRefreshTokenCount":2}',
      '2026-07-12T08:01:00.000Z',
    );
    insertAudit.run(
      'audit-refresh',
      'user.refresh_tokens.revoked',
      'retention-admin',
      'retention-target',
      'request-refresh',
      'mutation-refresh',
      null,
      null,
      '{"revokedRefreshTokenCount":3}',
      '2026-07-12T08:02:00.000Z',
    );
    const auditBefore = adminAuditRows(db);

    runMigrations(db);

    assert.deepEqual(
      db.prepare(`
        SELECT version, name, checksum
        FROM schema_migrations
        WHERE version <= 11
        ORDER BY version
      `).all(),
      V11_MIGRATION_PREFIX,
      'v12 must not rewrite a v1-v11 migration identity or checksum',
    );
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 12').get(),
      { version: 12, name: 'session_event_retention' },
    );
    assert.deepEqual(
      adminAuditRows(db),
      auditBefore,
      'v12 must retain every administrator audit field byte-for-byte',
    );

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = 'admin_audit_events'
        AND name LIKE 'idx_admin_audit_events_%'
      ORDER BY name
    `).pluck().all();
    assert.deepEqual(indexes, [
      'idx_admin_audit_events_action_occurred',
      'idx_admin_audit_events_actor_occurred',
      'idx_admin_audit_events_occurred',
      'idx_admin_audit_events_target_occurred',
    ]);

    const auditTriggers = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'admin_audit_events'
      ORDER BY name
    `).pluck().all();
    assert.deepEqual(auditTriggers, [
      'trg_admin_audit_events_append_only_delete',
      'trg_admin_audit_events_append_only_replace',
      'trg_admin_audit_events_append_only_update',
    ]);

    insertAudit.run(
      'audit-prune',
      'session_events.pruned',
      'retention-admin',
      null,
      'request-prune',
      'mutation-prune',
      null,
      '{"eventCount":1,"affectedSessionCount":1}',
      '{"retentionDays":180}',
      '2026-07-12T08:03:00.000Z',
    );
    assert.equal(
      db.prepare('SELECT action FROM admin_audit_events WHERE id = ?').pluck().get('audit-prune'),
      'session_events.pruned',
    );
    assert.throws(
      () => insertAudit.run(
        'audit-prune-with-target',
        'session_events.pruned',
        'retention-admin',
        'retention-target',
        'request-prune-with-target',
        'mutation-prune-with-target',
        null,
        '{}',
        '{}',
        NOW,
      ),
      /CHECK constraint failed/,
    );

    assert.throws(
      () => db!.prepare(`
        INSERT OR REPLACE INTO admin_audit_events (
          id, action, actor_user_id, target_user_id, request_id, mutation_id,
          before_json, after_json, details_json, occurred_at
        ) VALUES (?, 'settings.registration.updated', ?, NULL, ?, ?, '{}', '{}', '{}', ?)
      `).run(
        'audit-registration',
        'retention-admin',
        'replacement-request',
        'replacement-mutation',
        NOW,
      ),
      /administrator audit events are append-only/,
    );
    assert.throws(
      () => db!.prepare(`
        INSERT OR REPLACE INTO admin_audit_events (
          id, action, actor_user_id, target_user_id, request_id, mutation_id,
          before_json, after_json, details_json, occurred_at
        ) VALUES (?, 'settings.registration.updated', ?, NULL, ?, ?, '{}', '{}', '{}', ?)
      `).run(
        'different-audit-id',
        'retention-admin',
        'replacement-request',
        'mutation-registration',
        NOW,
      ),
      /administrator audit events are append-only/,
    );
    assert.throws(
      () => db!.prepare('UPDATE admin_audit_events SET details_json = ? WHERE id = ?').run(
        '{}',
        'audit-registration',
      ),
      /administrator audit events are append-only/,
    );
    assert.throws(
      () => db!.prepare('DELETE FROM admin_audit_events WHERE id = ?').run(
        'audit-registration',
      ),
      /administrator audit events are append-only/,
    );
    assert.deepEqual(
      adminAuditRows(db).filter((row) => row.id !== 'audit-prune'),
      auditBefore,
      'failed replacement and mutation attempts must leave legacy audit rows unchanged',
    );

    db.prepare(`
      UPDATE sessions SET event_seq = event_seq + 1 WHERE id = ?
    `).run('retention-session');
    db.prepare(`
      UPDATE sessions SET min_retained_seq = 1 WHERE id = ?
    `).run('retention-session');
    assert.deepEqual(
      db.prepare(`
        SELECT event_seq, min_retained_seq FROM sessions WHERE id = ?
      `).get('retention-session'),
      { event_seq: 3, min_retained_seq: 1 },
    );
    assert.throws(
      () => db!.prepare(`
        UPDATE sessions SET min_retained_seq = -1 WHERE id = ?
      `).run('retention-session'),
      /Session event cursors must be monotonic and valid/,
    );
    assert.throws(
      () => db!.prepare(`
        UPDATE sessions SET min_retained_seq = 4 WHERE id = ?
      `).run('retention-session'),
      /Session event cursors must be monotonic and valid/,
    );
    assert.throws(
      () => db!.prepare(`
        UPDATE sessions SET min_retained_seq = 0 WHERE id = ?
      `).run('retention-session'),
      /Session event cursors must be monotonic and valid/,
    );
    assert.throws(
      () => db!.prepare(`
        UPDATE sessions SET event_seq = 2 WHERE id = ?
      `).run('retention-session'),
      /Session event cursors must be monotonic and valid/,
    );
    assert.throws(
      () => db!.prepare(`
        UPDATE sessions SET event_seq = 'not-an-integer' WHERE id = ?
      `).run('retention-session'),
      /Session event cursors must be monotonic and valid/,
    );
    assert.equal(
      db.prepare(`
        UPDATE sessions SET event_seq = 4, min_retained_seq = 2 WHERE id = ?
      `).run('retention-session').changes,
      1,
      'event_seq and the retention cursor may advance together',
    );

    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES (?, 'Invalid Cursor', 'active', ?, 1, ?, ?, ?, ?)
    `);
    assert.throws(
      () => insertSession.run('negative-cursor-session', 'retention-admin', 0, -1, NOW, NOW),
      /Session event cursors must be non-negative and valid/,
    );
    assert.throws(
      () => insertSession.run('cursor-ahead-session', 'retention-admin', 0, 1, NOW, NOW),
      /Session event cursors must be non-negative and valid/,
    );
    assert.throws(
      () => insertSession.run(
        'text-cursor-session',
        'retention-admin',
        'not-an-integer',
        0,
        NOW,
        NOW,
      ),
      /Session event cursors must be non-negative and valid/,
    );

    assert.deepEqual(db.pragma('foreign_key_check'), []);
    runMigrations(db);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM schema_migrations WHERE version = 12').pluck().get(),
      1,
      'v12 migration replay must be idempotent',
    );
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('migration v12 rejects invalid legacy Session cursors and rolls back cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-retention-invalid-migration-'));
  const databasePath = join(directory, 'invalid-v11.db');
  let db: Database.Database | undefined;
  try {
    db = openDatabase(databasePath);
    restoreV11Fixture(db);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'hash', 'admin', ?, ?)
    `).run('invalid-cursor-owner', 'invalid-cursor-owner', NOW, NOW);
    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES (?, ?, 'active', 'invalid-cursor-owner', 1, ?, ?, ?, ?)
    `);
    insertSession.run('negative-head', 'Negative head', -1, 0, NOW, NOW);
    insertSession.run('negative-minimum', 'Negative minimum', 0, -1, NOW, NOW);
    insertSession.run('minimum-ahead', 'Minimum ahead', 1, 2, NOW, NOW);

    assert.throws(
      () => runMigrations(db!),
      /Failed to apply database migration 12 \(session_event_retention\)/,
    );
    assert.equal(
      db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(),
      11,
      'a rejected v12 migration must not record itself',
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'trg_sessions_event_cursor_%'
      `).pluck().get(),
      0,
      'a rejected v12 migration must not leave cursor triggers behind',
    );
    const adminAuditSql = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_audit_events'
    `).pluck().get() as string;
    assert.equal(
      adminAuditSql.includes('session_events.pruned'),
      false,
      'a rejected v12 migration must leave the v11 audit table intact',
    );
    assert.deepEqual(
      db.prepare(`
        SELECT id, event_seq, min_retained_seq FROM sessions
        WHERE id IN ('negative-head', 'negative-minimum', 'minimum-ahead')
        ORDER BY id
      `).all(),
      [
        { id: 'minimum-ahead', event_seq: 1, min_retained_seq: 2 },
        { id: 'negative-head', event_seq: -1, min_retained_seq: 0 },
        { id: 'negative-minimum', event_seq: 0, min_retained_seq: -1 },
      ],
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
