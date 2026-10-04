import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { test, TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { createShareRequest, acceptShareRequest, revokeShareGrant } from '../src/account-share/service';
import { listSharedSessions } from '../src/account-share/catalog';
import { setJoinPassphrase, joinSessionWithShare } from '../src/account-share/passphrase';
import { getRealtimeHub } from '../src/collaboration/realtime';
import { runMigrations } from '../src/db/migrations';
import { storeResponse } from '../src/collaboration/idempotency';

async function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  for (const username of ['alice', 'bob', 'carol']) db.prepare(`INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES (?,?,'unused','user',?,?)`).run(username, username, now, now);
  db.prepare(`INSERT INTO sessions(id,title,status,owner_user_id,version,event_seq,min_retained_seq,created_at,updated_at) VALUES ('net','Private net','active','alice',1,0,0,?,?)`).run(now, now);
  db.prepare(`INSERT INTO session_members(id,session_id,user_id,role,version,created_at,updated_at) VALUES ('alice-member','net','alice','owner',1,?,?)`).run(now, now);
  const secret = 'friends-fixture-secret-at-least-32-bytes';
  const app = createApp({ db, config: { jwtSecret: secret, jwtIssuer: 'friends-test', environment: 'test', rateLimitEnabled: false } });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(actor: string | null, path: string, method = 'GET', body?: unknown, key = randomUUID()) {
    const token = actor ? jwt.sign({ type: 'access', role: 'user', jti: randomUUID(), av: 1 }, secret, { issuer: 'friends-test', audience: 'openlogtool-v1', subject: actor, expiresIn: 300 }) : '';
    const response = await fetch(`${origin}/api/v1${path}`, { method, headers: { ...(actor ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': key }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  }
  async function friends() {
    const sent = await request('alice', '/social/friend-requests', 'POST', { username: 'BOB' });
    assert.equal(sent.status, 200);
    const accepted = await request('bob', `/social/friend-requests/${sent.body.request.id}/accept`, 'POST', {});
    assert.equal(accepted.status, 200);
  }
  return { db, request, friends };
}

test('legacy grants expire and cannot overwrite an independent invite membership', async t => {
  const { db } = await fixture(t);
  const grant = createShareRequest(db, { grantorUserId: 'alice', granteeUsername: 'bob', includePersonal: false, includeOwned: true, includeEditor: false, canJoinAs: 'editor', requestId: randomUUID(), mutationId: randomUUID() });
  db.prepare("UPDATE account_share_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(grant.id);
  assert.throws(() => acceptShareRequest(db, { grantId: grant.id, actorUserId: 'bob', requestId: randomUUID(), mutationId: randomUUID() }));
  assert.equal(listSharedSessions(db, 'bob').items.length, 0);
  const next = createShareRequest(db, { grantorUserId: 'alice', granteeUsername: 'bob', includePersonal: false, includeOwned: true, includeEditor: false, canJoinAs: 'editor', requestId: randomUUID(), mutationId: randomUUID() });
  acceptShareRequest(db, { grantId: next.id, actorUserId: 'bob', requestId: randomUUID(), mutationId: randomUUID() });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO session_members(id,session_id,user_id,role,version,created_at,updated_at,join_source) VALUES ('legacy-independent','net','bob','editor',1,?,?,'invite')`).run(now, now);
  setJoinPassphrase(db, { sessionId: 'net', ownerUserId: 'alice', passphrase: 'fixture-passphrase' });
  joinSessionWithShare(db, { sessionId: 'net', actorUserId: 'bob', passphrase: 'fixture-passphrase', requestId: randomUUID(), mutationId: randomUUID() });
  revokeShareGrant(db, { grantId: next.id, actorUserId: 'alice', requestId: randomUUID(), mutationId: randomUUID() });
  assert.deepEqual(db.prepare("SELECT join_source, removed_at FROM session_members WHERE id = 'legacy-independent'").get(), { join_source: 'invite', removed_at: null });
});

test('legacy passphrase is not persisted in idempotency responses', async t => {
  const { db, request } = await fixture(t);
  const key = randomUUID();
  const response = await request('alice', '/sessions/net/join-passphrase', 'PUT', { passphrase: 'test-only-passphrase' }, key);
  assert.equal(response.status, 200);
  const stored = db.prepare('SELECT response_json FROM processed_mutations WHERE mutation_id = ?').pluck().get(key) as string;
  assert.equal(stored.includes('test-only-passphrase'), false);
});

test('migration 30 preserves users, sessions and legacy grants while removing old plaintext receipts', async t => {
  const { db } = await fixture(t);
  const grant = createShareRequest(db, { grantorUserId: 'alice', granteeUsername: 'bob', includePersonal: false, includeOwned: true, includeEditor: false, canJoinAs: 'viewer', requestId: randomUUID(), mutationId: randomUUID() });
  const usersBefore = db.prepare('SELECT * FROM users ORDER BY id').all();
  const sessionsBefore = db.prepare('SELECT * FROM sessions').all();
  const grantsBefore = db.prepare('SELECT * FROM account_share_grants WHERE id = ?').get(grant.id);
  storeResponse(db, { mutationId: 'old-secret-receipt', userId: 'alice', requestHash: 'old-hash', status: 200, body: { configured: true, passphrase: 'old-secret' } });
  db.exec(`
    DROP TRIGGER trg_session_friend_owner_changed;
    DROP TABLE friend_requests;
    DROP TABLE friend_blocks;
    DROP TABLE session_friend_access;
    DROP TABLE session_access_requests;
    DROP TABLE social_audit_events;
    DELETE FROM schema_migrations WHERE version = 30;
  `);
  runMigrations(db);
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), usersBefore);
  assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), sessionsBefore);
  assert.deepEqual(db.prepare('SELECT * FROM account_share_grants WHERE id = ?').get(grant.id), grantsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) FROM friend_requests').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM session_friend_access').pluck().get(), 0);
  assert.deepEqual(JSON.parse(db.prepare("SELECT response_json FROM processed_mutations WHERE mutation_id = 'old-secret-receipt'").pluck().get() as string), { configured: true });
});

test('friends are mutual after consent; friendship reveals no private session or logs', async t => {
  const { request, friends } = await fixture(t);
  assert.equal((await request(null, '/social')).status, 401);
  await friends();
  const bob = (await request('bob', '/social')).body;
  assert.deepEqual(bob.friends, [{ userId: 'alice', username: 'alice' }]);
  assert.deepEqual(bob.sessions, []);
  assert.equal((await request('alice', '/social')).body.friends[0].username, 'bob');
  assert.equal((await request('bob', '/sessions/net/snapshot')).status, 404);
});

test('only the recipient accepts; crossed requests stay one pending relationship', async t => {
  const { request, db } = await fixture(t);
  const first = await request('alice', '/social/friend-requests', 'POST', { username: 'bob' });
  const second = await request('bob', '/social/friend-requests', 'POST', { username: 'alice' });
  assert.equal(second.body.request.id, first.body.request.id);
  assert.equal((await request('alice', `/social/friend-requests/${first.body.request.id}/accept`, 'POST', {})).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) FROM friend_requests').pluck().get(), 1);
  assert.equal((await request('alice', '/social/friend-requests', 'POST', { username: 'alice' })).status, 422);
});

test('invitation acceptance grants a real membership and replays without duplicating it', async t => {
  const { request, friends, db } = await fixture(t);
  await friends();
  const sent = await request('alice', '/social/sessions/net/invitations', 'POST', { username: 'bob', role: 'editor' });
  assert.equal(sent.status, 200);
  assert.equal((await request('carol', `/social/session-requests/${sent.body.request.id}/accept`, 'POST', {})).status, 404);
  const path = `/social/session-requests/${sent.body.request.id}/accept`;
  const key = randomUUID();
  const accepted = await request('bob', path, 'POST', {}, key);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.membership.role, 'editor');
  let replaySignals = 0;
  t.mock.method(getRealtimeHub(db), 'roleChanged', () => { replaySignals++; });
  assert.deepEqual((await request('bob', path, 'POST', {}, key)).body, accepted.body);
  assert.equal(replaySignals, 0, 'a replay must not emit an outdated role or disconnect the client again');
  assert.equal((await request('bob', '/sessions/net/snapshot')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) FROM session_members WHERE user_id = 'bob'").pluck().get(), 1);
  assert.equal((await request('bob', path, 'POST', { role: 'owner' })).status, 422);
});

test('transferring ownership resets discovery and cancels outstanding requests', async t => {
  const { request, friends, db } = await fixture(t);
  await friends();
  await request('alice', '/social/sessions/net', 'PUT', { visibility: 'friends' });
  const application = await request('bob', '/social/sessions/net/applications', 'POST', { role: 'viewer' });
  db.prepare("UPDATE sessions SET owner_user_id = 'carol' WHERE id = 'net'").run();
  assert.equal(db.prepare('SELECT COUNT(*) FROM session_friend_access').pluck().get(), 0);
  assert.equal(db.prepare('SELECT status FROM session_access_requests WHERE id = ?').pluck().get(application.body.request.id), 'cancelled');
  assert.equal((await request('bob', '/social')).body.sessions.length, 0);
});

test('friends discover only opted-in metadata; owner approves join applications', async t => {
  const { request, friends } = await fixture(t);
  await friends();
  assert.equal((await request('bob', '/social/sessions/net/applications', 'POST', { role: 'viewer' })).status, 404);
  assert.equal((await request('bob', '/social/sessions/net', 'PUT', { visibility: 'friends' })).status, 404);
  assert.equal((await request('alice', '/social/sessions/net', 'PUT', { visibility: 'friends' })).status, 200);
  const visible = (await request('bob', '/social')).body.sessions;
  assert.equal(visible.length, 1);
  assert.equal('logs' in visible[0], false);
  assert.equal((await request('carol', '/social')).body.sessions.length, 0);
  assert.equal((await request('carol', '/social/sessions/net/applications', 'POST', { role: 'viewer' })).status, 403);
  const applied = await request('bob', '/social/sessions/net/applications', 'POST', { role: 'viewer' });
  assert.equal(applied.status, 200);
  assert.equal((await request('bob', `/social/session-requests/${applied.body.request.id}/accept`, 'POST', {})).status, 403);
  const accepted = await request('alice', `/social/session-requests/${applied.body.request.id}/accept`, 'POST', {});
  assert.equal(accepted.body.membership.role, 'viewer');
});

test('making a session private cancels applications and disabling the owner blocks acceptance', async t => {
  const { request, friends, db } = await fixture(t);
  await friends();
  await request('alice', '/social/sessions/net', 'PUT', { visibility: 'friends' });
  const application = await request('bob', '/social/sessions/net/applications', 'POST', { role: 'editor' });
  await request('alice', '/social/sessions/net', 'PUT', { visibility: 'private' });
  assert.equal((await request('alice', `/social/session-requests/${application.body.request.id}/accept`, 'POST', {})).status, 409);
  const invite = await request('alice', '/social/sessions/net/invitations', 'POST', { username: 'bob', role: 'editor' });
  db.prepare("UPDATE users SET disabled_at = ? WHERE id = 'alice'").run(new Date().toISOString());
  assert.equal((await request('bob', `/social/session-requests/${invite.body.request.id}/accept`, 'POST', {})).status, 404);
});

test('friend removal cancels pending requests but preserves accepted session permissions', async t => {
  const { request, friends, db } = await fixture(t);
  await friends();
  const invite = await request('alice', '/social/sessions/net/invitations', 'POST', { username: 'bob', role: 'editor' });
  await request('bob', `/social/session-requests/${invite.body.request.id}/accept`, 'POST', {});
  await request('alice', '/social/friends/bob', 'DELETE');
  assert.equal((await request('bob', '/social')).body.friends.length, 0);
  assert.equal((await request('bob', '/sessions/net/snapshot')).status, 200);
  assert.equal(db.prepare("SELECT join_source FROM session_members WHERE user_id = 'bob'").pluck().get(), 'friend');
  await request('bob', '/social/blocks/alice', 'PUT');
  assert.equal((await request('alice', '/social/friend-requests', 'POST', { username: 'bob' })).status, 403);
  await request('bob', '/social/blocks/alice', 'DELETE');
  assert.equal((await request('alice', '/social/friend-requests', 'POST', { username: 'bob' })).status, 200);
});

test('expired and cancelled requests cannot be accepted; an existing membership is preserved', async t => {
  const { request, friends, db } = await fixture(t);
  await friends();
  const invite = await request('alice', '/social/sessions/net/invitations', 'POST', { username: 'bob', role: 'viewer' });
  db.prepare("UPDATE session_access_requests SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await request('bob', `/social/session-requests/${invite.body.request.id}/accept`, 'POST', {})).status, 409);
  const next = await request('alice', '/social/sessions/net/invitations', 'POST', { username: 'bob', role: 'viewer' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO session_members(id,session_id,user_id,role,version,created_at,updated_at,join_source) VALUES ('bob-original','net','bob','editor',1,?,?,'invite')`).run(now, now);
  const accepted = await request('bob', `/social/session-requests/${next.body.request.id}/accept`, 'POST', {});
  assert.equal(accepted.body.membership.role, 'editor');
  assert.equal(db.prepare("SELECT join_source FROM session_members WHERE user_id = 'bob'").pluck().get(), 'invite');
});
