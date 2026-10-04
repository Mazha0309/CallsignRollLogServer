import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { AppConfig } from '../src/config';
import { openDatabase, runMigrations } from '../src/db/database';
import {
  getPublicShareAnalytics,
  listPublicShareAnalytics,
  maybeCleanupPublicShareViewSessions,
  readPublicShareAnalyticsSummary,
  recordPublicShareOpen,
} from '../src/operations/public-share-analytics';

const CONFIG: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'public-share-analytics-jwt-secret-at-least-32-bytes',
  jwtIssuer: 'public-share-analytics-test',
  bootstrapSecret: 'public-share-analytics-bootstrap-secret',
  inviteHmacKey: 'public-share-analytics-invite-hmac-key-at-least-32-bytes',
  publicShareHmacKey: 'public-share-analytics-public-hmac-key-at-least-32-bytes',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 86_400,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
};

const OWNER_ID = 'analytics-owner';
const MAIN_SESSION_ID = 'analytics-session';
const CREATED_AT = '2026-07-20T00:00:00.000Z';
const FUTURE_EXPIRY = '2026-07-30T00:00:00.000Z';

function insertSession(
  db: Database.Database,
  sessionId: string,
  title: string,
): void {
  db.prepare(`
    INSERT INTO sessions (
      id, title, status, owner_user_id, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?, ?)
  `).run(sessionId, title, OWNER_ID, CREATED_AT, CREATED_AT);
}

function insertShare(
  db: Database.Database,
  publicShareId: string,
  sessionId: string,
  expiresAt = FUTURE_EXPIRY,
): void {
  db.prepare(`
    INSERT INTO public_shares (
      id, session_id, credential_version, secret_hash,
      created_by, created_at, expires_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?)
  `).run(
    publicShareId,
    sessionId,
    createHash('sha256').update(publicShareId).digest('hex'),
    OWNER_ID,
    CREATED_AT,
    expiresAt,
  );
}

