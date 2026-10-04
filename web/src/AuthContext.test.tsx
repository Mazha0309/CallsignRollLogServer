import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from './types';
import { AuthProvider, useAuth } from './AuthContext';

const { api } = vi.hoisted(() => ({ api: {
  refreshAccess: vi.fn(), subscribeAuth: vi.fn(),
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
} }));
vi.mock('./api', () => api);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const bob: AuthSession = { user: { id: 'bob', username: 'bob', role: 'user' }, accessToken: 'bob-token' };
function Probe() {
  const auth = useAuth();
  return <>
    <p data-testid="account">{auth.user?.id ?? 'signed-out'}</p>
    <button onClick={() => void auth.login('bob', 'password')}>login</button>
    <button onClick={() => void auth.logout()}>logout</button>
  </>;
}

describe('authentication context transitions', () => {
  let publish: (session: AuthSession | null) => void;
  beforeEach(() => {
    vi.resetAllMocks();
    api.subscribeAuth.mockImplementation((listener: typeof publish) => { publish = listener; return () => {}; });
    api.authApi.login.mockImplementation(async () => { publish(bob); return bob; });
  });
  afterEach(cleanup);

  it('does not erase an interactive login when the initial refresh is invalidated', async () => {
    const initial = deferred<AuthSession>();
    api.refreshAccess.mockReturnValue(initial.promise);
    render(<AuthProvider><Probe /></AuthProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'login' }));
    expect(screen.getByTestId('account').textContent).toBe('bob');
    await act(async () => { initial.reject(new Error('AUTH_CONTEXT_CHANGED')); });
    expect(screen.getByTestId('account').textContent).toBe('bob');
  });

  it('does not clear a newer login when a previous logout response arrives', async () => {
    api.refreshAccess.mockResolvedValue(bob);
    const pending = deferred<void>();
    api.authApi.logout.mockImplementation(() => { publish(null); return pending.promise; });
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { publish(bob); });
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    expect(screen.getByTestId('account').textContent).toBe('signed-out');
    await userEvent.click(screen.getByRole('button', { name: 'login' }));
    await act(async () => { pending.resolve(); });
    expect(screen.getByTestId('account').textContent).toBe('bob');
  });
});
