import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { test, TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { runMigrations } from '../src/db/migrations';
import { getRealtimeHub } from '../src/collaboration/realtime';
import { getSocialRealtimeHub } from '../src/social/realtime';

async function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const timestamp = new Date().toISOString();
  for (const name of ['alice', 'bob', 'carol']) db.prepare(`INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES (?,?,'unused','user',?,?)`).run(name, name, timestamp, timestamp);
  db.prepare(`INSERT INTO sessions(id,title,status,owner_user_id,version,event_seq,min_retained_seq,created_at,updated_at) VALUES ('net','Friend net','active','alice',1,0,0,?,?)`).run(timestamp, timestamp);
  db.prepare(`INSERT INTO session_members(id,session_id,user_id,role,version,created_at,updated_at) VALUES ('owner','net','alice','owner',1,?,?)`).run(timestamp, timestamp);
  db.prepare(`INSERT INTO friend_requests VALUES ('friends','alice','bob','accepted',?,?,'2099-01-01T00:00:00.000Z')`).run(timestamp, timestamp);
  const secret = 'direct-join-fixture-secret-at-least-32-bytes';
  const app = createApp({ db, config: { jwtSecret: secret, jwtIssuer: 'direct-test', environment: 'test', rateLimitEnabled: false } });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  async function request(actor: string | null, path: string, method = 'GET', body?: unknown, key = randomUUID()) {
    const token = actor ? jwt.sign({ type: 'access', role: 'user', jti: randomUUID(), av: 1 }, secret, { issuer: 'direct-test', audience: 'openlogtool-v1', subject: actor, expiresIn: 300 }) : '';
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { ...(actor ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  const configure = (body: unknown = { visibility: 'friends', joinPolicy: 'direct', defaultRole: 'viewer' }) => request('alice', '/social/sessions/net', 'PUT', body);
  const join = (actor: string | null = 'bob', body: unknown = {}, key = randomUUID()) => request(actor, '/social/sessions/net/join', 'POST', body, key);
  const member = () => db.prepare("SELECT * FROM session_members WHERE session_id = 'net' AND user_id = 'bob'").get() as Record<string, unknown> | undefined;
  return { db, request, configure, join, member };
}

test('migration 31 preserves existing data and makes direct join opt-in', async t => {
  const f = await fixture(t);
  await f.configure({ visibility: 'friends' });
  f.db.exec(`ALTER TABLE session_friend_access DROP COLUMN join_policy;
    ALTER TABLE session_friend_access DROP COLUMN default_role;
    DELETE FROM schema_migrations WHERE version >= 31;`);
  const users = f.db.prepare('SELECT * FROM users ORDER BY id').all();
  const memberships = f.db.prepare('SELECT * FROM session_members ORDER BY id').all();
  const friendships = f.db.prepare('SELECT * FROM friend_requests ORDER BY id').all();
  const settings = f.db.prepare('SELECT * FROM session_friend_access').get();
  runMigrations(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM users ORDER BY id').all(), users);
  assert.deepEqual(f.db.prepare('SELECT * FROM session_members ORDER BY id').all(), memberships);
  assert.deepEqual(f.db.prepare('SELECT * FROM friend_requests ORDER BY id').all(), friendships);
  assert.deepEqual(f.db.prepare('SELECT * FROM session_friend_access').get(), { ...settings as object, join_policy: 'approval', default_role: 'viewer' });
  assert.throws(() => f.db.prepare("UPDATE session_friend_access SET default_role = 'owner'").run());
  assert.throws(() => f.db.prepare("UPDATE session_friend_access SET join_policy = 'anything'").run());
  runMigrations(f.db);
  assert.equal(f.db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), 32);
});

test('only owners configure direct joining, defaults stay private and legacy updates remain compatible', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('alice', '/social/sessions/net')).body, { sessionId: 'net', visibility: 'private', joinPolicy: 'approval', defaultRole: 'viewer' });
  assert.deepEqual((await f.configure({ visibility: 'friends' })).body, { sessionId: 'net', visibility: 'friends', joinPolicy: 'approval', defaultRole: 'viewer' });
  assert.equal((await f.join()).body.error.code, 'APPROVAL_REQUIRED');
  assert.equal((await f.configure()).status, 200);
  assert.equal((await f.configure({ visibility: 'friends' })).body.joinPolicy, 'direct');
  for (const body of [{ visibility: 'friends', joinPolicy: 'auto' }, { visibility: 'friends', defaultRole: 'owner' }, { visibility: 'friends', joinPolicy: null }, { visibility: 'friends', defaultRole: null }]) {
    assert.equal((await f.configure(body)).status, 422);
  }
  assert.equal((await f.request('bob', '/social/sessions/net', 'PUT', { visibility: 'friends', joinPolicy: 'direct' })).status, 404);
  const privateSetting = await f.configure({ visibility: 'private', joinPolicy: 'direct', defaultRole: 'editor' });
  assert.deepEqual(privateSetting.body, { sessionId: 'net', visibility: 'private', joinPolicy: 'approval', defaultRole: 'editor' });
  assert.equal((await f.configure({ visibility: 'friends' })).body.joinPolicy, 'approval', 'making it visible again must not silently reopen direct entry');
});

