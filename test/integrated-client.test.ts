import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';

test('optional bundled client serves its base path, wasm and isolated SPA routes without affecting APIs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openlogtool-client-test-'));
  const db = openDatabase(':memory:');
  await mkdir(join(dir, 'pkg'));
  await writeFile(join(dir, 'index.html'), '<html><head><base href="/"></head><body>CLIENT FIXTURE</body></html>');
  await writeFile(join(dir, 'pkg', 'core.wasm'), Buffer.from([0, 97, 115, 109]));
  const server = createServer(createApp({ db, clientDirectory: dir, config: { environment: 'test', rateLimitEnabled: false } }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const redirect = await fetch(`${origin}/client`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/client/');
  for (const route of ['/client/', '/client/index.html', '/client/session/example']) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<base href="\/client\/">/);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-embedder-policy'), 'credentialless');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const wasm = await fetch(`${origin}/client/pkg/core.wasm`);
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal((await fetch(`${origin}/client/missing.js`)).status, 404);
  assert.equal((await fetch(`${origin}/api/v1/server-info`)).status, 200);
  assert.equal((await fetch(`${origin}/connect`)).status, 200);
});

test('a server without a client bundle does not advertise a fake client page', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openlogtool-no-client-test-'));
  const db = openDatabase(':memory:');
  const server = createServer(createApp({ db, clientDirectory: dir, config: { environment: 'test', rateLimitEnabled: false } }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${origin}/client/`, { method: 'HEAD' })).status, 404);
  assert.equal((await fetch(`${origin}/connect`)).status, 200);
});
