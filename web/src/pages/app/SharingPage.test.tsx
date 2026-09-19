import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import SharingPage from './SharingPage';

const { accountApi } = vi.hoisted(() => ({
  accountApi: {
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
});
