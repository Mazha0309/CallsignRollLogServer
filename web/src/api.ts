import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import type { SocialSnapshot } from './social-types';
import type {
  AdminOverview,
  AdminPersonalDictionarySnapshotDetail,
  AdminPersonalDictionarySnapshotItem,
  AdminPersonalSnapshotDetail,
  AdminPersonalSnapshotItem,
  AdminPersonalSessionDetails,
  AdminSessionAccount,
  AdminAccountSessionCatalog,
  AccountSessionSummary,
  CollaborationMetrics,
  AuditEvent,
  AuthSession,
  CursorPage,
  ExcelExportSettings,
  AccountShareGrant,
  SharedSessionSummary,
  ExcelExportSettingsResponse,
  ExcelCorrectionApplyResult,
  ExcelCorrectionCapabilities,
  ExcelCorrectionPreview,
  Invite,
  LogRecord,
  Member,
  Page,
  PublicShare,
  PublicLiveshareStatDetail,
  PublicLiveshareStats,
  PublicArchiveList,
  PublicArchiveListUser,
  PublicArchiveCandidateAccount,
  PublicArchiveSession,
  AvailableArchiveSourceSession,
  PersonalSnapshotDownload,
  PersonalSnapshotMetadata,
  PersonalSessionDetails,
  PersonalDictionarySnapshotDownload,
  PersonalDictionarySnapshotMetadata,
  ServerInfo,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  User,
} from './types';
import type { ParsedWorkbook } from './utils/sessionExcelImport';
import { refreshRetryDelay } from './utils/refreshRetry';

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
  result?: {
    status?: 'conflict' | 'rejected';
    code?: string;
    message?: string;
    details?: unknown;
    currentVersion?: number;
    currentEntity?: unknown;
  };
  code?: string;
  message?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const baseURL = '/api/v1';
const rawApi = axios.create({ baseURL, withCredentials: true, timeout: 20_000 });
const api = axios.create({ baseURL, withCredentials: true, timeout: 20_000 });
let accessToken: string | null = null;
let adminElevation: { token: string; expiresAt: number } | null = null;
let refreshPromise: Promise<AuthSession> | null = null;
const authListeners = new Set<(session: AuthSession | null) => void>();

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as ErrorEnvelope | undefined;
    const serverError = body?.error;
    const mutationError = body?.result;
    return new ApiError(
      error.response?.status ?? 0,
      serverError?.code ?? mutationError?.code ?? body?.code ?? (error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'NETWORK_ERROR'),
      serverError?.message ?? mutationError?.message ?? body?.message ?? error.message,
      serverError?.details ?? mutationError?.details ?? (mutationError ? {
        currentVersion: mutationError.currentVersion,
        currentEntity: mutationError.currentEntity,
      } : undefined),
    );
  }
  return new ApiError(0, 'UNKNOWN_ERROR', error instanceof Error ? error.message : 'Unknown error');
}

async function normalizeResponseError(error: unknown): Promise<ApiError> {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      const body = JSON.parse(await error.response.data.text()) as ErrorEnvelope;
      const serverError = body.error;
      return new ApiError(
        error.response.status,
        serverError?.code ?? body.code ?? 'REQUEST_FAILED',
        serverError?.message ?? body.message ?? error.message,
        serverError?.details,
      );
    } catch (parseError) {
      if (parseError instanceof ApiError) return parseError;
    }
  }
  return normalizeError(error);
}

function publishAuth(session: AuthSession | null) {
  accessToken = session?.accessToken ?? null;
  authListeners.forEach((listener) => listener(session));
}

export function subscribeAuth(listener: (session: AuthSession | null) => void) {
  authListeners.add(listener);
  return () => { authListeners.delete(listener); };
}

export function clearAuth() {
  adminElevation = null;
  publishAuth(null);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function requestRefreshWithOneRotationRetry(): Promise<AuthSession> {
  try {
    return (await rawApi.post<AuthSession>('/web-auth/refresh', { deviceId: webDeviceId })).data;
  } catch (failure) {
    const error = normalizeError(failure);
    const retryAfter = refreshRetryDelay(error);
    if (retryAfter === null) throw error;
    await wait(retryAfter);
    try {
      return (await rawApi.post<AuthSession>('/web-auth/refresh', { deviceId: webDeviceId })).data;
    } catch (retryFailure) {
      throw normalizeError(retryFailure);
    }
  }
}

function requestRefreshAcrossTabs(): Promise<AuthSession> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('openlogtool.web.refresh', requestRefreshWithOneRotationRetry);
  }
  return requestRefreshWithOneRotationRetry();
}

