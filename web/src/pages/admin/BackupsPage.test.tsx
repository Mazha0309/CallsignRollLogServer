import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import BackupsPage from './BackupsPage';

const { api } = vi.hoisted(() => ({ api: { recoveryStatus: vi.fn(), elevate: vi.fn(), downloadBackup: vi.fn(),
  previewRestore: vi.fn(), confirmRestore: vi.fn(), downloadSafetyBackup: vi.fn() } }));
vi.mock('../../api', () => ({ adminApi: api, ApiError: class extends Error {} }));
const preview = { id: 'preview-1', sha256: 'a'.repeat(64), users: 2, sessions: 3, logs: 4, bytes: 4096,
  schemaVersion: 30, instanceId: 'server', adminUsername: 'admin', expiresAt: '2030-01-01T00:00:00Z' };
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); localStorage.setItem('olt.web.locale', 'zh-CN');
  api.recoveryStatus.mockResolvedValue({ maxBytes: 64 * 1024 * 1024, restoreAvailable: true, automaticRestart: true, pending: false, lastResult: null });
  api.elevate.mockResolvedValue({}); api.previewRestore.mockResolvedValue(preview); api.confirmRestore.mockResolvedValue({});
});
afterEach(cleanup);
const mount = () => render(<PreferencesProvider><BackupsPage /></PreferencesProvider>);
it('downloads a backup only after reauthentication and reason', async () => {
  const user = userEvent.setup(); mount();
  await user.click(await screen.findByRole('button', { name: /下载一致性备份|Download consistent backup/ }));
  await user.type(screen.getByLabelText(/^(密码|Password)$/, { selector: "input" }), 'admin-password');
  await user.type(screen.getByLabelText(/原因|Reason/, { selector: 'textarea' }), 'before upgrade');
  await user.click(screen.getByRole('button', { name: /确\s*认|Confirm/ }));
  await waitFor(() => expect(api.downloadBackup).toHaveBeenCalledWith('before upgrade'));
  expect(api.elevate).toHaveBeenCalledWith('admin-password');
});
it('validation does not restore; confirmation requires RESTORE and a second password check', async () => {
  const user = userEvent.setup(); mount();
  await user.upload(await screen.findByLabelText(/选择 SQLite|Choose SQLite/), new File(['sqlite'], 'backup.db'));
  await user.click(screen.getByRole('button', { name: /上传并校验|Upload and validate/ }));
  await user.type(screen.getByLabelText(/^(密码|Password)$/, { selector: "input" }), 'admin-password');
  await user.click(screen.getByRole('button', { name: /确\s*认|Confirm/ }));
  expect(await screen.findByText(/校验通过，尚未恢复|Validated — not restored yet/)).toBeTruthy();
  expect(api.confirmRestore).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /恢复服务器数据|Restore server data/ }));
  await user.type(screen.getByLabelText(/^(密码|Password)$/, { selector: "input" }), 'admin-password');
  await user.type(screen.getByLabelText(/原因|Reason/, { selector: 'textarea' }), 'recover snapshot');
  await user.click(screen.getAllByRole('button', { name: /恢复服务器数据|Restore server data/ }).at(-1)!);
  expect(api.confirmRestore).not.toHaveBeenCalled();
  await user.type(screen.getByPlaceholderText('RESTORE'), 'RESTORE');
  await user.click(screen.getAllByRole('button', { name: /恢复服务器数据|Restore server data/ }).at(-1)!);
  await waitFor(() => expect(api.confirmRestore).toHaveBeenCalledWith(preview, 'recover snapshot', 'RESTORE', expect.any(String)));
  expect(api.elevate).toHaveBeenCalledTimes(2);
  expect(await screen.findByText(/恢复任务已提交|Restore queued/)).toBeTruthy();
});
it('does not expose restore upload when the process cannot restart', async () => {
  api.recoveryStatus.mockResolvedValue({ maxBytes: 1024, restoreAvailable: false, automaticRestart: false, pending: false, lastResult: null });
  mount();
  const upload = await screen.findByLabelText(/选择 SQLite|Choose SQLite/);
  expect((upload as HTMLInputElement).disabled).toBe(true);
  expect(api.previewRestore).not.toHaveBeenCalled();
});
