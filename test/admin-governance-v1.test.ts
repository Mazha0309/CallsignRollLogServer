import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { createApp } from '../src/app';
import {
  EMPTY_FIELD_REVISIONS,
  getLiveDraftLockManager,
} from '../src/collaboration/live-draft';
import { getRealtimeHub } from '../src/collaboration/realtime';
import type { AppConfig } from '../src/config';
import { openDatabase } from '../src/db/database';

type JsonObject = Record<string, any>;

interface HttpResult {
  status: number;
  headers: Headers;
  body: JsonObject;
  text: string;
}

interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; username: string; role: string };
}

const adminPassword = 'Governance-admin-password-123!';
const config: AppConfig = {
  port: 0,
  dbPath: ':memory:',
  jwtSecret: 'governance-test-jwt-secret-4387c917-07a3-41e6-892f-6fc85ea4d38d',
  jwtIssuer: 'openlogtool-governance-test',
  bootstrapSecret: 'governance-bootstrap-secret-a804166f-2762-4971',
  inviteHmacKey: 'governance-invite-key-833ce95b-c3f9-44bf-a205',
  publicShareHmacKey: 'governance-public-key-5c63905d-5f19-458e-bc92',
  accessTokenTtlSeconds: 300,
  refreshTokenTtlSeconds: 3_600,
  corsOrigins: [],
  trustProxy: false,
  jsonBodyLimit: '1mb',
  rateLimitEnabled: false,
  environment: 'test',
  containerMode: true,
};

function assertError(result: HttpResult, status: number, code: string): void {
  assert.equal(result.status, status, result.text);
  assert.equal(result.body.error?.code, code, result.text);
}

