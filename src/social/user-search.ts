import Database from 'better-sqlite3';
import { usernameIdentity } from '../auth/username-identity';
import { AppError } from '../errors/app-error';
import { requireString } from '../utils/validation';

interface UserSearchRow {
  userId: string;
  username: string;
  relationship: 'none' | 'friend' | 'outgoing' | 'incoming';
  requestId: string | null;
}

/** Search only public account names and this account's own relationship state. */
export function searchSocialUsers(db: Database.Database, actor: string, query: unknown) {
  const identity = usernameIdentity(requireString({ query }, 'query', { min: 2, max: 64 }));
  if (Array.from(identity).length < 2 || identity.length > 64) {
    throw new AppError(422, 'VALIDATION_FAILED', 'query length must be between 2 and 64', {
      field: 'query', min: 2, max: 64,
    });
  }
  const rows = db.prepare(`
    SELECT u.id AS userId, u.username,
      CASE
        WHEN f.status = 'accepted' THEN 'friend'
        WHEN f.sender_id = @actor THEN 'outgoing'
        WHEN f.recipient_id = @actor THEN 'incoming'
        ELSE 'none'
      END AS relationship,
      CASE WHEN f.status = 'pending' THEN f.id ELSE NULL END AS requestId
    FROM users u
    LEFT JOIN friend_requests f
      ON MIN(f.sender_id, f.recipient_id) = MIN(@actor, u.id)
      AND MAX(f.sender_id, f.recipient_id) = MAX(@actor, u.id)
      AND f.status IN ('pending', 'accepted')
      AND (f.status = 'accepted' OR f.expires_at > @now)
    WHERE u.id <> @actor AND u.disabled_at IS NULL AND u.deleted_at IS NULL
      AND INSTR(username_identity(u.username), @query) > 0
      AND NOT EXISTS (
        SELECT 1 FROM friend_blocks b
        WHERE (b.user_id = @actor AND b.blocked_user_id = u.id)
          OR (b.user_id = u.id AND b.blocked_user_id = @actor)
      )
    ORDER BY (username_identity(u.username) = @query) DESC,
      username_identity(u.username), u.id
    LIMIT 21
  `).all({ actor, query: identity, now: new Date().toISOString() }) as UserSearchRow[];
  return {
    items: rows.slice(0, 20).map(({ requestId, ...user }) => ({
      ...user,
      ...(requestId === null ? {} : { requestId }),
    })),
    hasMore: rows.length > 20,
  };
}
