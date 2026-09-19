import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import {
  acceptShareRequest,
  createShareRequest,
} from '../src/account-share/service';

const JWT_SECRET = 'join-share-test-jwt-secret-32-bytes-minimum';
const JWT_ISSUER = 'join-share-test';
const BOB = 'user-bob-join';
const ALICE = 'user-alice-join';
const CAROL = 'user-carol-join';
const NOW = '2026-09-13T12:00:00.000Z';
const OWNED = 'session-owned-join';
const EDITOR = 'session-editor-join';

function token(userId: string): string {
  return jwt.sign(
    { type: 'access', role: 'user', jti: randomUUID(), av: 1 },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: 'openlogtool-v1',
      subject: userId,
      expiresIn: 300,
    },
  );
}

function insertUser(db: ReturnType<typeof openDatabase>, id: string, username: string) {
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, 'unused', 'user', ?, ?)
  `).run(id, username, NOW, NOW);
}

describe('share join passphrase', () => {
  let db: ReturnType<typeof openDatabase>;
  let server: Server;
  let baseUrl: string;
  let bobToken: string;
  let aliceToken: string;
  let grantId: string;

  before(async () => {
    db = openDatabase(':memory:');
    insertUser(db, BOB, 'bob');
    insertUser(db, ALICE, 'alice');
    insertUser(db, CAROL, 'carol');
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq,
        min_retained_seq, created_at, updated_at
      ) VALUES (?, 'Owned', 'active', ?, 1, 0, 0, ?, ?)
    `).run(OWNED, BOB, NOW, NOW);
    db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
    `).run(randomUUID(), OWNED, BOB, NOW, NOW);
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq,
        min_retained_seq, created_at, updated_at
      ) VALUES (?, 'Carol owned', 'active', ?, 1, 0, 0, ?, ?)
    `).run(EDITOR, CAROL, NOW, NOW);
    db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
    `).run(randomUUID(), EDITOR, CAROL, NOW, NOW);
    db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'editor', 1, ?, ?)
    `).run(randomUUID(), EDITOR, BOB, NOW, NOW);

    const grant = createShareRequest(db, {
      grantorUserId: BOB,
      granteeUsername: 'alice',
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      canJoinAs: 'editor',
      requestId: randomUUID(),
      mutationId: 'join-share-grant-1',
    });
    acceptShareRequest(db, {
      grantId: grant.id,
      actorUserId: ALICE,
      requestId: randomUUID(),
      mutationId: 'join-share-accept-1',
    });
    grantId = grant.id;
    bobToken = token(BOB);
    aliceToken = token(ALICE);
    server = createServer(createApp({
      db,
      config: {
        jwtSecret: JWT_SECRET,
        jwtIssuer: JWT_ISSUER,
        rateLimitEnabled: false,
        environment: 'test',
      },
    }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  test('owner can set passphrase and grantee can join owned session', async () => {
    const put = await request(`/api/v1/sessions/${OWNED}/join-passphrase`, {
      method: 'PUT',
      token: bobToken,
      headers: { 'idempotency-key': 'pw-1' },
      body: { passphrase: 'net-join-ok' },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.passphrase, 'net-join-ok');
    const join = await request(`/api/v1/sessions/${OWNED}/join-with-share`, {
      method: 'POST',
      token: aliceToken,
      headers: { 'idempotency-key': 'join-1' },
      body: { passphrase: 'net-join-ok' },
    });
    assert.equal(join.status, 200);
    assert.equal(join.body.membership.role, 'editor');
    assert.equal(join.body.membership.joinSource, 'account_share');
  });

  test('editor session cannot be joined through B grant', async () => {
    const join = await request(`/api/v1/sessions/${EDITOR}/join-with-share`, {
      method: 'POST',
      token: aliceToken,
      headers: { 'idempotency-key': 'join-2' },
      body: { passphrase: 'whatever1' },
    });
    assert.equal(join.status, 403);
    assert.equal(join.body.error.code, 'ACCOUNT_SHARE_CANNOT_JOIN');
  });

  test('rotating passphrase keeps share-origin members', async () => {
    const put = await request(`/api/v1/sessions/${OWNED}/join-passphrase`, {
      method: 'PUT',
      token: bobToken,
      headers: { 'idempotency-key': 'pw-2' },
      body: { passphrase: 'net-join-2x' },
    });
    assert.equal(put.status, 200);
    const membership = await request(`/api/v1/sessions/${OWNED}/membership`, {
      token: aliceToken,
    });
    assert.equal(membership.status, 200);
  });

  test('revoking grant removes share-origin membership only', async () => {
    const revoked = await request(`/api/v1/account/session-shares/${grantId}/revoke`, {
      method: 'POST',
      token: bobToken,
      headers: { 'idempotency-key': 'rev-1' },
      body: {},
    });
    assert.equal(revoked.status, 200);
    const membership = await request(`/api/v1/sessions/${OWNED}/membership`, {
      token: aliceToken,
    });
    assert.equal(membership.status, 403);
    assert.equal(membership.body.error.code, 'MEMBERSHIP_REVOKED');
  });
});
