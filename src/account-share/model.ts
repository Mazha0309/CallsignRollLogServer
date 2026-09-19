export const SHARE_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'cancelled',
  'revoked',
  'expired',
] as const;

export type ShareStatus = (typeof SHARE_STATUSES)[number];
export type ShareJoinRole = 'editor' | 'viewer' | 'none';
export type ShareSource = 'personal' | 'collaboration';
export type GrantorShareRole = 'owner' | 'editor' | 'viewer';

export interface ShareScope {
  includePersonal: boolean;
  includeOwned: boolean;
  includeEditor: boolean;
  canJoinAs: ShareJoinRole;
}

export interface AccountShareGrantRow {
  id: string;
  grantor_user_id: string;
  grantee_user_id: string;
  status: ShareStatus;
  include_personal: number;
  include_owned: number;
  include_editor: number;
  can_join_as: ShareJoinRole;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

export interface AccountShareGrantDto {
  id: string;
  grantorUserId: string;
  granteeUserId: string;
  status: ShareStatus;
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

export const PENDING_INBOX_CAP = 50;
export const PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function grantDto(row: AccountShareGrantRow): AccountShareGrantDto {
  return {
    id: row.id,
    grantorUserId: row.grantor_user_id,
    granteeUserId: row.grantee_user_id,
    status: row.status,
    includePersonal: row.include_personal === 1,
    includeOwned: row.include_owned === 1,
    includeEditor: row.include_editor === 1,
    canJoinAs: row.can_join_as,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    respondedAt: row.responded_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}

export function sameShareScope(row: AccountShareGrantRow, scope: ShareScope): boolean {
  return (
    row.include_personal === (scope.includePersonal ? 1 : 0) &&
    row.include_owned === (scope.includeOwned ? 1 : 0) &&
    row.include_editor === (scope.includeEditor ? 1 : 0) &&
    row.can_join_as === scope.canJoinAs
  );
}
