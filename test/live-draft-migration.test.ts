import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/database';
import { runMigrations } from '../src/db/migrations';

const NOW = '2026-07-13T00:00:00.000Z';
const REVISIONS = JSON.stringify({
  time: 0,
  controller: 0,
  callsign: 0,
  rstSent: 0,
  rstRcvd: 0,
  qth: 0,
  device: 0,
  power: 0,
  antenna: 0,
  height: 0,
  remarks: 0,
});

function restoreV12(db: Database.Database): void {
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
    DROP TABLE server_config_overrides;
    DROP TABLE admin_governance_audit_events;
    DROP TABLE live_draft_device_state;
    DROP TABLE session_live_drafts;
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
  `);
  db.prepare('DELETE FROM schema_migrations WHERE version IN (13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30)').run();
}

test('migration v13 installs persistent single-draft and bounded device replay state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-live-draft-migration-'));
  const path = join(directory, 'v12.db');
  let db: Database.Database | undefined;
  try {
    db = openDatabase(path);
    restoreV12(db);
    assert.equal(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), 12);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES ('draft-owner', 'draft-owner', 'hash', 'admin', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES ('draft-session', 'Draft migration', 'active', 'draft-owner', 1, 0, 0, ?, ?)
    `).run(NOW, NOW);

    runMigrations(db);
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 13').get(),
      { version: 13, name: 'collaboration_live_draft' },
    );
    const tableNames = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('session_live_drafts', 'live_draft_device_state')
      ORDER BY name
    `).pluck().all();
    assert.deepEqual(tableNames, ['live_draft_device_state', 'session_live_drafts']);

    const insertDraft = db.prepare(`
      INSERT INTO session_live_drafts (
        session_id, draft_id, version, time, controller, rst_sent, rst_rcvd,
        field_revisions_json, created_at, last_updated_at
      ) VALUES (?, ?, 1, ?, 'BG0AAA', '59', '59', ?, ?, ?)
    `);
    insertDraft.run('draft-session', 'draft-one', NOW, REVISIONS, NOW, NOW);
    assert.throws(
      () => insertDraft.run('draft-session', 'draft-two', NOW, REVISIONS, NOW, NOW),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => db!.prepare(`UPDATE session_live_drafts SET version = 1 WHERE session_id = 'draft-session'`).run(),
      /Live draft versions must increase/,
    );
    db.prepare(`UPDATE session_live_drafts SET version = 2 WHERE session_id = 'draft-session'`).run();

    const insertState = db.prepare(`
      INSERT INTO live_draft_device_state (
        session_id, user_id, device_id, last_client_seq, request_hash, response_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, '{}', ?)
    `);
    insertState.run('draft-session', 'draft-owner', 'device-one', 1, 'a'.repeat(64), NOW);
    assert.throws(
      () => insertState.run('draft-session', 'draft-owner', 'device-one', 2, 'b'.repeat(64), NOW),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertState.run('missing-session', 'draft-owner', 'device-two', 1, 'c'.repeat(64), NOW),
      /FOREIGN KEY constraint failed/,
    );

    db.prepare(`DELETE FROM sessions WHERE id = 'draft-session'`).run();
    assert.equal(db.prepare('SELECT COUNT(*) FROM session_live_drafts').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM live_draft_device_state').pluck().get(), 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    runMigrations(db);
    assert.equal(db.prepare('SELECT COUNT(*) FROM schema_migrations WHERE version = 13').pluck().get(), 1);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
