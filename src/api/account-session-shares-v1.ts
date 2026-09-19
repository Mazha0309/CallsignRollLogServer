import Database from 'better-sqlite3';
import { Router } from 'express';
import {
  acceptShareRequest,
  blockAccountShare,
  cancelShareRequest,
  createShareRequest,
  listAccountShareBlocks,
  listShareGrants,
  rejectShareRequest,
  revokeShareGrant,
  unblockAccountShare,
  updateShareGrant,
} from '../account-share/service';
import { parseShareScope } from '../account-share/access';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
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

interface AccountSessionSharesV1Dependencies {
  db?: Database.Database;
  config?: AppConfig;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  if (body[field] === undefined) return undefined;
  if (typeof body[field] !== 'boolean') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a boolean`, { field });
  }
  return body[field];
}

export function createAccountSessionSharesV1Router(
  dependencies: AccountSessionSharesV1Dependencies = {},
): Router {
  const router = Router();
  const database = () => dependencies.db ?? getDb();
  const runtimeConfig = dependencies.config ?? config;
  const writeLimiter = createMemoryRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyGenerator: (req) => `${(req as V1AuthRequest).auth?.userId ?? 'anonymous'}:${req.ip}`,
    message: 'Too many account share writes',
  });

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(createAccessTokenMiddleware(runtimeConfig, database));

  const writeGuards = runtimeConfig.rateLimitEnabled ? [writeLimiter] : [];

  router.post('/session-shares', ...writeGuards, (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, [
        'granteeUsername',
        'includePersonal',
        'includeOwned',
        'includeEditor',
        'canJoinAs',
        'expiresAt',
      ]);
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash('POST', '/api/v1/account/session-shares', body);
      const stored = readStoredResponse(database(), mutationId, req.auth!.userId, requestHash);
      if (stored) {
        res.status(stored.status).json(stored.body);
        return;
      }
      const scope = parseShareScope({
        includePersonal: body.includePersonal ?? true,
        includeOwned: body.includeOwned ?? true,
        includeEditor: body.includeEditor ?? true,
        canJoinAs: body.canJoinAs ?? 'editor',
      });
      const share = createShareRequest(database(), {
        grantorUserId: req.auth!.userId,
        granteeUsername: requireString(body, 'granteeUsername', { min: 1, max: 64 }),
        ...scope,
        expiresAt: body.expiresAt === undefined
          ? undefined
          : body.expiresAt === null
            ? null
            : requireString(body, 'expiresAt', { min: 20, max: 64 }),
        requestId: getRequestId(req),
        mutationId,
      });
      const payload = { share };
      storeResponse(database(), {
        mutationId,
        userId: req.auth!.userId,
        requestHash,
        status: 201,
        body: payload,
      });
      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get('/session-shares', (req: V1AuthRequest, res, next) => {
    try {
      const box = typeof req.query.box === 'string' ? req.query.box : 'active';
      if (box !== 'inbox' && box !== 'outbox' && box !== 'active') {
        throw new AppError(422, 'VALIDATION_FAILED', 'box is invalid', { field: 'box' });
      }
      res.json({ items: listShareGrants(database(), req.auth!.userId, box) });
    } catch (error) {
      next(error);
    }
  });

  function mutationRoute(
    action: 'accept' | 'reject' | 'cancel' | 'revoke',
    run: typeof acceptShareRequest,
  ) {
    router.post(`/session-shares/:id/${action}`, ...writeGuards, (req: V1AuthRequest, res, next) => {
      try {
        const mutationId = requireIdempotencyKey(req);
        const path = `/api/v1/account/session-shares/${req.params.id}/${action}`;
        const requestHash = computeRequestHash('POST', path, {});
        const stored = readStoredResponse(database(), mutationId, req.auth!.userId, requestHash);
        if (stored) {
          res.status(stored.status).json(stored.body);
          return;
        }
        const share = run(database(), {
          grantId: req.params.id,
          actorUserId: req.auth!.userId,
          requestId: getRequestId(req),
          mutationId,
        });
        const payload = { share };
        storeResponse(database(), {
          mutationId,
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
  }

  mutationRoute('accept', acceptShareRequest);
  mutationRoute('reject', rejectShareRequest);
  mutationRoute('cancel', cancelShareRequest);
  mutationRoute('revoke', revokeShareGrant);

  router.patch('/session-shares/:id', ...writeGuards, (req: V1AuthRequest, res, next) => {
    try {
      const body = requireJsonObject(req.body);
      rejectUnknownKeys(body, [
        'includePersonal',
        'includeOwned',
        'includeEditor',
        'canJoinAs',
        'expiresAt',
      ]);
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(
        'PATCH',
        `/api/v1/account/session-shares/${req.params.id}`,
        body,
      );
      const stored = readStoredResponse(database(), mutationId, req.auth!.userId, requestHash);
      if (stored) {
        res.status(stored.status).json(stored.body);
        return;
      }
      const share = updateShareGrant(database(), {
        grantId: req.params.id,
        actorUserId: req.auth!.userId,
        includePersonal: optionalBoolean(body, 'includePersonal'),
        includeOwned: optionalBoolean(body, 'includeOwned'),
        includeEditor: optionalBoolean(body, 'includeEditor'),
        canJoinAs: body.canJoinAs as 'editor' | 'viewer' | 'none' | undefined,
        expiresAt: body.expiresAt === undefined
          ? undefined
          : body.expiresAt === null
            ? null
            : requireString(body, 'expiresAt', { min: 20, max: 64 }),
        requestId: getRequestId(req),
        mutationId,
      });
      const payload = { share };
      storeResponse(database(), {
        mutationId,
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

  router.get('/session-share-blocks', (req: V1AuthRequest, res, next) => {
    try {
      res.json({ items: listAccountShareBlocks(database(), req.auth!.userId) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/session-share-blocks/:username', ...writeGuards, (req: V1AuthRequest, res, next) => {
    try {
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(
        'PUT',
        `/api/v1/account/session-share-blocks/${req.params.username}`,
        {},
      );
      const stored = readStoredResponse(database(), mutationId, req.auth!.userId, requestHash);
      if (stored) {
        res.status(stored.status).json(stored.body);
        return;
      }
      const result = blockAccountShare(database(), {
        actorUserId: req.auth!.userId,
        username: req.params.username,
        requestId: getRequestId(req),
        mutationId,
      });
      storeResponse(database(), {
        mutationId,
        userId: req.auth!.userId,
        requestHash,
        status: 200,
        body: result,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/session-share-blocks/:username', ...writeGuards, (req: V1AuthRequest, res, next) => {
    try {
      const mutationId = requireIdempotencyKey(req);
      const requestHash = computeRequestHash(
        'DELETE',
        `/api/v1/account/session-share-blocks/${req.params.username}`,
        {},
      );
      const stored = readStoredResponse(database(), mutationId, req.auth!.userId, requestHash);
      if (stored) {
        res.status(stored.status).json(stored.body);
        return;
      }
      const result = unblockAccountShare(database(), {
        actorUserId: req.auth!.userId,
        username: req.params.username,
        requestId: getRequestId(req),
        mutationId,
      });
      storeResponse(database(), {
        mutationId,
        userId: req.auth!.userId,
        requestHash,
        status: 200,
        body: result,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
