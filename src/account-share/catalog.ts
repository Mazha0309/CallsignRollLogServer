import Database from 'better-sqlite3';
import { AppError } from '../errors/app-error';
import {
  getPersonalSessionDetail,
  getValidatedPersonalSnapshot,
  listPersonalSessionLogs,
  parsePersonalSessionLogsQuery,
} from '../session-catalog/account-session-catalog';
import { AccountShareGrantRow, GrantorShareRole } from './model';
import { sessionVisibleThroughGrant } from './access';
import { expireShareGrants } from './service';
import { grantSelectsSession } from './selection';

export interface SharedSessionItem {
  source: 'personal' | 'collaboration';
  sessionId: string;
  title: string;
  status: string;
  visibility: 'shared';
  grantId: string;
  grantorUserId: string;
  grantorUsername: string;
  grantorRole: GrantorShareRole | null;
  canJoin: boolean;
  joinRole: 'editor' | 'viewer' | null;
  logCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  deletedAt: string | null;
  snapshotRevision: number | null;
  canEditLogs: boolean;
  canDeleteLogs: boolean;
}

interface CollaborationRow {
  session_id: string;
  title: string;
  status: string;
  role: GrantorShareRole;
  owner_user_id: string;
  owner_username: string;
  log_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  deleted_at: string | null;
}

export function listSharedSessions(
  db: Database.Database,
  granteeUserId: string,
): { items: SharedSessionItem[] } {
  expireShareGrants(db);
  const grants = db.prepare(`
    SELECT g.*, u.username AS grantor_username
    FROM account_share_grants g
    JOIN users u ON u.id = g.grantor_user_id
    WHERE g.grantee_user_id = ? AND g.status = 'accepted'
      AND u.disabled_at IS NULL AND u.deleted_at IS NULL
  `).all(granteeUserId) as Array<AccountShareGrantRow & { grantor_username: string }>;

  const memberRoles = new Map(
    (db.prepare(`
      SELECT session_id, role FROM session_members
      WHERE user_id = ? AND removed_at IS NULL
    `).all(granteeUserId) as Array<{ session_id: string; role: string }>).map((row) => [row.session_id, row.role]),
  );

  const passphraseSessions = new Set(
    (db.prepare('SELECT session_id FROM session_join_passphrases').all() as Array<{
      session_id: string;
    }>).map((row) => row.session_id),
  );

  const items: SharedSessionItem[] = [];
  for (const grant of grants) {
    const scope = {
      includePersonal: grant.include_personal === 1,
      includeOwned: grant.include_owned === 1,
      includeEditor: grant.include_editor === 1,
    };
    if (scope.includePersonal) {
      const snapshot = getValidatedPersonalSnapshot(db, grant.grantor_user_id);
      if (snapshot) {
        const snapshotRevision = Number(db.prepare('SELECT revision FROM personal_cloud_snapshots WHERE user_id = ?').pluck().get(grant.grantor_user_id));
        const logCounts = new Map<string, number>();
        for (const log of snapshot.logs) {
          if (!log.deleted_at) {
            logCounts.set(log.session_id, (logCounts.get(log.session_id) ?? 0) + 1);
          }
        }
        for (const session of snapshot.sessions) {
          if (session.deleted_at || !grantSelectsSession(grant, 'personal', session.session_id)) continue;
          if (!sessionVisibleThroughGrant({ ...scope, source: 'personal' })) continue;
          items.push({
            source: 'personal',
            sessionId: session.session_id,
            title: session.title,
            status: session.status,
            visibility: 'shared',
            grantId: grant.id,
            grantorUserId: grant.grantor_user_id,
            grantorUsername: grant.grantor_username,
            grantorRole: null,
            canJoin: false,
            joinRole: null,
            logCount: logCounts.get(session.session_id) ?? 0,
            createdAt: session.created_at,
            updatedAt: session.updated_at,
            closedAt: session.closed_at,
            deletedAt: session.deleted_at,
            snapshotRevision,
            canEditLogs: grant.can_edit_logs === 1 && session.status === 'active',
            canDeleteLogs: grant.can_edit_logs === 1 && grant.can_delete_logs === 1 && session.status === 'active',
          });
        }
      }
    }

    const collaborationRows = db.prepare(`
      SELECT
        s.id AS session_id, s.title, s.status, sm.role,
        s.owner_user_id, owner.username AS owner_username,
        (SELECT COUNT(*) FROM logs l
         WHERE l.session_id = s.id AND l.deleted_at IS NULL) AS log_count,
        s.created_at, s.updated_at, s.closed_at, s.deleted_at
      FROM sessions s
      INNER JOIN session_members sm ON sm.session_id = s.id
      INNER JOIN users owner ON owner.id = s.owner_user_id
      WHERE sm.user_id = ? AND sm.removed_at IS NULL AND s.deleted_at IS NULL
    `).all(grant.grantor_user_id) as CollaborationRow[];

    for (const row of collaborationRows) {
      const memberRole = memberRoles.get(row.session_id);
      // An independent viewer membership must not mask an explicit editable
      // share. Owner/editor memberships already grant all record operations.
      if (memberRole && (memberRole !== 'viewer' || grant.can_edit_logs !== 1)) continue;
      if (!grantSelectsSession(grant, 'collaboration', row.session_id)) continue;
      const visible = sessionVisibleThroughGrant({
        ...scope,
        source: 'collaboration',
        grantorRole: row.role,
      });
      if (!visible) continue;
      const canJoin = row.role === 'owner'
        && scope.includeOwned
        && grant.can_join_as !== 'none'
        && passphraseSessions.has(row.session_id);
      items.push({
        source: 'collaboration',
        sessionId: row.session_id,
        title: row.title,
        status: row.status,
        visibility: 'shared',
        grantId: grant.id,
        grantorUserId: grant.grantor_user_id,
        grantorUsername: grant.grantor_username,
        grantorRole: row.role,
        canJoin,
        joinRole: canJoin ? (grant.can_join_as === 'none' ? null : grant.can_join_as) : null,
        logCount: Number(row.log_count),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at,
        deletedAt: row.deleted_at,
        snapshotRevision: null,
        canEditLogs: grant.can_edit_logs === 1 && row.owner_user_id === grant.grantor_user_id && row.status === 'active',
        canDeleteLogs: grant.can_edit_logs === 1 && grant.can_delete_logs === 1 && row.owner_user_id === grant.grantor_user_id && row.status === 'active',
      });
    }
  }

  items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
    || left.sessionId.localeCompare(right.sessionId));
  return { items };
}

