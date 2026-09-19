import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { usernameIdentity } from '../auth/username-identity';
import { appendCollaborationAudit } from '../collaboration/audit';
import { AppError } from '../errors/app-error';
import { appendAccountShareAudit } from './audit';
import { parseShareScope } from './access';
import {
  AccountShareGrantDto,
  AccountShareGrantRow,
  PENDING_INBOX_CAP,
  PENDING_TTL_MS,
  ShareJoinRole,
  grantDto,
  sameShareScope,
} from './model';

export interface ShareMutationContext {
  grantorUserId?: string;
  actorUserId?: string;
  granteeUsername?: string;
  grantId?: string;
  includePersonal?: boolean;
  includeOwned?: boolean;
  includeEditor?: boolean;
  canJoinAs?: ShareJoinRole;
  expiresAt?: string | null;
  requestId: string;
  mutationId: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function findActiveUserByUsername(
  db: Database.Database,
  username: string,
): { id: string } | undefined {
  return db.prepare(`
    SELECT id FROM users
    WHERE username_identity(username) = ?
      AND disabled_at IS NULL
      AND deleted_at IS NULL
  `).get(usernameIdentity(username)) as { id: string } | undefined;
}

function isBlocked(
  db: Database.Database,
  blockerUserId: string,
  blockedUserId: string,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM account_share_blocks
    WHERE blocker_user_id = ? AND blocked_user_id = ?
  `).get(blockerUserId, blockedUserId));
}

function loadGrant(db: Database.Database, grantId: string): AccountShareGrantRow {
  const row = db.prepare('SELECT * FROM account_share_grants WHERE id = ?').get(grantId) as
    | AccountShareGrantRow
    | undefined;
  if (!row) {
    throw new AppError(404, 'NOT_FOUND', 'Share request not found');
  }
  return row;
}

function pendingInboxCount(db: Database.Database, granteeUserId: string): number {
  return Number(db.prepare(`
    SELECT COUNT(*) FROM account_share_grants
    WHERE grantee_user_id = ? AND status = 'pending'
  `).pluck().get(granteeUserId));
}

function findOpenPair(
  db: Database.Database,
  grantorUserId: string,
  granteeUserId: string,
): AccountShareGrantRow | undefined {
  return db.prepare(`
    SELECT * FROM account_share_grants
    WHERE grantor_user_id = ? AND grantee_user_id = ? AND status IN ('pending', 'accepted')
  `).get(grantorUserId, granteeUserId) as AccountShareGrantRow | undefined;
}

export function createShareRequest(
  db: Database.Database,
  input: {
    grantorUserId: string;
    granteeUsername: string;
    includePersonal: boolean;
    includeOwned: boolean;
    includeEditor: boolean;
    canJoinAs: ShareJoinRole;
    expiresAt?: string | null;
    requestId: string;
    mutationId: string;
  },
): AccountShareGrantDto {
  const scope = parseShareScope(input);
  return db.transaction(() => {
    const grantee = findActiveUserByUsername(db, input.granteeUsername);
    if (!grantee) {
      throw new AppError(404, 'ACCOUNT_SHARE_USER_NOT_FOUND', 'Share target was not found');
    }
    if (grantee.id === input.grantorUserId) {
      throw new AppError(400, 'ACCOUNT_SHARE_SELF', 'An account cannot share with itself');
    }
    if (
      isBlocked(db, grantee.id, input.grantorUserId) ||
      isBlocked(db, input.grantorUserId, grantee.id)
    ) {
      throw new AppError(403, 'ACCOUNT_SHARE_BLOCKED', 'This share is blocked');
    }
    const existing = findOpenPair(db, input.grantorUserId, grantee.id);
    if (existing) {
      if (sameShareScope(existing, scope)) return grantDto(existing);
      throw new AppError(
        409,
        'ACCOUNT_SHARE_PENDING_EXISTS',
        'An open share already exists for this pair',
      );
    }
    if (pendingInboxCount(db, grantee.id) >= PENDING_INBOX_CAP) {
      throw new AppError(409, 'ACCOUNT_SHARE_INBOX_FULL', 'The share inbox is full');
    }
    const now = nowIso();
    const expiresAt = input.expiresAt === undefined
      ? new Date(Date.now() + PENDING_TTL_MS).toISOString()
      : input.expiresAt;
    const id = randomUUID();
    db.prepare(`
      INSERT INTO account_share_grants (
        id, grantor_user_id, grantee_user_id, status,
        include_personal, include_owned, include_editor, can_join_as,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.grantorUserId,
      grantee.id,
      scope.includePersonal ? 1 : 0,
      scope.includeOwned ? 1 : 0,
      scope.includeEditor ? 1 : 0,
      scope.canJoinAs,
      now,
      now,
      expiresAt,
    );
    appendAccountShareAudit(db, {
      action: 'account_share.requested',
      actorUserId: input.grantorUserId,
      requestId: input.requestId,
      mutationId: input.mutationId,
      grantId: id,
      targetUserId: grantee.id,
      after: { status: 'pending', canJoinAs: scope.canJoinAs },
      occurredAt: now,
    });
    return grantDto(loadGrant(db, id));
  })();
}

