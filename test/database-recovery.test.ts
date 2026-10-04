import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { config as defaults } from '../src/config';
import { openDatabase } from '../src/db/database';
import { issueAdminElevation } from '../src/admin/elevation';
import { registerUsernameIdentityFunction } from '../src/auth/username-identity';
import {
  acceptedInstanceIds, applyPendingDatabaseRestore, databaseInstanceId, ensureRecoveryDirectory,
  inspectRestoreFile, inspectRestoreFileIsolated, readRecoveryJson, RestoreJob, schemaHash, writeRecoveryJson, restoreSourcePath,
} from '../src/admin/database-recovery';

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'olt-recovery-test-'));
  const db = openDatabase(path.join(directory, 'data.db'));
  db.prepare("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES ('admin','Administrator','current-password-hash','admin',?,?)").run(new Date().toISOString(), new Date().toISOString());
  const recovery = ensureRecoveryDirectory(db);
  const id = randomUUID();
  const file = restoreSourcePath(recovery, id);
  await db.backup(file);
  const expected = { actorUserId: 'admin', instanceId: databaseInstanceId(db), schemaHash: schemaHash(db) };
  const job: RestoreJob = { ...inspectRestoreFile(file, expected), ...expected, id, authVersion: 1,
    authSessionId: 'session-1', serverInstanceId: expected.instanceId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    newInstanceId: randomUUID(), reason: 'Recover test snapshot', requestId: randomUUID(), mutationId: randomUUID() };
  t.after(() => { if (db.open) db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, recovery, file, expected, job };
}
test('validates exact schema and lineage; rejects corrupt, foreign and modified-schema files', async (t) => {
  const f = await fixture(t);
  const preview = await inspectRestoreFileIsolated(f.file, f.expected);
  assert.equal(preview.users, 1);
  assert.equal(preview.schemaVersion, 33);
  assert.throws(() => inspectRestoreFile(f.file, { ...f.expected, instanceId: randomUUID() }), /another server/);
  assert.throws(() => inspectRestoreFile(f.file, { ...f.expected, actorUserId: 'absent' }), /administrator/);
  const backup = openDatabase(f.file);
  backup.exec('CREATE TABLE injected_table (value TEXT)'); backup.close();
  await assert.rejects(inspectRestoreFileIsolated(f.file, f.expected), /schema differs/);
  fs.writeFileSync(f.file, 'not a SQLite database');
  await assert.rejects(inspectRestoreFileIsolated(f.file, f.expected), /Invalid SQLite file size/);
});
test('startup atomically restores data, preserves current admin password, rotates instance and keeps safety backup', async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET username = 'renamed', password_hash = 'new-password' WHERE id = 'admin'").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES ('later','Later','hash','user','now','now')").run();
  writeRecoveryJson(f.recovery, 'pending.json', f.job);
  const result = applyPendingDatabaseRestore(f.db)!;
  assert.equal(result.status, 'completed', result.error);
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1);
  assert.deepEqual(f.db.prepare('SELECT username, password_hash, auth_version FROM users').get(), { username: 'Administrator', password_hash: 'new-password', auth_version: 2 });
  assert.equal(databaseInstanceId(f.db), f.job.newInstanceId);
  assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
  const safety = openDatabase(path.join(f.recovery, result.safetyBackup!));
  assert.equal(safety.prepare('SELECT COUNT(*) FROM users').pluck().get(), 2); safety.close();
  assert.ok(acceptedInstanceIds(f.db).includes(f.expected.instanceId));
  // Simulate a power loss after the SQLite commit but before pending removal.
  writeRecoveryJson(f.recovery, 'pending.json', f.job);
  assert.equal(applyPendingDatabaseRestore(f.db)!.status, 'completed');
  assert.equal(f.db.prepare('SELECT auth_version FROM users').pluck().get(), 2);
  assert.equal(applyPendingDatabaseRestore(f.db), null);
});
test('corrupted queued file or revoked admin fails closed without replacing current data', async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET auth_version = 2, username = 'current' WHERE id = 'admin'").run();
  writeRecoveryJson(f.recovery, 'pending.json', f.job);
  const result = applyPendingDatabaseRestore(f.db)!;
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /authorization changed/);
  assert.equal(f.db.prepare('SELECT username FROM users').pluck().get(), 'current');
  writeRecoveryJson(f.recovery, 'pending.json', { ...f.job, authVersion: 2 });
  fs.writeFileSync(f.file, 'broken');
  assert.equal(applyPendingDatabaseRestore(f.db)!.status, 'failed');
  assert.equal(f.db.prepare('SELECT username FROM users').pluck().get(), 'current');
});
test('SQL failure rolls back all table and trigger changes and retains safety backup', async (t) => {
  const f = await fixture(t);
  const originalSchema = schemaHash(f.db);
  f.db.prepare("UPDATE users SET username = 'BeforeFailure' WHERE id = 'admin'").run();
  // Fail at the final audit insert, after every table has already been copied.
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => {
    if (sql.includes('INSERT INTO admin_governance_audit_events')) throw new Error('injected restore failure');
    return prepare(sql);
  }) as typeof f.db.prepare;
  writeRecoveryJson(f.recovery, 'pending.json', f.job);
  const result = applyPendingDatabaseRestore(f.db)!;
  f.db.prepare = prepare;
  registerUsernameIdentityFunction(f.db);
  assert.equal(result.status, 'failed');
  assert.ok(result.safetyBackup);
  assert.equal(f.db.prepare('SELECT username FROM users').pluck().get(), 'BeforeFailure');
  assert.equal(schemaHash(f.db), originalSchema);
  assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
});
test('restoration lineage allows undo using the automatic pre-restore backup', async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET username = 'BeforeRestore' WHERE id = 'admin'").run();
  writeRecoveryJson(f.recovery, 'pending.json', f.job);
  const first = applyPendingDatabaseRestore(f.db)!;
  assert.equal(first.status, 'completed');
  const id = randomUUID();
  const source = restoreSourcePath(f.recovery, id);
  fs.copyFileSync(path.join(f.recovery, first.safetyBackup!), source);
  const expected = { schemaHash: schemaHash(f.db), instanceId: databaseInstanceId(f.db), actorUserId: 'admin', acceptedInstanceIds: acceptedInstanceIds(f.db) };
  const preview = inspectRestoreFile(source, expected);
  writeRecoveryJson(f.recovery, 'pending.json', { ...f.job, ...preview, id, authVersion: 2, serverInstanceId: databaseInstanceId(f.db), newInstanceId: randomUUID() });
  assert.equal(applyPendingDatabaseRestore(f.db)!.status, 'completed');
  assert.equal(f.db.prepare('SELECT username FROM users').pluck().get(), 'BeforeRestore');
  assert.equal(f.db.prepare('SELECT auth_version FROM users').pluck().get(), 3);
});
test('matching DDL cannot disguise future migrations or invalid authentication versions', async (t) => {
  const f = await fixture(t);
  let backup = openDatabase(f.file);
  backup.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (999,'future','fake','now')").run();
  backup.close();
  assert.throws(() => inspectRestoreFile(f.file, f.expected), /schema differs/);
  await f.db.backup(f.file);
  backup = openDatabase(f.file);
  const row = backup.prepare('PRAGMA table_info(server_config_overrides)').all() as { name: string }[];
  assert.ok(row.some((column) => column.name === 'value_json'));
  // Override schema requires audit metadata; invalid auth_version provides an
  // independent semantic-corruption case without weakening any DB constraints.
  backup.prepare("UPDATE users SET auth_version = 9007199254740991 WHERE id = 'admin'").run(); backup.close();
  assert.throws(() => inspectRestoreFile(f.file, f.expected), /authentication version/);
});
test('HTTP upload and confirmation require active elevated admin, matching preview, session and explicit confirmation', async (t) => {
  const f = await fixture(t);
  const config = { ...defaults, rateLimitEnabled: false, environment: 'test', jwtSecret: 'recovery-test-secret', jwtIssuer: 'recovery-test' };
  let restartCalls = 0;
  const server = createServer(createApp({ db: f.db, config, onRestoreQueued: () => { restartCalls++; } }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/database-recovery`;
  const token = jwt.sign({ type: 'access', role: 'admin', av: 1 }, config.jwtSecret, { subject: 'admin', jwtid: 'session-1', issuer: config.jwtIssuer, audience: 'openlogtool-v1', expiresIn: 300 });
  const elevation = issueAdminElevation(config, { id: 'admin', auth_version: 1 });
  const auth = { Authorization: `Bearer ${token}`, 'X-Admin-Elevation': elevation };
  const bytes = fs.readFileSync(f.file);
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base + '/preview', { method: 'POST', headers: { Authorization: auth.Authorization, 'Content-Type': 'application/octet-stream' }, body: bytes })).status, 403);
  assert.equal((await fetch(base + '/preview', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status, 415);
  const response = await fetch(base + '/preview', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: bytes });
  const preview = await response.json() as RestoreJob;
  assert.equal(response.status, 201, JSON.stringify(preview));
  assert.equal(preview.users, 1);
  assert.equal(f.db.prepare('SELECT auth_version FROM users').pluck().get(), 1);
  const mutationId = randomUUID();
  const confirm = (body: unknown) => fetch(base + '/confirm', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': mutationId }, body: JSON.stringify(body) });
  const body = { id: preview.id, sha256: preview.sha256, reason: 'testing restore', confirmation: 'RESTORE' };
  assert.equal((await confirm({ ...body, confirmation: 'yes' })).status, 422);
  assert.equal((await confirm({ ...body, sha256: 'wrong' })).status, 409);
  const stored = readRecoveryJson<RestoreJob>(f.recovery, 'preview.json')!;
  writeRecoveryJson(f.recovery, 'preview.json', { ...stored, authSessionId: 'another-login' });
  assert.equal((await confirm(body)).status, 403);
  writeRecoveryJson(f.recovery, 'preview.json', { ...stored, expiresAt: '2000-01-01T00:00:00Z' });
  assert.equal((await confirm(body)).status, 409);
  writeRecoveryJson(f.recovery, 'preview.json', stored);
  assert.equal((await confirm(body)).status, 202);
  assert.equal((await confirm(body)).status, 202);
  assert.equal(readRecoveryJson<RestoreJob>(f.recovery, 'pending.json')!.mutationId, mutationId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(restartCalls >= 1);
});
