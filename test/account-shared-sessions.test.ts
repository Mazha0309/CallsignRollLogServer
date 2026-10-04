import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { validatePersonalSnapshot } from '../src/personal-snapshot/model';
import {
  acceptShareRequest,
  createShareRequest,
} from '../src/account-share/service';

const JWT_SECRET = 'shared-sessions-test-jwt-secret-32-bytes-min';
const JWT_ISSUER = 'shared-sessions-test';
const BOB = 'user-bob-shared';
const ALICE = 'user-alice-shared';
const CAROL = 'user-carol-shared';
const NOW = '2026-09-13T12:00:00.000Z';
const OWNED = 'session-owned-shared';
const EDITOR = 'session-editor-shared';
const VIEWER = 'session-viewer-shared';

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

function insertSession(
  db: ReturnType<typeof openDatabase>,
  id: string,
  title: string,
  ownerId: string,
) {
  db.prepare(`
    INSERT INTO sessions (
      id, title, status, owner_user_id, version, event_seq,
      min_retained_seq, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, 1, 0, 0, ?, ?)
  `).run(id, title, ownerId, NOW, NOW);
}

function insertMember(
  db: ReturnType<typeof openDatabase>,
  sessionId: string,
  userId: string,
  role: 'owner' | 'editor' | 'viewer',
) {
  db.prepare(`
    INSERT INTO session_members (
      id, session_id, user_id, role, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(randomUUID(), sessionId, userId, role, NOW, NOW);
}

describe('shared session catalog', () => {
  let db: ReturnType<typeof openDatabase>;
  let server: Server;
  let baseUrl: string;
  let aliceToken: string;

  before(async () => {
    db = openDatabase(':memory:');
    insertUser(db, BOB, 'bob');
    insertUser(db, ALICE, 'alice');
    insertUser(db, CAROL, 'carol');
    insertSession(db, OWNED, 'Bob owned', BOB);
    insertMember(db, OWNED, BOB, 'owner');
    insertSession(db, EDITOR, 'Carol owned Bob editor', CAROL);
    insertMember(db, EDITOR, CAROL, 'owner');
    insertMember(db, EDITOR, BOB, 'editor');
    insertSession(db, VIEWER, 'Carol owned Bob viewer', CAROL);
    insertMember(db, VIEWER, CAROL, 'owner');
    insertMember(db, VIEWER, BOB, 'viewer');

    const snapshot = {
      version: 1 as const,
      exportedAt: '2026-09-13T12:01:02.000Z',
      sessions: [{
        session_id: 'personal-bob-1',
        title: 'Bob personal',
        status: 'closed' as const,
        created_at: NOW,
        updated_at: NOW,
        closed_at: NOW,
        deleted_at: null,
      }],
      logs: [{
        sync_id: 'personal-log-1',
        session_id: 'personal-bob-1',
        time: NOW,
        controller: 'BG5AAA',
        callsign: 'BG5BBB',
        rst_sent: '59',
        rst_rcvd: '59',
        qth: null,
        device: null,
        power: null,
        antenna: null,
        height: null,
        remarks: null,
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
        source_device_id: null,
      }],
    };
    const validated = validatePersonalSnapshot(snapshot);
    db.prepare(`
      INSERT INTO personal_cloud_snapshots (
        user_id, revision, format_version, snapshot_json,
        session_count, log_count, byte_size, checksum, created_at, updated_at
      ) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      BOB,
      JSON.stringify(validated.snapshot),
      validated.sessionCount,
      validated.logCount,
      validated.byteSize,
      validated.checksum,
      NOW,
      NOW,
    );

    const grant = createShareRequest(db, {
      grantorUserId: BOB,
      granteeUsername: 'alice',
      includePersonal: true,
      includeOwned: true,
      includeEditor: true,
      canJoinAs: 'editor',
      requestId: randomUUID(),
      mutationId: 'share-catalog-1',
    });
    acceptShareRequest(db, {
      grantId: grant.id,
      actorUserId: ALICE,
      requestId: randomUUID(),
      mutationId: 'accept-catalog-1',
    });

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

  test('shared catalog hides viewer sessions and marks editor read-only', async () => {
    const response = await fetch(`${baseUrl}/api/v1/account/shared-sessions`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const body = await response.json() as {
      items: Array<{ sessionId: string; canJoin: boolean; source: string }>;
    };
    assert.equal(response.status, 200);
    const ids = body.items.map((row) => row.sessionId);
    assert.ok(ids.includes(OWNED));
    assert.ok(ids.includes(EDITOR));
    assert.ok(ids.includes('personal-bob-1'));
    assert.equal(ids.includes(VIEWER), false);
    const editor = body.items.find((row) => row.sessionId === EDITOR);
    assert.equal(editor?.canJoin, false);
    const owned = body.items.find((row) => row.sessionId === OWNED);
    assert.equal(owned?.canJoin, false);
  });
});