export function acceptShareRequest(
  db: Database.Database,
  input: {
    grantId: string;
    actorUserId: string;
    requestId: string;
    mutationId: string;
  },
): AccountShareGrantDto {
  return db.transaction(() => {
    const grant = loadGrant(db, input.grantId);
    if (grant.grantee_user_id !== input.actorUserId) {
      throw new AppError(403, 'ACCOUNT_SHARE_NOT_GRANTEE', 'Only the grantee can accept');
    }
    if (grant.status !== 'pending') {
      throw new AppError(409, 'ACCOUNT_SHARE_PENDING_EXISTS', 'Share request is not pending');
    }
    const now = nowIso();
    db.prepare(`
      UPDATE account_share_grants
      SET status = 'accepted', responded_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, grant.id);
    appendAccountShareAudit(db, {
      action: 'account_share.accepted',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      mutationId: input.mutationId,
      grantId: grant.id,
      targetUserId: grant.grantor_user_id,
      before: { status: grant.status },
      after: { status: 'accepted' },
      occurredAt: now,
    });
    return grantDto(loadGrant(db, grant.id));
  })();
}

export function revokeShareGrant(
  db: Database.Database,
  input: {
    grantId: string;
    actorUserId: string;
    requestId: string;
    mutationId: string;
  },
): AccountShareGrantDto {
  return db.transaction(() => {
    const grant = loadGrant(db, input.grantId);
    if (grant.grantor_user_id !== input.actorUserId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the grantor can revoke');
    }
    if (grant.status !== 'accepted') {
      throw new AppError(409, 'ACCOUNT_SHARE_PENDING_EXISTS', 'Share grant is not accepted');
    }
    return revokeAcceptedGrant(db, grant, input);
  })();
}

function revokeAcceptedGrant(
  db: Database.Database,
  grant: AccountShareGrantRow,
  input: { actorUserId: string; requestId: string; mutationId: string },
): AccountShareGrantDto {
  const now = nowIso();
  const members = db.prepare(`
    SELECT id, session_id, user_id, role, version
    FROM session_members
    WHERE account_share_grant_id = ?
      AND join_source = 'account_share'
      AND removed_at IS NULL
  `).all(grant.id) as Array<{
    id: string;
    session_id: string;
    user_id: string;
    role: 'owner' | 'editor' | 'viewer';
    version: number;
  }>;
  for (const member of members) {
    db.prepare(`
      UPDATE session_members
      SET removed_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND removed_at IS NULL
    `).run(now, now, member.id);
    const updated = db.prepare('SELECT version FROM session_members WHERE id = ?').get(member.id) as {
      version: number;
    };
    appendCollaborationAudit(db, {
      action: 'membership.removed',
      sessionId: member.session_id,
      actorUserId: input.actorUserId,
      targetUserId: member.user_id,
      requestId: input.requestId,
      mutationId: `${input.mutationId}:${member.id}`,
      occurredAt: now,
      role: member.role,
      beforeVersion: member.version,
      afterVersion: updated.version,
      removedAt: now,
    });
  }
  db.prepare(`
    UPDATE account_share_grants
    SET status = 'revoked', revoked_at = ?, updated_at = ?
    WHERE id = ?
  `).run(now, now, grant.id);
  appendAccountShareAudit(db, {
    action: 'account_share.revoked',
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    mutationId: input.mutationId,
    grantId: grant.id,
    targetUserId: grant.grantee_user_id,
    before: { status: grant.status },
    after: { status: 'revoked' },
    occurredAt: now,
  });
  return grantDto(loadGrant(db, grant.id));
}

export function rejectShareRequest(
  db: Database.Database,
  input: {
    grantId: string;
    actorUserId: string;
    requestId: string;
    mutationId: string;
  },
): AccountShareGrantDto {
  return db.transaction(() => {
    const grant = loadGrant(db, input.grantId);
    if (grant.grantee_user_id !== input.actorUserId) {
      throw new AppError(403, 'ACCOUNT_SHARE_NOT_GRANTEE', 'Only the grantee can reject');
    }
    if (grant.status !== 'pending') {
      throw new AppError(409, 'ACCOUNT_SHARE_PENDING_EXISTS', 'Share request is not pending');
    }
    const now = nowIso();
    db.prepare(`
      UPDATE account_share_grants
      SET status = 'rejected', responded_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, grant.id);
    appendAccountShareAudit(db, {
      action: 'account_share.rejected',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      mutationId: input.mutationId,
      grantId: grant.id,
      targetUserId: grant.grantor_user_id,
      before: { status: grant.status },
      after: { status: 'rejected' },
      occurredAt: now,
    });
    return grantDto(loadGrant(db, grant.id));
  })();
}

