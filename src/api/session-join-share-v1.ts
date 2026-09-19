import Database from 'better-sqlite3';
import { Router } from 'express';
import {
  clearJoinPassphrase,
  getJoinPassphraseStatus,
  joinSessionWithShare,
  setJoinPassphrase,
} from '../account-share/passphrase';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import {
  computeRequestHash,
  readStoredResponse,
  requireIdempotencyKey,
  storeResponse,
} from '../collaboration/idempotency';
import { createAccessTokenMiddleware, V1AuthRequest } from '../middleware/auth-v1';
import { createMemoryRateLimiter } from '../middleware/rate-limit';
import { getRequestId } from '../middleware/request-id';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

interface SessionJoinShareV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

export function createSessionJoinShareV1Router(
  dependencies: SessionJoinShareV1Dependencies = {},
): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const joinLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 10,
    keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'anonymous'}:${req.ip}`,
    message: 'Too many share joins',
  });
  const writeGuards = runtimeConfig.rateLimitEnabled ? [joinLimiter] : [];

  router.use(createAccessTokenMiddleware(runtimeConfig, database));

  router.get('/:sessionId/join-passphrase', (req: V1AuthRequest, res, next) => {
    try {
      res.json(getJoinPassphraseStatus(database(), req.params.sessionId, req.auth!.userId));
    } catch (error) {
      next(error);
    }
  });

  router.put('/:sessionId/join-passphrase', ...writeGuards, (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['passphrase']);
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(
        'PUT',
        `/api/v1/sessions/${req.params.sessionId}/join-passphrase`,
        body,
      );
      const stored = readStoredResponse(database(), mutationId, req.auth!.userId, requestHash);
      if (stored) {
        res.status(stored.status).json(stored.body);
        return;
      }
      const payload = setJoinPassphrase(database(), {
        sessionId: req.params.sessionId,
        ownerUserId: req.auth!.userId,
        passphrase: requireString(body, 'passphrase', { min: 8, max: 128 }),
      });
      storeResponse(database(), {
        mutationId,
        sessionId: req.params.sessionId,
        userId: req.auth!.userId,
        requestHash,
        status: 200,
        body: payload,
      });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:sessionId/join-passphrase', ...writeGuards, (req: V1AuthRequest, res, next) => {
    try {
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(
        'DELETE',
        `/api/v1/sessions/${req.params.sessionId}/join-passphrase`,
        {},
      );
      const stored = readStoredResponse(database(), mutationId, req.auth!.userId, requestHash);
      if (stored) {
        res.status(stored.status).json(stored.body);
        return;
      }
      const payload = clearJoinPassphrase(database(), {
        sessionId: req.params.sessionId,
        ownerUserId: req.auth!.userId,
      });
      storeResponse(database(), {
        mutationId,
        sessionId: req.params.sessionId,
        userId: req.auth!.userId,
        requestHash,
        status: 200,
        body: payload,
      });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:sessionId/join-with-share', ...writeGuards, (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, ['passphrase']);
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(
        'POST',
        `/api/v1/sessions/${req.params.sessionId}/join-with-share`,
        body,
      );
      const stored = readStoredResponse(database(), mutationId, req.auth!.userId, requestHash);
      if (stored) {
        res.status(stored.status).json(stored.body);
        return;
      }
      const payload = joinSessionWithShare(database(), {
        sessionId: req.params.sessionId,
        actorUserId: req.auth!.userId,
        passphrase: requireString(body, 'passphrase', { min: 8, max: 128 }),
        requestId: getRequestId(req),
        mutationId,
      });
      storeResponse(database(), {
        mutationId,
        sessionId: req.params.sessionId,
        userId: req.auth!.userId,
        requestHash,
        status: 200,
        body: payload,
      });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
