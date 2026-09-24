import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/database';
import { runMigrations } from '../src/db/migrations';

test('migrations v19-v20 add isolated personal snapshots without changing collaboration data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-personal-snapshot-migration-'));
  let db: Database.Database | undefined;
  try {
    db = openDatabase(join(directory, 'v18.db'));
    db.exec(`
      DROP TABLE llm_excel_correction_previews;
      DROP TABLE server_llm_credentials;
      DROP TABLE account_excel_export_settings;
      DROP TABLE public_share_view_sessions;
      DROP TABLE public_share_view_totals;
      DROP INDEX idx_users_username_identity;
      DROP TABLE public_archive_aliases;
      DROP TABLE public_archive_list_logs;
      DROP TABLE public_archive_list_sessions;
      DROP TABLE public_archive_list_sources;
      DROP TABLE public_archive_list_members;
      DROP TABLE public_archive_lists;
      DROP TABLE account_share_audit_events;
      DROP TABLE session_join_passphrases;
      DROP TABLE account_share_blocks;
      DROP TABLE account_share_grants;
      DELETE FROM schema_migrations WHERE version IN (21, 22, 23, 24, 25, 26, 27, 28, 29);
      DROP INDEX idx_personal_dictionary_snapshots_updated;
      DROP TABLE personal_dictionary_snapshots;
      DELETE FROM schema_migrations WHERE version = 20;
      DROP INDEX idx_personal_cloud_snapshots_updated;
      DROP TABLE personal_cloud_snapshots;
      DELETE FROM schema_migrations WHERE version = 19;
    `);
    const now = '2026-07-18T00:00:00.000Z';
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES ('migration-admin', 'migration-admin', 'hash', 'admin', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO sessions (id, title, status, owner_user_id, created_at, updated_at)
      VALUES ('existing-session', 'Existing collaboration data', 'active',
              'migration-admin', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, controller, callsign, time, created_at, updated_at
      ) VALUES ('existing-log', 'existing-session', 'BG5AAA', 'BG5BBB', ?, ?, ?)
    `).run(now, now, now);

    runMigrations(db);

    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 19').get(),
      { version: 19, name: 'personal_cloud_snapshots' },
    );
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 20').get(),
      { version: 20, name: 'personal_dictionary_snapshots' },
    );
    assert.equal(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 1);
    assert.equal(db.prepare('SELECT COUNT(*) FROM logs').pluck().get(), 1);
    const columns = (db.pragma('table_info(personal_cloud_snapshots)') as Array<{ name: string }>)
      .map((column) => column.name);
    assert.deepEqual(columns, [
      'user_id', 'revision', 'format_version', 'snapshot_json', 'session_count',
      'log_count', 'byte_size', 'checksum', 'created_at', 'updated_at',
    ]);
    const dictionaryColumns = (
      db.pragma('table_info(personal_dictionary_snapshots)') as Array<{ name: string }>
    ).map((column) => column.name);
    assert.deepEqual(dictionaryColumns, [
      'user_id', 'revision', 'format_version', 'snapshot_json', 'item_count',
      'active_count', 'deleted_count', 'byte_size', 'checksum', 'created_at',
      'updated_at',
    ]);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES ('snapshot-member', 'snapshot-member', 'hash', 'user', ?, ?)
    `).run(now, now);
    const insertSnapshot = db.prepare(`
      INSERT INTO personal_cloud_snapshots (
        user_id, revision, format_version, snapshot_json,
        session_count, log_count, byte_size, checksum, created_at, updated_at
      ) VALUES (?, ?, 1, '{}', 0, 0, 2, ?, ?, ?)
    `);
    assert.throws(
      () => insertSnapshot.run('snapshot-member', 0, 'a'.repeat(64), now, now),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => insertSnapshot.run('snapshot-member', 1, 'A'.repeat(64), now, now),
      /CHECK constraint failed/,
    );
    insertSnapshot.run('snapshot-member', 1, 'a'.repeat(64), now, now);
    db.prepare(`
      INSERT INTO personal_dictionary_snapshots (
        user_id, revision, format_version, snapshot_json,
        item_count, active_count, deleted_count, byte_size,
        checksum, created_at, updated_at
      ) VALUES (?, 1, 1, '{}', 0, 0, 0, 2, ?, ?, ?)
    `).run('snapshot-member', 'b'.repeat(64), now, now);
    db.prepare('DELETE FROM users WHERE id = ?').run('snapshot-member');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM personal_cloud_snapshots').pluck().get(),
      0,
      'account deletion must cascade to the private snapshot',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM personal_dictionary_snapshots').pluck().get(),
      0,
      'account deletion must cascade to the private dictionary snapshot',
    );
    runMigrations(db);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM schema_migrations WHERE version = 19').pluck().get(),
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM schema_migrations WHERE version = 20').pluck().get(),
      1,
    );
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