test('migrations v23-v24 persist bounded public share analytics with visitor IP details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openlogtool-public-share-analytics-'));
  const databasePath = join(directory, 'analytics.db');
  let db: Database.Database | undefined;
  try {
    db = openDatabase(databasePath);

    // Recreate the released v22 boundary and verify that v23-v24 can upgrade it in place.
    db.exec(`
      DROP TABLE llm_excel_correction_previews;
      DROP TABLE server_llm_credentials;
      DROP TABLE account_excel_export_settings;
      DROP TABLE public_share_view_sessions;
      DROP TABLE public_share_view_totals;
      DROP TABLE public_archive_aliases;
      DROP TABLE public_archive_list_logs;
      DROP TABLE public_archive_list_sessions;
      DROP TABLE public_archive_list_sources;
      DROP TABLE public_archive_list_members;
      DROP TABLE public_archive_lists;
      DROP TABLE account_share_audit_events;
      DROP TRIGGER trg_session_friend_owner_changed;
      DROP TABLE friend_requests;
      DROP TABLE friend_blocks;
      DROP TABLE session_friend_access;
      DROP TABLE session_access_requests;
      DROP TABLE social_audit_events;
      DROP TABLE session_join_passphrases;
      DROP TABLE account_share_blocks;
      DROP TABLE account_share_grants;
      DELETE FROM schema_migrations WHERE version IN (23, 24, 25, 26, 27, 28, 29, 30);
    `);
    assert.equal(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), 22);
    runMigrations(db);
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 23').get(),
      { version: 23, name: 'public_share_analytics' },
    );
    assert.deepEqual(
      db.prepare('SELECT version, name FROM schema_migrations WHERE version = 24').get(),
      { version: 24, name: 'public_share_visitor_ip' },
    );

    const totalsColumns = (
      db.pragma('table_info(public_share_view_totals)') as Array<{ name: string }>
    ).map((column) => column.name);
    assert.deepEqual(totalsColumns, [
      'public_share_id',
      'total_opens',
      'first_opened_at',
      'last_opened_at',
      'last_accessed_at',
      'count_saturated_at',
    ]);
    const sessionColumns = (
      db.pragma('table_info(public_share_view_sessions)') as Array<{ name: string }>
    ).map((column) => column.name);
    assert.deepEqual(sessionColumns, [
      'public_share_id',
      'view_session_hash',
      'first_seen_at',
      'last_seen_at',
      'last_ip_address',
    ]);
    assert.equal(
      (db.pragma('table_info(public_ws_tickets)') as Array<{ name: string }>)
        .some((column) => column.name === 'view_session_hash'),
      true,
    );
    assert.deepEqual(
      db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_public_share_view_%'
        ORDER BY name
      `).pluck().all(),
      [
        'idx_public_share_view_sessions_last_seen',
        'idx_public_share_view_totals_last_accessed',
      ],
    );

    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, 'analytics-owner', 'hash', 'admin', ?, ?)
    `).run(OWNER_ID, CREATED_AT, CREATED_AT);
    insertSession(db, MAIN_SESSION_ID, 'Analytics Session');
    insertShare(db, 'share-active', MAIN_SESSION_ID);

    const viewOne = '11111111-1111-4111-8111-111111111111';
    const viewTwo = '22222222-2222-4222-8222-222222222222';
    const firstAt = '2026-07-21T08:00:00.000Z';
    const repeatedAt = '2026-07-21T08:01:00.000Z';
    const secondAt = '2026-07-21T08:02:00.000Z';

    assert.deepEqual(
      db.transaction(() => recordPublicShareOpen(
        db!,
        CONFIG,
        'share-active',
        viewOne,
        firstAt,
        undefined,
        '203.0.113.10',
      )).deferred(),
      {
        newOpen: true,
        openCountSaturated: false,
        openCountSaturatedAt: null,
        totalOpens: 1,
        firstOpenedAt: firstAt,
        lastOpenedAt: firstAt,
        lastAccessedAt: firstAt,
      },
    );
    assert.deepEqual(
      recordPublicShareOpen(
        db,
        CONFIG,
        'share-active',
        viewOne,
        repeatedAt,
        undefined,
        '203.0.113.11',
      ),
      {
        newOpen: false,
        openCountSaturated: false,
        openCountSaturatedAt: null,
        totalOpens: 1,
        firstOpenedAt: firstAt,
        lastOpenedAt: firstAt,
        lastAccessedAt: repeatedAt,
      },
    );
    assert.equal(
      recordPublicShareOpen(db, CONFIG, 'share-active', viewTwo, secondAt).totalOpens,
      2,
    );

    insertShare(db, 'share-bounded', MAIN_SESSION_ID);
    const boundedLimits = { perShare: 2, total: 100 };
    recordPublicShareOpen(
      db,
      CONFIG,
      'share-bounded',
      '66666666-6666-4666-8666-666666666661',
      '2026-07-21T08:10:00.000Z',
      boundedLimits,
    );
    recordPublicShareOpen(
      db,
      CONFIG,
      'share-bounded',
      '66666666-6666-4666-8666-666666666662',
      '2026-07-21T08:11:00.000Z',
      boundedLimits,
    );
    const saturated = recordPublicShareOpen(
      db,
      CONFIG,
      'share-bounded',
      '66666666-6666-4666-8666-666666666663',
      '2026-07-21T08:12:00.000Z',
      boundedLimits,
    );
    assert.equal(saturated.newOpen, true);
    assert.equal(saturated.totalOpens, 3);
    assert.equal(saturated.openCountSaturated, true);
    assert.equal(saturated.openCountSaturatedAt, '2026-07-21T08:12:00.000Z');
    const afterSaturation = recordPublicShareOpen(
      db,
      CONFIG,
      'share-bounded',
      '66666666-6666-4666-8666-666666666664',
      '2026-07-21T08:13:00.000Z',
      boundedLimits,
    );
    assert.equal(afterSaturation.newOpen, false);
    assert.equal(afterSaturation.totalOpens, 3);
    assert.equal(afterSaturation.openCountSaturated, true);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM public_share_view_sessions
        WHERE public_share_id = 'share-bounded'
      `).pluck().get(),
      2,
      'active-share detail storage must stop at the hard per-share bound',
    );

    insertShare(db, 'share-global-bounded', MAIN_SESSION_ID);
    const globalSaturated = recordPublicShareOpen(
      db,
      CONFIG,
      'share-global-bounded',
      '77777777-7777-4777-8777-777777777771',
      '2026-07-21T08:14:00.000Z',
      { perShare: 10, total: 4 },
    );
    assert.equal(globalSaturated.totalOpens, 1);
    assert.equal(globalSaturated.openCountSaturated, true);
    recordPublicShareOpen(
      db,
      CONFIG,
      'share-global-bounded',
      '77777777-7777-4777-8777-777777777772',
      '2026-07-21T08:15:00.000Z',
      { perShare: 10, total: 4 },
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM public_share_view_sessions').pluck().get(),
      4,
      'global detail storage must remain at its hard bound',
    );

    const storedViewRows = db.prepare(`
      SELECT view_session_hash, first_seen_at, last_seen_at, last_ip_address
      FROM public_share_view_sessions
      WHERE public_share_id = 'share-active'
      ORDER BY first_seen_at
    `).all() as Array<{
      view_session_hash: string;
      first_seen_at: string;
      last_seen_at: string;
      last_ip_address: string | null;
    }>;
    assert.equal(storedViewRows.length, 2);
    assert.match(storedViewRows[0].view_session_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(storedViewRows[0].view_session_hash, storedViewRows[1].view_session_hash);
    assert.equal(storedViewRows[0].last_seen_at, repeatedAt);
    assert.equal(storedViewRows[0].last_ip_address, '203.0.113.11');
    const serializedPrivateRows = JSON.stringify(storedViewRows);
    assert.equal(serializedPrivateRows.includes(viewOne), false);
    assert.equal(serializedPrivateRows.includes(viewTwo), false);

    assert.throws(
      () => db!.prepare(`
        INSERT INTO public_share_view_sessions (
          public_share_id, view_session_hash, first_seen_at, last_seen_at
        ) VALUES ('share-active', ?, ?, ?)
      `).run('A'.repeat(64), firstAt, firstAt),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db!.prepare(`
        INSERT INTO public_share_view_totals (
          public_share_id, total_opens, first_opened_at, last_opened_at, last_accessed_at
        ) VALUES ('missing-share', 0, ?, ?, ?)
      `).run(firstAt, firstAt, firstAt),
      /CHECK constraint failed/,
    );

    db.close();
    db = openDatabase(databasePath);
    const afterRestart = getPublicShareAnalytics(db, 'share-active', secondAt);
    assert.equal(afterRestart?.totalOpens, 2);
    assert.equal(afterRestart?.sessionTitle, 'Analytics Session');
    assert.equal(afterRestart?.status, 'active');
    assert.equal(
      recordPublicShareOpen(db, CONFIG, 'share-active', viewOne, '2026-07-21T08:03:00.000Z')
        .totalOpens,
      2,
      'deduplication must survive a server/database restart',
    );

    insertShare(db, 'share-revoked', MAIN_SESSION_ID);
    insertShare(db, 'share-expired', MAIN_SESSION_ID, '2026-07-21T12:00:00.000Z');
    insertSession(db, 'analytics-deleted-session', 'Deleted Session');
    insertShare(db, 'share-session-deleted', 'analytics-deleted-session');

    const auxiliaryViews = [
      ['share-revoked', '33333333-3333-4333-8333-333333333333'],
      ['share-expired', '44444444-4444-4444-8444-444444444444'],
      ['share-session-deleted', '55555555-5555-4555-8555-555555555555'],
    ] as const;
    for (const [shareId, viewId] of auxiliaryViews) {
      recordPublicShareOpen(db, CONFIG, shareId, viewId, '2026-07-21T10:00:00.000Z');
    }
    db.prepare(`
      UPDATE public_shares SET revoked_at = ?, revoked_by = ? WHERE id = 'share-revoked'
    `).run('2026-07-21T11:00:00.000Z', OWNER_ID);
    db.prepare(`
      UPDATE sessions SET deleted_at = ?, status = 'closed'
      WHERE id = 'analytics-deleted-session'
    `).run('2026-07-21T11:30:00.000Z');

    const cleanup = maybeCleanupPublicShareViewSessions(
      db,
      '2026-07-21T12:05:00.000Z',
    );
    assert.deepEqual(cleanup, {
      attempted: true,
      deletedViewSessions: 3,
      failed: false,
    });
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM public_share_view_sessions').pluck().get(),
      4,
      'active-share deduplication rows must remain',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM public_share_view_totals').pluck().get(),
      6,
      'cleanup must preserve all aggregate totals',
    );
    assert.equal(
      maybeCleanupPublicShareViewSessions(db, '2026-07-21T12:06:00.000Z').attempted,
      false,
      'cleanup must be throttled per database connection',
    );

    const analytics = listPublicShareAnalytics(
      db,
      '2026-07-21T12:06:00.000Z',
      { limit: 20 },
    );
    const byId = new Map(analytics.map((item) => [item.publicShareId, item]));
    assert.deepEqual(
      [...byId.entries()].map(([id, item]) => [id, item.status]).sort(),
      [
        ['share-active', 'active'],
        ['share-bounded', 'active'],
        ['share-expired', 'expired'],
        ['share-global-bounded', 'active'],
        ['share-revoked', 'revoked'],
        ['share-session-deleted', 'sessionDeleted'],
      ],
    );
    assert.equal(byId.get('share-revoked')?.totalOpens, 1);
    assert.equal(byId.get('share-expired')?.lastAccessedAt, '2026-07-21T10:00:00.000Z');
    assert.equal(byId.get('share-session-deleted')?.sessionTitle, 'Deleted Session');
    assert.equal(byId.get('share-session-deleted')?.sessionDeleted, true);

    assert.deepEqual(
      readPublicShareAnalyticsSummary(db, '2026-07-21T12:06:00.000Z'),
      {
        shares: {
          total: 6,
          active: 3,
          revoked: 1,
          expired: 1,
          sessionDeleted: 1,
          everOpened: 6,
          saturated: 2,
        },
        totalOpens: 9,
        firstOpenedAt: firstAt,
        lastOpenedAt: '2026-07-21T10:00:00.000Z',
        lastAccessedAt: '2026-07-21T10:00:00.000Z',
      },
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    runMigrations(db);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM schema_migrations WHERE version = 23').pluck().get(),
      1,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM schema_migrations WHERE version = 24').pluck().get(),
      1,
    );
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
