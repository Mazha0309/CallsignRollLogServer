import { createHash, randomUUID } from 'crypto';
import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { registerUsernameIdentityFunction } from '../auth/username-identity';
import { appendGovernanceAudit } from './governance-audit';
import { AppError } from '../errors/app-error';
import { config, validateRuntimeConfig } from '../config';
import { applyStoredConfigOverrides } from '../config-overrides';

export const MAX_RESTORE_BYTES = 64 * 1024 * 1024;
export const RESTORE_PREVIEW_TTL_MS = 15 * 60 * 1000;
export interface RestorePreview {
  id: string;
  sha256: string;
  bytes: number;
  users: number;
  sessions: number;
  logs: number;
  schemaVersion: number;
  instanceId: string;
  adminUsername: string;
  expiresAt: string;
}
export interface RestoreJob extends RestorePreview {
  actorUserId: string;
  authVersion: number;
  authSessionId: string;
  schemaHash: string;
  serverInstanceId: string;
  reason?: string;
  requestId?: string;
  mutationId?: string;
  newInstanceId?: string;
}
export interface RestoreResult {
  id: string;
  status: 'completed' | 'failed';
  finishedAt: string;
  safetyBackup: string | null;
  error?: string;
}
export function recoveryDirectory(db: Database.Database): string {
  if (!db.name || db.name === ':memory:') throw new AppError(409, 'RESTORE_UNAVAILABLE', 'Recovery requires a persistent database');
  return path.resolve(path.dirname(db.name), '.database-recovery');
}
export function ensureRecoveryDirectory(db: Database.Database): string {
  const directory = recoveryDirectory(db);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}
