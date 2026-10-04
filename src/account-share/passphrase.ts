import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import {
  findMembership,
  findMembershipIncludingRemoved,
  findSession,
  membershipDto,
  sessionDto,
} from '../collaboration/access';
import { appendCollaborationAudit } from '../collaboration/audit';
import { AppError } from '../errors/app-error';
import { appendAccountShareAudit } from './audit';
import { AccountShareGrantRow } from './model';
import { expireShareGrants } from './service';

const MIN_PASSPHRASE = 8;
const MAX_PASSPHRASE = 128;

function normalizePassphrase(value: string): string {
  const passphrase = value.trim();
  if (passphrase.length < MIN_PASSPHRASE || passphrase.length > MAX_PASSPHRASE) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      `passphrase length must be between ${MIN_PASSPHRASE} and ${MAX_PASSPHRASE}`,
      { field: 'passphrase', min: MIN_PASSPHRASE, max: MAX_PASSPHRASE },
    );
  }
  return passphrase;
}

function hashPassphrase(passphrase: string, saltHex: string): string {
  return scryptSync(passphrase, Buffer.from(saltHex, 'hex'), 32).toString('hex');
}

export function getJoinPassphraseStatus(
  db: Database.Database,
  sessionId: string,
  actorUserId: string,
) {
  const session = findSession(db, sessionId);
  if (!session || session.deleted_at) {
    throw new AppError(404, 'NOT_FOUND', 'Session not found');
  }
  if (session.owner_user_id !== actorUserId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the owner can view join passphrase status');
  }
  const row = db.prepare(`
    SELECT updated_at FROM session_join_passphrases WHERE session_id = ?
  `).get(sessionId) as { updated_at: string } | undefined;
  return {
    configured: Boolean(row),
    updatedAt: row?.updated_at ?? null,
  };
}

