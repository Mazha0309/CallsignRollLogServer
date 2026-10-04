import { describe, expect, it, vi } from 'vitest';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import type { AuthSession } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function session(id: string, token = `${id}-token`): AuthSession {
  return { user: { id, username: id, role: 'user' }, accessToken: token };
}

async function fixture() {
  vi.resetModules();
  const { default: axios } = await import('axios');
  const requests: { url: string; token: unknown; key: unknown }[] = [];
  let handler: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>;
  axios.defaults.adapter = async config => {
    requests.push({ url: config.url!, token: config.headers.get('Authorization'), key: config.headers.get('Idempotency-Key') });
    return handler(config);
  };
  const api = await import('./api');
  function response(config: InternalAxiosRequestConfig, data: unknown, status = 200): AxiosResponse {
    return { config, data, status, statusText: `${status}`, headers: {} };
  }
  function expired(config: InternalAxiosRequestConfig): never {
    throw new axios.AxiosError('expired', 'ERR_BAD_REQUEST', config, undefined,
      response(config, { error: { code: 'TOKEN_EXPIRED', message: 'Access token expired' } }, 401));
  }
  function setHandler(next: typeof handler) { handler = next; }
  async function login(id: string, token = `${id}-token`) {
    const previous = handler;
    handler = async config => config.url === '/web-auth/login'
      ? response(config, session(id, token)) : previous(config);
    return api.authApi.login(id, 'password');
  }
  const observed: (string | null)[] = [];
  api.subscribeAuth(value => observed.push(value?.user.id ?? null));
  return { api, requests, response, expired, setHandler, login, observed };
}

