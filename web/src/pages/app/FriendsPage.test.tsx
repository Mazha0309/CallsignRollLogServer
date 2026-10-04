import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import FriendsPage from './FriendsPage';

const { api, auth } = vi.hoisted(() => ({ api: { dashboard: vi.fn(), mutate: vi.fn() }, auth: { user: { id: 'bob' } } }));
vi.mock('../../api', () => ({ socialApi: api, ApiError: class extends Error {} }));
vi.mock('../../AuthContext', () => ({ useAuth: () => auth }));
const empty = { friends: [], friendRequests: [], sessionRequests: [], sessions: [], blocks: [] };
function mount() {
  return render(<PreferencesProvider><MemoryRouter initialEntries={['/app/friends']}><Routes>
    <Route path="/app/friends" element={<FriendsPage />} />
    <Route path="/app/sessions/collaboration/:id" element={<p>opened session</p>} />
  </Routes></MemoryRouter></PreferencesProvider>);
}
describe('friends workspace', () => {
  beforeEach(() => { vi.resetAllMocks(); api.dashboard.mockResolvedValue(empty); api.mutate.mockResolvedValue({}); });
  afterEach(cleanup);
  it('sends a named friend request and reloads', async () => {
    mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox'), 'BA1ABC');
    await user.click(screen.getByRole('button', { name: /发送申请|Send request/ }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('POST', '/friend-requests', { username: 'BA1ABC' }, expect.any(String)));
    await waitFor(() => expect(api.dashboard).toHaveBeenCalledTimes(2));
  });
  it('accepts an invitation and directly opens its session', async () => {
    api.dashboard.mockResolvedValue({ ...empty, sessionRequests: [{ id: 'request-1', senderId: 'alice', senderUsername: 'BA1ABC', recipientId: 'bob', recipientUsername: 'BA2ABC', kind: 'invitation', role: 'editor', status: 'pending', sessionId: 'net-1', sessionTitle: 'Evening net' }] });
    mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /消息|Messages/ }));
    await user.click(await screen.findByRole('button', { name: /接受|Accept/ }));
    expect(await screen.findByText('opened session')).toBeTruthy();
    expect(api.mutate).toHaveBeenCalledWith('POST', '/session-requests/request-1/accept', {}, expect.any(String));
  });
  it('requests participation in a visible friend session', async () => {
    api.dashboard.mockResolvedValue({ ...empty, sessions: [{ sessionId: 'net-1', title: 'Evening net', ownerId: 'alice', ownerUsername: 'BA1ABC', visibility: 'friends' }] });
    mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /会话|Sessions/ }));
    await user.click(await screen.findByRole('button', { name: /申请加入|Request to join/ }));
    await user.click(await screen.findByRole('button', { name: /确\s*定|确\s*认|OK/ }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('POST', '/sessions/net-1/applications', { role: 'editor' }, expect.any(String)));
  });
});
