export type AccountRole = 'admin' | 'user';
export type SessionRole = 'owner' | 'editor' | 'viewer';
export type SessionStatus = 'initializing' | 'active' | 'closed' | 'deleted';

export interface User {
  id: string;
  username: string;
  role: AccountRole;
  createdAt?: string;
  disabledAt?: string | null;
  mustChangePassword?: boolean;
  loginNeverExpires?: boolean;
}

export interface ExcelExportSettings {
  formatVersion: 1;
  headerText: string;
  useSessionTitleAsHeader: boolean;
  useSessionTitleAsFileName: boolean;
  headerBackgroundColor: string;
  headerRowBackgroundColor: string;
  controllerBackgroundColor: string;
  tableBackgroundColor: string;
  alternateRowColor: string;
  useAlternateColors: boolean;
  fontFamily: string;
  showFooter: boolean;
  fileNameTemplate: string;
}

export interface ExcelExportSettingsResponse {
  excelExportSettings: ExcelExportSettings;
  persisted: boolean;
  updatedAt: string | null;
}

export interface AuthSession {
  accessToken: string;
  accessTokenExpiresIn?: number;
  user: User;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  status: SessionStatus;
  version: number;
  role: SessionRole;
  highWatermarkSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  deletedAt: string | null;
  ownerUsername?: string;
  logCount?: number;
}

export type AccountSessionSource = 'collaboration' | 'personal' | 'shared';
export type ShareJoinRole = 'editor' | 'viewer' | 'none';
export type ShareGrantStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'revoked' | 'expired';

