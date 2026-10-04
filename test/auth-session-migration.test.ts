import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/database';
import { runMigrations } from '../src/db/migrations';

test('migration v16 backfills rotation chains into unique server-side auth Sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-auth-session-migration-'));
  let db: Database.Database | undefined;
  try {
    db = openDatabase(join(directory, 'v15.db'));
    db.exec(`
      DROP TABLE llm_excel_correction_previews;
      DROP TABLE server_llm_credentials;
      DROP TABLE account_excel_export_settings;
      DROP TABLE public_share_view_sessions;
      DROP TABLE public_share_view_totals;
      DROP INDEX idx_users_username_identity;
      DROP INDEX idx_personal_dictionary_snapshots_updated;
      DROP TABLE personal_dictionary_snapshots;
      DROP TABLE personal_cloud_snapshots;
      DROP TRIGGER trg_ws_tickets_legacy_expiry_insert;
      DROP TRIGGER trg_ws_tickets_legacy_expiry_immutable;
      DROP TRIGGER trg_refresh_tokens_issued_auth_version_insert;
      DROP TRIGGER trg_refresh_tokens_issued_auth_version_immutable;
      DROP INDEX idx_refresh_tokens_issued_auth_version;
      ALTER TABLE ws_tickets DROP COLUMN access_expires_at;
      ALTER TABLE refresh_tokens DROP COLUMN issued_auth_version;
      DROP TRIGGER trg_ws_tickets_auth_session_insert;
      DROP TRIGGER trg_ws_tickets_auth_session_immutable;
      DROP INDEX idx_ws_tickets_auth_session;
      ALTER TABLE ws_tickets DROP COLUMN auth_session_id;
      DROP TRIGGER trg_refresh_tokens_auth_session_insert;
      DROP TRIGGER trg_refresh_tokens_auth_session_immutable;
      DROP INDEX idx_refresh_tokens_auth_session;
      ALTER TABLE refresh_tokens DROP COLUMN auth_session_id;
      DROP TABLE public_archive_aliases;
      DROP TABLE public_archive_list_logs;
      DROP TABLE public_archive_list_sessions;
      DROP TABLE public_archive_list_sources;
      DROP TABLE public_archive_list_members;
      DROP TABLE public_archive_lists;
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
      DELETE FROM schema_migrations WHERE version >= 16;
    `);

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES ('family-user', 'family-user', 'hash', 'admin', ?, ?)
    `).run(now, now);
    const insert = db.prepare(`
      INSERT INTO refresh_tokens (
        id, user_id, token_hash, device_id, created_at, expires_at,
        revoked_at, rotated_at, replaced_by_id
      ) VALUES (?, 'family-user', ?, 'shared-device-label', ?, ?, ?, ?, ?)
    `);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    insert.run('family-active', 'hash-active', now, expiresAt, null, null, null);
    insert.run('family-middle', 'hash-middle', now, expiresAt, now, now, 'family-active');
    insert.run('family-root', 'hash-root', now, expiresAt, now, now, 'family-middle');
    insert.run('independent-login', 'hash-independent', now, expiresAt, null, null, null);

    runMigrations(db);

    const families = db.prepare(`
      SELECT id, auth_session_id
      FROM refresh_tokens
      ORDER BY id
    `).all() as Array<{ id: string; auth_session_id: string }>;
    const byId = new Map(families.map((row) => [row.id, row.auth_session_id]));
    assert.equal(byId.get('family-root'), 'family-root');
    assert.equal(byId.get('family-middle'), 'family-root');
    assert.equal(byId.get('family-active'), 'family-root');
    assert.equal(byId.get('independent-login'), 'independent-login');
    assert.notEqual(byId.get('family-active'), byId.get('independent-login'));
    assert.deepEqual(
      db.prepare(`
        SELECT id, issued_auth_version
        FROM refresh_tokens
        ORDER BY id
      `).all(),
      [
        { id: 'family-active', issued_auth_version: 1 },
        { id: 'family-middle', issued_auth_version: null },
        { id: 'family-root', issued_auth_version: null },
        { id: 'independent-login', issued_auth_version: 1 },
      ],
      'only active legacy refresh leaves can safely inherit the current credential version',
    );
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 16').get(),
      { version: 16, name: 'refresh_token_session_families' },
    );

    assert.throws(
      () => db!.prepare(`
        INSERT INTO refresh_tokens (
          id, user_id, token_hash, issued_auth_version, created_at, expires_at
        ) VALUES ('missing-family', 'family-user', 'hash-missing', 1, ?, ?)
      `).run(now, expiresAt),
      /authentication Session is required/i,
    );
    assert.throws(
      () => db!.prepare(`
        UPDATE refresh_tokens SET auth_session_id = 'different-family'
        WHERE id = 'family-active'
      `).run(),
      /authentication Session is immutable/i,
    );
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
