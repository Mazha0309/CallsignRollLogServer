import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
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
