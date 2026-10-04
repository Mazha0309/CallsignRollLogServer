import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { test, TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';

async function fixture(t: TestContext, rateLimitEnabled = false) {
  const db = openDatabase(':memory:');
  const timestamp = new Date().toISOString();
  function user(username: string, id = username) {
    db.prepare(`INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES (?,?,'not-public','user',?,?)`).run(id, username, timestamp, timestamp);
    return id;
  }
  user('alice');
  user('bob');
  const secret = 'social-search-fixture-secret-at-least-32-bytes';
  const app = createApp({ db, config: { jwtSecret: secret, jwtIssuer: 'search-test', environment: 'test', rateLimitEnabled } });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  async function request(path: string, actor: string | null = 'alice', method = 'GET', body?: unknown) {
    const token = actor ? jwt.sign({ type: 'access', role: 'user', jti: randomUUID(), av: 1 }, secret, { issuer: 'search-test', audience: 'openlogtool-v1', subject: actor, expiresIn: 300 }) : '';
    const response = await fetch(`${origin}/api/v1/social${path}`, {
      method,
      headers: { ...(actor ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  }
  const search = (query: string, actor: string | null = 'alice') => request(`/users?query=${encodeURIComponent(query)}`, actor);
  function relation(sender: string, recipient: string, status: string, expires = '2099-01-01T00:00:00.000Z') {
    const id = randomUUID();
    db.prepare('INSERT INTO friend_requests VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, sender, recipient, status, timestamp, timestamp, expires);
    return id;
  }
  return { db, user, request, search, relation };
}

test('user search requires an active account and respects token revocation', async t => {
  const f = await fixture(t);
  assert.equal((await f.search('bob', null)).status, 401);
  assert.equal((await f.search('bob', 'missing')).status, 401);
  f.db.prepare("UPDATE users SET disabled_at = '2020-01-01' WHERE id = 'alice'").run();
  assert.equal((await f.search('bob')).status, 403);
  f.db.prepare("UPDATE users SET disabled_at = NULL, auth_version = 2 WHERE id = 'alice'").run();
  assert.equal((await f.search('bob')).status, 401);
});

test('search normalizes account identity, trims input and puts an exact name first', async t => {
  const f = await fixture(t);
  f.user('BG5CRL');
  f.user('a-bg5crl');
  f.user('BG5CRL-portable');
  f.user('Écho');
  const found = await f.search('  bG5CrL  ');
  assert.equal(found.status, 200);
  assert.equal(found.headers.get('cache-control'), 'no-store');
  assert.deepEqual(found.body, { items: [
    { userId: 'BG5CRL', username: 'BG5CRL', relationship: 'none' },
    { userId: 'a-bg5crl', username: 'a-bg5crl', relationship: 'none' },
    { userId: 'BG5CRL-portable', username: 'BG5CRL-portable', relationship: 'none' },
  ], hasMore: false });
  assert.deepEqual((await f.search('e\u0301C')).body.items, [{ userId: 'Écho', username: 'Écho', relationship: 'none' }]);
  assert.deepEqual((await f.search('5cr')).body.items.map((item: { username: string }) => item.username), ['a-bg5crl', 'BG5CRL', 'BG5CRL-portable']);
  assert.deepEqual((await f.search('not-a-user')).body, { items: [], hasMore: false });
});

test('search uses literal substrings, not SQL or wildcard expressions', async t => {
  const f = await fixture(t);
  f.user('literal_%user');
  f.user('literal-AA-user');
  assert.deepEqual((await f.search('_%')).body.items, [{ userId: 'literal_%user', username: 'literal_%user', relationship: 'none' }]);
  assert.deepEqual((await f.search("' OR 1=1 --")).body, { items: [], hasMore: false });
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 4);
});

test('search never exposes self, inactive accounts, or accounts blocked in either direction', async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET username = 'radio-self' WHERE id = 'alice'").run();
  for (const name of ['radio-open', 'radio-disabled', 'radio-deleted', 'radio-blocked', 'radio-blocking']) f.user(name);
  f.db.prepare("UPDATE users SET disabled_at = '2020-01-01' WHERE id = 'radio-disabled'").run();
  f.db.prepare("UPDATE users SET deleted_at = '2020-01-01' WHERE id = 'radio-deleted'").run();
  f.db.prepare("INSERT INTO friend_blocks VALUES ('alice', 'radio-blocked'), ('radio-blocking', 'alice')").run();
  f.relation('alice', 'radio-blocked', 'accepted');
  f.relation('radio-blocking', 'alice', 'pending');
  assert.deepEqual((await f.search('radio')).body, {
    items: [{ userId: 'radio-open', username: 'radio-open', relationship: 'none' }], hasMore: false,
  });
  for (const username of ['radio-self', 'radio-disabled', 'radio-deleted', 'radio-blocked', 'radio-blocking']) {
    assert.deepEqual((await f.search(username)).body, { items: [], hasMore: false });
  }
});

test('search returns only the caller relationship and ignores expired or historical requests', async t => {
  const f = await fixture(t);
  for (const name of ['peer-friend', 'peer-incoming', 'peer-outgoing', 'peer-expired', 'peer-rejected', 'peer-removed', 'peer-cancelled', 'peer-other']) f.user(name);
  f.relation('alice', 'peer-friend', 'accepted', '2000-01-01T00:00:00.000Z');
  const incoming = f.relation('peer-incoming', 'alice', 'pending');
  const outgoing = f.relation('alice', 'peer-outgoing', 'pending');
  const expired = f.relation('alice', 'peer-expired', 'pending', '2000-01-01T00:00:00.000Z');
  for (const status of ['rejected', 'removed', 'cancelled']) f.relation('alice', `peer-${status}`, status);
  f.relation('bob', 'peer-other', 'accepted');
  const found = await f.search('peer');
  assert.deepEqual(found.body.items, [
    { userId: 'peer-cancelled', username: 'peer-cancelled', relationship: 'none' },
    { userId: 'peer-expired', username: 'peer-expired', relationship: 'none' },
    { userId: 'peer-friend', username: 'peer-friend', relationship: 'friend' },
    { userId: 'peer-incoming', username: 'peer-incoming', relationship: 'incoming', requestId: incoming },
    { userId: 'peer-other', username: 'peer-other', relationship: 'none' },
    { userId: 'peer-outgoing', username: 'peer-outgoing', relationship: 'outgoing', requestId: outgoing },
    { userId: 'peer-rejected', username: 'peer-rejected', relationship: 'none' },
    { userId: 'peer-removed', username: 'peer-removed', relationship: 'none' },
  ]);
  assert.equal(f.db.prepare('SELECT status FROM friend_requests WHERE id = ?').pluck().get(expired), 'pending', 'search is read-only');
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM social_audit_events').pluck().get(), 0);
});

test('search results follow send and accept actions without granting anything in search itself', async t => {
  const f = await fixture(t);
  assert.equal((await f.search('bob')).body.items[0].relationship, 'none');
  const sent = await f.request('/friend-requests', 'alice', 'POST', { username: 'bob' });
  assert.equal(sent.status, 200);
  assert.deepEqual((await f.search('bob')).body.items[0], { userId: 'bob', username: 'bob', relationship: 'outgoing', requestId: sent.body.request.id });
  assert.equal((await f.search('alice', 'bob')).body.items[0].relationship, 'incoming');
  assert.equal((await f.request(`/friend-requests/${sent.body.request.id}/accept`, 'bob', 'POST', {})).status, 200);
  assert.deepEqual((await f.search('bob')).body.items[0], { userId: 'bob', username: 'bob', relationship: 'friend' });
});

test('search has a deterministic limit and tells the caller to narrow broad matches', async t => {
  const f = await fixture(t);
  for (let index = 29; index >= 0; index--) f.user(`peer-${String(index).padStart(2, '0')}`);
  f.user('peer');
  const found = (await f.search('peer')).body;
  assert.equal(found.items.length, 20);
  assert.equal(found.hasMore, true);
  assert.deepEqual(found.items.map((item: { username: string }) => item.username), ['peer', ...Array.from({ length: 19 }, (_, index) => `peer-${String(index).padStart(2, '0')}`)]);
  assert.deepEqual((await f.search('peer')).body, found);
  assert.equal((await f.search('peer-2')).body.items.length, 10);
  assert.equal((await f.search('peer-2')).body.hasMore, false);
  f.db.prepare("DELETE FROM users WHERE username >= 'peer-19' AND username < 'peer-30'").run();
  assert.equal((await f.search('peer')).body.items.length, 20);
  assert.equal((await f.search('peer')).body.hasMore, false);
});

test('search rejects missing, short, oversized, structured and unexpected queries', async t => {
  const f = await fixture(t);
  for (const query of ['', ' ', 'b', 'e\u0301', '😀', 'b'.repeat(65)]) {
    const response = await f.search(query);
    assert.equal(response.status, 422, JSON.stringify(query));
    assert.equal(response.body.error.code, 'VALIDATION_FAILED');
  }
  for (const path of ['/users', '/users?query=bo&query=al', '/users?query[name]=bob', '/users?query=bob&limit=1000']) {
    assert.equal((await f.request(path)).status, 422, path);
  }
  f.user('b'.repeat(64));
  assert.equal((await f.search('b'.repeat(64))).status, 200);
});

test('search rate limit is independent, per account, and includes retry information', async t => {
  const f = await fixture(t, true);
  for (let index = 0; index < 30; index++) assert.equal((await f.search('bob')).status, 200);
  const limited = await f.search('bob');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.equal(limited.headers.get('ratelimit-limit'), '30');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await f.request('/')).status, 200, 'search exhaustion does not prevent viewing friend requests');
  assert.equal((await f.search('alice', 'bob')).status, 200, 'another account has its own search budget');
});
