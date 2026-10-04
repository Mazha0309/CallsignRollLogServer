import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';

// An isolated real-process rehearsal: no production database, accounts or port.
const directory = await mkdtemp(path.join(tmpdir(), 'olt-recovery-dist-'));
let child;
let base;
let diagnostics = '';
const password = 'Recovery-rehearsal-password-123!';
async function start() {
  diagnostics = '';
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  child = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(directory, 'server.db'), NODE_ENV: 'test', CONTAINER_MODE: 'false',
      JWT_SECRET: 'recovery-rehearsal-jwt-key-at-least-32-bytes', JWT_ISSUER: 'recovery-rehearsal',
      ADMIN_BOOTSTRAP_TOKEN: 'recovery-rehearsal-bootstrap-secret', INVITE_HMAC_KEY: 'recovery-rehearsal-invite-key-32-bytes',
      PUBLIC_SHARE_HMAC_KEY: 'recovery-rehearsal-public-key-32-bytes', RATE_LIMIT_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Startup timeout')); }, 10_000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before listening: ' + errors)); });
    child.stderr.on('data', (chunk) => { errors += chunk; diagnostics += chunk; });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const port = output.match(/listening on port (\d+)/)?.[1];
      if (port) { base = `http://127.0.0.1:${port}/api/v1`; clearTimeout(timer); resolve(); }
    });
  });
}
async function json(url, body, token, headers = {}) {
  const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  assert.ok(response.ok, `${url}: ${response.status}; ${response.ok ? '' : diagnostics}`);
  return response.json();
}
try {
  await start();
  const admin = await json('/auth/bootstrap', { username: 'RecoveryAdmin', password }, null, { 'X-Bootstrap-Secret': 'recovery-rehearsal-bootstrap-secret' });
  const token = admin.accessToken;
  const elevation = await json('/admin/elevate', { password }, token);
  const headers = { Authorization: `Bearer ${token}`, 'X-Admin-Elevation': elevation.elevationToken, 'Idempotency-Key': crypto.randomUUID() };
  const before = await (await fetch(base + '/server-info')).json();
  const download = await fetch(base + '/admin/database-backup', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'recovery rehearsal' }) });
  assert.equal(download.status, 200);
  const backup = new Uint8Array(await download.arrayBuffer());
  await json('/auth/register', { username: 'AfterSnapshot', password });
  const uploaded = await fetch(base + '/admin/database-recovery/preview', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: backup });
  const preview = await uploaded.json();
  assert.equal(uploaded.status, 201, JSON.stringify(preview));
  assert.equal(preview.users, 1);
  const reused = await fetch(base + '/admin/database-recovery/confirm', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: preview.id, sha256: preview.sha256, confirmation: 'RESTORE', reason: 'recovery rehearsal' }) });
  assert.equal(reused.status, 409, 'Reusing the backup download key must be rejected without queuing a restore');
  const exited = once(child, 'exit');
  await json('/admin/database-recovery/confirm', { id: preview.id, sha256: preview.sha256, confirmation: 'RESTORE', reason: 'recovery rehearsal' }, token, { ...headers, 'Idempotency-Key': crypto.randomUUID() });
  const exitTimeout = setTimeout(() => child.kill('SIGKILL'), 12_000);
  const [code] = await exited;
  clearTimeout(exitTimeout);
  assert.equal(code, 0, 'Queued native process should stop cleanly');
  await start();
  const after = await (await fetch(base + '/server-info')).json();
  assert.notEqual(after.serverInstanceId, before.serverInstanceId);
  assert.equal((await fetch(base + '/admin/database-recovery', { headers })).status, 401, 'Old access token must be revoked');
  const loggedIn = await json('/auth/login', { username: 'RecoveryAdmin', password });
  const status = await (await fetch(base + '/admin/database-recovery', { headers: { Authorization: `Bearer ${loggedIn.accessToken}` } })).json();
  assert.equal(status.lastResult.status, 'completed');
  assert.ok(status.lastResult.safetyBackup);
  const users = await (await fetch(base + '/admin/users', { headers: { Authorization: `Bearer ${loggedIn.accessToken}` } })).json();
  assert.equal(users.items.length, 1);
  console.log('Compiled recovery HTTP → shutdown → startup → relogin rehearsal passed');
} finally {
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    await stopped; clearTimeout(timer);
  }
  await rm(directory, { recursive: true, force: true });
}