export function setJoinPassphrase(
  db: Database.Database,
  input: { sessionId: string; ownerUserId: string; passphrase: string },
): { configured: true; passphrase: string; updatedAt: string } {
  const session = findSession(db, input.sessionId);
  if (!session || session.deleted_at) {
    throw new AppError(404, 'NOT_FOUND', 'Session not found');
  }
  if (session.owner_user_id !== input.ownerUserId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the owner can set a join passphrase');
  }
  const passphrase = normalizePassphrase(input.passphrase);
  const salt = randomBytes(16).toString('hex');
  const hash = hashPassphrase(passphrase, salt);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO session_join_passphrases (
      session_id, passphrase_hash, passphrase_salt, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      passphrase_hash = excluded.passphrase_hash,
      passphrase_salt = excluded.passphrase_salt,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(input.sessionId, hash, salt, input.ownerUserId, now);
  return { configured: true, passphrase, updatedAt: now };
}

export function clearJoinPassphrase(
  db: Database.Database,
  input: { sessionId: string; ownerUserId: string },
): { configured: false } {
  const session = findSession(db, input.sessionId);
  if (!session || session.deleted_at) {
    throw new AppError(404, 'NOT_FOUND', 'Session not found');
  }
  if (session.owner_user_id !== input.ownerUserId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the owner can clear a join passphrase');
  }
  db.prepare('DELETE FROM session_join_passphrases WHERE session_id = ?').run(input.sessionId);
  return { configured: false };
}

function verifyPassphrase(db: Database.Database, sessionId: string, passphrase: string): boolean {
  const row = db.prepare(`
    SELECT passphrase_hash, passphrase_salt
    FROM session_join_passphrases
    WHERE session_id = ?
  `).get(sessionId) as { passphrase_hash: string; passphrase_salt: string } | undefined;
  if (!row) return false;
  const actual = Buffer.from(hashPassphrase(passphrase, row.passphrase_salt), 'hex');
  const expected = Buffer.from(row.passphrase_hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function joinSessionWithShare(
  db: Database.Database,
  input: {
    sessionId: string;
    actorUserId: string;
    passphrase: string;
    requestId: string;
    mutationId: string;
  },
) {
  expireShareGrants(db);
  return db.transaction(() => {
    const session = findSession(db, input.sessionId);
    if (!session || session.deleted_at) {
      throw new AppError(404, 'NOT_FOUND', 'Session not found');
    }
    if (session.owner_user_id === input.actorUserId) {
      throw new AppError(403, 'ACCOUNT_SHARE_CANNOT_JOIN', 'The owner cannot join through sharing');
    }
    const grant = db.prepare(`
      SELECT * FROM account_share_grants
      WHERE grantor_user_id = ? AND grantee_user_id = ? AND status = 'accepted'
    `).get(session.owner_user_id, input.actorUserId) as AccountShareGrantRow | undefined;
    if (!grant || grant.include_owned !== 1 || (grant.can_join_as !== 'editor' && grant.can_join_as !== 'viewer')) {
      throw new AppError(403, 'ACCOUNT_SHARE_CANNOT_JOIN', 'Sharing cannot join this session');
    }
    const passphrase = normalizePassphrase(input.passphrase);
    const configured = Boolean(db.prepare(
      'SELECT 1 FROM session_join_passphrases WHERE session_id = ?',
    ).get(session.id));
    if (!configured) {
      throw new AppError(403, 'ACCOUNT_SHARE_CANNOT_JOIN', 'Sharing cannot join this session');
    }
    if (!verifyPassphrase(db, session.id, passphrase)) {
      throw new AppError(403, 'ACCOUNT_SHARE_PASSPHRASE_INVALID', 'Join passphrase is invalid');
    }
    const now = new Date().toISOString();
    const existing = findMembershipIncludingRemoved(db, session.id, input.actorUserId);
    const role = grant.can_join_as;
    if (!existing) {
      db.prepare(`
        INSERT INTO session_members (
          id, session_id, user_id, role, version, created_at, updated_at,
          join_source, account_share_grant_id
        ) VALUES (?, ?, ?, ?, 1, ?, ?, 'account_share', ?)
      `).run(randomUUID(), session.id, input.actorUserId, role, now, now, grant.id);
    } else {
      const nextRole = existing.removed_at
        ? role
        : (existing.role === 'owner' || (existing.role === 'editor' && role === 'viewer')
          ? existing.role
          : role);
      db.prepare(`
        UPDATE session_members
        SET role = ?, removed_at = NULL, removed_by = NULL,
            version = version + 1, updated_at = ?,
            join_source = CASE WHEN removed_at IS NULL THEN join_source ELSE 'account_share' END,
            account_share_grant_id = CASE WHEN removed_at IS NULL THEN account_share_grant_id ELSE ? END
        WHERE id = ?
      `).run(nextRole, now, grant.id, existing.id);
    }
    const membership = findMembership(db, session.id, input.actorUserId);
    if (!membership) {
      throw new AppError(409, 'REDEMPTION_STATE_INVALID', 'Share join state is incomplete');
    }
    appendAccountShareAudit(db, {
      action: 'account_share.joined',
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      mutationId: input.mutationId,
      grantId: grant.id,
      targetUserId: session.owner_user_id,
      sessionId: session.id,
      after: { role: membership.role },
      occurredAt: now,
    });
    appendCollaborationAudit(db, {
      action: 'invite.redeemed',
      sessionId: session.id,
      actorUserId: input.actorUserId,
      targetUserId: input.actorUserId,
      requestId: input.requestId,
      mutationId: input.mutationId,
      occurredAt: now,
      inviteId: grant.id,
      roleGranted: role,
      beforeUsedCount: 0,
      afterUsedCount: 1,
      beforeMembershipState: existing
        ? (existing.removed_at ? 'removed' : 'active')
        : 'absent',
      beforeMembershipRole: existing?.role ?? null,
      beforeMembershipVersion: existing?.version ?? null,
      afterMembershipState: 'active',
      afterMembershipRole: membership.role,
      afterMembershipVersion: membership.version,
    });
    return {
      membership: {
        ...membershipDto(membership),
        joinSource: 'account_share',
      },
      session: sessionDto(session, membership.role),
    };
  })();
}