describe('v1 administrator governance API', { concurrency: false }, () => {
  let directory: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let runtimeConfig: AppConfig;
  let admin: AuthResult;
  let member: AuthResult;
  let resetTarget: AuthResult;
  let elevationToken: string;

  async function request(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'x-request-id': randomUUID(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) as JsonObject : {},
      text,
    };
  }

  async function register(username: string, password: string): Promise<AuthResult> {
    const result = await request('/api/v1/auth/register', {
      method: 'POST',
      body: { username, password },
    });
    assert.equal(result.status, 201, result.text);
    return result.body as AuthResult;
  }

  function commandHeaders(label: string, elevated = false): Record<string, string> {
    return {
      'idempotency-key': `${label}-${randomUUID()}`,
      ...(elevated ? { 'x-admin-elevation': elevationToken } : {}),
    };
  }

  function refreshTokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  function seedSession(input: {
    sessionId: string;
    syncId: string;
    deleted?: boolean;
  }): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at, closed_at, closed_by, deleted_at
      ) VALUES (?, ?, 'closed', ?, 1, 0, 0, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      `Title ${input.sessionId}`,
      member.user.id,
      now,
      now,
      now,
      member.user.id,
      input.deleted ? now : null,
    );
    db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
    `).run(randomUUID(), input.sessionId, member.user.id, now, now);
    db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, version, time, controller, callsign,
        rst_sent, rst_rcvd, qth, remarks, created_at, updated_at,
        created_by, updated_by, source_device_id
      ) VALUES (?, ?, 1, ?, 'BA1CTRL', 'BA1OLD', '59', '59', 'Beijing',
                'original', ?, ?, ?, ?, 'seed-device')
    `).run(input.syncId, input.sessionId, now, now, now, member.user.id, member.user.id);
  }

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openlogtool-governance-'));
    db = openDatabase(join(directory, 'governance.db'));
    const app = createApp({ db, config });
    runtimeConfig = (app.locals.openLogTool as { config: AppConfig }).config;
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const bootstrap = await request('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'x-bootstrap-secret': config.bootstrapSecret },
      body: { username: 'governanceadmin', password: adminPassword },
    });
    assert.equal(bootstrap.status, 201, bootstrap.text);
    admin = bootstrap.body as AuthResult;
    member = await register('governancemember', 'Governance-member-password-123!');
    resetTarget = await register('governancetarget', 'Governance-target-password-123!');

    const elevation = await request('/api/v1/admin/elevate', {
      method: 'POST',
      token: admin.accessToken,
      body: { password: adminPassword },
    });
    assert.equal(elevation.status, 200, elevation.text);
    elevationToken = String(elevation.body.elevationToken);

    seedSession({ sessionId: 'governance-closed', syncId: 'governance-log' });
    seedSession({
      sessionId: 'governance-deleted-source',
      syncId: 'governance-deleted-log',
      deleted: true,
    });
  });

  after(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    db?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test('global administrators can inspect non-member Sessions while members cannot enter governance', async () => {
    const forbidden = await request('/api/v1/admin/sessions', { token: member.accessToken });
    assertError(forbidden, 403, 'ADMIN_REQUIRED');

    const listed = await request('/api/v1/admin/sessions?includeDeleted=true&pageSize=10', {
      token: admin.accessToken,
    });
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(
      new Set(listed.body.items.map((item: JsonObject) => item.sessionId)),
      new Set(['governance-closed', 'governance-deleted-source']),
    );

    const accessId = randomUUID();
    for (let page = 1; page <= 2; page += 1) {
      const logs = await request(`/api/v1/admin/sessions/governance-closed/logs?page=${page}&pageSize=1`, {
        token: admin.accessToken,
        headers: { 'x-admin-access-id': accessId },
      });
      assert.equal(logs.status, 200, logs.text);
    }
    const auditCount = db.prepare(`
      SELECT COUNT(*) FROM admin_governance_audit_events
      WHERE action = 'session.records.viewed' AND session_id = ?
    `).pluck().get('governance-closed');
    assert.equal(Number(auditCount), 1, 'one detail visit must produce one deduplicated read audit');

    const collisionAccessId = randomUUID();
    const oldPredictableMutationId = [
      'read',
      admin.user.id,
      'governance-closed',
      'session.records.viewed',
      Math.floor(Date.now() / (15 * 60_000)),
      collisionAccessId,
    ].join(':');
    db.prepare(`
      INSERT INTO admin_governance_audit_events (
        id, action, actor_user_id, target_type, target_id, session_id,
        request_id, mutation_id, reason, before_json, after_json,
        details_json, occurred_at
      ) VALUES (?, 'server.operational_settings.updated', ?, 'session', ?, ?,
                ?, ?, 'Collision regression fixture', NULL, NULL, '{}', ?)
    `).run(
      randomUUID(),
      admin.user.id,
      'governance-closed',
      'governance-closed',
      randomUUID(),
      oldPredictableMutationId,
      new Date().toISOString(),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const logs = await request('/api/v1/admin/sessions/governance-closed/logs?pageSize=1', {
        token: admin.accessToken,
        headers: { 'x-admin-access-id': collisionAccessId },
      });
      assert.equal(logs.status, 200, logs.text);
    }
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM admin_governance_audit_events
      WHERE action = 'session.records.viewed' AND session_id = ?
    `).pluck().get('governance-closed')), 2,
    'a colliding write mutation must not suppress the read audit, while the real read still deduplicates');
    assert.throws(
      () => db.prepare(`
        UPDATE admin_governance_audit_events SET reason = 'tampered'
        WHERE action = 'session.records.viewed' AND session_id = ?
      `).run('governance-closed'),
      /append-only/,
    );
  });

  test('administrators can keep another account signed in without bypassing revocation', async () => {
    const username = `persistent-${randomUUID().slice(0, 8)}`;
    const password = 'Persistent-login-password-123!';
    const target = await register(username, password);
    const endpoint = `/api/v1/admin/users/${target.user.id}/login-expiration`;
    const body = {
      loginNeverExpires: true,
      reason: 'Keep this managed station signed in',
    };

    const forbidden = await request(endpoint, {
      method: 'PATCH',
      token: member.accessToken,
      headers: commandHeaders('persistent-member', true),
      body,
    });
    assertError(forbidden, 403, 'ADMIN_REQUIRED');

    const missingElevation = await request(endpoint, {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('persistent-no-elevation'),
      body,
    });
    assertError(missingElevation, 403, 'ADMIN_ELEVATION_REQUIRED');

    const invalid = await request(endpoint, {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('persistent-invalid', true),
      body: {
        loginNeverExpires: 'yes',
        reason: 'Reject invalid policy input',
      },
    });
    assertError(invalid, 422, 'VALIDATION_FAILED');

    const selfChange = await request(
      `/api/v1/admin/users/${admin.user.id}/login-expiration`,
      {
        method: 'PATCH',
        token: admin.accessToken,
        headers: commandHeaders('persistent-self', true),
        body,
      },
    );
    assertError(selfChange, 409, 'SELF_LOGIN_EXPIRATION_FORBIDDEN');

    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const staleToken = `stale-${randomUUID()}`;
    const staleTokenId = randomUUID();
    db.prepare(`
      INSERT INTO refresh_tokens (
        id, user_id, token_hash, auth_session_id, issued_auth_version,
        created_at, expires_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      staleTokenId,
      target.user.id,
      refreshTokenHash(staleToken),
      staleTokenId,
      Number(db.prepare('SELECT auth_version FROM users WHERE id = ?').pluck().get(target.user.id)),
      new Date(Date.now() - 120_000).toISOString(),
      expiredAt,
      expiredAt,
    );
    const enableHeaders = commandHeaders('persistent-enable', true);
    const enabled = await request(endpoint, {
      method: 'PATCH',
      token: admin.accessToken,
      headers: enableHeaders,
      body,
    });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.body.loginNeverExpires, true);
    assert.equal(enabled.body.changed, true);
    assert.equal(enabled.body.updatedDeviceSessionCount, 1);
    assert.equal(
      db.prepare('SELECT expires_at FROM refresh_tokens WHERE token_hash = ?').pluck()
        .get(refreshTokenHash(target.refreshToken)),
      '9999-12-31T23:59:59.999Z',
      'only a currently valid device session is extended',
    );
    assertError(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: staleToken },
    }), 401, 'REFRESH_TOKEN_INVALID');

    const replay = await request(endpoint, {
      method: 'PATCH',
      token: admin.accessToken,
      headers: enableHeaders,
      body,
    });
    assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.body, enabled.body);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM admin_governance_audit_events
      WHERE action = 'user.login_expiration.updated' AND target_id = ?
    `).pluck().get(target.user.id)), 1);

    const listed = await request(`/api/v1/admin/users?q=${encodeURIComponent(username)}`, {
      token: admin.accessToken,
    });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.items[0]?.loginNeverExpires, true);
    const detail = await request(`/api/v1/admin/users/${target.user.id}`, {
      token: admin.accessToken,
      headers: { 'x-admin-access-id': `persistent-${randomUUID()}` },
    });
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.user.loginNeverExpires, true);

    const originalHash = refreshTokenHash(target.refreshToken);
    await register(`cleanup-${randomUUID().slice(0, 8)}`, 'Cleanup-password-123!');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM refresh_tokens WHERE token_hash = ?').pluck()
        .get(originalHash),
      1,
      'ordinary token cleanup must retain an active persistent session',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM refresh_tokens WHERE token_hash = ?').pluck()
        .get(refreshTokenHash(staleToken)),
      0,
      'ordinary cleanup removes the already-expired credential instead of reviving it',
    );

    const refreshed = await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: target.refreshToken },
    });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.equal(refreshed.body.refreshTokenExpiresAt, '9999-12-31T23:59:59.999Z');
    const retiredOriginal = db.prepare(`
      SELECT expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?
    `).get(originalHash) as { expires_at: string; revoked_at: string | null };
    assert.equal(typeof retiredOriginal.revoked_at, 'string');
    assert.notEqual(retiredOriginal.expires_at, '9999-12-31T23:59:59.999Z');
    assert.ok(Date.parse(retiredOriginal.expires_at) > Date.now());

    const webLogin = await request('/api/v1/web-auth/login', {
      method: 'POST',
      body: { username, password },
    });
    assert.equal(webLogin.status, 200, webLogin.text);
    const firstSetCookie = webLogin.headers.get('set-cookie') ?? '';
    assert.match(firstSetCookie, /Expires=[^;]*9999/i);
    const firstCookie = firstSetCookie.split(';', 1)[0];
    const webRefreshed = await request('/api/v1/web-auth/refresh', {
      method: 'POST',
      headers: { cookie: firstCookie },
      body: {},
    });
    assert.equal(webRefreshed.status, 200, webRefreshed.text);
    const secondSetCookie = webRefreshed.headers.get('set-cookie') ?? '';
    assert.match(secondSetCookie, /Expires=[^;]*9999/i);
    const secondCookie = secondSetCookie.split(';', 1)[0];
    const secondWebToken = decodeURIComponent(secondCookie.slice(secondCookie.indexOf('=') + 1));

    const disabled = await request(endpoint, {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('persistent-disable', true),
      body: {
        loginNeverExpires: false,
        reason: 'Restore the standard login expiration policy',
      },
    });
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal(disabled.body.loginNeverExpires, false);
    assert.ok(Number(disabled.body.updatedDeviceSessionCount) >= 2);

    db.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE token_hash IN (?, ?)').run(
      expiredAt,
      refreshTokenHash(String(refreshed.body.refreshToken)),
      refreshTokenHash(secondWebToken),
    );
    assertError(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: refreshed.body.refreshToken },
    }), 401, 'REFRESH_TOKEN_INVALID');
    const expiredWeb = await request('/api/v1/web-auth/refresh', {
      method: 'POST',
      headers: { cookie: secondCookie },
      body: {},
    });
    assertError(expiredWeb, 401, 'REFRESH_TOKEN_INVALID');
    assert.match(expiredWeb.headers.get('set-cookie') ?? '', /olt_web_refresh=;/);

    const reenabled = await request(endpoint, {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('persistent-reenable', true),
      body,
    });
    assert.equal(reenabled.status, 200, reenabled.text);
    assert.equal(reenabled.body.updatedDeviceSessionCount, 0);
    assertError(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: refreshed.body.refreshToken },
    }), 401, 'REFRESH_TOKEN_INVALID');
    const relogin = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    assert.equal(relogin.status, 200, relogin.text);
    const reloginHash = refreshTokenHash(String(relogin.body.refreshToken));
    assert.equal(
      db.prepare('SELECT expires_at FROM refresh_tokens WHERE token_hash = ?').pluck()
        .get(reloginHash),
      '9999-12-31T23:59:59.999Z',
    );
    const revoked = await request(
      `/api/v1/admin/users/${target.user.id}/revoke-refresh-tokens`,
      {
        method: 'POST',
        token: admin.accessToken,
        headers: commandHeaders('persistent-revoke', true),
        body: { reason: 'Explicitly revoke every managed station login' },
      },
    );
    assert.equal(revoked.status, 200, revoked.text);
    assert.ok(Number(revoked.body.revokedRefreshTokenCount) >= 1);
    assert.equal(
      typeof db.prepare('SELECT revoked_at FROM refresh_tokens WHERE token_hash = ?').pluck()
        .get(reloginHash),
      'string',
    );
    assertError(await request('/api/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: relogin.body.refreshToken },
    }), 401, 'REFRESH_TOKEN_INVALID');
  });

  test('login expiration policy and device expiry roll back with a failed audit write', async () => {
    const target = await register(
      `persistent-rollback-${randomUUID().slice(0, 8)}`,
      'Persistent-rollback-password-123!',
    );
    const tokenHash = refreshTokenHash(target.refreshToken);
    const beforeExpiry = String(db.prepare(`
      SELECT expires_at FROM refresh_tokens WHERE token_hash = ?
    `).pluck().get(tokenHash));
    const headers = commandHeaders('persistent-audit-rollback', true);
    db.exec(`
      CREATE TEMP TRIGGER fail_login_expiration_audit
      BEFORE INSERT ON admin_governance_audit_events
      WHEN NEW.action = 'user.login_expiration.updated'
      BEGIN
        SELECT RAISE(ABORT, 'forced login expiration audit failure');
      END;
    `);
    try {
      const result = await request(
        `/api/v1/admin/users/${target.user.id}/login-expiration`,
        {
          method: 'PATCH',
          token: admin.accessToken,
          headers,
          body: {
            loginNeverExpires: true,
            reason: 'Verify atomic persistent login policy updates',
          },
        },
      );
      assertError(result, 500, 'INTERNAL_ERROR');
      assert.equal(
        db.prepare('SELECT login_never_expires FROM users WHERE id = ?').pluck()
          .get(target.user.id),
        0,
      );
      assert.equal(
        db.prepare('SELECT expires_at FROM refresh_tokens WHERE token_hash = ?').pluck()
          .get(tokenHash),
        beforeExpiry,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?').pluck()
          .get(headers['idempotency-key']),
        0,
      );
    } finally {
      db.exec('DROP TRIGGER fail_login_expiration_audit');
    }
  });

  test('an elevated administrator can atomically discard a blocking live draft and close before deletion', async (t) => {
    const sessionId = `governance-blocked-${randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO sessions (
        id, title, status, owner_user_id, version, event_seq, min_retained_seq,
        created_at, updated_at
      ) VALUES (?, 'Blocked active Session', 'active', ?, 1, 0, 0, ?, ?)
    `).run(sessionId, member.user.id, now, now);
    db.prepare(`
      INSERT INTO session_members (
        id, session_id, user_id, role, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 1, ?, ?)
    `).run(randomUUID(), sessionId, member.user.id, now, now);
    const draftId = randomUUID();
    db.prepare(`
      INSERT INTO session_live_drafts (
        session_id, draft_id, version, callsign, rst_sent, rst_rcvd,
        field_revisions_json, last_updated_by, created_at, last_updated_at
      ) VALUES (?, ?, 3, 'BG5BLOCKED', '59', '59', ?, ?, ?, ?)
    `).run(
      sessionId,
      draftId,
      JSON.stringify(EMPTY_FIELD_REVISIONS),
      member.user.id,
      now,
      now,
    );
    db.prepare(`
      INSERT INTO live_draft_device_state (
        session_id, user_id, device_id, last_client_seq,
        request_hash, response_json, updated_at
      ) VALUES (?, ?, 'blocked-device', 1, ?, '{}', ?)
    `).run(sessionId, member.user.id, 'a'.repeat(64), now);
    getLiveDraftLockManager(db).acquire({
      sessionId,
      field: 'callsign',
      userId: member.user.id,
      username: member.user.username,
      deviceId: 'blocked-device',
    });

    const ordinaryClose = await request(`/api/v1/admin/sessions/${sessionId}/close`, {
      method: 'POST',
      token: admin.accessToken,
      headers: commandHeaders('blocked-ordinary-close'),
      body: { expectedVersion: 1 },
    });
    assertError(ordinaryClose, 409, 'LIVE_DRAFT_NOT_EMPTY');

    const withoutElevation = await request(
      `/api/v1/admin/sessions/${sessionId}/close-discarding-live-draft`,
      {
        method: 'POST',
        token: admin.accessToken,
        headers: commandHeaders('blocked-force-close-no-elevation'),
        body: { expectedVersion: 1, reason: 'Remove a stuck test Session' },
      },
    );
    assertError(withoutElevation, 403, 'ADMIN_ELEVATION_REQUIRED');

    const stale = await request(
      `/api/v1/admin/sessions/${sessionId}/close-discarding-live-draft`,
      {
        method: 'POST',
        token: admin.accessToken,
        headers: commandHeaders('blocked-force-close-stale', true),
        body: { expectedVersion: 2, reason: 'Remove a stuck test Session' },
      },
    );
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.result?.status, 'conflict', stale.text);
    assert.ok(db.prepare('SELECT 1 FROM session_live_drafts WHERE session_id = ?').get(sessionId));
    assert.equal(getLiveDraftLockManager(db).list(sessionId).length, 1);

    db.exec(`
      CREATE TEMP TRIGGER fail_force_close_audit
      BEFORE INSERT ON admin_governance_audit_events
      WHEN NEW.action = 'session.closed_with_live_draft_discard'
      BEGIN
        SELECT RAISE(ABORT, 'forced force-close audit failure');
      END;
    `);
    try {
      const failed = await request(
        `/api/v1/admin/sessions/${sessionId}/close-discarding-live-draft`,
        {
          method: 'POST',
          token: admin.accessToken,
          headers: commandHeaders('blocked-force-close-audit-failure', true),
          body: { expectedVersion: 1, reason: 'Verify atomic forced close' },
        },
      );
      assertError(failed, 500, 'INTERNAL_ERROR');
      const unchanged = db.prepare(`
        SELECT status, version, event_seq FROM sessions WHERE id = ?
      `).get(sessionId) as { status: string; version: number; event_seq: number };
      assert.deepEqual(unchanged, { status: 'active', version: 1, event_seq: 0 });
      assert.ok(db.prepare('SELECT 1 FROM session_live_drafts WHERE session_id = ?').get(sessionId));
      assert.equal(db.prepare('SELECT COUNT(*) FROM live_draft_device_state WHERE session_id = ?').pluck().get(sessionId), 1);
      assert.equal(getLiveDraftLockManager(db).list(sessionId).length, 1);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_force_close_audit');
    }

    const deliveredEvents: unknown[] = [];
    const deliveredControls: unknown[] = [];
    const unsubscribe = getRealtimeHub(db).add({
      audience: 'member',
      sessionId,
      userId: member.user.id,
      ipAddress: 'governance-test',
      deliver(event) { deliveredEvents.push(event); },
      deliverControl(control) { deliveredControls.push(control); },
      revoke() { /* probe */ },
      membershipChanged() { /* probe */ },
      sessionDeleted() { /* probe */ },
      close() { /* probe */ },
    });
    t.after(unsubscribe);

    const forceCloseKey = `blocked-force-close-${randomUUID()}`;
    const forceCloseOptions = {
      method: 'POST',
      token: admin.accessToken,
      headers: {
        'idempotency-key': forceCloseKey,
        'x-admin-elevation': elevationToken,
      },
      body: { expectedVersion: 1, reason: 'Remove a stuck test Session' },
    };
    const forceClosed = await request(
      `/api/v1/admin/sessions/${sessionId}/close-discarding-live-draft`,
      forceCloseOptions,
    );
    assert.equal(forceClosed.status, 200, forceClosed.text);
    assert.equal(forceClosed.body.result?.status, 'accepted', forceClosed.text);
    assert.equal(forceClosed.body.result?.event?.type, 'session.closed', forceClosed.text);
    const cleared = forceClosed.body.result.event.payload.liveDraftCleared as JsonObject;
    assert.equal(cleared.terminal, true);
    assert.equal(cleared.discardedDraftId, draftId);
    assert.equal(cleared.discardedDraftVersion, 3);
    assert.equal(cleared.discardedDeviceStateCount, 1);
    assert.notEqual(cleared.nextDraft.draftId, draftId);
    assert.equal(cleared.nextDraft.sessionId, sessionId);
    assert.equal(cleared.nextDraft.version, 4);
    assert.deepEqual(cleared.nextDraft.fields, {
      time: null,
      controller: null,
      callsign: null,
      rstSent: '59',
      rstRcvd: '59',
      qth: null,
      device: null,
      power: null,
      antenna: null,
      height: null,
      remarks: null,
    });
    assert.deepEqual(cleared.nextDraft.fieldRevisions, EMPTY_FIELD_REVISIONS);
    const storedCloseEvent = JSON.parse(String(db.prepare(`
      SELECT payload_json
      FROM session_events
      WHERE session_id = ? AND type = 'session.closed'
    `).pluck().get(sessionId))) as JsonObject;
    assert.deepEqual(storedCloseEvent.payload.liveDraftCleared, cleared);
    assert.ok(!JSON.stringify(storedCloseEvent).includes('BG5BLOCKED'));
    assert.equal(deliveredEvents.length, 1);
    assert.deepEqual(
      (deliveredEvents[0] as JsonObject).payload.liveDraftCleared,
      cleared,
    );
    assert.equal(deliveredControls.length, 1);
    const clearControl = deliveredControls[0] as JsonObject;
    assert.equal(clearControl.type, 'liveDraft.cleared');
    assert.equal(clearControl.discardedDraftId, draftId);
    assert.equal(clearControl.terminal, true);
    assert.deepEqual(clearControl.nextDraft, cleared.nextDraft);
    assert.ok(!JSON.stringify(clearControl).includes('BG5BLOCKED'));
    const closed = db.prepare(`
      SELECT status, version, closed_at FROM sessions WHERE id = ?
    `).get(sessionId) as { status: string; version: number; closed_at: string | null };
    assert.equal(closed.status, 'closed');
    assert.equal(Number(closed.version), 2);
    assert.equal(typeof closed.closed_at, 'string');
    assert.equal(db.prepare('SELECT COUNT(*) FROM session_live_drafts WHERE session_id = ?').pluck().get(sessionId), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM live_draft_device_state WHERE session_id = ?').pluck().get(sessionId), 0);
    assert.deepEqual(getLiveDraftLockManager(db).list(sessionId), []);

    const audit = db.prepare(`
      SELECT reason, details_json
      FROM admin_governance_audit_events
      WHERE session_id = ? AND action = 'session.closed_with_live_draft_discard'
    `).get(sessionId) as { reason: string; details_json: string };
    assert.equal(audit.reason, 'Remove a stuck test Session');
    const details = JSON.parse(audit.details_json) as JsonObject;
    assert.equal(details.discardedDraftId, draftId);
    assert.equal(details.discardedDeviceStateCount, 1);
    assert.equal(details.clearedActiveLockCount, 1);

    const replay = await request(
      `/api/v1/admin/sessions/${sessionId}/close-discarding-live-draft`,
      forceCloseOptions,
    );
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.deepEqual(replay.body, forceClosed.body);
    assert.equal(deliveredEvents.length, 1);
    assert.equal(deliveredControls.length, 1);

    const deleted = await request(`/api/v1/admin/sessions/${sessionId}`, {
      method: 'DELETE',
      token: admin.accessToken,
      headers: commandHeaders('delete-force-closed', true),
      body: { expectedVersion: 2, reason: 'Remove the closed test Session' },
    });
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.body.result?.status, 'accepted', deleted.text);
    assert.equal(deleted.body.result?.event?.type, 'session.deleted', deleted.text);
  });

  test('administrator corrections on a closed Session use the canonical event stream', async () => {
    const idempotencyKey = `admin-log-update-${randomUUID()}`;
    const update = await request('/api/v1/admin/sessions/governance-closed/logs/governance-log', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: { 'idempotency-key': idempotencyKey },
      body: { expectedVersion: 1, patch: { callsign: 'BA1NEW', remarks: 'admin correction' } },
    });
    assert.equal(update.status, 200, update.text);
    assert.equal(update.body.result.status, 'accepted');

    const row = db.prepare(`
      SELECT version, callsign, remarks, updated_by FROM logs
      WHERE session_id = ? AND sync_id = ?
    `).get('governance-closed', 'governance-log') as JsonObject;
    assert.deepEqual(row, {
      version: 2,
      callsign: 'BA1NEW',
      remarks: 'admin correction',
      updated_by: admin.user.id,
    });
    const event = db.prepare(`
      SELECT seq, type, actor_user_id FROM session_events
      WHERE session_id = ?
    `).get('governance-closed') as JsonObject;
    assert.deepEqual(event, { seq: 1, type: 'log.updated', actor_user_id: admin.user.id });
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM admin_governance_audit_events
      WHERE mutation_id = ? AND action = 'log.updated'
    `).pluck().get(idempotencyKey)), 1);

    const replay = await request('/api/v1/admin/sessions/governance-closed/logs/governance-log', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: { 'idempotency-key': idempotencyKey },
      body: { expectedVersion: 1, patch: { callsign: 'BA1NEW', remarks: 'admin correction' } },
    });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');

    const changedVersion = await request('/api/v1/admin/sessions/governance-closed/logs/governance-log', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: { 'idempotency-key': idempotencyKey },
      body: { expectedVersion: 2, patch: { callsign: 'BA1NEW', remarks: 'admin correction' } },
    });
    assertError(changedVersion, 409, 'MUTATION_ID_REUSED');
  });

  test('temporary passwords are displayed once and never persisted in audit or replay data', async () => {
    const idempotencyKey = `reset-password-${randomUUID()}`;
    const body = { reason: 'Account owner requested recovery' };
    const reset = await request(`/api/v1/admin/users/${resetTarget.user.id}/reset-password`, {
      method: 'POST',
      token: admin.accessToken,
      headers: {
        'idempotency-key': idempotencyKey,
        'x-admin-elevation': elevationToken,
      },
      body,
    });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(typeof reset.body.temporaryPassword, 'string');
    assert.ok(reset.body.temporaryPassword.length >= 20);

    const stored = String(db.prepare(`
      SELECT response_json FROM processed_mutations WHERE mutation_id = ?
    `).pluck().get(idempotencyKey));
    const audit = JSON.stringify(db.prepare(`
      SELECT before_json, after_json, details_json
      FROM admin_governance_audit_events WHERE mutation_id = ?
    `).get(idempotencyKey));
    assert.ok(!stored.includes(reset.body.temporaryPassword));
    assert.ok(!audit.includes(reset.body.temporaryPassword));

    const replay = await request(`/api/v1/admin/users/${resetTarget.user.id}/reset-password`, {
      method: 'POST',
      token: admin.accessToken,
      headers: {
        'idempotency-key': idempotencyKey,
        'x-admin-elevation': elevationToken,
      },
      body,
    });
    assertError(replay, 409, 'ONE_TIME_SECRET_ALREADY_ISSUED');

    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: resetTarget.user.username, password: reset.body.temporaryPassword },
    });
    assertError(login, 403, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal(typeof login.body.error.details?.passwordChangeToken, 'string');
  });

  test('concurrent password resets return only a temporary password that remains valid', async () => {
    const target = await register(
      `reset-race-${randomUUID().slice(0, 8)}`,
      'Reset-race-password-123!',
    );
    const body = { reason: 'Concurrent recovery regression test' };
    const results = await Promise.all([
      request(`/api/v1/admin/users/${target.user.id}/reset-password`, {
        method: 'POST',
        token: admin.accessToken,
        headers: commandHeaders('reset-race-a', true),
        body,
      }),
      request(`/api/v1/admin/users/${target.user.id}/reset-password`, {
        method: 'POST',
        token: admin.accessToken,
        headers: commandHeaders('reset-race-b', true),
        body,
      }),
    ]);
    const successful = results.filter((result) => result.status === 200);
    const conflicted = results.filter(
      (result) => result.status === 409 && result.body.error?.code === 'ACCOUNT_CHANGED',
    );
    assert.equal(successful.length, 1, JSON.stringify(results));
    assert.equal(conflicted.length, 1, JSON.stringify(results));
    assert.equal('temporaryPassword' in conflicted[0].body, false);

    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      body: {
        username: target.user.username,
        password: successful[0].body.temporaryPassword,
      },
    });
    assertError(login, 403, 'PASSWORD_CHANGE_REQUIRED');
  });

  test('user deletion cannot be blocked by pre-occupying its former predictable tombstone name', async () => {
    const target = await register(
      `delete-race-${randomUUID().slice(0, 8)}`,
      'Delete-race-password-123!',
    );
    const oldPredictableName = `deleted-${target.user.id}`;
    const now = new Date().toISOString();
    const snapshotJson = JSON.stringify({ privateMarker: 'must-not-appear-in-audit' });
    const dictionarySnapshotJson = JSON.stringify({
      privateDictionaryMarker: 'must-not-appear-in-audit',
    });
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, 'unusable-password-hash', 'user', ?, ?)
    `).run(randomUUID(), oldPredictableName, now, now);
    db.prepare(`
      INSERT INTO personal_cloud_snapshots (
        user_id, revision, format_version, snapshot_json,
        session_count, log_count, byte_size, checksum, created_at, updated_at
      ) VALUES (?, 1, 1, ?, 0, 0, ?, ?, ?, ?)
    `).run(
      target.user.id,
      snapshotJson,
      Buffer.byteLength(snapshotJson, 'utf8'),
      'a'.repeat(64),
      now,
      now,
    );
    db.prepare(`
      INSERT INTO personal_dictionary_snapshots (
        user_id, revision, format_version, snapshot_json,
        item_count, active_count, deleted_count, byte_size,
        checksum, created_at, updated_at
      ) VALUES (?, 1, 1, ?, 0, 0, 0, ?, ?, ?, ?)
    `).run(
      target.user.id,
      dictionarySnapshotJson,
      Buffer.byteLength(dictionarySnapshotJson, 'utf8'),
      'b'.repeat(64),
      now,
      now,
    );

    const disabled = await request(`/api/v1/admin/users/${target.user.id}/disable`, {
      method: 'POST',
      token: admin.accessToken,
      headers: commandHeaders('delete-race-disable', true),
      body: { reason: 'Deletion collision regression test' },
    });
    assert.equal(disabled.status, 200, disabled.text);
    const deleted = await request(`/api/v1/admin/users/${target.user.id}`, {
      method: 'DELETE',
      token: admin.accessToken,
      headers: commandHeaders('delete-race-delete', true),
      body: { reason: 'Deletion collision regression test' },
    });
    assert.equal(deleted.status, 200, deleted.text);
    assert.notEqual(deleted.body.tombstoneUsername, oldPredictableName);
    assert.match(String(deleted.body.tombstoneUsername), /^deleted-[0-9a-f-]{36}-[0-9a-f]{12}$/);
    assert.deepEqual(
      db.prepare('SELECT username, deleted_at FROM users WHERE id = ?').get(target.user.id),
      { username: deleted.body.tombstoneUsername, deleted_at: deleted.body.deletedAt },
    );
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM personal_cloud_snapshots WHERE user_id = ?
    `).pluck().get(target.user.id)), 0);
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM personal_dictionary_snapshots WHERE user_id = ?
    `).pluck().get(target.user.id)), 0);
    const audit = db.prepare(`
      SELECT details_json
      FROM admin_governance_audit_events
      WHERE action = 'user.deleted' AND target_type = 'user' AND target_id = ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `).get(target.user.id) as { details_json: string };
    const auditDetails = JSON.parse(audit.details_json) as JsonObject;
    assert.equal(auditDetails.removedPersonalSnapshot, true);
    assert.equal(
      auditDetails.removedPersonalSnapshotBytes,
      Buffer.byteLength(snapshotJson, 'utf8'),
    );
    assert.equal(auditDetails.removedPersonalDictionarySnapshot, true);
    assert.equal(
      auditDetails.removedPersonalDictionarySnapshotBytes,
      Buffer.byteLength(dictionarySnapshotJson, 'utf8'),
    );
    assert.equal(
      auditDetails.removedPersonalCloudBytes,
      Buffer.byteLength(snapshotJson, 'utf8') +
        Buffer.byteLength(dictionarySnapshotJson, 'utf8'),
    );
    assert.ok(!audit.details_json.includes('must-not-appear-in-audit'));
  });

  test('user deletion rejects published and unpublished archive list owners without mutation', async () => {
    for (const isPublished of [0, 1]) {
      const target = await register(
        `archive-owner-${isPublished}-${randomUUID().slice(0, 8)}`,
        'Archive-owner-password-123!',
      );
      const disabled = await request(`/api/v1/admin/users/${target.user.id}/disable`, {
        method: 'POST',
        token: admin.accessToken,
        headers: commandHeaders(`archive-owner-${isPublished}-disable`, true),
        body: { reason: 'Prepare archive owner deletion regression test' },
      });
      assert.equal(disabled.status, 200, disabled.text);
      const createdAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO public_archive_lists (
          id, title, owner_user_id, is_published, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), `Owned archive ${isPublished}`, target.user.id, isPublished, createdAt, createdAt);
      const mutationId = `archive-owner-delete-${isPublished}-${randomUUID()}`;
      const userBefore = db.prepare(`
        SELECT username, role, disabled_at, deleted_at, auth_version
        FROM users WHERE id = ?
      `).get(target.user.id);

      const deletion = await request(`/api/v1/admin/users/${target.user.id}`, {
        method: 'DELETE',
        token: admin.accessToken,
        headers: {
          'idempotency-key': mutationId,
          'x-admin-elevation': elevationToken,
        },
        body: { reason: 'Attempt deletion while archive ownership remains' },
      });
      assertError(deletion, 409, 'ARCHIVE_LIST_OWNERSHIP_REQUIRED');
      assert.deepEqual(db.prepare(`
        SELECT username, role, disabled_at, deleted_at, auth_version
        FROM users WHERE id = ?
      `).get(target.user.id), userBefore);
      assert.equal(Number(db.prepare(`
        SELECT COUNT(*) FROM admin_governance_audit_events
        WHERE mutation_id = ? OR (action = 'user.deleted' AND target_id = ?)
      `).pluck().get(mutationId, target.user.id)), 0);
      assert.equal(Number(db.prepare(`
        SELECT COUNT(*) FROM processed_mutations WHERE mutation_id = ?
      `).pluck().get(mutationId)), 0);
    }
  });

  test('soft-deleted archive lists do not block user deletion', async () => {
    const target = await register(
      `removed-archive-owner-${randomUUID().slice(0, 8)}`,
      'Deleted-archive-owner-password-123!',
    );
    const disabled = await request(`/api/v1/admin/users/${target.user.id}/disable`, {
      method: 'POST',
      token: admin.accessToken,
      headers: commandHeaders('deleted-archive-owner-disable', true),
      body: { reason: 'Prepare deleted archive owner deletion regression test' },
    });
    assert.equal(disabled.status, 200, disabled.text);
    const deletedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO public_archive_lists (
        id, title, owner_user_id, is_published, created_at, updated_at,
        unpublished_at, deleted_at
      ) VALUES (?, 'Deleted owned archive', ?, 0, ?, ?, ?, ?)
    `).run(randomUUID(), target.user.id, deletedAt, deletedAt, deletedAt, deletedAt);

    const deletion = await request(`/api/v1/admin/users/${target.user.id}`, {
      method: 'DELETE',
      token: admin.accessToken,
      headers: commandHeaders('deleted-archive-owner-delete', true),
      body: { reason: 'Delete account after its archive list was deleted' },
    });
    assert.equal(deletion.status, 200, deletion.text);
    assert.equal(typeof db.prepare('SELECT deleted_at FROM users WHERE id = ?').pluck().get(target.user.id), 'string');
  });

  test('deleted Sessions recover only as a new closed copy and replay the same creation result', async () => {
    const idempotencyKey = `recover-session-${randomUUID()}`;
    const recoverBody = { title: 'Recovered net', reason: 'Operator approved recovery' };
    const recovered = await request('/api/v1/admin/sessions/governance-deleted-source/recover', {
      method: 'POST',
      token: admin.accessToken,
      headers: {
        'idempotency-key': idempotencyKey,
        'x-admin-elevation': elevationToken,
      },
      body: recoverBody,
    });
    assert.equal(recovered.status, 201, recovered.text);
    const recoveredId = String(recovered.body.recoveredSessionId);
    assert.notEqual(recoveredId, 'governance-deleted-source');
    assert.deepEqual(
      db.prepare('SELECT status, deleted_at FROM sessions WHERE id = ?').get(recoveredId),
      { status: 'closed', deleted_at: null },
    );
    assert.equal(Number(db.prepare('SELECT COUNT(*) FROM logs WHERE session_id = ?').pluck().get(recoveredId)), 1);
    assert.equal(Number(db.prepare('SELECT COUNT(*) FROM collaboration_invites WHERE session_id = ?').pluck().get(recoveredId)), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(*) FROM public_shares WHERE session_id = ?').pluck().get(recoveredId)), 0);
    assert.ok(db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').pluck().get('governance-deleted-source'));

    const replay = await request('/api/v1/admin/sessions/governance-deleted-source/recover', {
      method: 'POST',
      token: admin.accessToken,
      headers: {
        'idempotency-key': idempotencyKey,
        'x-admin-elevation': elevationToken,
      },
      body: recoverBody,
    });
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.equal(replay.body.recoveredSessionId, recoveredId);
  });

  test('Session exports stream safely, neutralize legacy spreadsheet formulas and cannot replay', async () => {
    db.prepare(`
      UPDATE logs SET remarks = ?
      WHERE session_id = 'governance-closed' AND sync_id = 'governance-log'
    `).run('\t=1+1');
    const headers = {
      ...commandHeaders('csv-export', true),
      authorization: `Bearer ${admin.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/csv',
      'x-request-id': randomUUID(),
    };
    const body = JSON.stringify({
      format: 'csv',
      includeDeleted: false,
      reason: 'Export governance records for review',
    });
    const exported = await fetch(`${baseUrl}/api/v1/admin/sessions/governance-closed/export`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5_000),
    });
    const csv = await exported.text();
    assert.equal(exported.status, 200, csv);
    assert.equal(exported.headers.get('x-export-log-count'), '1');
    assert.ok(csv.startsWith('syncId,'), 'Fetch text decoding strips the UTF-8 BOM');
    assert.ok(csv.includes("'\t=1+1"), 'leading control whitespace must not bypass CSV formula protection');

    const replay = await fetch(`${baseUrl}/api/v1/admin/sessions/governance-closed/export`, {
      method: 'POST',
      headers: { ...headers, 'x-request-id': randomUUID() },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    const replayBody = await replay.json() as JsonObject;
    assert.equal(replay.status, 409);
    assert.ok(replayBody.error && typeof replayBody.error === 'object');
    assert.equal(replayBody.error.code, 'DOWNLOAD_ALREADY_ISSUED');
  });

  test('a backpressured export does not keep the shared SQLite connection busy', async () => {
    const sessionId = 'governance-large-export';
    seedSession({ sessionId, syncId: 'large-export-seed' });
    const insert = db.prepare(`
      INSERT INTO logs (
        sync_id, session_id, version, time, controller, callsign,
        remarks, created_at, updated_at, created_by, updated_by, source_device_id
      ) VALUES (?, ?, 1, ?, 'BA1CTRL', ?, ?, ?, ?, ?, ?, 'export-fixture')
    `);
    const seededAt = new Date().toISOString();
    db.transaction(() => {
      for (let index = 0; index < 700; index += 1) {
        insert.run(
          `large-export-${String(index).padStart(4, '0')}`,
          sessionId,
          new Date(Date.parse(seededAt) + index + 1).toISOString(),
          `BA1${String(index).padStart(4, '0')}`,
          'x'.repeat(2_000),
          seededAt,
          seededAt,
          member.user.id,
          member.user.id,
        );
      }
    }).immediate();

    const body = JSON.stringify({
      format: 'json',
      includeDeleted: false,
      reason: 'Exercise export backpressure without blocking live writes',
    });
    const url = new URL(`/api/v1/admin/sessions/${sessionId}/export`, baseUrl);
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'idempotency-key': `large-export-${randomUUID()}`,
          'x-admin-elevation': elevationToken,
          'x-request-id': randomUUID(),
        },
      }, resolve);
      outgoing.on('error', reject);
      outgoing.end(body);
    });
    response.pause();
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-export-log-count'], '701');
    assert.doesNotThrow(() => db.prepare(`
      UPDATE server_settings
      SET registration_enabled = registration_enabled
      WHERE id = 1
    `).run());

    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    response.resume();
    const payload = JSON.parse((await completed).toString('utf8')) as JsonObject;
    assert.equal(payload.logs.length, 701);
  });

  test('clearing an immediate operational override restores the original runtime baseline', async () => {
    const update = await request('/api/v1/admin/operational-settings', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('settings-update', true),
      body: {
        updates: { accessTokenTtlSeconds: 123 },
        reason: 'Exercise runtime override behavior',
      },
    });
    assert.equal(update.status, 200, update.text);
    assert.equal(update.body.effective.accessTokenTtlSeconds, 123);
    assert.equal(update.body.restartRequired, false);

    const clear = await request('/api/v1/admin/operational-settings', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('settings-clear', true),
      body: {
        updates: { accessTokenTtlSeconds: null },
        reason: 'Return to environment baseline',
      },
    });
    assert.equal(clear.status, 200, clear.text);
    assert.equal(clear.body.effective.accessTokenTtlSeconds, config.accessTokenTtlSeconds);
    assert.deepEqual(clear.body.overrides, {});
  });

  test('persists an immediately active LLM Base URL and a write-only encrypted API key', async () => {
    const update = await request('/api/v1/admin/operational-settings', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('settings-llm', true),
      body: {
        updates: {
          llmProvider: 'openai-chat',
          llmBaseUrl: 'https://llm.example/v1/',
          llmModel: 'radio-correction-model',
          llmTimeoutSeconds: 75,
        },
        reason: 'Configure the server LLM from WebUI',
      },
    });
    assert.equal(update.status, 200, update.text);
    assert.equal(update.body.effective.llmBaseUrl, 'https://llm.example/v1');
    assert.equal(update.body.effective.llmProvider, 'openai-chat');
    assert.equal(runtimeConfig.llmBaseUrl, 'https://llm.example/v1');
    assert.equal(update.body.restartRequired, false);

    const withoutElevation = await request('/api/v1/admin/llm-credential', {
      method: 'PUT',
      token: admin.accessToken,
      headers: commandHeaders('settings-llm-key-no-elevation'),
      body: { apiKey: 'server-secret-key', reason: 'Must require reauthentication' },
    });
    assertError(withoutElevation, 403, 'ADMIN_ELEVATION_REQUIRED');

    const credential = await request('/api/v1/admin/llm-credential', {
      method: 'PUT',
      token: admin.accessToken,
      headers: commandHeaders('settings-llm-key', true),
      body: { apiKey: 'server-secret-key', reason: 'Store the server LLM credential' },
    });
    assert.equal(credential.status, 200, credential.text);
    assert.equal(credential.body.configured, true);
    assert.equal(credential.body.source, 'database');
    assert.equal(credential.text.includes('server-secret-key'), false);
    const ciphertext = String(db.prepare(`
      SELECT encrypted_api_key FROM server_llm_credentials WHERE id = 1
    `).pluck().get());
    assert.equal(ciphertext.includes('server-secret-key'), false);

    const status = await request('/api/v1/admin/llm-credential', {
      token: admin.accessToken,
    });
    assert.equal(status.status, 200, status.text);
    assert.deepEqual(
      { configured: status.body.configured, source: status.body.source },
      { configured: true, source: 'database' },
    );

    const remove = await request('/api/v1/admin/llm-credential', {
      method: 'DELETE',
      token: admin.accessToken,
      headers: commandHeaders('settings-llm-key-remove', true),
      body: { reason: 'Restore the test credential baseline' },
    });
    assert.equal(remove.status, 200, remove.text);
    assert.equal(remove.body.source, 'none');

    const clear = await request('/api/v1/admin/operational-settings', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('settings-llm-clear', true),
      body: {
        updates: {
          llmProvider: null,
          llmBaseUrl: null,
          llmModel: null,
          llmTimeoutSeconds: null,
        },
        reason: 'Restore the server LLM test baseline',
      },
    });
    assert.equal(clear.status, 200, clear.text);
    assert.equal(runtimeConfig.llmProvider, 'disabled');
    assert.equal(runtimeConfig.llmBaseUrl, '');
  });

  test('container mode rejects port overrides atomically without blocking other overrides', async () => {
    const rejected = await request('/api/v1/admin/operational-settings', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('settings-container-port', true),
      body: {
        updates: {
          port: 4321,
          accessTokenTtlSeconds: 234,
        },
        reason: 'Port mapping is owned by the container deployment',
      },
    });
    assertError(rejected, 422, 'VALIDATION_FAILED');
    assert.equal(runtimeConfig.accessTokenTtlSeconds, 300);
    assert.equal(Number(db.prepare(`
      SELECT COUNT(*) FROM server_config_overrides
      WHERE key IN ('port', 'accessTokenTtlSeconds')
    `).pluck().get()), 0);

    const accepted = await request('/api/v1/admin/operational-settings', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('settings-container-other', true),
      body: {
        updates: {
          accessTokenTtlSeconds: 234,
          corsOrigins: ['https://radio.example'],
          webClientUrl: 'https://client.example/',
        },
        reason: 'Other operational overrides remain configurable',
      },
    });
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.body.effective.accessTokenTtlSeconds, 234);
    assert.equal(runtimeConfig.webClientUrl, 'https://client.example/');
    assert.equal((await request('/api/v1/server-info')).body.webClientUrl, 'https://client.example/');
    assert.deepEqual(accepted.body.effective.corsOrigins, ['https://radio.example']);
    assert.equal(runtimeConfig.accessTokenTtlSeconds, 234);
    assert.deepEqual(runtimeConfig.corsOrigins, ['https://radio.example']);
    assert.deepEqual(accepted.body.overrides, {
      accessTokenTtlSeconds: 234,
      corsOrigins: ['https://radio.example'],
      webClientUrl: 'https://client.example/',
    });

    const clear = await request('/api/v1/admin/operational-settings', {
      method: 'PATCH',
      token: admin.accessToken,
      headers: commandHeaders('settings-container-other-clear', true),
      body: {
        updates: {
          accessTokenTtlSeconds: null,
          corsOrigins: null,
          webClientUrl: null,
        },
        reason: 'Restore the container test baseline',
      },
    });
    assert.equal(clear.status, 200, clear.text);
    assert.deepEqual(clear.body.overrides, {});
    assert.equal(runtimeConfig.accessTokenTtlSeconds, 300);
    assert.deepEqual(runtimeConfig.corsOrigins, []);
  });

  test('a failed settings audit leaves both persisted and live configuration unchanged', async () => {
    const beforeTtl = config.accessTokenTtlSeconds;
    db.exec(`
      CREATE TEMP TRIGGER fail_operational_settings_audit
      BEFORE INSERT ON admin_governance_audit_events
      WHEN NEW.action = 'server.operational_settings.updated'
      BEGIN
        SELECT RAISE(ABORT, 'forced settings audit failure');
      END;
    `);
    try {
      const result = await request('/api/v1/admin/operational-settings', {
        method: 'PATCH',
        token: admin.accessToken,
        headers: commandHeaders('settings-rollback', true),
        body: {
          updates: { accessTokenTtlSeconds: 456 },
          reason: 'Verify atomic runtime configuration',
        },
      });
      assertError(result, 500, 'INTERNAL_ERROR');
      assert.equal(config.accessTokenTtlSeconds, beforeTtl);
      assert.equal(
        db.prepare(`
          SELECT COUNT(*) FROM server_config_overrides
          WHERE key = 'accessTokenTtlSeconds'
        `).pluck().get(),
        0,
      );
    } finally {
      db.exec('DROP TRIGGER fail_operational_settings_audit');
    }
  });
});