export function readRecoveryJson<T>(directory: string, file: string): T | null {
  try { return JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function writeRecoveryJson(directory: string, file: string, value: unknown): void {
  const temporary = path.join(directory, `${file}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, path.join(directory, file));
  const dir = fs.openSync(directory, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function schemaHash(db: Database.Database): string {
  const schema = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  const migrations = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  return createHash('sha256').update(JSON.stringify({ schema, migrations })).digest('hex');
}
export function databaseInstanceId(db: Database.Database): string {
  return String((db.prepare('SELECT instance_id FROM server_settings WHERE id = 1').get() as { instance_id: string }).instance_id);
}
export function acceptedInstanceIds(db: Database.Database): string[] {
  return [...new Set([databaseInstanceId(db), ...(readRecoveryJson<string[]>(recoveryDirectory(db), 'lineage.json') ?? [])])];
}
export function restoreSourcePath(directory: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid recovery job');
  // Unique names prevent a leftover WAL from an interrupted inspection from
  // ever being paired with a subsequently uploaded database.
  return path.join(directory, `source-${id}.sqlite3`);
}
export function hashFile(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function inspectRestoreFile(file: string, expected: { schemaHash: string; instanceId: string; actorUserId: string; acceptedInstanceIds?: string[] }): Omit<RestorePreview, 'id' | 'expiresAt'> {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 100 || stat.size > MAX_RESTORE_BYTES) throw new Error('Invalid SQLite file size');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    registerUsernameIdentityFunction(db);
    db.pragma('query_only = ON');
    db.pragma('cache_size = -4096');
    // Never execute uploaded DDL or migrations. Accept only this server's exact
    // current schema (including its indexes and triggers), then inspect data.
    if (schemaHash(db) !== expected.schemaHash) throw new Error('Backup schema differs from this server; use the matching server version for offline recovery');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('SQLite integrity or foreign key check failed');
    const instanceId = databaseInstanceId(db);
    if (![expected.instanceId, ...(expected.acceptedInstanceIds ?? [])].includes(instanceId)) throw new Error('Backup belongs to another server instance');
    const admin = db.prepare("SELECT username FROM users WHERE id = ? AND role = 'admin' AND disabled_at IS NULL AND deleted_at IS NULL AND must_change_password = 0").get(expected.actorUserId) as { username: string } | undefined;
    if (!admin) throw new Error('Your active administrator account is missing from the backup');
    if (db.prepare("SELECT 1 FROM users WHERE typeof(auth_version) <> 'integer' OR auth_version < 1 OR auth_version >= 9007199254740991 LIMIT 1").get()) throw new Error('Invalid authentication version in backup');
    // Validate restored settings before committing them. Secrets are outside
    // the database; a neutral valid JWT value checks only the stored overrides.
    const restoredConfig = applyStoredConfigOverrides(db, { ...config, jwtSecret: 'recovery-validation-only-secret-32-bytes' });
    validateRuntimeConfig(restoredConfig);
    if (!Number.isSafeInteger(restoredConfig.port) || restoredConfig.port < 1 || restoredConfig.port > 65535) throw new Error('Invalid restored port');
    const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return { sha256: hashFile(file), bytes: stat.size, users: count('users'), sessions: count('sessions'), logs: count('logs'),
      schemaVersion: Number(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()), instanceId, adminUsername: admin.username };
  } finally { db.close(); }
}
// Run untrusted SQLite validation outside the web process, with a hard deadline.
export function inspectRestoreFileIsolated(file: string, expected: Parameters<typeof inspectRestoreFile>[1]): Promise<ReturnType<typeof inspectRestoreFile>> {
  return new Promise((resolve, reject) => {
    const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
    const child = fork(path.join(__dirname, 'database-recovery-worker' + extension), [file, JSON.stringify(expected)], {
      execArgv: [...process.execArgv.filter((arg) => !arg.startsWith('--inspect')), '--max-old-space-size=128'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Backup validation timed out')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('message', (message: { result?: ReturnType<typeof inspectRestoreFile>; error?: string }) => {
      clearTimeout(timer);
      if (message.result) resolve(message.result); else reject(new Error(message.error ?? 'Invalid backup'));
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Backup validation failed')); });
  });
}
const quote = (identifier: string) => '"' + identifier.replace(/"/g, '""') + '"';

/** Called at startup BEFORE opening HTTP/WS listeners. SQLite commits all data
 * replacement atomically; a crash cannot leave a half-restored database. */
export function applyPendingDatabaseRestore(db: Database.Database): RestoreResult | null {
  if (!db.name || db.name === ':memory:') return null;
  const directory = recoveryDirectory(db);
  const job = readRecoveryJson<RestoreJob>(directory, 'pending.json');
  if (!job) return null;
  if (!/^[0-9a-f-]{36}$/.test(job.id)) throw new Error('Invalid recovery job');
  const backupName = `before-${job.id}.sqlite3`;
  const backupPath = path.join(directory, backupName);
  let attached = false;
  let result: RestoreResult;
  try {
    // The completion audit is in the SAME transaction as the replacement. If
    // power failed before removing pending.json, never replay a completed job.
    const completed = db.prepare("SELECT 1 FROM admin_governance_audit_events WHERE action = 'database.restore.completed' AND mutation_id = ?").get(job.id);
    if (!completed) {
      const current = db.prepare("SELECT password_hash, auth_version FROM users WHERE id = ? AND role = 'admin' AND disabled_at IS NULL AND deleted_at IS NULL AND must_change_password = 0").get(job.actorUserId) as { password_hash: string; auth_version: number } | undefined;
      if (!current || current.auth_version !== job.authVersion) throw new Error('Administrator authorization changed before recovery');
      if (schemaHash(db) !== job.schemaHash || databaseInstanceId(db) !== job.serverInstanceId) throw new Error('Server changed after backup validation');
      if (!job.newInstanceId || !job.reason) throw new Error('Recovery confirmation is missing');
      const file = restoreSourcePath(directory, job.id);
      const preview = inspectRestoreFile(file, job);
      if (preview.sha256 !== job.sha256) throw new Error('Backup checksum changed after validation');
      // A synchronous consistent SQLite snapshot, made while no client is
      // connected. Never overwrite an earlier safety backup when resuming.
      if (!fs.existsSync(backupPath)) {
        const temporaryBackup = backupPath + '.tmp';
        if (fs.existsSync(temporaryBackup)) fs.unlinkSync(temporaryBackup);
        db.prepare('VACUUM INTO ?').run(temporaryBackup);
        fs.chmodSync(temporaryBackup, 0o600);
        const fd = fs.openSync(temporaryBackup, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporaryBackup, backupPath);
        const directoryFd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
      const authVersions = db.prepare('SELECT id, auth_version FROM users').all() as { id: string; auth_version: number }[];
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
      const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'").all() as { name: string; sql: string }[];
      db.prepare('ATTACH DATABASE ? AS recovery_source').run(file);
      attached = true;
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
        for (const { name } of tables) db.exec(`DELETE FROM main.${quote(name)}`);
        for (const { name } of tables) {
          const columns = (db.pragma(`table_info(${quote(name)})`) as { name: string }[]).map((column) => quote(column.name)).join(',');
          db.exec(`INSERT INTO main.${quote(name)} (${columns}) SELECT ${columns} FROM recovery_source.${quote(name)}`);
        }
        if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get()) {
          db.exec('DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM recovery_source.sqlite_sequence');
        }
        // Revoke all restored credentials and prevent reuse of tokens issued
        // since the snapshot. Keep the initiating admin's CURRENT password.
        db.exec('UPDATE users SET auth_version = auth_version + 1; DELETE FROM refresh_tokens; DELETE FROM ws_tickets');
        const bump = db.prepare('UPDATE users SET auth_version = MAX(auth_version, ?) WHERE id = ?');
        for (const user of authVersions) bump.run(user.auth_version + 1, user.id);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(current.password_hash, job.actorUserId);
        db.prepare('UPDATE server_settings SET instance_id = ? WHERE id = 1').run(job.newInstanceId);
        for (const trigger of triggers) db.exec(trigger.sql);
        if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Restored database violates foreign keys');
        appendGovernanceAudit(db, { action: 'database.restore.completed', actorUserId: job.actorUserId,
          mutationId: job.id, requestId: job.requestId ?? job.id, reason: job.reason,
          targetType: 'database', targetId: 'primary', details: { sha256: job.sha256, safetyBackup: backupName, previousInstanceId: job.instanceId, newInstanceId: job.newInstanceId } });
      }).immediate();
    }
    result = { id: job.id, status: 'completed', finishedAt: new Date().toISOString(), safetyBackup: backupName };
  } catch (error) {
    result = { id: job.id, status: 'failed', finishedAt: new Date().toISOString(),
      safetyBackup: fs.existsSync(backupPath) ? backupName : null, error: error instanceof Error ? error.message : 'Recovery failed' };
  } finally {
    db.pragma('foreign_keys = ON');
    if (attached) db.exec('DETACH DATABASE recovery_source');
  }
  // Metadata failures must stop startup, not mislabel a committed restore as a
  // rollback. pending.json remains and the completion audit makes retry safe.
  if (result.status === 'completed') writeRecoveryJson(directory, 'lineage.json', [...new Set([...acceptedInstanceIds(db), job.serverInstanceId, job.instanceId])]);
  writeRecoveryJson(directory, 'last-result.json', result);
  fs.unlinkSync(path.join(directory, 'pending.json'));
  return result;
}
