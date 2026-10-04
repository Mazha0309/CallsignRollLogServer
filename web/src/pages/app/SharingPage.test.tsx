import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import SharingPage from './SharingPage';

const { accountApi, socialApi, auth, subscribe } = vi.hoisted(() => ({
  auth: {user: {id: 'alice'}},
  subscribe: vi.fn(),
  socialApi: {dashboard: vi.fn(),ticket: vi.fn()},
  accountApi: {
    allSessionCatalog: vi.fn(), saveBatchShare: vi.fn(),
    sessionShares: vi.fn(),
    createSessionShare: vi.fn(),
    acceptSessionShare: vi.fn(),
    rejectSessionShare: vi.fn(),
    cancelSessionShare: vi.fn(),
    revokeSessionShare: vi.fn(),
  },
}));

vi.mock('../../api', () => ({
  accountApi,
  socialApi,
  ApiError: class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));
vi.mock('../../AuthContext', () => ({useAuth: () => auth}));
vi.mock('../../social-realtime', () => ({subscribeSocialUpdates: subscribe}));

function renderPage() {
  return render(
    <PreferencesProvider>
      <MemoryRouter>
        <SharingPage />
      </MemoryRouter>
    </PreferencesProvider>,
  );
}

describe('SharingPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.user = {id: 'alice'};
    subscribe.mockReturnValue(() => {});
    socialApi.dashboard.mockResolvedValue({friends:[{userId:'bob',username:'bob'}]});
    accountApi.allSessionCatalog.mockResolvedValue([{source:'personal',sessionId:'p1',title:'Personal one',role:null}]);
    accountApi.saveBatchShare.mockResolvedValue({});
    accountApi.sessionShares.mockImplementation(async (box: string) => {
      if (box === 'inbox') {
        return { items: [{ id: 'grant-1', grantorUserId: 'bob', granteeUserId: 'alice', status: 'pending' }] };
      }
      return { items: [] };
    });
    accountApi.acceptSessionShare.mockResolvedValue({ share: { id: 'grant-1', status: 'accepted' } });
  });
  afterEach(cleanup);

  it('accepts an inbound share request', async () => {
    renderPage();
    const user = userEvent.setup();
    const accept = await screen.findByRole('button', { name: /接受|Accept/i });
    await user.click(accept);
    await waitFor(() => expect(accountApi.acceptSessionShare).toHaveBeenCalledWith('grant-1'));
  });
  it('shows the sharer name and keeps delete permission separately disabled', async () => {
    renderPage(); const user=userEvent.setup();
    expect(await screen.findByText('bob')).toBeTruthy();
    const deletion=screen.getByRole('checkbox',{name:/另外允许删除记录|Also allow deleting records/}) as HTMLInputElement;
    expect(deletion.disabled).toBe(true);expect(deletion.checked).toBe(false);
    await user.click(screen.getByRole('checkbox',{name:/允许新增、修改记录|Allow adding and editing records/}));
    expect(deletion.disabled).toBe(false);expect(deletion.checked).toBe(false);
    await user.click(deletion);expect(deletion.checked).toBe(true);
    await user.click(screen.getByRole('checkbox',{name:/允许新增、修改记录|Allow adding and editing records/}));
    expect(deletion.checked).toBe(false);expect(deletion.disabled).toBe(true);
  });
  it('submits explicit ongoing all sharing with no implicit deletion',async()=>{
    renderPage();const user=userEvent.setup();
    await user.type(screen.getByRole('combobox',{name:/接收人|Grantee/}),'bob');
    await user.click(screen.getByRole('combobox',{name:/共享范围|Scope/}));
    await user.click(await screen.findByText(/持续共享全部（包含以后新建）|Ongoing access to all, including future sessions/,{selector:'.ant-select-item-option-content'}));
    await user.click(screen.getByRole('checkbox',{name:/允许新增、修改记录|Allow adding and editing records/}));
    await user.click(screen.getByRole('button',{name:/发送|Send/}));
    await waitFor(()=>expect(accountApi.saveBatchShare).toHaveBeenCalledWith({granteeUsername:'bob',scopeMode:'all',selectedSessions:[],canEditLogs:true,canDeleteLogs:false},undefined,expect.any(String)));
  });
});