export function requireSharedSession(
  db: Database.Database,
  granteeUserId: string,
  source: 'personal' | 'collaboration',
  sessionId: string,
  grantId?: string,
): SharedSessionItem {
  const matches = listSharedSessions(db, granteeUserId).items.filter(
    (row) => row.source === source && row.sessionId === sessionId && (!grantId || row.grantId === grantId),
  );
  if (matches.length > 1) throw new AppError(422, 'SHARE_GRANT_REQUIRED', 'Specify the grantId for this shared session');
  const item = matches[0];
  if (!item) {
    throw new AppError(404, 'NOT_FOUND', 'Shared session was not found');
  }
  return item;
}

export function getSharedSessionDetail(
  db: Database.Database,
  granteeUserId: string,
  source: 'personal' | 'collaboration',
  sessionId: string,
  grantId?: string,
) {
  const item = requireSharedSession(db, granteeUserId, source, sessionId, grantId);
  if (source === 'personal') {
    return {
      ...item,
      detail: getPersonalSessionDetail(db, item.grantorUserId, sessionId),
    };
  }
  return { ...item };
}

export function listSharedSessionLogs(
  db: Database.Database,
  granteeUserId: string,
  source: 'personal' | 'collaboration',
  sessionId: string,
  query: Record<string, unknown>,
) {
  const { grantId, ...logQuery } = query;
  if (grantId !== undefined && typeof grantId !== 'string') throw new AppError(422, 'VALIDATION_FAILED', 'Invalid grantId');
  const item = requireSharedSession(db, granteeUserId, source, sessionId, grantId);
  const parsed = parsePersonalSessionLogsQuery(logQuery);
  if (parsed.includeDeleted) throw new AppError(403, 'FORBIDDEN', 'Deleted records are not shared');
  if (source === 'personal') {
    return { ...listPersonalSessionLogs(
      db,
      item.grantorUserId,
      sessionId,
      parsed,
    ), session: item };
  }
  const clauses = ['l.session_id = ?', 'l.deleted_at IS NULL'];
  const parameters: Array<string | number> = [sessionId];
  if (parsed.q) {
    clauses.push(`(
      l.callsign LIKE ? ESCAPE '\\' COLLATE NOCASE OR
      l.controller LIKE ? ESCAPE '\\' COLLATE NOCASE
    )`);
    const pattern = `%${parsed.q.replace(/[\\%_]/g, '\\$&')}%`;
    parameters.push(pattern, pattern);
  }
  const where = clauses.join(' AND ');
  const offset = (parsed.page - 1) * parsed.pageSize;
  const total = Number(db.prepare(`SELECT COUNT(*) FROM logs l WHERE ${where}`).pluck().get(...parameters));
  const rows = db.prepare(`
    SELECT l.* FROM logs l
    WHERE ${where}
    ORDER BY ${parsed.sort === 'updatedDesc' ? 'l.updated_at DESC' : parsed.sort === 'timeDesc' ? 'l.time DESC' : 'l.time ASC'}, l.id ASC
    LIMIT ? OFFSET ?
  `).all(...parameters, parsed.pageSize, offset);
  return {
    session: item,
    items: rows,
    page: parsed.page,
    pageSize: parsed.pageSize,
    total,
    totalPages: Math.ceil(total / parsed.pageSize),
  };
}