for (const role of ['viewer', 'editor']) test(`direct join grants the owner-selected ${role} role, never a client-selected role`, async t => {
  const f = await fixture(t);
  await f.configure({ visibility: 'friends', joinPolicy: 'direct', defaultRole: role });
  const catalog = (await f.request('bob', '/social')).body.sessions[0];
  assert.equal(catalog.joinPolicy, 'direct');
  assert.equal(catalog.defaultRole, role);
  assert.equal((await f.join('bob', { role: 'owner' })).status, 422);
  assert.equal((await f.join('bob', { defaultRole: role === 'viewer' ? 'editor' : 'viewer' })).status, 422);
  assert.equal(f.member(), undefined);
  const joined = await f.join();
  assert.equal(joined.status, 200);
  assert.equal(joined.body.joined, true);
  assert.equal(joined.body.membership.role, role);
  assert.equal(f.member()?.role, role);
  assert.equal(f.member()?.join_source, 'friend');
  assert.equal((await f.request('bob', '/sessions/net/snapshot')).status, 200);
  assert.equal((await f.request('bob', '/social')).body.sessions.length, 0);
});

test('direct joins are idempotent and existing memberships are never upgraded or downgraded', async t => {
  const f = await fixture(t);
  await f.configure();
  const notices: unknown[][] = [];
  t.mock.method(getRealtimeHub(f.db), 'roleChanged', (...args: unknown[]) => notices.push(args));
  const key = randomUUID();
  const joined = await f.join('bob', {}, key);
  assert.deepEqual((await f.join('bob', {}, key)).body, joined.body);
  assert.equal((await f.join()).body.joined, false);
  await f.configure({ visibility: 'friends', joinPolicy: 'direct', defaultRole: 'editor' });
  assert.equal((await f.join()).body.membership.role, 'viewer');
  f.db.prepare("UPDATE session_members SET role = 'editor', version = version + 1 WHERE user_id = 'bob'").run();
  await f.configure({ visibility: 'friends', joinPolicy: 'direct', defaultRole: 'viewer' });
  assert.equal((await f.join()).body.membership.role, 'editor');
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0], ['net', 'bob', 'viewer', 1]);
  assert.equal(f.db.prepare("SELECT COUNT(*) FROM social_audit_events WHERE action LIKE 'session.direct_join.%'").pluck().get(), 1);
});

test('a removed member cannot self-rejoin or revive access by replay, but owner approval can restore them', async t => {
  const f = await fixture(t);
  await f.configure();
  const key = randomUUID();
  assert.equal((await f.join('bob', {}, key)).status, 200);
  f.db.prepare("UPDATE session_members SET removed_at = '2020-01-01', removed_by = 'alice' WHERE user_id = 'bob'").run();
  assert.equal((await f.join('bob', {}, key)).status, 200, 'replay returns only the original receipt');
  assert.equal((await f.request('bob', '/sessions/net/snapshot')).status, 403);
  assert.equal((await f.join()).body.error.code, 'MEMBERSHIP_REVOKED');
  assert.equal(f.member()?.removed_at, '2020-01-01');
  const application = await f.request('bob', '/social/sessions/net/applications', 'POST', { role: 'viewer' });
  assert.equal(application.status, 200);
  assert.equal((await f.request('alice', `/social/session-requests/${application.body.request.id}/accept`, 'POST', {})).status, 200);
  assert.equal(f.member()?.removed_at, null);
});

