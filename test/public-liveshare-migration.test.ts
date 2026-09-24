import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations } from '../src/db/database';

const CREATED_AT = '2026-07-12T08:00:00.000Z';
const CONSUMED_AT = '2026-07-12T08:00:30.000Z';
const TICKET_EXPIRES_AT = '2026-07-12T08:01:00.000Z';
const SHARE_EXPIRES_AT = '2026-07-13T08:00:00.000Z';

const V10_COLLABORATION_AUDIT_SQL = `
CREATE TABLE collaboration_audit_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN (
    'membership.role.updated',
    'membership.removed',
    'ownership.transferred',
    'invite.created',
    'invite.redeemed',
    'invite.revoked',
    'session.deleted'
  )),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
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
  UNIQUE (session_id, action, mutation_id),
  CHECK (
    (
      action IN (
        'membership.role.updated',
        'membership.removed',
        'ownership.transferred',
        'invite.redeemed'
      ) AND target_user_id IS NOT NULL
    ) OR (
      action IN ('invite.created', 'invite.revoked', 'session.deleted')
      AND target_user_id IS NULL
    )
  ),
  CHECK (
    (action = 'invite.created' AND before_json IS NULL) OR
    (action <> 'invite.created' AND before_json IS NOT NULL)
  ),
  CHECK (after_json IS NOT NULL)
);

CREATE INDEX idx_collaboration_audit_session_occurred
ON collaboration_audit_events(session_id, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_action_occurred
ON collaboration_audit_events(session_id, action, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_actor_occurred
ON collaboration_audit_events(session_id, actor_user_id, occurred_at DESC, id DESC);

CREATE INDEX idx_collaboration_audit_session_target_occurred
ON collaboration_audit_events(session_id, target_user_id, occurred_at DESC, id DESC)
WHERE target_user_id IS NOT NULL;

CREATE TRIGGER trg_collaboration_audit_append_only_replace
BEFORE INSERT ON collaboration_audit_events
WHEN EXISTS (
  SELECT 1 FROM collaboration_audit_events
  WHERE id = NEW.id OR (
    session_id = NEW.session_id AND
    action = NEW.action AND
    mutation_id = NEW.mutation_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;

CREATE TRIGGER trg_collaboration_audit_append_only_update
BEFORE UPDATE ON collaboration_audit_events
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;

CREATE TRIGGER trg_collaboration_audit_append_only_delete
BEFORE DELETE ON collaboration_audit_events
BEGIN
  SELECT RAISE(ABORT, 'collaboration audit events are append-only');
END;
`;

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

interface AuditRow {
  id: string;
  session_id: string;
  action: string;
  actor_user_id: string;
  target_user_id: string | null;
  request_id: string;
  mutation_id: string;
  before_json: string | null;
  after_json: string;
  details_json: string;
  occurred_at: string;
}

const V10_MIGRATION_PREFIX: readonly MigrationRow[] = [
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
];

