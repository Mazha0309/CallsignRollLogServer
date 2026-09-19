import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { AppError } from '../src/errors/app-error';
import { openDatabase } from '../src/db/database';
import {
  parseShareScope,
  sessionVisibleThroughGrant,
} from '../src/account-share/access';
import {
  acceptShareRequest,
  createShareRequest,
  revokeShareGrant,
} from '../src/account-share/service';

test('viewer collaboration is never visible', () => {
  assert.equal(
    sessionVisibleThroughGrant({
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      source: 'collaboration',
      grantorRole: 'viewer',
    }),
    false,
  );
});

test('editor collaboration is visible but not joinable', () => {
  assert.equal(
    sessionVisibleThroughGrant({
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      source: 'collaboration',
      grantorRole: 'editor',
    }),
    true,
  );
});

test('scope cannot disable every source', () => {
  assert.throws(() => parseShareScope({
    includePersonal: false,
    includeOwned: false,
    includeEditor: false,
  }));
});

function insertUser(
  db: ReturnType<typeof openDatabase>,
  id: string,
  username: string,
) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, 'unused', 'user', ?, ?)
  `).run(id, username, now, now);
}

test('createShareRequest accepts then stays one open pair', () => {
  const db = openDatabase(':memory:');
  insertUser(db, 'user-bob', 'bob');
  insertUser(db, 'user-alice', 'alice');

  const created = createShareRequest(db, {
    grantorUserId: 'user-bob',
    granteeUsername: 'alice',
    includePersonal: true,
    includeOwned: true,
    includeEditor: true,
    canJoinAs: 'editor',
    requestId: randomUUID(),
    mutationId: 'share-1',
  });
  assert.equal(created.status, 'pending');
  assert.equal(created.grantorUserId, 'user-bob');
  assert.equal(created.granteeUserId, 'user-alice');

  const replay = createShareRequest(db, {
    grantorUserId: 'user-bob',
    granteeUsername: 'alice',
    includePersonal: true,
    includeOwned: true,
    includeEditor: true,
    canJoinAs: 'editor',
    requestId: randomUUID(),
    mutationId: 'share-2',
  });
  assert.equal(replay.id, created.id);

  assert.throws(
    () => createShareRequest(db, {
      grantorUserId: 'user-bob',
      granteeUsername: 'alice',
      includePersonal: false,
      includeOwned: true,
      includeEditor: true,
      canJoinAs: 'viewer',
      requestId: randomUUID(),
      mutationId: 'share-3',
    }),
    (error: unknown) => error instanceof AppError && error.code === 'ACCOUNT_SHARE_PENDING_EXISTS',
  );
});

test('unknown username, self share and block are rejected', () => {
  const db = openDatabase(':memory:');
  insertUser(db, 'user-bob', 'bob');
  insertUser(db, 'user-alice', 'alice');

  assert.throws(
    () => createShareRequest(db, {
      grantorUserId: 'user-bob',
      granteeUsername: 'missing',
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      canJoinAs: 'editor',
      requestId: randomUUID(),
      mutationId: 'missing-1',
    }),
    (error: unknown) => error instanceof AppError && error.code === 'ACCOUNT_SHARE_USER_NOT_FOUND',
  );

  assert.throws(
    () => createShareRequest(db, {
      grantorUserId: 'user-bob',
      granteeUsername: 'bob',
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      canJoinAs: 'editor',
      requestId: randomUUID(),
      mutationId: 'self-1',
    }),
    (error: unknown) => error instanceof AppError && error.code === 'ACCOUNT_SHARE_SELF',
  );

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO account_share_blocks (blocker_user_id, blocked_user_id, created_at)
    VALUES (?, ?, ?)
  `).run('user-alice', 'user-bob', now);

  assert.throws(
    () => createShareRequest(db, {
      grantorUserId: 'user-bob',
      granteeUsername: 'alice',
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      canJoinAs: 'editor',
      requestId: randomUUID(),
      mutationId: 'blocked-1',
    }),
    (error: unknown) => error instanceof AppError && error.code === 'ACCOUNT_SHARE_BLOCKED',
  );
});

