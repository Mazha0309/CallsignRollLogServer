import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { test, TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { createCollaborationWsServer } from '../src/ws';
import { getRealtimeHub } from '../src/collaboration/realtime';
import { getSocialRealtimeHub } from '../src/social/realtime';

async function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  for (const id of ['alice', 'bob', 'carol']) db.prepare(`INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES (?,?,'unused','user',?,?)`).run(id, id, now, now);
  const secret = 'social-ws-fixture-secret-at-least-32-bytes';
  const app = createApp({ db, config: { jwtSecret: secret, jwtIssuer: 'test', environment: 'test', rateLimitEnabled: false } });
  const server = createServer(app);
  const config = app.locals.openLogTool.config;
  const controller = createCollaborationWsServer(server, { db, config });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { controller.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  async function request(actor: string | null, path: string, method = 'GET', body?: unknown, key = randomUUID()) {
    const token = actor ? jwt.sign({ type: 'access', role: 'user', jti: randomUUID(), av: 1 }, secret, { issuer: 'test', audience: 'openlogtool-v1', subject: actor, expiresIn: 300 }) : '';
    const response = await fetch(`${origin}/api/v1${path}`, { method, headers: { ...(actor ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': key }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  }
  async function issue(actor: string) { const response = await request(actor, '/social/ws-ticket', 'POST', {}); assert.equal(response.status, 200); return response.body.ticket as string; }
  function connect(ticket: string, socketOrigin = origin) {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/social?ticket=${encodeURIComponent(ticket)}`, { origin: socketOrigin });
    const messages: Record<string, unknown>[] = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    ws.on('message', raw => { const value = JSON.parse(raw.toString()); messages.push(value); waiters.shift()?.(value); });
    ws.on('error', () => undefined);
    let index = 0;
    const next = async () => {
      if (messages[index]) return messages[index++];
      const value = await Promise.race([
        new Promise<Record<string, unknown>>(resolve => waiters.push(resolve)),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('No notification received')), 1500); timer.unref(); }),
      ]);
      index++; return value;
    };
    return { ws, messages, next };
  }
  const denied = (ticket: string, socketOrigin = origin) => new Promise<number>((resolve, reject) => {
    const { ws } = connect(ticket, socketOrigin);
    ws.once('open', () => { ws.terminate(); reject(new Error('Unexpected authorization')); });
    ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); });
  });
  return { db, request, issue, connect, denied, controller };
}

test('account socket needs no session membership, authenticates once and rejects reuse/origin', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(null, '/social/ws-ticket', 'POST', {})).status, 401);
  const ticket = await f.issue('bob');
  assert.equal(await f.denied(ticket, 'https://untrusted.example'), 403);
  const bob = f.connect(ticket);
  assert.deepEqual(await bob.next(), { type: 'social.ready', userId: 'bob', serverInstanceId: f.db.prepare('SELECT instance_id FROM server_settings').pluck().get() });
  assert.equal(await f.denied(ticket), 401);
  const closed = once(bob.ws, 'close');
  bob.ws.send(JSON.stringify({ type: 'subscribe', userId: 'alice' }));
  assert.equal((await closed)[0], 1008);
});

test('friend requests notify only affected accounts and replay/failure do not notify again', async t => {
  const f = await fixture(t);
  const alice = f.connect(await f.issue('alice'));
  const bob = f.connect(await f.issue('bob'));
  const carol = f.connect(await f.issue('carol'));
  await Promise.all([alice.next(), bob.next(), carol.next()]);
  const key = randomUUID();
  const sent = await f.request('alice', '/social/friend-requests', 'POST', { username: 'bob' }, key);
  assert.equal(sent.status, 200);
  assert.deepEqual(await bob.next(), { type: 'social.changed' });
  assert.deepEqual(await alice.next(), { type: 'social.changed' });
  assert.equal((await f.request('alice', '/social/friend-requests', 'POST', { username: 'bob' }, key)).status, 200);
  assert.equal((await f.request('carol', `/social/friend-requests/${sent.body.request.id}/accept`, 'POST', {})).status, 404);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(carol.messages.length, 1);
  assert.equal(bob.messages.length, 2);
  assert.equal(alice.messages.length, 2);
  assert.equal((await f.request('bob', `/social/friend-requests/${sent.body.request.id}/accept`, 'POST', {})).status, 200);
  assert.deepEqual(await alice.next(), { type: 'social.changed' });
  assert.equal((await f.request('alice', '/social')).body.friends[0].userId, 'bob');
});

test('a broken account transport cannot fail a committed request or prevent peer notification', async t => {
  const f = await fixture(t);
  const alice = f.connect(await f.issue('alice'));
  await alice.next();
  const serverSocket = [...f.controller.wss.clients][0];
  const bob = f.connect(await f.issue('bob'));
  await bob.next();
  const send = t.mock.method(serverSocket, 'send', () => { throw new Error('broken send'); });
  const terminate = t.mock.method(serverSocket, 'terminate', () => { throw new Error('broken cleanup'); });
  try {
    assert.equal((await f.request('alice', '/social/friend-requests', 'POST', { username: 'bob' })).status, 200);
    assert.deepEqual(await bob.next(), { type: 'social.changed' });
    assert.equal((await f.request('bob', '/social')).body.friendRequests.length, 1);
  } finally {
    send.mock.restore(); terminate.mock.restore(); serverSocket.terminate();
  }
});

test('revocation invalidates outstanding tickets and active sockets immediately', async t => {
  const f = await fixture(t);
  const bob = f.connect(await f.issue('bob'));
  await bob.next();
  const pending = await f.issue('bob');
  const closed = once(bob.ws, 'close');
  getRealtimeHub(f.db).revokeUser('bob');
  assert.equal((await closed)[0], 1008);
  assert.equal(await f.denied(pending), 401);
  const outdated = await f.issue('carol');
  f.db.prepare("UPDATE users SET auth_version = auth_version + 1 WHERE id = 'carol'").run();
  assert.equal(await f.denied(outdated), 401);
});

test('session invitations and applications notify before membership exists', async t => {
  const f = await fixture(t);
  const now = new Date().toISOString();
  f.db.prepare(`INSERT INTO sessions(id,title,status,owner_user_id,version,event_seq,min_retained_seq,created_at,updated_at) VALUES ('net','Private net','active','alice',1,0,0,?,?)`).run(now, now);
  f.db.prepare(`INSERT INTO session_members(id,session_id,user_id,role,version,created_at,updated_at) VALUES ('owner','net','alice','owner',1,?,?)`).run(now, now);
  const friend = await f.request('alice', '/social/friend-requests', 'POST', { username: 'bob' });
  assert.equal((await f.request('bob', `/social/friend-requests/${friend.body.request.id}/accept`, 'POST', {})).status, 200);
  const alice = f.connect(await f.issue('alice'));
  const bob = f.connect(await f.issue('bob'));
  const carol = f.connect(await f.issue('carol'));
  await Promise.all([alice.next(), bob.next(), carol.next()]);
  const changed = async () => {
    assert.deepEqual(await alice.next(), { type: 'social.changed' });
    assert.deepEqual(await bob.next(), { type: 'social.changed' });
  };
  const invitation = await f.request('alice', '/social/sessions/net/invitations', 'POST', { username: 'bob', role: 'editor' });
  assert.equal(invitation.status, 200);
  await changed();
  assert.equal((await f.request('bob', '/social')).body.sessionRequests[0].id, invitation.body.request.id);
  assert.equal((await f.request('bob', '/sessions/net/snapshot')).status, 404, 'notification must not grant access');
  assert.equal((await f.request('bob', `/social/session-requests/${invitation.body.request.id}/reject`, 'POST', {})).status, 200);
  await changed();
  assert.equal((await f.request('alice', '/social/sessions/net', 'PUT', { visibility: 'friends' })).status, 200);
  await changed();
  const application = await f.request('bob', '/social/sessions/net/applications', 'POST', { role: 'viewer' });
  assert.equal(application.status, 200);
  await changed();
  assert.equal((await f.request('alice', '/social')).body.sessionRequests[0].id, application.body.request.id);
  assert.equal((await f.request('alice', `/social/session-requests/${application.body.request.id}/accept`, 'POST', {})).status, 200);
  await changed();
  assert.equal((await f.request('bob', '/sessions/net/snapshot')).status, 200);
  assert.equal((await f.request('bob', '/social')).body.sessionRequests[0].status, 'accepted');
  assert.equal(carol.messages.length, 1, 'unrelated accounts receive no invalidation');
});

for (const trigger of ['heartbeat', 'dashboard'] as const) test(`pending expiration via ${trigger} pushes invalidation and reconnect reloads state`, async t => {
  const f = await fixture(t);
  const request = await f.request('alice', '/social/friend-requests', 'POST', { username: 'bob' });
  const bob = f.connect(await f.issue('bob'));
  await bob.next();
  f.db.prepare("UPDATE friend_requests SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(request.body.request.id);
  if (trigger === 'heartbeat') getSocialRealtimeHub(f.db).heartbeat();
  else await f.request('carol', '/social');
  assert.deepEqual(await bob.next(), { type: 'social.changed' });
  assert.equal((await f.request('bob', '/social')).body.friendRequests.length, 0);
  bob.ws.close();
  const again = f.connect(await f.issue('bob'));
  assert.equal((await again.next()).type, 'social.ready');
});