export interface AccountShareGrant {
  id: string;
  grantorUserId: string;
  granteeUserId: string;
  status: ShareGrantStatus;
  includePersonal: boolean;
  includeOwned: boolean;
  includeEditor: boolean;
  canJoinAs: ShareJoinRole;
  createdAt: string;
  updatedAt: string;
  respondedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

export interface SharedSessionSummary {
  source: 'personal' | 'collaboration';
  sessionId: string;
  title: string;
  status: string;
  visibility: 'shared';
  grantId: string;
  grantorUserId: string;
  grantorUsername: string;
  grantorRole: SessionRole | null;
  canJoin: boolean;
  joinRole: Exclude<ShareJoinRole, 'none'> | null;
  logCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  deletedAt: string | null;
}

export interface AccountSessionSummary {
  source: AccountSessionSource;
  sessionId: string;
  title: string;
  status: SessionStatus | 'archived';
  role: SessionRole | null;
  ownerUserId: string;
  ownerUsername: string;
  logCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  deletedAt: string | null;
  snapshotRevision: number | null;
  sharedSource?: 'personal' | 'collaboration';
}

export interface PersonalSessionDetails {
  session: {
    source: 'personal';
    sessionId: string;
    title: string;
    status: 'active' | 'closed' | 'archived' | 'deleted';
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    deletedAt: string | null;
  };
  snapshot: {
    revision: number;
    formatVersion: number;
    sessionCount: number;
    logCount: number;
    byteSize: number;
    checksum: string;
    createdAt: string;
    updatedAt: string;
    exportedAt: string;
  };
  counts: { logs: number; deletedLogs: number };
}

export interface AdminSessionAccount {
  user: User & { disabledAt: string | null; deletedAt: string | null };
  collaborationSessionCount: number;
  ownedCollaborationSessionCount: number;
  personalSessionCount: number;
  totalSessionCount: number;
  personalSnapshotRevision: number | null;
  personalSnapshotUpdatedAt: string | null;
}

export interface AdminAccountSessionCatalog {
  user: User & { disabledAt: string | null; deletedAt: string | null };
  catalog: Page<AccountSessionSummary>;
}

export interface AdminPersonalSessionDetails extends PersonalSessionDetails {
  user: PersonalSnapshotOwner;
}

export interface LogRecord {
  syncId: string;
  sessionId: string;
  version: number;
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
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  deletedAt: string | null;
  ownedByCurrentUser?: boolean;
  canMutate?: boolean;
}

export type ExcelCorrectionField =
  | 'time'
  | 'controller'
  | 'callsign'
  | 'rstSent'
  | 'rstRcvd'
  | 'qth'
  | 'device'
  | 'power'
  | 'antenna'
  | 'height'
  | 'remarks';

export interface ExcelCorrectionCapabilities {
  configured: boolean;
  provider: 'disabled' | 'openai-responses' | 'openai-chat' | 'anthropic';
  model: string;
  maxWorkbookRows: number;
  previewExpiresInSeconds: number;
  canPreview: boolean;
  closedSessionRequiresOwner: boolean;
}

export interface ExcelCorrectionProposal {
  proposalId: string;
  syncId: string;
  ordinal: number;
  source: { sheet: string; row: number; sourceOrdinal: number | null };
  target: LogRecord;
  patch: Partial<Record<ExcelCorrectionField, string | null>>;
  changes: Array<{
    field: ExcelCorrectionField;
    before: string | null;
    after: string | null;
  }>;
  matchBasis: 'ordinal' | 'callsign-time' | 'callsign' | 'time-controller';
  confidence: number;
  notes: string[];
  requiresCarefulReview: boolean;
}

export interface ExcelCorrectionSummary {
  workbookRows: number;
  extractedRecords: number;
  matchedRecords: number;
  unchangedRecords: number;
  unmatchedRecords: number;
  ambiguousRecords: number;
  proposals: number;
  warnings: Array<{ sheet: string; row: number; message: string }>;
}

export interface ExcelCorrectionPreview {
  previewId: string | null;
  expiresAt: string | null;
  llm: {
    provider: Exclude<ExcelCorrectionCapabilities['provider'], 'disabled'>;
    model: string;
  };
  proposals: ExcelCorrectionProposal[];
  summary: ExcelCorrectionSummary;
}

export interface ExcelCorrectionApplyResult {
  previewId: string;
  appliedAt: string;
  appliedCount: number;
  applied: Array<{ proposalId: string; syncId: string; version: number }>;
}

export interface SessionSnapshot {
  protocolVersion: number;
  session: SessionSummary;
  highWatermarkSeq: number;
  includesDeletedLogs: boolean;
  logs: LogRecord[];
}

export interface Member {
  membershipId: string;
  sessionId: string;
  userId: string;
  username: string;
  role: SessionRole;
  version: number;
  joinedAt: string;
  updatedAt: string;
  removedAt: string | null;
}

export interface Invite {
  inviteId: string;
  sessionId: string;
  codeHint: string;
  code?: string;
  linkToken?: string;
  role: Exclude<SessionRole, 'owner'>;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface PublicShare {
  publicShareId: string;
  sessionId: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  secret?: string;
}

export interface AuditEvent {
  auditEventId: string;
  action: string;
  actorUserId: string;
  targetUserId?: string | null;
  targetSessionId?: string | null;
  targetLogId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  sessionId?: string | null;
  reason?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  requestId: string | null;
  mutationId: string | null;
  occurredAt: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CursorPage<T> {
  items: T[];
  pageInfo: { limit: number; hasMore: boolean; nextCursor: string | null };
}

export interface PublicArchiveList {
  id: string;
  title: string;
  ownerUserId: string;
  ownerUsername: string;
  isPublished: boolean;
  displayAlias?: string;
  capabilities: { canManageContents: boolean; canManageAccounts: boolean };
  sessions?: PublicArchiveSession[];
}

export interface PublicArchiveSession {
  id: string;
  listId: string;
  sourceUserId: string;
  sourceKind: AccountSessionSource;
  sourceSessionId: string;
  title: string;
  closedAt: string;
  displayOrder: number;
  logCount: number;
  snapshotAt: string;
}

export interface AvailableArchiveSourceSession extends Omit<AccountSessionSummary, 'status'> {
  status: 'closed';
}

export interface PublicArchiveListUser {
  userId: string;
  username: string;
}

export interface PublicArchiveCandidateAccount {
  userId: string;
  username: string;
}

export interface AdminOverview {
  serverInstanceId: string;
  generatedAt: string;
  registrationEnabled: boolean;
  counts: {
    users: { total: number; admins: number };
    sessions: { total: number; initializing: number; active: number; closed: number; deleted: number };
  };
}

export interface AudienceMetric {
  member: number;
  public: number;
}

export interface HttpSurfaceMetric {
  total: number;
  success: number;
  clientError: number;
  rateLimited: number;
  serverError: number;
  aborted: number;
  idempotentReplays: number;
  durationBucketsMs: Record<string, number>;
}

export interface CollaborationMetrics {
  schemaVersion: number;
  serverInstanceId: string;
  serverVersion: string;
  generatedAt: string;
  scope: {
    runtimeCounters: string;
    databaseGauges: string;
    countersStartedAt: string;
    singleProcessOnly: boolean;
  };
  runtime: {
    process: {
      memoryBytes: {
        rss: number;
        heapUsed: number;
        heapTotal: number;
        external: number;
      };
      cpu: {
        sampleWindowMs: number;
        userMicroseconds: number;
        systemMicroseconds: number;
        percentOfOneCore: number;
        percentOfMachineCapacity: number;
        logicalCpuCount: number;
      };
    };
    system: {
      scope: 'node-visible-runtime';
      logicalCpuCount: number;
      cpu: {
        sampleWindowMs: number;
        percentOfOneCore: number;
        percentOfMachineCapacity: number;
        logicalCpuCount: number;
      };
      loadAverage: { oneMinute: number; fiveMinutes: number; fifteenMinutes: number };
      memoryBytes: { total: number; free: number; used: number };
      cgroupV2: {
        available: false;
      } | {
        available: true;
        memoryBytes: {
          current: number | null;
          max: number | null;
          unlimited: boolean | null;
        };
        cpu: {
          usageMicroseconds: number | null;
          quotaMicroseconds: number | null;
          periodMicroseconds: number | null;
          quotaCpuCount: number | null;
          unlimited: boolean | null;
        };
      };
    };
    http: {
      total: number;
      completed: number;
      aborted: number;
      inFlight: number;
      rateLimited: number;
      idempotentReplays: number;
      bySurface: Record<string, HttpSurfaceMetric>;
    };
    webSockets: {
      attempts: AudienceMetric;
      accepted: AudienceMetric;
      cursorResumeAccepted: AudienceMetric;
      rejected: AudienceMetric;
      closed: AudienceMetric;
      active: AudienceMetric;
      resyncRequired: AudienceMetric;
      accessRevoked: AudienceMetric;
      controlDeliveryFailures: AudienceMetric;
    };
  };
  gauges: {
    runtime: {
      activeWebSockets: AudienceMetric & { total: number };
    };
    database: {
      activePublicShares: number;
      [key: string]: unknown;
    };
  };
}

export type PublicLiveshareState = 'active' | 'expired' | 'revoked' | 'sessionDeleted';

export interface PublicLiveshareStatItem {
  publicShareId: string;
  sessionId: string;
  sessionTitle: string;
  sessionStatus: SessionStatus;
  state: PublicLiveshareState;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  currentConnections: number;
  totalOpens: number;
  openCountSaturated: boolean;
  openCountSaturatedAt: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  lastAccessedAt: string | null;
}

export interface PublicLiveshareStats {
  schemaVersion: number;
  generatedAt: string;
  scope: {
    currentConnections: 'current-process';
    openCounts: 'current-database';
    singleProcessOnly: boolean;
    anonymousPageSessions: boolean;
    trackingStartedAt: string | null;
    viewSessionDetailLimits: {
      perShare: number;
      total: number;
    };
    visitorDetailLimit: number;
    visitorIpSource: 'trusted-request-ip';
  };
  totals: {
    activeShares: number;
    currentConnections: number;
    totalOpens: number;
    sharesWithOpens: number;
    saturatedShares: number;
  };
  items: PublicLiveshareStatItem[];
}

export interface PublicLiveshareStatDetail {
  schemaVersion: number;
  generatedAt: string;
  scope: PublicLiveshareStats['scope'];
  item: PublicLiveshareStatItem;
  visitors: PublicLiveshareVisitor[];
}

export interface PublicLiveshareVisitor {
  ipAddress: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  visitCount: number;
  currentConnections: number;
  location: {
    country: string | null;
    province: string | null;
    city: string | null;
    isp: string | null;
    displayName: string;
    source: 'ip2region';
  } | null;
}

export interface ServerInfo {
  serverInstanceId?: string;
  serverVersion?: string;
  version?: string;
  protocolVersion?: number;
  registrationEnabled?: boolean;
  capabilities?: Record<string, boolean>;
}

export interface PersonalSnapshotMetadata {
  exists: boolean;
  revision: number;
  formatVersion: number;
  sessionCount: number;
  logCount: number;
  byteSize: number;
  checksum: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PersonalSnapshotSession {
  session_id: string;
  title: string;
  status: 'active' | 'closed' | 'archived';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
}

export interface PersonalSnapshotLog {
  sync_id: string;
  session_id: string;
  time: string;
  controller: string;
  callsign: string;
  rst_sent: string | null;
  rst_rcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  source_device_id: string | null;
}

export interface PersonalSnapshot {
  version: 1;
  exportedAt: string;
  sessions: PersonalSnapshotSession[];
  logs: PersonalSnapshotLog[];
}

export interface PersonalSnapshotDownload extends PersonalSnapshotMetadata {
  snapshot: PersonalSnapshot;
}

export interface PersonalSnapshotOwner {
  id: string;
  username: string;
}

export interface AdminPersonalSnapshotItem {
  user: PersonalSnapshotOwner;
  personalSnapshot: PersonalSnapshotMetadata;
}

export interface AdminPersonalSnapshotDetail {
  user: PersonalSnapshotOwner;
  personalSnapshot: PersonalSnapshotDownload;
}

export interface PersonalDictionarySnapshotMetadata {
  exists: boolean;
  revision: number;
  formatVersion: number;
  itemCount: number;
  activeCount: number;
  deletedCount: number;
  byteSize: number;
  checksum: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export type PersonalDictionaryType = 'device' | 'antenna' | 'callsign' | 'qth';
export type PersonalDictionaryOrigin = 'user' | 'builtin';
export type PersonalDictionaryItemState = 'active' | 'deleted';

export interface PersonalDictionarySnapshotItem {
  dictType: PersonalDictionaryType;
  raw: string;
  origin: PersonalDictionaryOrigin;
  state: PersonalDictionaryItemState;
  pinyin: string | null;
  abbreviation: string | null;
}

export interface PersonalDictionarySnapshot {
  version: 1;
  exportedAt: string;
  items: PersonalDictionarySnapshotItem[];
}

export interface PersonalDictionarySnapshotDownload
  extends PersonalDictionarySnapshotMetadata {
  snapshot: PersonalDictionarySnapshot;
}

export interface AdminPersonalDictionarySnapshotItem {
  user: PersonalSnapshotOwner;
  personalDictionarySnapshot: PersonalDictionarySnapshotMetadata;
}

export interface AdminPersonalDictionarySnapshotDetail {
  user: PersonalSnapshotOwner;
  personalDictionarySnapshot: PersonalDictionarySnapshotDownload;
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type Locale = 'zh-CN' | 'en-US';