test('accept then revoke removes only share-origin memberships', () => {
  const db = openDatabase(':memory:');
  insertUser(db, 'user-bob', 'bob');
  insertUser(db, 'user-alice', 'alice');
  insertUser(db, 'user-carol', 'carol');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sessions (
      id, title, status, owner_user_id, version, event_seq,
      min_retained_seq, created_at, updated_at
    ) VALUES (?, 'Owned', 'active', ?, 1, 0, 0, ?, ?)
  `).run('session-owned', 'user-bob', now, now);
  db.prepare(`
    INSERT INTO session_members (
      id, session_id, user_id, role, version, created_at, updated_at, join_source
    ) VALUES (?, ?, ?, 'owner', 1, ?, ?, 'bootstrap')
  `).run(randomUUID(), 'session-owned', 'user-bob', now, now);

  const grant = createShareRequest(db, {
    grantorUserId: 'user-bob',
    granteeUsername: 'alice',
    includePersonal: true,
    includeOwned: true,
    includeEditor: true,
    canJoinAs: 'editor',
    requestId: randomUUID(),
    mutationId: 'share-accept-1',
  });
  const accepted = acceptShareRequest(db, {
    grantId: grant.id,
    actorUserId: 'user-alice',
    requestId: randomUUID(),
    mutationId: 'accept-1',
  });
  assert.equal(accepted.status, 'accepted');

  db.prepare(`
    INSERT INTO session_members (
      id, session_id, user_id, role, version, created_at, updated_at,
      join_source, account_share_grant_id
    ) VALUES (?, ?, ?, 'editor', 1, ?, ?, 'account_share', ?)
  `).run(randomUUID(), 'session-owned', 'user-alice', now, now, grant.id);
  db.prepare(`
    INSERT INTO session_members (
      id, session_id, user_id, role, version, created_at, updated_at, join_source
    ) VALUES (?, ?, ?, 'viewer', 1, ?, ?, 'invite')
  `).run(randomUUID(), 'session-owned', 'user-carol', now, now);

  revokeShareGrant(db, {
    grantId: grant.id,
    actorUserId: 'user-bob',
    requestId: randomUUID(),
    mutationId: 'revoke-1',
  });

  const shareOrigin = db.prepare(`
    SELECT removed_at FROM session_members
    WHERE session_id = ? AND user_id = ? AND join_source = 'account_share'
  `).get('session-owned', 'user-alice') as { removed_at: string | null };
  const invited = db.prepare(`
    SELECT removed_at FROM session_members
    WHERE session_id = ? AND user_id = ? AND join_source = 'invite'
  `).get('session-owned', 'user-carol') as { removed_at: string | null };
  assert.ok(shareOrigin.removed_at);
  assert.equal(invited.removed_at, null);
});

const JWT_SECRET = 'account-share-test-jwt-secret-32-bytes-minimum';
const JWT_ISSUER = 'account-share-test';
const BOB_ID = 'user-bob-http';
const ALICE_ID = 'user-alice-http';
const NOW = '2026-09-13T12:00:00.000Z';

function accessToken(userId: string): string {
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

describe('account session share HTTP API', () => {
  let db: ReturnType<typeof openDatabase>;
  let server: Server;
  let baseUrl: string;
  let bobToken: string;
  let aliceToken: string;

  before(async () => {
    db = openDatabase(':memory:');
    const insertUser = db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'unused', 'user', ?, ?)
    `);
    insertUser.run(BOB_ID, 'bob', NOW, NOW);
    insertUser.run(ALICE_ID, 'alice', NOW, NOW);
    bobToken = accessToken(BOB_ID);
    aliceToken = accessToken(ALICE_ID);
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

  test('create then accept makes an active grant without reverse grant', async () => {
    const created = await request('/api/v1/account/session-shares', {
      method: 'POST',
      token: bobToken,
      headers: { 'idempotency-key': 'share-http-1' },
      body: {
        granteeUsername: 'alice',
        includePersonal: true,
        includeOwned: true,
        includeEditor: true,
        canJoinAs: 'editor',
      },
    });
    assert.equal(created.status, 201);
    const accepted = await request(
      `/api/v1/account/session-shares/${created.body.share.id}/accept`,
      {
        method: 'POST',
        token: aliceToken,
        headers: { 'idempotency-key': 'accept-http-1' },
        body: {},
      },
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.share.status, 'accepted');
    const aliceOutbox = await request('/api/v1/account/session-shares?box=outbox', {
      token: aliceToken,
    });
    assert.equal(aliceOutbox.body.items.length, 0);
  });

  test('unknown username, self share and non-grantee accept are rejected', async () => {
    const missing = await request('/api/v1/account/session-shares', {
      method: 'POST',
      token: bobToken,
      headers: { 'idempotency-key': 'missing-http-1' },
      body: {
        granteeUsername: 'nobody',
        includePersonal: true,
        includeOwned: true,
        includeEditor: true,
        canJoinAs: 'editor',
      },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'ACCOUNT_SHARE_USER_NOT_FOUND');

    const self = await request('/api/v1/account/session-shares', {
      method: 'POST',
      token: bobToken,
      headers: { 'idempotency-key': 'self-http-1' },
      body: {
        granteeUsername: 'bob',
        includePersonal: true,
        includeOwned: true,
        includeEditor: true,
        canJoinAs: 'editor',
      },
    });
    assert.equal(self.status, 400);
    assert.equal(self.body.error.code, 'ACCOUNT_SHARE_SELF');

    const created = await request('/api/v1/account/session-shares', {
      method: 'POST',
      token: aliceToken,
      headers: { 'idempotency-key': 'alice-to-bob-1' },
      body: {
        granteeUsername: 'bob',
        includePersonal: true,
        includeOwned: true,
        includeEditor: true,
        canJoinAs: 'editor',
      },
    });
    const stolen = await request(
      `/api/v1/account/session-shares/${created.body.share.id}/accept`,
      {
        method: 'POST',
        token: aliceToken,
        headers: { 'idempotency-key': 'stolen-accept-1' },
        body: {},
      },
    );
    assert.equal(stolen.status, 403);
    assert.equal(stolen.body.error.code, 'ACCOUNT_SHARE_NOT_GRANTEE');
  });

  test('block rejects inbound requests', async () => {
    const blocked = await request('/api/v1/account/session-share-blocks/bob', {
      method: 'PUT',
      token: aliceToken,
      headers: { 'idempotency-key': 'block-bob-1' },
    });
    assert.equal(blocked.status, 200);
    const created = await request('/api/v1/account/session-shares', {
      method: 'POST',
      token: bobToken,
      headers: { 'idempotency-key': 'blocked-create-1' },
      body: {
        granteeUsername: 'alice',
        includePersonal: true,
        includeOwned: true,
        includeEditor: true,
        canJoinAs: 'editor',
      },
    });
    assert.equal(created.status, 403);
    assert.equal(created.body.error.code, 'ACCOUNT_SHARE_BLOCKED');
  });
});
