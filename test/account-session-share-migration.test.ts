import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database';

test('migration v29 creates account share tables', () => {
  const db = openDatabase(':memory:');
  for (const table of [
    'account_share_grants',
    'account_share_blocks',
    'session_join_passphrases',
    'account_share_audit_events',
  ]) {
    assert.ok(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table),
      table,
    );
  }
  const memberCols = db.pragma('table_info(session_members)') as Array<{ name: string }>;
  assert.ok(memberCols.some((col) => col.name === 'join_source'));
  assert.ok(memberCols.some((col) => col.name === 'account_share_grant_id'));
});