describe('account-bound HTTP requests', () => {
  it('retries once with a refreshed token and the same mutation key for the same account', async () => {
    const f = await fixture();
    await f.login('alice', 'alice-old');
    f.setHandler(async config => {
      if (config.url === '/web-auth/refresh') return f.response(config, session('alice', 'alice-new'));
      if (config.headers.get('Authorization') === 'Bearer alice-old') return f.expired(config);
      return f.response(config, { accepted: true });
    });
    await expect(f.api.socialApi.mutate('POST', '/friend-requests', { username: 'carol' }, 'same-operation')).resolves.toEqual({ accepted: true });
    expect(f.requests.filter(r => r.url === '/social/friend-requests')).toEqual([
      { url: '/social/friend-requests', token: 'Bearer alice-old', key: 'same-operation' },
      { url: '/social/friend-requests', token: 'Bearer alice-new', key: 'same-operation' },
    ]);
    expect(f.requests.filter(r => r.url === '/web-auth/refresh')).toHaveLength(1);
  });

  it('never replays a mutation when another tab changed the refresh cookie account', async () => {
    const f = await fixture();
    await f.login('alice');
    f.setHandler(async config => config.url === '/web-auth/refresh'
      ? f.response(config, session('bob')) : f.expired(config));
    await expect(f.api.socialApi.mutate('POST', '/friend-requests', { username: 'carol' }))
      .rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(f.requests.filter(r => r.url === '/social/friend-requests')).toHaveLength(1);
    expect(f.observed.at(-1)).toBe('bob');
    f.setHandler(async config => f.response(config, {}));
    await f.api.socialApi.mutate('POST', '/friend-requests', { username: 'dave' });
    expect(f.requests.at(-1)?.token).toBe('Bearer bob-token');
  });

  for (const next of ['bob', 'alice']) it(`rejects an old 401 after logout/login as ${next} without even refreshing`, async () => {
    const f = await fixture();
    await f.login('alice', 'alice-first');
    const pending = deferred<AxiosResponse>();
    let oldConfig!: InternalAxiosRequestConfig;
    f.setHandler(async config => { oldConfig = config; return pending.promise; });
    const result = f.api.socialApi.mutate('POST', '/friend-requests', { username: 'carol' }).catch(error => error);
    f.api.clearAuth();
    await f.login(next, `${next}-second`);
    try { f.expired(oldConfig); } catch (error) { pending.reject(error); }
    expect(await result).toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(f.requests.filter(r => r.url === '/web-auth/refresh')).toHaveLength(0);
    expect(f.requests.filter(r => r.url === '/social/friend-requests')).toHaveLength(1);
    expect(f.observed.at(-1)).toBe(next);
  });

  for (const succeeds of [true, false]) it(`does not let an old refresh ${succeeds ? 'success' : 'failure'} replace a newer login`, async () => {
    const f = await fixture();
    await f.login('alice');
    const pending = deferred<AxiosResponse>();
    let refreshConfig!: InternalAxiosRequestConfig;
    f.setHandler(async config => {
      if (config.url === '/web-auth/refresh') { refreshConfig = config; return pending.promise; }
      return f.expired(config);
    });
    const result = f.api.socialApi.mutate('POST', '/sessions/private/join').catch(error => error);
    await vi.waitFor(() => expect(refreshConfig).toBeDefined());
    f.api.clearAuth();
    await f.login('bob');
    if (succeeds) pending.resolve(f.response(refreshConfig, session('alice', 'late-alice')));
    else pending.reject(new Error('old refresh failed'));
    expect(await result).toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(f.observed.at(-1)).toBe('bob');
    expect(f.requests.filter(r => r.url === '/social/sessions/private/join')).toHaveLength(1);
    f.setHandler(async config => f.response(config, {}));
    await f.api.socialApi.mutate('POST', '/friend-requests', { username: 'dave' });
    expect(f.requests.at(-1)?.token).toBe('Bearer bob-token');
  });

  it('rejects stale successful data from an earlier account', async () => {
    const f = await fixture();
    await f.login('alice');
    const pending = deferred<AxiosResponse>();
    let oldConfig!: InternalAxiosRequestConfig;
    f.setHandler(async config => { oldConfig = config; return pending.promise; });
    const result = f.api.socialApi.dashboard().catch(error => error);
    await f.login('bob');
    pending.resolve(f.response(oldConfig, { friends: [{ username: 'alice-private-friend' }] }));
    expect(await result).toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(f.observed.at(-1)).toBe('bob');
  });

  it('invalidates requests at logout initiation and never clears a login completed during logout', async () => {
    const f = await fixture();
    await f.login('alice');
    const pending = deferred<AxiosResponse>();
    let logoutConfig!: InternalAxiosRequestConfig;
    f.setHandler(async config => { logoutConfig = config; return pending.promise; });
    const logout = f.api.authApi.logout();
    expect(f.observed.at(-1)).toBeNull();
    await f.login('bob');
    pending.resolve(f.response(logoutConfig, {}));
    await logout;
    expect(f.observed.at(-1)).toBe('bob');
  });

  it('shares one concurrent refresh for same-account requests', async () => {
    const f = await fixture();
    await f.login('alice', 'old');
    const pending = deferred<AxiosResponse>();
    let refreshConfig!: InternalAxiosRequestConfig;
    f.setHandler(async config => {
      if (config.url === '/web-auth/refresh') { refreshConfig = config; return pending.promise; }
      if (config.headers.get('Authorization') === 'Bearer old') return f.expired(config);
      return f.response(config, {});
    });
    const first = f.api.socialApi.mutate('POST', '/friend-requests', { username: 'carol' });
    const second = f.api.socialApi.mutate('POST', '/friend-requests', { username: 'dave' });
    await vi.waitFor(() => expect(refreshConfig).toBeDefined());
    pending.resolve(f.response(refreshConfig, session('alice', 'new')));
    await Promise.all([first, second]);
    expect(f.requests.filter(r => r.url === '/web-auth/refresh')).toHaveLength(1);
    expect(f.requests.filter(r => r.url === '/social/friend-requests')).toHaveLength(4);
  });

  it('cannot revive an old initial refresh or a superseded interactive login', async () => {
    const f = await fixture();
    const pending = deferred<AxiosResponse>();
    let oldConfig!: InternalAxiosRequestConfig;
    f.setHandler(async config => { oldConfig = config; return pending.promise; });
    const initial = f.api.refreshAccess().catch(error => error);
    await f.login('bob');
    pending.resolve(f.response(oldConfig, session('alice')));
    expect(await initial).toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(f.observed.at(-1)).toBe('bob');

    const oldLogin = deferred<AxiosResponse>();
    f.setHandler(async config => { oldConfig = config; return oldLogin.promise; });
    const firstLogin = f.api.authApi.login('alice', 'password').catch(error => error);
    await f.login('carol');
    oldLogin.resolve(f.response(oldConfig, session('alice')));
    expect(await firstLogin).toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(f.observed.at(-1)).toBe('carol');
  });
});
