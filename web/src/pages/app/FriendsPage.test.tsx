import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import FriendsPage from './FriendsPage';
import type { SocialUserSearchResult } from '../../social-types';

const { api, server, auth, subscribe } = vi.hoisted(() => ({ api: { dashboard: vi.fn(), mutate: vi.fn(), searchUsers: vi.fn() }, server: { info: vi.fn() }, auth: { user: { id: 'bob' } }, subscribe: vi.fn() }));
vi.mock('../../api', () => ({ socialApi: api, serverApi: server, ApiError: class extends Error {} }));
vi.mock('../../AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../social-realtime', () => ({ subscribeSocialUpdates: subscribe }));
const empty = { friends: [], friendRequests: [], sessionRequests: [], sessions: [], blocks: [] };
function workspace() {
  return <PreferencesProvider><MemoryRouter initialEntries={['/app/friends']}><Routes>
    <Route path="/app/friends" element={<FriendsPage />} />
    <Route path="/app/sessions/collaboration/:id" element={<p>opened session</p>} />
  </Routes></MemoryRouter></PreferencesProvider>;
}
function mount() { return render(workspace()); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
describe('friends workspace', () => {
  beforeEach(() => {
    vi.resetAllMocks(); auth.user = { id: 'bob' };
    api.dashboard.mockResolvedValue(empty); api.mutate.mockResolvedValue({});
    api.searchUsers.mockResolvedValue({ items: [], hasMore: false });
    server.info.mockResolvedValue({ features: ['friendCollaboration', 'friendUserSearch', 'friendDirectJoin'] });
    subscribe.mockReturnValue(() => {});
  });
  afterEach(cleanup);
  it('searches first, sends to the selected identity, then refreshes its relationship', async () => {
    api.searchUsers.mockResolvedValue({ items: [{ userId: 'alice', username: 'BG5CRL', relationship: 'none' }], hasMore: false });
    api.dashboard.mockResolvedValueOnce(empty).mockResolvedValue({ ...empty,
      friendRequests: [{ id: 'request-1', senderId: 'bob', senderUsername: 'BG5BOB', recipientId: 'alice', recipientUsername: 'BG5CRL', status: 'pending' }],
    });
    mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), '  bg5  ');
    expect(api.searchUsers).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /发送申请|Send request/ })).toBeNull();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('BG5CRL')).toBeTruthy();
    expect(api.searchUsers).toHaveBeenCalledWith('bg5');
    expect(api.mutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /发送申请|Send request/ }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('POST', '/friend-requests', { username: 'BG5CRL' }, expect.any(String)));
    await waitFor(() => expect(api.dashboard).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/已发送申请|Request sent/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发送申请|Send request/ })).toBeNull();
    expect(api.searchUsers).toHaveBeenCalledTimes(1);
  });
  it('does not send empty or one-character searches', async () => {
    mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), ' B ');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/2–64/)).toBeTruthy();
    expect(api.searchUsers).not.toHaveBeenCalled();
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it('clears old results on input changes and ignores late responses', async () => {
    const older = deferred<SocialUserSearchResult>();
    api.searchUsers.mockReturnValueOnce(older.promise)
      .mockResolvedValue({ items: [{ userId: 'new', username: 'BG6NEW', relationship: 'none' }], hasMore: false });
    mount(); const user = userEvent.setup(); const input = await screen.findByRole('searchbox');
    await user.type(input, 'BG5{Enter}');
    await waitFor(() => expect(api.searchUsers).toHaveBeenCalledTimes(1));
    await user.clear(input);
    await user.type(input, 'BG6{Enter}');
    expect(await screen.findByText('BG6NEW')).toBeTruthy();
    await act(async () => { older.resolve({ items: [{ userId: 'old', username: 'BG5OLD', relationship: 'none' }], hasMore: false }); });
    expect(screen.queryByText('BG5OLD')).toBeNull();
    expect(screen.getByText('BG6NEW')).toBeTruthy();
    await user.type(input, 'X');
    expect(screen.queryByText('BG6NEW')).toBeNull();
    expect(screen.queryByRole('button', { name: /发送申请|Send request/ })).toBeNull();
  });
  it('does not restore a pending search after clearing its input', async () => {
    const older = deferred<SocialUserSearchResult>();
    api.searchUsers.mockReturnValue(older.promise);
    mount(); const user = userEvent.setup(); const input = await screen.findByRole('searchbox');
    await user.type(input, 'BG5{Enter}');
    await user.clear(input);
    await act(async () => { older.resolve({ items: [{ userId: 'old', username: 'BG5OLD', relationship: 'none' }], hasMore: false }); });
    expect(screen.queryByText('BG5OLD')).toBeNull();
    expect(screen.queryByRole('button', { name: /发送申请|Send request/ })).toBeNull();
  });
  it('shows a retryable error without stale identities and handles no matches', async () => {
    api.searchUsers.mockResolvedValueOnce({ items: [{ userId: 'old', username: 'BG5OLD', relationship: 'none' }], hasMore: false })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ items: [], hasMore: false });
    mount(); const user = userEvent.setup(); const input = await screen.findByRole('searchbox');
    await user.type(input, 'BG5{Enter}');
    expect(await screen.findByText('BG5OLD')).toBeTruthy();
    await user.type(input, 'X{Enter}');
    expect(await screen.findByText(/搜索失败|Search failed/)).toBeTruthy();
    expect(screen.queryByText('BG5OLD')).toBeNull();
    await user.click(screen.getByRole('button', { name: /重试|Retry/ }));
    expect(await screen.findByText(/没有找到匹配用户|No matching users/)).toBeTruthy();
    expect(api.searchUsers).toHaveBeenLastCalledWith('BG5X');
  });
  it('shows relationship states and routes incoming requests to the inbox', async () => {
    api.searchUsers.mockResolvedValue({ items: [
      { userId: 'friend', username: 'BG5FRIEND', relationship: 'friend' },
      { userId: 'sent', username: 'BG5SENT', relationship: 'outgoing', requestId: 'sent-1' },
      { userId: 'incoming', username: 'BG5INCOMING', relationship: 'incoming', requestId: 'in-1' },
    ], hasMore: true });
    api.dashboard.mockResolvedValue({ ...empty, friendRequests: [{ id: 'in-1', senderId: 'incoming', senderUsername: 'BG5INCOMING', recipientId: 'bob', recipientUsername: 'BG5BOB', status: 'pending' }] });
    mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), 'BG5{Enter}');
    expect(await screen.findByText(/已是好友|Already friends/)).toBeTruthy();
    expect(screen.getByText(/已发送申请|Request sent/)).toBeTruthy();
    expect(screen.getByText(/待你处理|Needs your response/)).toBeTruthy();
    expect(screen.getByText(/前 20|first 20/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发送申请|Send request/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /查看申请|Review request/ }));
    expect(await screen.findByRole('button', { name: /接受|Accept/ })).toBeTruthy();
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it('updates active relationships across repeated WS refreshes without searching again', async () => {
    api.searchUsers.mockResolvedValue({ items: [{ userId: 'alice', username: 'BG5CRL', relationship: 'outgoing' }], hasMore: false });
    mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), 'BG5{Enter}');
    expect(await screen.findByText(/已发送申请|Request sent/)).toBeTruthy();
    api.dashboard.mockResolvedValue({ ...empty, friends: [{ userId: 'alice', username: 'BG5CRL' }] });
    act(() => { subscribe.mock.calls.at(-1)![0].invalidate(); });
    expect(await screen.findByText(/已是好友|Already friends/)).toBeTruthy();
    for (let index = 0; index < 5; index++) {
      act(() => { subscribe.mock.calls.at(-1)![0].invalidate(); });
      await waitFor(() => expect(api.dashboard).toHaveBeenCalledTimes(index + 3));
    }
    expect(screen.getByText(/已是好友|Already friends/)).toBeTruthy();
    expect(api.searchUsers).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
  it('overlays new requests, cancellation and blocking without discarding or repeating the search', async () => {
    api.searchUsers.mockResolvedValue({ items: [{ userId: 'alice', username: 'BG5CRL', relationship: 'none' }], hasMore: false });
    mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), 'BG5{Enter}');
    expect(await screen.findByRole('button', { name: /发送申请|Send request/ })).toBeTruthy();
    api.dashboard.mockResolvedValue({ ...empty, friendRequests: [{ id: 'in-1', senderId: 'alice', senderUsername: 'BG5CRL', recipientId: 'bob', recipientUsername: 'BG5BOB', status: 'pending' }] });
    act(() => { subscribe.mock.calls.at(-1)![0].invalidate(); });
    expect(await screen.findByRole('button', { name: /查看申请|Review request/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发送申请|Send request/ })).toBeNull();
    api.dashboard.mockResolvedValue({ ...empty });
    act(() => { subscribe.mock.calls.at(-1)![0].invalidate(); });
    expect(await screen.findByRole('button', { name: /发送申请|Send request/ })).toBeTruthy();
    api.dashboard.mockResolvedValue({ ...empty, blocks: [{ userId: 'alice', username: 'BG5CRL' }] });
    act(() => { subscribe.mock.calls.at(-1)![0].invalidate(); });
    expect(await screen.findByText(/没有找到匹配用户|No matching users/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发送申请|Send request/ })).toBeNull();
    expect(api.searchUsers).toHaveBeenCalledTimes(1);
  });
  it('a slow identity search cannot roll back a newer dashboard friendship', async () => {
    const older = deferred<SocialUserSearchResult>();
    api.searchUsers.mockReturnValue(older.promise);
    mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), 'BG5{Enter}');
    api.dashboard.mockResolvedValue({ ...empty, friends: [{ userId: 'alice', username: 'BG5CRL' }] });
    act(() => { subscribe.mock.calls.at(-1)![0].invalidate(); });
    await waitFor(() => expect(api.dashboard).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('BG5CRL')).toBeTruthy();
    await act(async () => { older.resolve({ items: [{ userId: 'alice', username: 'BG5CRL', relationship: 'none' }], hasMore: false }); });
    expect(await screen.findByText(/已是好友|Already friends/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发送申请|Send request/ })).toBeNull();
    expect(api.searchUsers).toHaveBeenCalledTimes(1);
  });
  it('a slow search cannot restore a relationship removed by a newer dashboard', async () => {
    const older = deferred<SocialUserSearchResult>();
    api.dashboard.mockResolvedValue({ ...empty, friends: [{ userId: 'alice', username: 'BG5CRL' }] });
    api.searchUsers.mockReturnValue(older.promise);
    mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), 'BG5{Enter}');
    api.dashboard.mockResolvedValue({ ...empty });
    act(() => { subscribe.mock.calls.at(-1)![0].invalidate(); });
    await waitFor(() => expect(screen.queryByText('BG5CRL')).toBeNull());
    await act(async () => { older.resolve({ items: [{ userId: 'alice', username: 'BG5CRL', relationship: 'friend' }], hasMore: false }); });
    expect(await screen.findByRole('button', { name: /发送申请|Send request/ })).toBeTruthy();
    expect(screen.queryByText(/已是好友|Already friends/)).toBeNull();
    expect(api.searchUsers).toHaveBeenCalledTimes(1);
  });
  it('discards pending results and search text when the signed-in account changes', async () => {
    const oldAccount = deferred<SocialUserSearchResult>();
    api.searchUsers.mockReturnValue(oldAccount.promise);
    const view = mount(); const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox'), 'BG5{Enter}');
    auth.user = { id: 'charlie' };
    view.rerender(workspace());
    expect((await screen.findByRole('searchbox') as HTMLInputElement).value).toBe('');
    await act(async () => { oldAccount.resolve({ items: [{ userId: 'old', username: 'BG5OLD', relationship: 'none' }], hasMore: false }); });
    expect(screen.queryByText('BG5OLD')).toBeNull();
    expect(api.searchUsers).toHaveBeenCalledTimes(1);
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
  it('joins a direct-join friend session with server-selected permissions and opens it', async () => {
    api.dashboard.mockResolvedValue({ ...empty, sessions: [{ sessionId: 'net-1', title: 'Evening net', ownerId: 'alice', ownerUsername: 'BG5CRL', visibility: 'friends', joinPolicy: 'direct', defaultRole: 'viewer' }] });
    mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /会话|Sessions/ }));
    expect(await screen.findByText(/加入后：只能查看|On joining: View only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /申请加入|Request to join/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /直接加入|Join directly/ }));
    expect(await screen.findByText('opened session')).toBeTruthy();
    expect(api.mutate).toHaveBeenCalledWith('POST', '/sessions/net-1/join', {}, expect.any(String));
  });
  it('keeps direct joining off until the owner chooses a mode and saves', async () => {
    api.dashboard.mockResolvedValue({ ...empty, sessions: [{ sessionId: 'net-1', title: 'Evening net', ownerId: 'bob', ownerUsername: 'BG5BOB', visibility: 'private' }] });
    mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /会话|Sessions/ }));
    await user.click(await screen.findByRole('button', { name: /加入方式|Joining options/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect((dialog.getByRole('radio', { name: /仅邀请加入|Invitation only/ }) as HTMLInputElement).checked).toBe(true);
    expect(api.mutate).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('radio', { name: /好友可直接加入|Friends can join directly/ }));
    expect(dialog.getByText(/全部已有和后续记录|existing and future records/)).toBeTruthy();
    expect(dialog.getByText(/不更改现有成员权限|Existing members keep their permissions/)).toBeTruthy();
    expect((dialog.getByRole('radio', { name: /只能查看|View only/ }) as HTMLInputElement).checked).toBe(true);
    await user.click(dialog.getByRole('radio', { name: /共同记录|Record together/ }));
    expect(api.mutate).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: /保\s*存|Save/ }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('PUT', '/sessions/net-1', { visibility: 'friends', joinPolicy: 'direct', defaultRole: 'editor' }, expect.any(String)));
  });
  it('does not expose or send direct-join settings to an older server', async () => {
    server.info.mockResolvedValue({ features: ['friendCollaboration'] });
    api.dashboard.mockResolvedValue({ ...empty, sessions: [{ sessionId: 'net-1', title: 'Evening net', ownerId: 'bob', ownerUsername: 'BG5BOB', visibility: 'private' }] });
    mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /会话|Sessions/ }));
    await user.click(await screen.findByRole('button', { name: /加入方式|Joining options/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByRole('radio', { name: /好友可直接加入|Friends can join directly/ })).toBeNull();
    await user.click(dialog.getByRole('radio', { name: /好友申请|Friends request approval/ }));
    await user.click(dialog.getByRole('button', { name: /保\s*存|Save/ }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('PUT', '/sessions/net-1', { visibility: 'friends' }, expect.any(String)));
  });
  it('turns direct joining off when changing a session to invitation-only', async () => {
    api.dashboard.mockResolvedValue({ ...empty, sessions: [{ sessionId: 'net-1', title: 'Evening net', ownerId: 'bob', ownerUsername: 'BG5BOB', visibility: 'friends', joinPolicy: 'direct', defaultRole: 'editor' }] });
    mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /会话|Sessions/ }));
    await user.click(await screen.findByRole('button', { name: /加入方式|Joining options/ }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('radio', { name: /仅邀请加入|Invitation only/ }));
    await user.click(dialog.getByRole('button', { name: /保\s*存|Save/ }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('PUT', '/sessions/net-1', { visibility: 'private', joinPolicy: 'approval', defaultRole: 'editor' }, expect.any(String)));
  });
});