test('direct joining rechecks friendship, bidirectional blocks, active accounts and the current session state', async t => {
  const f = await fixture(t);
  await f.configure();
  assert.equal((await f.join(null)).status, 401);
  assert.equal((await f.join('carol')).body.error.code, 'FRIEND_REQUIRED');
  for (const status of ['pending', 'removed', 'rejected']) {
    f.db.prepare("UPDATE friend_requests SET status = ? WHERE id = 'friends'").run(status);
    assert.equal((await f.join()).body.error.code, 'FRIEND_REQUIRED');
  }
  f.db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = 'friends'").run();
  for (const [a, b] of [['alice', 'bob'], ['bob', 'alice']]) {
    f.db.prepare('INSERT INTO friend_blocks VALUES (?, ?)').run(a, b);
    assert.equal((await f.join()).body.error.code, 'FRIEND_REQUIRED');
    assert.equal((await f.request('bob', '/social')).body.sessions.length, 0);
    f.db.prepare('DELETE FROM friend_blocks').run();
  }
  for (const column of ['disabled_at', 'deleted_at']) {
    f.db.prepare(`UPDATE users SET ${column} = '2020-01-01' WHERE id = 'alice'`).run();
    assert.equal((await f.join()).body.error.code, 'USER_NOT_FOUND');
    f.db.prepare(`UPDATE users SET ${column} = NULL WHERE id = 'alice'`).run();
  }
  f.db.prepare("UPDATE users SET disabled_at = '2020-01-01' WHERE id = 'bob'").run();
  assert.equal((await f.join()).status, 403);
  f.db.prepare("UPDATE users SET disabled_at = NULL WHERE id = 'bob'").run();
  await f.configure({ visibility: 'private' });
  assert.equal((await f.join()).status, 404);
  await f.configure({ visibility: 'friends', joinPolicy: 'approval' });
  assert.equal((await f.join()).body.error.code, 'APPROVAL_REQUIRED');
  await f.configure();
  f.db.prepare("UPDATE sessions SET status = 'closed' WHERE id = 'net'").run();
  assert.equal((await f.join()).status, 404);
  f.db.prepare("UPDATE sessions SET status = 'active', deleted_at = '2020-01-01' WHERE id = 'net'").run();
  assert.equal((await f.join()).status, 404);
  assert.equal(f.member(), undefined);
});

for (const kind of ['application', 'invitation']) test(`direct joining cancels a pending ${kind} without inheriting its requested higher role`, async t => {
  const f = await fixture(t);
  await f.configure({ visibility: 'friends' });
  const pending = kind === 'application'
    ? await f.request('bob', '/social/sessions/net/applications', 'POST', { role: 'editor' })
    : await f.request('alice', '/social/sessions/net/invitations', 'POST', { username: 'bob', role: 'editor' });
  assert.equal(pending.status, 200);
  await f.configure();
  assert.equal((await f.join()).body.membership.role, 'viewer');
  assert.equal(f.db.prepare('SELECT status FROM session_access_requests WHERE id = ?').pluck().get(pending.body.request.id), 'cancelled');
  const recipient = kind === 'application' ? 'alice' : 'bob';
  assert.equal((await f.request(recipient, `/social/session-requests/${pending.body.request.id}/accept`, 'POST', {})).status, 409);
});

test('closing direct entry preserves members and ownership transfer resets discovery and direct entry', async t => {
  const f = await fixture(t);
  await f.configure();
  await f.join();
  const before = f.member();
  await f.configure({ visibility: 'friends', joinPolicy: 'approval' });
  assert.deepEqual(f.member(), before);
  assert.equal((await f.request('bob', '/sessions/net/snapshot')).status, 200);
  await f.configure();
  f.db.prepare("UPDATE sessions SET owner_user_id = 'carol' WHERE id = 'net'").run();
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM session_friend_access').pluck().get(), 0);
  assert.deepEqual(f.member(), before);
  assert.equal((await f.join()).body.error.code, 'FRIEND_REQUIRED');
});

test('direct join audit failure rolls membership, pending cancellation and receipt back without notifications', async t => {
  const f = await fixture(t);
  await f.configure();
  const pending = await f.request('bob', '/social/sessions/net/applications', 'POST', { role: 'editor' });
  f.db.exec(`CREATE TRIGGER reject_direct_join_audit BEFORE INSERT ON social_audit_events
    WHEN NEW.action LIKE 'session.direct_join.%' BEGIN SELECT RAISE(ABORT, 'forced direct join audit failure'); END;`);
  const key = randomUUID();
  let notices = 0;
  t.mock.method(getSocialRealtimeHub(f.db), 'notify', () => notices++);
  t.mock.method(getRealtimeHub(f.db), 'roleChanged', () => notices++);
  assert.equal((await f.join('bob', {}, key)).status, 500);
  assert.equal(f.member(), undefined);
  assert.equal(f.db.prepare('SELECT status FROM session_access_requests WHERE id = ?').pluck().get(pending.body.request.id), 'pending');
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck().get(key), 0);
  assert.equal(notices, 0);
});

test('direct join invalidates owner and joining account state through existing realtime notifications', async t => {
  const f = await fixture(t);
  await f.configure();
  const notifications = new Set<string>();
  t.mock.method(getSocialRealtimeHub(f.db), 'notify', (recipients: Iterable<string>) => { for (const user of recipients) notifications.add(user); });
  assert.equal((await f.join()).status, 200);
  assert.deepEqual([...notifications].sort(), ['alice', 'bob']);
});