export async function refreshAccess(): Promise<AuthSession> {
  if (!refreshPromise) {
    refreshPromise = requestRefreshAcrossTabs()
      .then((session) => {
        publishAuth(session);
        return session;
      })
      .catch((error: unknown) => {
        publishAuth(null);
        throw normalizeError(error);
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  if (adminElevation && adminElevation.expiresAt > Date.now() && config.url?.startsWith('/admin/')) {
    config.headers['X-Admin-Elevation'] = adminElevation.token;
  }
  if (config.method && ['post', 'put', 'patch', 'delete'].includes(config.method.toLowerCase())) {
    config.headers['Idempotency-Key'] ??= crypto.randomUUID();
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as (AxiosRequestConfig & { _authRetried?: boolean }) | undefined;
    const normalized = await normalizeResponseError(error);
    const refreshable = ['AUTH_REQUIRED', 'TOKEN_EXPIRED', 'TOKEN_INVALID', 'TOKEN_REVOKED'].includes(normalized.code);
    if (error.response?.status === 401 && refreshable && config && !config._authRetried) {
      config._authRetried = true;
      try {
        await refreshAccess();
        return api.request(config);
      } catch (refreshError) {
        throw await normalizeResponseError(refreshError);
      }
    }
    throw normalized;
  },
);

async function unwrap<T>(request: Promise<{ data: T }>): Promise<T> {
  try {
    return (await request).data;
  } catch (error) {
    throw normalizeError(error);
  }
}

async function unwrapArchive<T>(request: Promise<{ data: { data: T } }>): Promise<T> {
  return (await unwrap(request)).data;
}

export const authApi = {
  async login(username: string, password: string): Promise<AuthSession> {
    const data = await unwrap(rawApi.post<AuthSession>('/web-auth/login', { username, password, deviceId: webDeviceId }));
    publishAuth(data);
    return data;
  },
  async register(username: string, password: string): Promise<AuthSession> {
    const data = await unwrap(rawApi.post<AuthSession>('/web-auth/register', { username, password, deviceId: webDeviceId }));
    publishAuth(data);
    return data;
  },
  async bootstrap(username: string, password: string, bootstrapSecret: string): Promise<AuthSession> {
    const data = await unwrap(rawApi.post<AuthSession>('/web-auth/bootstrap', { username, password, deviceId: webDeviceId }, { headers: { 'X-Bootstrap-Secret': bootstrapSecret } }));
    publishAuth(data);
    return data;
  },
  async completePasswordChange(passwordChangeToken: string, newPassword: string): Promise<AuthSession> {
    const data = await unwrap(rawApi.post<AuthSession>('/web-auth/complete-password-change', { passwordChangeToken, newPassword, deviceId: webDeviceId }));
    publishAuth(data);
    return data;
  },
  async logout(): Promise<void> {
    try {
      await api.post('/web-auth/logout', {});
    } finally {
      publishAuth(null);
    }
  },
  me: () => unwrap(api.get<User>('/web-auth/me')),
};

export const serverApi = {
  info: () => unwrap(rawApi.get<ServerInfo>('/server-info')),
};

export const accountApi = {
  profile: () => unwrap(api.get<User>('/account')),
  updateProfile: (username: string, currentPassword: string) =>
    unwrap(api.patch<User>('/account/username', { username, currentPassword })),
  changePassword: (currentPassword: string, newPassword: string) =>
    unwrap(api.post<void>('/account/change-password', { currentPassword, newPassword })),
  devices: () => unwrap(api.get<{ items: DeviceSession[] }>('/account/devices')),
  revokeDevice: (id: string) => unwrap(api.delete<void>(`/account/devices/${encodeURIComponent(id)}`)),
  sessionCatalog: (params: { page: number; pageSize: number; q?: string; source?: 'collaboration' | 'personal'; status?: string; role?: string; includeDeleted?: boolean }) =>
    unwrap(api.get<Page<AccountSessionSummary>>('/account/session-catalog', { params })),
  personalSnapshot: () => unwrap(api.get<{ personalSnapshot: PersonalSnapshotMetadata }>('/account/personal-snapshot')),
  downloadPersonalSnapshot: () => unwrap(api.get<{ personalSnapshot: PersonalSnapshotDownload }>('/account/personal-snapshot/download')),
  exportPersonalSnapshotSessionDatabaseV7: (sessionId: string) => downloadGetFile(
    `/account/personal-snapshot/sessions/${encodeURIComponent(sessionId)}/database-backup-v7`,
    `openlogtool-session-${sessionId}-v7.json`,
  ),
  personalSession: (sessionId: string) =>
    unwrap(api.get<PersonalSessionDetails>(`/account/personal-snapshot/sessions/${encodeURIComponent(sessionId)}`)),
  personalSessionLogs: (sessionId: string, params: { page: number; pageSize: number; q?: string; includeDeleted?: boolean; sort?: 'timeAsc' | 'timeDesc' | 'updatedDesc' }) =>
    unwrap(api.get<Page<LogRecord>>(`/account/personal-snapshot/sessions/${encodeURIComponent(sessionId)}/logs`, { params })),
  personalDictionarySnapshot: () => unwrap(api.get<{ personalDictionarySnapshot: PersonalDictionarySnapshotMetadata }>('/account/personal-dictionary-snapshot')),
  downloadPersonalDictionarySnapshot: () => unwrap(api.get<{ personalDictionarySnapshot: PersonalDictionarySnapshotDownload }>('/account/personal-dictionary-snapshot/download')),
  excelExportSettings: () =>
    unwrap(api.get<ExcelExportSettingsResponse>('/account/excel-export-settings')),
  updateExcelExportSettings: (excelExportSettings: ExcelExportSettings) =>
    unwrap(api.put<ExcelExportSettingsResponse>('/account/excel-export-settings', {
      excelExportSettings,
    })),
  sessionShares: (box: 'inbox' | 'outbox' | 'active') =>
    unwrap(api.get<{ items: AccountShareGrant[] }>('/account/session-shares', { params: { box } })),
  createSessionShare: (body: {
    granteeUsername: string;
    includePersonal: boolean;
    includeOwned: boolean;
    includeEditor: boolean;
    canJoinAs: 'editor' | 'viewer' | 'none';
  }) => unwrap(api.post<{ share: AccountShareGrant }>('/account/session-shares', body)),
  acceptSessionShare: (id: string) =>
    unwrap(api.post<{ share: AccountShareGrant }>(`/account/session-shares/${encodeURIComponent(id)}/accept`, {})),
  rejectSessionShare: (id: string) =>
    unwrap(api.post<{ share: AccountShareGrant }>(`/account/session-shares/${encodeURIComponent(id)}/reject`, {})),
  cancelSessionShare: (id: string) =>
    unwrap(api.post<{ share: AccountShareGrant }>(`/account/session-shares/${encodeURIComponent(id)}/cancel`, {})),
  revokeSessionShare: (id: string) =>
    unwrap(api.post<{ share: AccountShareGrant }>(`/account/session-shares/${encodeURIComponent(id)}/revoke`, {})),
  sessionShareBlocks: () =>
    unwrap(api.get<{ items: Array<{ blockedUserId: string; username: string; createdAt: string }> }>('/account/session-share-blocks')),
  blockSessionShare: (username: string) =>
    unwrap(api.put<{ blockedUserId: string }>(`/account/session-share-blocks/${encodeURIComponent(username)}`)),
  unblockSessionShare: (username: string) =>
    unwrap(api.delete<{ blockedUserId: string }>(`/account/session-share-blocks/${encodeURIComponent(username)}`)),
  sharedSessions: () =>
    unwrap(api.get<{ items: SharedSessionSummary[] }>('/account/shared-sessions')),
  sharedSession: (source: 'personal' | 'collaboration', sessionId: string) =>
    unwrap(api.get<SharedSessionSummary>(`/account/shared-sessions/${source}/${encodeURIComponent(sessionId)}`)),
  sharedSessionLogs: (source: 'personal' | 'collaboration', sessionId: string, params: { page: number; pageSize: number }) =>
    unwrap(api.get<Page<LogRecord>>(`/account/shared-sessions/${source}/${encodeURIComponent(sessionId)}/logs`, { params })),
  joinPassphrase: (sessionId: string) =>
    unwrap(api.get<{ configured: boolean; updatedAt: string | null }>(`/sessions/${encodeURIComponent(sessionId)}/join-passphrase`)),
  setJoinPassphrase: (sessionId: string, passphrase: string) =>
    unwrap(api.put<{ configured: true; passphrase: string; updatedAt: string }>(`/sessions/${encodeURIComponent(sessionId)}/join-passphrase`, { passphrase })),
  clearJoinPassphrase: (sessionId: string) =>
    unwrap(api.delete<{ configured: false }>(`/sessions/${encodeURIComponent(sessionId)}/join-passphrase`)),
  joinWithShare: (sessionId: string, passphrase: string) =>
    unwrap(api.post<{ membership: { role: string; joinSource: string } }>(`/sessions/${encodeURIComponent(sessionId)}/join-with-share`, { passphrase })),
};

export const socialApi = {
  dashboard: () => unwrap(api.get<SocialSnapshot>('/social')),
  ticket: () => unwrap(api.post<{ ticket: string; expiresAt: string }>('/social/ws-ticket', {})),
  mutate: (method: 'POST' | 'PUT' | 'DELETE', path: string, body: Record<string, unknown> = {}, key: string = crypto.randomUUID()) =>
    unwrap(api.request({ method, url: `/social${path}`, data: body, headers: { 'Idempotency-Key': key } })),
};

export interface DeviceSession {
  id: string;
  deviceId: string | null;
  userAgent: string | null;
  lastUsedAt: string | null;
  expiresAt: string;
  current: boolean;
}

export interface LogPatch {
  time: string;
  controller: string;
  callsign: string;
  rstSent: string | null;
  rstRcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
}

export interface MutationResult {
  mutationId: string;
  status: 'accepted' | 'conflict' | 'rejected';
  code?: string;
  message?: string;
  currentVersion?: number;
  currentEntity?: LogRecord;
}

const webDeviceId = (() => {
  const key = 'olt.web.device-id';
  const current = localStorage.getItem(key);
  if (current) return current;
  const value = crypto.randomUUID();
  localStorage.setItem(key, value);
  return value;
})();

async function mutateLog(
  sessionId: string,
  log: LogRecord,
  operation: 'update' | 'delete' | 'restore',
  patch?: Partial<LogPatch>,
): Promise<MutationResult> {
  const mutationId = crypto.randomUUID();
  const operationBody = {
    mutationId,
    entityType: 'log',
    entityId: log.syncId,
    operation,
    baseVersion: log.version,
    observedSeq: 0,
    queuedAt: new Date().toISOString(),
    ...(operation === 'update' ? { patch } : {}),
    ...(operation === 'restore' ? { confirm: true } : {}),
  };
  const response = await unwrap(api.post<{ results: MutationResult[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/mutations`,
    { protocolVersion: 1, deviceId: webDeviceId, operations: [operationBody] },
  ));
  return response.results[0];
}

export const sessionsApi = {
  list: () => unwrap(api.get<SessionSummary[]>('/sessions')),
  catalog: (params: { page: number; pageSize: number; q?: string; status?: string; role?: string }) =>
    unwrap(api.get<Page<SessionSummary>>('/sessions/catalog', { params })),
  logs: (sessionId: string, params: { page: number; pageSize: number; q?: string; includeDeleted?: boolean; sort?: 'timeAsc' | 'timeDesc' | 'updatedDesc' }) =>
    unwrap(api.get<Page<LogRecord>>(`/sessions/${encodeURIComponent(sessionId)}/logs`, { params })),
  snapshot: (sessionId: string, includeDeleted = false) =>
    unwrap(api.get<SessionSnapshot>(`/sessions/${encodeURIComponent(sessionId)}/snapshot`, {
      params: includeDeleted ? { includeDeleted: true } : undefined,
    })),
  updateLog: (sessionId: string, log: LogRecord, patch: Partial<LogPatch>) =>
    mutateLog(sessionId, log, 'update', patch),
  deleteLog: (sessionId: string, log: LogRecord) => mutateLog(sessionId, log, 'delete'),
  restoreLog: (sessionId: string, log: LogRecord) => mutateLog(sessionId, log, 'restore'),
  updateTitle: (sessionId: string, baseVersion: number, title: string) =>
    unwrap(api.post<{ results: MutationResult[] }>(`/sessions/${encodeURIComponent(sessionId)}/mutations`, {
      protocolVersion: 1,
      deviceId: webDeviceId,
      operations: [{
        mutationId: crypto.randomUUID(), entityType: 'session', entityId: sessionId,
        operation: 'update', baseVersion, patch: { title }, queuedAt: new Date().toISOString(),
      }],
    })).then((response) => response.results[0]),
  close: (sessionId: string, baseVersion: number) =>
    unwrap(api.post<{ results: MutationResult[] }>(`/sessions/${encodeURIComponent(sessionId)}/mutations`, {
      protocolVersion: 1,
      deviceId: webDeviceId,
      operations: [{
        mutationId: crypto.randomUUID(), entityType: 'session', entityId: sessionId,
        operation: 'close', baseVersion, queuedAt: new Date().toISOString(),
      }],
    })).then((response) => response.results[0]),
  members: (sessionId: string) =>
    unwrap(api.get<{ members: Member[] }>(`/sessions/${encodeURIComponent(sessionId)}/members`)),
  updateMember: (sessionId: string, userId: string, role: 'editor' | 'viewer') =>
    unwrap(api.patch(`/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(userId)}`, { role })),
  removeMember: (sessionId: string, userId: string) =>
    unwrap(api.delete(`/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(userId)}`)),
  invites: (sessionId: string) =>
    unwrap(api.get<{ invites: Invite[] }>(`/sessions/${encodeURIComponent(sessionId)}/invites`)),
  createInvite: (sessionId: string, values: { role: 'editor' | 'viewer'; expiresInHours: number; maxUses: number }) =>
    unwrap(api.post<{ invite: Invite }>(`/sessions/${encodeURIComponent(sessionId)}/invites`, { ...values, includeLinkToken: true })),
  revokeInvite: (sessionId: string, inviteId: string) =>
    unwrap(api.delete(`/sessions/${encodeURIComponent(sessionId)}/invites/${encodeURIComponent(inviteId)}`)),
  shares: (sessionId: string) =>
    unwrap(api.get<{ publicShares: PublicShare[]; nextCursor: string | null }>(`/sessions/${encodeURIComponent(sessionId)}/public-shares`)),
  createShare: (sessionId: string, expiresInHours: number) =>
    unwrap(api.post<{ publicShare: PublicShare }>(`/sessions/${encodeURIComponent(sessionId)}/public-shares`, { expiresInHours })),
  revokeShare: (sessionId: string, publicShareId: string) =>
    unwrap(api.delete(`/sessions/${encodeURIComponent(sessionId)}/public-shares/${encodeURIComponent(publicShareId)}`)),
  audit: (sessionId: string) =>
    unwrap(api.get<CursorPage<AuditEvent>>(`/sessions/${encodeURIComponent(sessionId)}/audit-events`)),
  excelCorrectionCapabilities: (sessionId: string) =>
    unwrap(api.get<ExcelCorrectionCapabilities>(
      `/sessions/${encodeURIComponent(sessionId)}/excel-corrections/capabilities`,
    )),
  previewExcelCorrections: (sessionId: string, workbook: ParsedWorkbook) =>
    unwrap(api.post<ExcelCorrectionPreview>(
      `/sessions/${encodeURIComponent(sessionId)}/excel-corrections/preview`,
      workbook,
      { timeout: 10 * 60_000 },
    )),
  applyExcelCorrections: (sessionId: string, previewId: string, proposalIds: string[]) =>
    unwrap(api.post<ExcelCorrectionApplyResult>(
      `/sessions/${encodeURIComponent(sessionId)}/excel-corrections/apply`,
      { previewId, proposalIds },
      { headers: { 'X-Device-Id': webDeviceId } },
    )),
};

export interface AdminSession {
  sessionId: string;
  title: string;
  status: SessionStatus;
  version: number;
  ownerUserId: string;
  ownerUsername: string;
  logCount: number;
  memberCount: number;
  activePublicShareCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  deletedAt: string | null;
}

export interface AdminSessionDetails {
  session: Omit<AdminSession, 'logCount' | 'memberCount' | 'activePublicShareCount'> & { highWatermarkSeq: number; minRetainedSeq: number };
  counts: { logs: number; deleted_logs: number; members: number; invites: number; public_shares: number };
  liveDraft: { exists: boolean; hasActualContent: boolean; activeLockCount: number };
}

export interface AdminMember {
  membershipId: string;
  userId: string;
  username: string;
  role: 'owner' | 'editor' | 'viewer';
  version: number;
  joinedAt: string;
  updatedAt: string;
  removedAt: string | null;
  accountDisabledAt: string | null;
  accountDeletedAt: string | null;
}

export interface AdminUserDetails {
  user: User & {
    deletedAt: string | null;
    mustChangePassword: boolean;
    loginNeverExpires: boolean;
    authVersion: number;
    passwordChangedAt: string | null;
    usernameChangedAt: string | null;
    updatedAt: string;
  };
  counts: {
    owned_sessions: number;
    memberships: number;
    active_device_sessions: number;
    personal_record_snapshot_bytes: number;
    personal_dictionary_snapshot_bytes: number;
  };
  deviceSessions: Array<{
    sessionId: string;
    deviceId: string | null;
    createdAt: string;
    expiresAt: string;
    lastUsedAt: string | null;
    userAgent: string | null;
    ipAddress: string | null;
  }>;
}

export interface PasswordResetResult {
  userId: string;
  mustChangePassword: true;
  temporaryPasswordIssued: true;
  revokedDeviceSessionCount: number;
  auditEventId: string;
  temporaryPassword: string;
}

export interface RecoveryResult {
  sourceSessionId: string;
  recoveredSessionId: string;
  status: 'closed';
  ownerUserId: string;
  copiedLogCount: number;
  copiedMemberCount: number;
}

export interface OperationalSettings {
  effective: Record<string, unknown>;
  desired: Record<string, unknown>;
  overrides: Record<string, unknown>;
  restartRequired: boolean;
  restartRequiredKeys: string[];
  readOnly: Record<string, unknown>;
}

export interface LlmCredentialStatus {
  configured: boolean;
  source: 'database' | 'environment' | 'none';
  updatedAt: string | null;
}

export type OperationalSettingsUpdate = Omit<OperationalSettings, 'readOnly'>;

async function downloadAdminFile(url: string, body: Record<string, unknown>, fallbackName: string) {
  try {
    const response = await api.post<Blob>(url, body, { responseType: 'blob', timeout: 0 });
    saveDownloadedBlob(
      response.data,
      response.headers['content-disposition'] as string | undefined,
      fallbackName,
    );
  } catch (error) {
    throw await normalizeResponseError(error);
  }
}

function saveDownloadedBlob(
  blob: Blob,
  disposition: string | undefined,
  fallbackName: string,
) {
  const match = disposition?.match(/filename="?([^";]+)"?/i);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = match?.[1] ?? fallbackName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

async function downloadGetFile(
  url: string,
  fallbackName: string,
  headers?: Record<string, string>,
) {
  try {
    const response = await api.get<Blob>(url, {
      responseType: 'blob',
      timeout: 0,
      ...(headers ? { headers } : {}),
    });
    saveDownloadedBlob(
      response.data,
      response.headers['content-disposition'] as string | undefined,
      fallbackName,
    );
  } catch (error) {
    throw await normalizeResponseError(error);
  }
}

export const adminApi = {
  overview: () => unwrap(api.get<AdminOverview>('/admin/overview')),
  settings: () => unwrap(api.get<{ registrationEnabled: boolean }>('/admin/settings')),
  updateSettings: (registrationEnabled: boolean, reason: string) =>
    unwrap(api.patch<{ registrationEnabled: boolean }>('/admin/settings', {
      registrationEnabled,
      reason,
    })),
  users: (params: { page: number; pageSize: number; q?: string; role?: string }) =>
    unwrap(api.get<Page<User>>('/admin/users', { params })),
  updateRole: (userId: string, role: 'admin' | 'user', reason: string) =>
    unwrap(api.patch(`/admin/users/${encodeURIComponent(userId)}/role`, { role, reason })),
  revokeTokens: (userId: string, reason: string) =>
    unwrap(api.post(`/admin/users/${encodeURIComponent(userId)}/revoke-refresh-tokens`, { reason })),
  setLoginNeverExpires: (userId: string, loginNeverExpires: boolean, reason: string) =>
    unwrap(api.patch(`/admin/users/${encodeURIComponent(userId)}/login-expiration`, {
      loginNeverExpires,
      reason,
    })),
  user: (userId: string, accessId: string) => unwrap(api.get<AdminUserDetails>(`/admin/users/${encodeURIComponent(userId)}`, { headers: { 'X-Admin-Access-Id': accessId } })),
  resetPassword: (userId: string, reason: string) =>
    unwrap(api.post<PasswordResetResult>(`/admin/users/${encodeURIComponent(userId)}/reset-password`, { reason })),
  setUserEnabled: (userId: string, enabled: boolean, reason: string) =>
    unwrap(api.post(`/admin/users/${encodeURIComponent(userId)}/${enabled ? 'enable' : 'disable'}`, { reason })),
  deleteUser: (userId: string, reason: string) =>
    unwrap(api.delete(`/admin/users/${encodeURIComponent(userId)}`, { data: { reason } })),
  sessions: (params: { page: number; pageSize: number; q?: string; status?: string; includeDeleted?: boolean }) =>
    unwrap(api.get<Page<AdminSession>>('/admin/sessions', { params })),
  sessionAccounts: (params: { page: number; pageSize: number; q?: string }) =>
    unwrap(api.get<Page<AdminSessionAccount>>('/admin/session-accounts', { params })),
  accountSessions: (userId: string, accessId: string, params: { page: number; pageSize: number; q?: string; source?: 'collaboration' | 'personal'; status?: string; role?: string; includeDeleted?: boolean }) =>
    unwrap(api.get<AdminAccountSessionCatalog>(`/admin/session-accounts/${encodeURIComponent(userId)}/sessions`, { params, headers: { 'X-Admin-Access-Id': accessId } })),
  personalSnapshots: (params: { page: number; pageSize: number; q?: string }) =>
    unwrap(api.get<Page<AdminPersonalSnapshotItem>>('/admin/personal-snapshots', { params })),
  personalSnapshot: (userId: string, accessId: string) =>
    unwrap(api.get<AdminPersonalSnapshotDetail>(`/admin/personal-snapshots/${encodeURIComponent(userId)}`, {
      headers: { 'X-Admin-Access-Id': accessId },
    })),
  personalSession: (userId: string, sessionId: string, accessId: string) =>
    unwrap(api.get<AdminPersonalSessionDetails>(`/admin/personal-snapshots/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`, { headers: { 'X-Admin-Access-Id': accessId } })),
  personalSessionLogs: (userId: string, sessionId: string, accessId: string, params: { page: number; pageSize: number; q?: string; includeDeleted?: boolean; sort?: 'timeAsc' | 'timeDesc' | 'updatedDesc' }) =>
    unwrap(api.get<Page<LogRecord>>(`/admin/personal-snapshots/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/logs`, { params, headers: { 'X-Admin-Access-Id': accessId } })),
  exportPersonalSnapshotSessionDatabaseV7: (userId: string, sessionId: string) => downloadGetFile(
    `/admin/personal-snapshots/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/database-backup-v7`,
    `openlogtool-session-${sessionId}-v7.json`,
    { 'X-Admin-Access-Id': crypto.randomUUID() },
  ),
  personalDictionarySnapshots: (params: { page: number; pageSize: number; q?: string }) =>
    unwrap(api.get<Page<AdminPersonalDictionarySnapshotItem>>('/admin/personal-dictionary-snapshots', { params })),
  personalDictionarySnapshot: (userId: string, accessId: string) =>
    unwrap(api.get<AdminPersonalDictionarySnapshotDetail>(`/admin/personal-dictionary-snapshots/${encodeURIComponent(userId)}`, {
      headers: { 'X-Admin-Access-Id': accessId },
    })),
  session: (sessionId: string, accessId: string) => unwrap(api.get<AdminSessionDetails>(`/admin/sessions/${encodeURIComponent(sessionId)}`, { headers: { 'X-Admin-Access-Id': accessId } })),
  sessionLogs: (sessionId: string, accessId: string, params: { page: number; pageSize: number; q?: string; includeDeleted?: boolean }) =>
    unwrap(api.get<Page<LogRecord>>(`/admin/sessions/${encodeURIComponent(sessionId)}/logs`, { params, headers: { 'X-Admin-Access-Id': accessId } })),
  sessionMembers: (sessionId: string, accessId: string) =>
    unwrap(api.get<{ items: AdminMember[] }>(`/admin/sessions/${encodeURIComponent(sessionId)}/members`, { headers: { 'X-Admin-Access-Id': accessId } })),
  updateAdminMember: (sessionId: string, member: AdminMember, role: 'editor' | 'viewer', reason: string) =>
    unwrap(api.patch(`/admin/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(member.userId)}`, { role, expectedVersion: member.version, reason })),
  removeAdminMember: (sessionId: string, member: AdminMember, reason: string) =>
    unwrap(api.delete(`/admin/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(member.userId)}`, { data: { expectedVersion: member.version, reason } })),
  addAdminMember: (sessionId: string, userId: string, role: 'editor' | 'viewer', reason: string) =>
    unwrap(api.post(`/admin/sessions/${encodeURIComponent(sessionId)}/members`, { userId, role, reason })),
  transferOwnership: (sessionId: string, targetUserId: string, reason: string) =>
    unwrap(api.post(`/admin/sessions/${encodeURIComponent(sessionId)}/transfer-ownership`, { targetUserId, reason })),
  updateSession: (sessionId: string, expectedVersion: number, title: string) =>
    unwrap(api.patch(`/admin/sessions/${encodeURIComponent(sessionId)}`, { expectedVersion, title })),
  sessionCommand: (sessionId: string, command: 'close' | 'reopen', expectedVersion: number) =>
    unwrap(api.post(`/admin/sessions/${encodeURIComponent(sessionId)}/${command}`, { expectedVersion })),
  closeDiscardingLiveDraft: (sessionId: string, expectedVersion: number, reason: string) =>
    unwrap(api.post(`/admin/sessions/${encodeURIComponent(sessionId)}/close-discarding-live-draft`, { expectedVersion, reason })),
  deleteSession: (sessionId: string, expectedVersion: number, reason: string) =>
    unwrap(api.delete(`/admin/sessions/${encodeURIComponent(sessionId)}`, { data: { expectedVersion, reason } })),
  recoverSession: (sessionId: string, values: { title: string; ownerUserId?: string; reason: string }) =>
    unwrap(api.post<RecoveryResult>(`/admin/sessions/${encodeURIComponent(sessionId)}/recover`, values)),
  updateLog: (sessionId: string, log: LogRecord, patch: Partial<LogPatch>) =>
    unwrap(api.patch(`/admin/sessions/${encodeURIComponent(sessionId)}/logs/${encodeURIComponent(log.syncId)}`, { expectedVersion: log.version, patch })),
  createLog: (sessionId: string, value: LogPatch, reason: string) =>
    unwrap(api.post(`/admin/sessions/${encodeURIComponent(sessionId)}/logs`, { syncId: crypto.randomUUID(), value, reason })),
  deleteLog: (sessionId: string, log: LogRecord, reason: string) =>
    unwrap(api.delete(`/admin/sessions/${encodeURIComponent(sessionId)}/logs/${encodeURIComponent(log.syncId)}`, { data: { expectedVersion: log.version, reason } })),
  restoreLog: (sessionId: string, log: LogRecord, reason: string) =>
    unwrap(api.post(`/admin/sessions/${encodeURIComponent(sessionId)}/logs/${encodeURIComponent(log.syncId)}/restore`, { expectedVersion: log.version, reason })),
  adminInvites: (sessionId: string, accessId: string) => unwrap(api.get<{ items: Invite[] }>(`/admin/sessions/${encodeURIComponent(sessionId)}/invites`, { headers: { 'X-Admin-Access-Id': accessId } })),
  revokeAdminInvite: (sessionId: string, inviteId: string, reason: string) =>
    unwrap(api.delete(`/admin/sessions/${encodeURIComponent(sessionId)}/invites/${encodeURIComponent(inviteId)}`, { data: { reason } })),
  adminShares: (sessionId: string, accessId: string) => unwrap(api.get<{ items: PublicShare[] }>(`/admin/sessions/${encodeURIComponent(sessionId)}/public-shares`, { headers: { 'X-Admin-Access-Id': accessId } })),
  revokeAdminShare: (sessionId: string, publicShareId: string, reason: string) =>
    unwrap(api.delete(`/admin/sessions/${encodeURIComponent(sessionId)}/public-shares/${encodeURIComponent(publicShareId)}`, { data: { reason } })),
  elevate: async (password: string) => {
    const result = await unwrap(api.post<{ elevationToken: string; expiresIn: number }>('/admin/elevate', { password }));
    adminElevation = { token: result.elevationToken, expiresAt: Date.now() + result.expiresIn * 1_000 - 5_000 };
    return result;
  },
  operationalSettings: () => unwrap(api.get<OperationalSettings>('/admin/operational-settings')),
  updateOperationalSettings: (updates: Record<string, unknown>, reason: string) =>
    unwrap(api.patch<OperationalSettingsUpdate>('/admin/operational-settings', { updates, reason })),
  llmCredential: () => unwrap(api.get<LlmCredentialStatus>('/admin/llm-credential')),
  updateLlmCredential: (apiKey: string, reason: string) =>
    unwrap(api.put<LlmCredentialStatus>('/admin/llm-credential', { apiKey, reason })),
  removeLlmCredential: (reason: string) =>
    unwrap(api.delete<LlmCredentialStatus>('/admin/llm-credential', { data: { reason } })),
  exportSession: (sessionId: string, format: 'csv' | 'json', includeDeleted: boolean, reason: string) =>
    downloadAdminFile(`/admin/sessions/${encodeURIComponent(sessionId)}/export`, { format, includeDeleted, reason }, `session.${format}`),
  downloadBackup: (reason: string) => downloadAdminFile('/admin/database-backup', { reason }, 'openlogtool.db'),
  audit: (params: { page: number; pageSize: number; action?: string }) =>
    unwrap(api.get<Page<AuditEvent>>('/admin/governance-audit-events', { params })),
  metrics: () => unwrap(api.get<CollaborationMetrics>('/admin/collaboration-metrics')),
  publicLiveshareStats: (limit = 50) =>
    unwrap(api.get<PublicLiveshareStats>('/admin/public-liveshare-stats', { params: { limit } })),
  publicLiveshareStat: (publicShareId: string) =>
    unwrap(api.get<PublicLiveshareStatDetail>(`/admin/public-liveshare-stats/${encodeURIComponent(publicShareId)}`)),
  retentionPreview: (retentionDays: number) =>
    unwrap(api.get<Record<string, unknown>>('/admin/session-event-retention/preview', { params: { retentionDays } })),
  retentionPrune: (retentionDays: number, reason: string) =>
    unwrap(api.post<Record<string, unknown>>('/admin/session-event-retention/prune', { retentionDays, reason })),
};

export const archiveApi = {
  list: (params: { page: number; pageSize: number }) =>
    unwrapArchive(api.get<{ data: Page<PublicArchiveList> }>('/public-archive-lists', { params })),
  create: (title: string) => unwrapArchive(api.post<{ data: PublicArchiveList }>('/public-archive-lists', { title })),
  detail: (listId: string) => unwrapArchive(api.get<{ data: PublicArchiveList }>(`/public-archive-lists/${encodeURIComponent(listId)}`)),
  update: (listId: string, title: string) => unwrapArchive(api.patch<{ data: PublicArchiveList }>(`/public-archive-lists/${encodeURIComponent(listId)}`, { title })),
  remove: (listId: string) => unwrap(api.delete(`/public-archive-lists/${encodeURIComponent(listId)}`)),
  publish: (listId: string) => unwrapArchive(api.post<{ data: PublicArchiveList }>(`/public-archive-lists/${encodeURIComponent(listId)}/publish`, {})),
  unpublish: (listId: string) => unwrapArchive(api.post<{ data: PublicArchiveList }>(`/public-archive-lists/${encodeURIComponent(listId)}/unpublish`, {})),
  members: (listId: string) => unwrapArchive(api.get<{ data: PublicArchiveListUser[] }>(`/public-archive-lists/${encodeURIComponent(listId)}/members`)),
  addMember: (listId: string, userId: string) => unwrap(api.put(`/public-archive-lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(userId)}`, {})),
  addMemberByUsername: (listId: string, username: string) => unwrap(api.put(`/public-archive-lists/${encodeURIComponent(listId)}/members`, { username })),
  removeMember: (listId: string, userId: string) => unwrap(api.delete(`/public-archive-lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(userId)}`)),
  sources: (listId: string) => unwrapArchive(api.get<{ data: PublicArchiveListUser[] }>(`/public-archive-lists/${encodeURIComponent(listId)}/sources`)),
  addSource: (listId: string, userId: string) => unwrap(api.put(`/public-archive-lists/${encodeURIComponent(listId)}/sources/${encodeURIComponent(userId)}`, {})),
  addSourceByUsername: (listId: string, username: string) => unwrap(api.put(`/public-archive-lists/${encodeURIComponent(listId)}/sources`, { username })),
  removeSource: (listId: string, userId: string) => unwrap(api.delete(`/public-archive-lists/${encodeURIComponent(listId)}/sources/${encodeURIComponent(userId)}`)),
  candidateAccounts: (listId: string, params: { kind: 'members' | 'sources'; page: number; pageSize: number; q?: string }) =>
    unwrapArchive(api.get<{ data: Page<PublicArchiveCandidateAccount> }>(`/public-archive-lists/${encodeURIComponent(listId)}/candidate-accounts`, { params })),
  availableSessions: (listId: string, params: { page: number; pageSize: number; source?: 'personal' | 'collaboration' }) =>
    unwrapArchive(api.get<{ data: Page<AvailableArchiveSourceSession> }>(`/public-archive-lists/${encodeURIComponent(listId)}/available-sessions`, { params })),
  addSession: (listId: string, input: { sourceUserId: string; sourceKind: 'personal' | 'collaboration'; sourceSessionId: string }) =>
    unwrapArchive(api.post<{ data: PublicArchiveSession }>(`/public-archive-lists/${encodeURIComponent(listId)}/sessions`, input)),
  refreshSession: (listId: string, archiveSessionId: string) => unwrapArchive(api.put<{ data: PublicArchiveSession }>(`/public-archive-lists/${encodeURIComponent(listId)}/sessions/${encodeURIComponent(archiveSessionId)}/refresh`, {})),
  reorderSessions: (listId: string, archiveSessionIds: string[]) => unwrap(api.patch(`/public-archive-lists/${encodeURIComponent(listId)}/sessions/order`, { archiveSessionIds })),
  removeSession: (listId: string, archiveSessionId: string) => unwrap(api.delete(`/public-archive-lists/${encodeURIComponent(listId)}/sessions/${encodeURIComponent(archiveSessionId)}`)),
};

export const adminArchiveApi = {
  setAlias: (listId: string, alias: string) => unwrapArchive(api.put<{ data: Pick<PublicArchiveList, 'id' | 'title' | 'displayAlias'> }>(`/admin/public-archive-lists/${encodeURIComponent(listId)}/alias`, { alias })),
  removeAlias: (listId: string) => unwrap(api.delete(`/admin/public-archive-lists/${encodeURIComponent(listId)}/alias`)),
};

export default api;
