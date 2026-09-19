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
  const grants = db.prepare(`
    SELECT g.*, u.username AS grantor_username
    FROM account_share_grants g
    JOIN users u ON u.id = g.grantor_user_id
    WHERE g.grantee_user_id = ? AND g.status = 'accepted'
  `).all(granteeUserId) as Array<AccountShareGrantRow & { grantor_username: string }>;

  const memberSessionIds = new Set(
    (db.prepare(`
      SELECT session_id FROM session_members
      WHERE user_id = ? AND removed_at IS NULL
    `).all(granteeUserId) as Array<{ session_id: string }>).map((row) => row.session_id),
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
        const logCounts = new Map<string, number>();
        for (const log of snapshot.logs) {
          if (!log.deleted_at) {
            logCounts.set(log.session_id, (logCounts.get(log.session_id) ?? 0) + 1);
          }
        }
        for (const session of snapshot.sessions) {
          if (session.deleted_at) continue;
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
            snapshotRevision: null,
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
      if (memberSessionIds.has(row.session_id)) continue;
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
): SharedSessionItem {
  const item = listSharedSessions(db, granteeUserId).items.find(
    (row) => row.source === source && row.sessionId === sessionId,
  );
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
) {
  const item = requireSharedSession(db, granteeUserId, source, sessionId);
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
  const item = requireSharedSession(db, granteeUserId, source, sessionId);
  if (source === 'personal') {
    return listPersonalSessionLogs(
      db,
      item.grantorUserId,
      sessionId,
      parsePersonalSessionLogsQuery(query),
    );
  }
  const parsed = parsePersonalSessionLogsQuery(query);
  const clauses = ['l.session_id = ?', 'l.deleted_at IS NULL'];
  const parameters: Array<string | number> = [sessionId];
  if (parsed.q) {
    clauses.push(`(
      l.callsign LIKE ? COLLATE NOCASE OR
      l.controller LIKE ? COLLATE NOCASE
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
    ORDER BY l.time ASC, l.id ASC
    LIMIT ? OFFSET ?
  `).all(...parameters, parsed.pageSize, offset);
  return {
    items: rows,
    page: parsed.page,
    pageSize: parsed.pageSize,
    total,
    totalPages: Math.ceil(total / parsed.pageSize),
  };
}
