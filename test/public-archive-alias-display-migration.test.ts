import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/database';
import { runMigrations } from '../src/db/migrations';

const NOW = '2026-08-18T00:00:00.000Z';

test('migration v26 backfills legacy public archive alias display case without changing its canonical alias', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-archive-alias-v25-'));
  let db: Database.Database | undefined;
  try {
    db = openDatabase(join(directory, 'v25.db'));
    db.exec(`
      DROP TABLE llm_excel_correction_previews;
      DROP TABLE server_llm_credentials;
      DROP TABLE account_excel_export_settings;
      DROP TABLE public_archive_aliases;
      CREATE TABLE public_archive_aliases (
        alias TEXT PRIMARY KEY,
        list_id TEXT NOT NULL UNIQUE REFERENCES public_archive_lists(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
      DELETE FROM schema_migrations WHERE version >= 26;
    `);
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES ('owner', 'owner', 'hash', 'user', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO public_archive_lists (id, title, owner_user_id, is_published, created_at, updated_at)
      VALUES ('list-1', 'Archive', 'owner', 1, ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO public_archive_aliases (alias, list_id, created_by, created_at, updated_at)
      VALUES ('br5ai', 'list-1', 'owner', ?, ?)`).run(NOW, NOW);

    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT alias, display_alias FROM public_archive_aliases WHERE list_id = ?').get('list-1'), {
      alias: 'br5ai', display_alias: 'br5ai',
    });
    runMigrations(db);
    assert.deepEqual(db.prepare('SELECT alias, display_alias FROM public_archive_aliases WHERE list_id = ?').get('list-1'), {
      alias: 'br5ai', display_alias: 'br5ai',
    });
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
