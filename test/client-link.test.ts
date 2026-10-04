import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWebClientUrl } from '../src/client-link';
import { applyStoredConfigOverrides } from '../src/config-overrides';
import { config } from '../src/config';
import { openDatabase } from '../src/db/database';

test('client links are explicit safe destinations and persist across restart', () => {
  for (const value of ['javascript:alert(1)', '//evil.test', 'https://user:pass@site.test/', 'https://site.test/?token=x', 'https://site.test/#x', null]) {
    assert.throws(() => validateWebClientUrl(value));
  }
  assert.equal(validateWebClientUrl('  '), '');
  assert.equal(validateWebClientUrl('https://client.example/client/'), 'https://client.example/client/');
  const db = openDatabase(':memory:');
  try {
    db.exec("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES ('admin','Admin','hash','admin','now','now')");
    db.prepare('INSERT INTO server_config_overrides VALUES (?, ?, ?, ?)').run('webClientUrl', JSON.stringify('https://client.example/'), 'admin', 'now');
    const runtime = { ...config };
    applyStoredConfigOverrides(db, runtime);
    assert.equal(runtime.webClientUrl, 'https://client.example/');
    assert.throws(() => db.prepare('INSERT INTO server_config_overrides VALUES (?, ?, ?, ?)').run('untrustedKey', 'true', 'admin', 'now'));
  } finally { db.close(); }
});
