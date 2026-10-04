import Database from 'better-sqlite3';
import { normalizeStableId } from '../collaboration/access';
import { AppError } from '../errors/app-error';
import { getValidatedPersonalSnapshot } from '../session-catalog/account-session-catalog';
import { rejectUnknownKeys, requireJsonObject } from '../utils/validation';
import { AccountShareGrantRow, BatchShareOptions, SelectedShareSession } from './model';

export function parseBatchShareOptions(input: Record<string, unknown>): BatchShareOptions {
  const result: BatchShareOptions = {};
  if (input.scopeMode !== undefined) {
    if (input.scopeMode !== 'all' && input.scopeMode !== 'selected') {
      throw new AppError(422, 'VALIDATION_FAILED', 'Choose all or selected sessions');
    }
    result.scopeMode = input.scopeMode;
  }
  for (const key of ['canEditLogs', 'canDeleteLogs'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new AppError(422, 'VALIDATION_FAILED', `${key} must be boolean`);
    result[key] = input[key];
  }
  if (input.selectedSessions !== undefined) {
    if (!Array.isArray(input.selectedSessions) || input.selectedSessions.length > 5000) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Select at most 5000 sessions');
    }
    const unique = new Map<string, SelectedShareSession>();
    for (const raw of input.selectedSessions) {
      const row = requireJsonObject(raw);
      rejectUnknownKeys(row, ['source', 'sessionId']);
      if (row.source !== 'personal' && row.source !== 'collaboration') {
        throw new AppError(422, 'VALIDATION_FAILED', 'Invalid session source');
      }
      const sessionId = normalizeStableId(row.sessionId, 'sessionId');
      unique.set(`${row.source}:${sessionId}`, { source: row.source, sessionId });
    }
    result.selectedSessions = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  }
  return result;
}

export function resolveBatchShareOptions(db: Database.Database, owner: string, input: BatchShareOptions, previous?: AccountShareGrantRow): Required<BatchShareOptions> {
  const result = {
    scopeMode: input.scopeMode ?? previous?.scope_mode ?? 'all',
    selectedSessions: input.selectedSessions ?? (previous ? JSON.parse(previous.selected_sessions_json) as SelectedShareSession[] : []),
    canEditLogs: input.canEditLogs ?? (previous?.can_edit_logs === 1),
    canDeleteLogs: input.canDeleteLogs ?? (previous?.can_delete_logs === 1),
  };
  if (result.scopeMode === 'all') {
    if (input.selectedSessions?.length) throw new AppError(422, 'VALIDATION_FAILED', 'All-session sharing cannot also contain a selection');
    result.selectedSessions = [];
  } else {
    if (!result.selectedSessions.length) throw new AppError(422, 'VALIDATION_FAILED', 'Select at least one session');
    const personal = result.selectedSessions.some(row => row.source === 'personal')
      ? getValidatedPersonalSnapshot(db, owner) : null;
    for (const row of result.selectedSessions) {
      const owned = row.source === 'personal'
        ? personal?.sessions.some(s => s.session_id === row.sessionId && !s.deleted_at)
        : db.prepare('SELECT 1 FROM sessions WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL').get(row.sessionId, owner);
      if (!owned) throw new AppError(404, 'SHARE_SESSION_UNAVAILABLE', 'Only your own synchronized sessions can be shared', { sessionId: row.sessionId });
    }
  }
  if (result.canDeleteLogs && !result.canEditLogs) throw new AppError(422, 'VALIDATION_FAILED', 'Deleting records requires edit permission as well');
  return result;
}

export function grantSelectsSession(grant: AccountShareGrantRow, source: string, sessionId: string): boolean {
  return grant.scope_mode === 'all' || (JSON.parse(grant.selected_sessions_json) as SelectedShareSession[])
    .some(row => row.source === source && row.sessionId === sessionId);
}