export function updateShareGrant(
  db: Database.Database,
  input: {
    grantId: string;
    actorUserId: string;
    includePersonal?: boolean;
    includeOwned?: boolean;
    includeEditor?: boolean;
    canJoinAs?: ShareJoinRole;
    expiresAt?: string | null;
    requestId: string;
    mutationId: string;
  },
): AccountShareGrantDto {
  return db.transaction(() => {
    const grant = loadGrant(db, input.grantId);
    if (grant.grantor_user_id !== input.actorUserId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the grantor can update');
    }
    if (grant.status !== 'accepted') {
      throw new AppError(409, 'ACCOUNT_SHARE_PENDING_EXISTS', 'Share grant is not accepted');
    }
    const next = parseShareScope({
      includePersonal: input.includePersonal ?? grant.include_personal === 1,
      includeOwned: input.includeOwned ?? grant.include_owned === 1,
      includeEditor: input.includeEditor ?? grant.include_editor === 1,
      canJoinAs: input.canJoinAs ?? grant.can_join_as,
    });
    const expiresAt = input.expiresAt === undefined ? grant.expires_at : input.expiresAt;
    const now = nowIso();
    db.prepare(`
      UPDATE account_share_grants
      SET include_personal = ?, include_owned = ?, include_editor = ?,
          can_join_as = ?, expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.includePersonal ? 1 : 0,
      next.includeOwned ? 1 : 0,
      next.includeEditor ? 1 : 0,
      next.canJoinAs,
      expiresAt,
      now,
      grant.id,
    );
    appendAccountShareAudit(db, {
      action: 'account_share.updated',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      mutationId: input.mutationId,
      grantId: grant.id,
      targetUserId: grant.grantee_user_id,
      before: grantDto(grant) as unknown as Record<string, unknown>,
      after: { ...next, expiresAt },
      occurredAt: now,
    });
    return grantDto(loadGrant(db, grant.id));
  })();
}

export function cancelShareRequest(
  db: Database.Database,
  input: {
    grantId: string;
    actorUserId: string;
    requestId: string;
    mutationId: string;
  },
): AccountShareGrantDto {
  return db.transaction(() => {
    const grant = loadGrant(db, input.grantId);
    if (grant.grantor_user_id !== input.actorUserId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the grantor can cancel');
    }
    if (grant.status !== 'pending') {
      throw new AppError(409, 'ACCOUNT_SHARE_PENDING_EXISTS', 'Share request is not pending');
    }
    return markGrantCancelled(db, grant, input);
  })();
}

function markGrantCancelled(
  db: Database.Database,
  grant: AccountShareGrantRow,
  input: { actorUserId: string; requestId: string; mutationId: string },
): AccountShareGrantDto {
  const now = nowIso();
  db.prepare(`
    UPDATE account_share_grants
    SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, grant.id);
  appendAccountShareAudit(db, {
    action: 'account_share.cancelled',
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    mutationId: input.mutationId,
    grantId: grant.id,
    targetUserId: grant.grantor_user_id === input.actorUserId
      ? grant.grantee_user_id
      : grant.grantor_user_id,
    before: { status: grant.status },
    after: { status: 'cancelled' },
    occurredAt: now,
  });
  return grantDto(loadGrant(db, grant.id));
}

export function listShareGrants(
  db: Database.Database,
  actorUserId: string,
  box: 'inbox' | 'outbox' | 'active',
): AccountShareGrantDto[] {
  const rows = db.prepare(`
    SELECT * FROM account_share_grants
    WHERE
      CASE ?
        WHEN 'inbox' THEN grantee_user_id = ? AND status = 'pending'
        WHEN 'outbox' THEN grantor_user_id = ? AND status = 'pending'
        ELSE (
          (grantor_user_id = ? OR grantee_user_id = ?) AND status = 'accepted'
        )
      END
    ORDER BY updated_at DESC, id DESC
  `).all(box, actorUserId, actorUserId, actorUserId, actorUserId) as AccountShareGrantRow[];
  return rows.map(grantDto);
}

export function blockAccountShare(
  db: Database.Database,
  input: {
    actorUserId: string;
    username: string;
    requestId: string;
    mutationId: string;
  },
): { blockedUserId: string } {
  return db.transaction(() => {
    const target = findActiveUserByUsername(db, input.username);
    if (!target) {
      throw new AppError(404, 'ACCOUNT_SHARE_USER_NOT_FOUND', 'Share target was not found');
    }
    if (target.id === input.actorUserId) {
      throw new AppError(400, 'ACCOUNT_SHARE_SELF', 'An account cannot block itself');
    }
    const now = nowIso();
    db.prepare(`
      INSERT OR IGNORE INTO account_share_blocks (blocker_user_id, blocked_user_id, created_at)
      VALUES (?, ?, ?)
    `).run(input.actorUserId, target.id, now);
    const inbound = db.prepare(`
      SELECT * FROM account_share_grants
      WHERE grantor_user_id = ? AND grantee_user_id = ? AND status IN ('pending', 'accepted')
    `).all(target.id, input.actorUserId) as AccountShareGrantRow[];
    for (const grant of inbound) {
      if (grant.status === 'pending') {
        markGrantCancelled(db, grant, {
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          mutationId: `${input.mutationId}:${grant.id}`,
        });
      } else {
        revokeAcceptedGrant(db, grant, {
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          mutationId: `${input.mutationId}:${grant.id}`,
        });
      }
    }
    appendAccountShareAudit(db, {
      action: 'account_share.blocked',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      mutationId: input.mutationId,
      targetUserId: target.id,
      after: { blockedUserId: target.id },
      occurredAt: now,
    });
    return { blockedUserId: target.id };
  })();
}

export function unblockAccountShare(
  db: Database.Database,
  input: {
    actorUserId: string;
    username: string;
    requestId: string;
    mutationId: string;
  },
): { blockedUserId: string } {
  return db.transaction(() => {
    const target = findActiveUserByUsername(db, input.username);
    if (!target) {
      throw new AppError(404, 'ACCOUNT_SHARE_USER_NOT_FOUND', 'Share target was not found');
    }
    db.prepare(`
      DELETE FROM account_share_blocks
      WHERE blocker_user_id = ? AND blocked_user_id = ?
    `).run(input.actorUserId, target.id);
    appendAccountShareAudit(db, {
      action: 'account_share.unblocked',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      mutationId: input.mutationId,
      targetUserId: target.id,
      after: { blockedUserId: target.id },
      occurredAt: nowIso(),
    });
    return { blockedUserId: target.id };
  })();
}

export function listAccountShareBlocks(
  db: Database.Database,
  actorUserId: string,
): Array<{ blockedUserId: string; username: string; createdAt: string }> {
  return db.prepare(`
    SELECT b.blocked_user_id AS blockedUserId, u.username, b.created_at AS createdAt
    FROM account_share_blocks b
    JOIN users u ON u.id = b.blocked_user_id
    WHERE b.blocker_user_id = ?
    ORDER BY b.created_at DESC, b.blocked_user_id
  `).all(actorUserId) as Array<{ blockedUserId: string; username: string; createdAt: string }>;
}
