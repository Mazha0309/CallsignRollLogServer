import Database from 'better-sqlite3';
import { Router } from 'express';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { computeRequestHash, readStoredResponse, requireIdempotencyKey, storeResponse } from '../collaboration/idempotency';
import { getRealtimeHub } from '../collaboration/realtime';
import { getSocialRealtimeHub, socialRecipients } from '../social/realtime';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';
import { blockFriend, expireRequests, removeFriend, requestFriend, requestSession, respondFriend, respondSession, sessionAccess, socialDashboard } from '../social/service';

export function createSocialV1Router(deps: { db?: Database.Database; config?: AppConfig } = {}) {
  const router = Router();
  const db = deps.db ?? getDb();
  const runtime = deps.config ?? config;
  router.use(createAccessTokenMiddleware(runtime, () => db));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  if (runtime.rateLimitEnabled) router.use(createMemoryRateLimiter({ windowMs: 60_000, max: 120, keyGenerator: req => `${(req as V1AuthRequest).auth!.userId}:${req.ip}`, message: 'Too many friend requests' }));
  router.post('/ws-ticket', (req: V1AuthRequest, res, next) => {
    try {
      rejectUnknownKeys(requireJsonObject(req.body ?? {}), []);
      res.json(getSocialRealtimeHub(db).issue(req.auth!));
    } catch (error) { next(error); }
  });
  router.get('/', (req: V1AuthRequest, res, next) => {
    try {
      const result = db.transaction(() => ({ expired: expireRequests(db), body: socialDashboard(db, req.auth!.userId) }))();
      getSocialRealtimeHub(db).notify(result.expired);
      res.json(result.body);
    } catch (error) { next(error); }
  });
  router.get('/sessions/:id', (req: V1AuthRequest, res, next) => {
    try { res.json(sessionAccess(db, req.auth!.userId, req.params.id)); } catch (error) { next(error); }
  });
  function mutation(method: 'post' | 'put' | 'delete', path: string, keys: string[], run: (actor: string, params: Record<string, string>, body: Record<string, unknown>) => unknown) {
    router[method](path, (req: V1AuthRequest, res, next) => {
      try {
        const body = requireJsonObject(req.body ?? {});
        rejectUnknownKeys(body, keys);
        const mutationId = requireIdempotencyKey(req);
        const userId = req.auth!.userId;
        const requestHash = computeRequestHash(method, req.originalUrl, body);
        const result = db.transaction(() => {
          const stored = readStoredResponse(db, mutationId, userId, requestHash);
          if (stored) return { ...stored, replayed: true };
          const recipients = expireRequests(db);
          for (const peer of socialRecipients(db, userId)) recipients.add(peer);
          const payload = run(userId, req.params, body);
          for (const peer of socialRecipients(db, userId)) recipients.add(peer);
          storeResponse(db, { mutationId, userId, requestHash, status: 200, body: payload });
          return { status: 200, body: payload, replayed: false, recipients };
        }).immediate();
        const membership = (result.body as { membership?: { sessionId: string; userId: string; role: string; version: number } }).membership;
        if (membership && !result.replayed) getRealtimeHub(db).roleChanged(membership.sessionId, membership.userId, membership.role, membership.version);
        if ('recipients' in result && result.recipients) getSocialRealtimeHub(db).notify(result.recipients);
        res.status(result.status).json(result.body);
      } catch (error) { next(error); }
    });
  }
  mutation('post', '/friend-requests', ['username'], (actor, _, body) => requestFriend(db, actor, requireString(body, 'username', { max: 64 })));
  mutation('post', '/friend-requests/:id/:action', [], (actor, p) => respondFriend(db, actor, p.id, p.action));
  mutation('delete', '/friends/:id', [], (actor, p) => removeFriend(db, actor, p.id));
  mutation('put', '/blocks/:username', [], (actor, p) => blockFriend(db, actor, p.username, true));
  mutation('delete', '/blocks/:username', [], (actor, p) => blockFriend(db, actor, p.username, false));
  mutation('put', '/sessions/:id', ['visibility'], (actor, p, body) => sessionAccess(db, actor, p.id, requireString(body, 'visibility')));
  mutation('post', '/sessions/:id/invitations', ['username', 'role'], (actor, p, body) => requestSession(db, actor, p.id, 'invitation', body.role, requireString(body, 'username', { max: 64 })));
  mutation('post', '/sessions/:id/applications', ['role'], (actor, p, body) => requestSession(db, actor, p.id, 'application', body.role));
  mutation('post', '/session-requests/:id/:action', [], (actor, p) => respondSession(db, actor, p.id, p.action));
  return router;
}