function restoreV10Fixture(db: Database.Database): void {
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
    DROP TRIGGER trg_sessions_event_cursor_valid_insert;
    DROP TRIGGER trg_sessions_event_cursor_monotonic_update;
    DROP TABLE public_ws_tickets;
    DROP TABLE public_shares;
    DROP TABLE collaboration_audit_events;
    ALTER TABLE server_settings DROP COLUMN public_share_hmac_fingerprint;
    DROP TABLE account_share_audit_events;
    DROP TABLE session_join_passphrases;
    DROP TABLE account_share_blocks;
    DROP TABLE account_share_grants;
  `);
  db.prepare('DELETE FROM schema_migrations WHERE version IN (11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29)').run();
  db.exec(V10_COLLABORATION_AUDIT_SQL);
}

test('migration v11 preserves v10 audit data and enforces public capability guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-migration-'));
  const databasePath = join(directory, 'v10.db');
  let db: Database.Database | undefined;
  try {
    db = openDatabase(databasePath);
    restoreV10Fixture(db);

    assert.equal(
      db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(),
      10,
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM pragma_table_info('server_settings')
        WHERE name = 'public_share_hmac_fingerprint'
      `).pluck().get(),
      0,
    );

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'hash', 'admin', ?, ?)
    `).run('migration-owner', 'migration-owner', CREATED_AT, CREATED_AT);
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, created_at, updated_at
      ) VALUES (?, 'Migration Session', 'closed', ?, ?, ?)
    `).run('migration-session', 'migration-owner', CREATED_AT, CREATED_AT);

    const legacyAfter = JSON.stringify({
      inviteId: 'legacy-invite',
      role: 'viewer',
      maxUses: 1,
      usedCount: 0,
      expiresAt: SHARE_EXPIRES_AT,
    });
    db.prepare(`
      INSERT INTO collaboration_audit_events (
        id, session_id, action, actor_user_id, target_user_id,
        request_id, mutation_id, before_json, after_json, details_json, occurred_at
      ) VALUES (?, ?, 'invite.created', ?, NULL, ?, ?, NULL, ?, '{}', ?)
    `).run(
      'legacy-audit-event',
      'migration-session',
      'migration-owner',
      'legacy-request',
      'legacy-mutation',
      legacyAfter,
      CREATED_AT,
    );

    const prefixBefore = db.prepare(`
      SELECT version, name, checksum
      FROM schema_migrations
      WHERE version <= 10
      ORDER BY version
    `).all() as MigrationRow[];
    assert.deepEqual(
      prefixBefore,
      V10_MIGRATION_PREFIX,
      'the v10 fixture must retain the released v1-v10 migration checksums',
    );
    const auditBefore = db.prepare(`
      SELECT
        id, session_id, action, actor_user_id, target_user_id,
        request_id, mutation_id, before_json, after_json, details_json, occurred_at
      FROM collaboration_audit_events
      WHERE id = ?
    `).get('legacy-audit-event') as AuditRow;

    runMigrations(db);

    assert.equal(
      db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(),
      28,
    );
    assert.deepEqual(
      db.prepare(`
        SELECT version, name, checksum
        FROM schema_migrations
        WHERE version <= 10
        ORDER BY version
      `).all(),
      V10_MIGRATION_PREFIX,
      'v11 must not rewrite any v1-v10 migration identity or checksum',
    );
    assert.deepEqual(
      db.prepare(`
        SELECT
          id, session_id, action, actor_user_id, target_user_id,
          request_id, mutation_id, before_json, after_json, details_json, occurred_at
        FROM collaboration_audit_events
        WHERE id = ?
      `).get('legacy-audit-event'),
      auditBefore,
      'v11 must copy every stored audit field byte-for-byte',
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM pragma_table_info('public_ws_tickets')
        WHERE name = 'access_token_id' AND "notnull" = 1
      `).pluck().get(),
      1,
    );

    const insertShare = db.prepare(`
      INSERT INTO public_shares (
        id, session_id, credential_version, secret_hash,
        created_by, created_at, expires_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
    `);
    insertShare.run(
      'public-share-one',
      'migration-session',
      'a'.repeat(64),
      'migration-owner',
      CREATED_AT,
      SHARE_EXPIRES_AT,
    );

    assert.throws(
      () => db!.prepare(`
        INSERT OR REPLACE INTO public_shares (
          id, session_id, credential_version, secret_hash,
          created_by, created_at, expires_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(
        'public-share-one',
        'migration-session',
        'b'.repeat(64),
        'migration-owner',
        CREATED_AT,
        SHARE_EXPIRES_AT,
      ),
      /cannot replace existing capabilities/,
    );
    assert.throws(
      () => db!.prepare('UPDATE public_shares SET expires_at = ? WHERE id = ?').run(
        '2026-07-14T08:00:00.000Z',
        'public-share-one',
      ),
      /immutable except for one-way revocation/,
    );
    assert.throws(
      () => db!.prepare('DELETE FROM public_shares WHERE id = ?').run('public-share-one'),
      /must be retained as revoked capabilities/,
    );

    db.prepare(`
      INSERT INTO public_ws_tickets (
        id, token_hash, public_share_id, access_token_id, after_seq,
        created_at, expires_at, authorization_expires_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      'public-ticket-one',
      'c'.repeat(64),
      'public-share-one',
      'public-access-jti',
      CREATED_AT,
      TICKET_EXPIRES_AT,
      SHARE_EXPIRES_AT,
    );
    assert.equal(
      db.prepare('SELECT access_token_id FROM public_ws_tickets WHERE id = ?').pluck().get(
        'public-ticket-one',
      ),
      'public-access-jti',
    );
    assert.throws(
      () => db!.prepare(`
        UPDATE public_ws_tickets
        SET access_token_id = ?, consumed_at = ?
        WHERE id = ?
      `).run('different-access-jti', CONSUMED_AT, 'public-ticket-one'),
      /may only be consumed once while authorized/,
    );

    const consumed = db.prepare(`
      UPDATE public_ws_tickets
      SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL
    `).run(CONSUMED_AT, 'public-ticket-one');
    assert.equal(consumed.changes, 1);
    assert.throws(
      () => db!.prepare(`
        UPDATE public_ws_tickets SET consumed_at = ? WHERE id = ?
      `).run('2026-07-12T08:00:40.000Z', 'public-ticket-one'),
      /may only be consumed once while authorized/,
    );

    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
