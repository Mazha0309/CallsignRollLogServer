import Database from 'better-sqlite3';
import compression from 'compression';
import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { createAdminV1Router } from './api/admin-v1';
import { createAdminPersonalSnapshotsV1Router } from './api/admin-personal-snapshots-v1';
import { createAdminPersonalDictionarySnapshotsV1Router } from './api/admin-personal-dictionary-snapshots-v1';
import { createAdminGovernanceV1Router } from './api/admin-governance-v1';
import { createAdminDatabaseRecoveryRouter } from './api/admin-database-recovery-v1';
import { createAuthV1Router } from './api/auth-v1';
import { createWebAuthV1Router } from './api/web-auth-v1';
import { createAccountV1Router } from './api/account-v1';
import { createAccountSessionSharesV1Router } from './api/account-session-shares-v1';
import { createSocialV1Router } from './api/social-v1';
import { createPersonalSnapshotV1Router } from './api/personal-snapshot-v1';
import { createPersonalDictionarySnapshotV1Router } from './api/personal-dictionary-snapshot-v1';
import { createExcelExportSettingsV1Router } from './api/excel-export-settings-v1';
import { createExcelCorrectionsV1Router } from './api/excel-corrections-v1';
import { createCollaborationInvitesV1Router } from './api/collaboration-invites-v1';
import { createCollaborationMetricsV1Router } from './api/collaboration-metrics-v1';
import { createCollaborationSyncV1Router } from './api/collaboration-sync-v1';
import { createServerInfoRouter } from './api/server-info';
import { createSessionMembershipV1Router } from './api/session-members-v1';
import { createSessionsV1Router } from './api/sessions-v1';
import { createSessionJoinShareV1Router } from './api/session-join-share-v1';
import { createSessionEventRetentionV1Router } from './api/session-event-retention-v1';
import { createLiveDraftV1Router } from './api/live-draft-v1';
import { createPublicArchiveListsV1Router } from './api/public-archive-lists-v1';
import { createAdminPublicArchiveListsV1Router } from './api/admin-public-archive-lists-v1';
import { createPublicArchivesV1Router } from './api/public-archives-v1';
import { RESERVED_PUBLIC_ARCHIVE_ALIASES } from './public-archives/model';
import {
  createPublicSessionsV1Router,
  createPublicShareExchangeV1Router,
  createSessionPublicSharesV1Router,
} from './api/public-shares-v1';
import { AppConfig, config as defaultConfig } from './config';
import { bindBaseConfig } from './config-overrides';
import { getDb } from './db/database';
import { getRealtimeHub } from './collaboration/realtime';
import { errorMiddleware, notFoundMiddleware } from './middleware/error-handler';
import { requestIdMiddleware } from './middleware/request-id';
import { getRuntimeMetrics } from './operations/metrics';

export interface CreateAppOptions {
  onRestoreQueued?: () => void;
  clientDirectory?: string;
  db?: Database.Database;
  config?: Partial<AppConfig>;
  baseConfig?: AppConfig;
}

function resolveConfig(overrides?: Partial<AppConfig>): AppConfig {
  const resolved = { ...defaultConfig, ...overrides };
  return { ...resolved, corsOrigins: [...resolved.corsOrigins] };
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const runtimeConfig = resolveConfig(options.config);
  bindBaseConfig(runtimeConfig, options.baseConfig ?? runtimeConfig);
  const db = options.db ?? getDb();
  const metrics = getRuntimeMetrics(db);

  app.disable('x-powered-by');
  app.set('trust proxy', runtimeConfig.trustProxy);
  app.locals.openLogTool = {
    db,
    config: runtimeConfig,
    realtime: getRealtimeHub(db),
    metrics,
  };

  app.use(requestIdMiddleware);
  app.use(metrics.requestMiddleware());
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || runtimeConfig.corsOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: false,
      exposedHeaders: ['Preference-Applied'],
    }),
  );
  app.use(compression());
  app.use(
    [
      '/api/v1/admin',
      '/api/v1/auth',
      '/api/v1/web-auth',
      '/api/v1/account',
      '/api/v1/sessions',
      '/api/v1/collaboration-invites',
      '/api/v1/public-shares',
      '/api/v1/public-archive-lists',
      '/api/v1/public',
    ],
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  app.use(express.json({ limit: runtimeConfig.jsonBodyLimit }));
  app.use('/api/v1/admin/database-recovery', createAdminDatabaseRecoveryRouter({ db, config: runtimeConfig, onRestoreQueued: options.onRestoreQueued }));

  app.use(
    '/api/v1/server-info',
    createServerInfoRouter({ db, config: runtimeConfig }),
  );
  app.use('/api/v1/auth', createAuthV1Router({ db, config: runtimeConfig }));
  app.use('/api/v1/social', createSocialV1Router({ db, config: runtimeConfig }));
  app.use('/api/v1/web-auth', createWebAuthV1Router({ db, config: runtimeConfig }));
  app.use('/api/v1/account', createAccountV1Router({ db, config: runtimeConfig }));
  app.use(
    '/api/v1/account',
    createAccountSessionSharesV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/account',
    createPersonalSnapshotV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/account',
    createPersonalDictionarySnapshotV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/account',
    createExcelExportSettingsV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/admin',
    createCollaborationMetricsV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/admin',
    createSessionEventRetentionV1Router({ db, config: runtimeConfig }),
  );
  app.use('/api/v1/admin', createAdminV1Router({ db, config: runtimeConfig }));
  app.use(
    '/api/v1/admin',
    createAdminPersonalSnapshotsV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/admin',
    createAdminPersonalDictionarySnapshotsV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/admin',
    createAdminGovernanceV1Router({ db, config: runtimeConfig }),
  );
  app.use('/api/v1/sessions', createSessionsV1Router({ db, config: runtimeConfig }));
  app.use('/api/v1/sessions', createSessionJoinShareV1Router({ db, config: runtimeConfig }));
  app.use(
    '/api/v1/sessions',
    createExcelCorrectionsV1Router({ db, config: runtimeConfig }),
  );
  app.use('/api/v1/sessions', createLiveDraftV1Router({ db, config: runtimeConfig }));
  app.use(
    '/api/v1/sessions',
    createCollaborationSyncV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/sessions',
    createSessionMembershipV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/sessions',
    createSessionPublicSharesV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/collaboration-invites',
    createCollaborationInvitesV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/public-shares',
    createPublicShareExchangeV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/public/sessions',
    createPublicSessionsV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/public-archive-lists',
    createPublicArchiveListsV1Router({ db, config: runtimeConfig }),
  );
  app.use(
    '/api/v1/admin',
    createAdminPublicArchiveListsV1Router({ db, config: runtimeConfig }),
  );
  app.use('/api/v1/public', createPublicArchivesV1Router({ db }));

  const liveDist = path.join(__dirname, '../live/dist');
  const webDist = path.join(__dirname, '../web/dist');
  const clientDist = options.clientDirectory ?? process.env.WEB_CLIENT_DIR ?? path.join(__dirname, '../web-client');
  if (existsSync(path.join(clientDist, 'index.html'))) {
    const index = readFileSync(path.join(clientDist, 'index.html'), 'utf8')
      .replace(/<base href="[^"]*"\s*\/?\s*>/, '<base href="/client/">');
    app.get(/^\/client$/, (_req, res) => { res.redirect(302, '/client/'); });
    app.use('/client', (_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      next();
    });
    app.get('/client/index.html', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(index);
    });
    app.use('/client', express.static(clientDist, { index: false }));
    app.get('/client/*', (req, res, next) => {
      if (path.extname(req.path)) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(index);
    });
  }
  app.use('/live', express.static(liveDist, { index: false }));
  app.get(['/live/:publicShareId', '/live/:publicShareId/*'], (_req, res) => {
    res.sendFile(path.join(liveDist, 'index.html'));
  });

  app.use(express.static(webDist, { index: false }));
  app.get(['/:alias', '/:alias/session/:archiveSessionId'], (req, res, next) => {
    const alias = req.params.alias.toLowerCase();
    if (RESERVED_PUBLIC_ARCHIVE_ALIASES.has(alias)) return next();
    const published = db.prepare(`SELECT 1 FROM public_archive_aliases a
      JOIN public_archive_lists l ON l.id = a.list_id
      LEFT JOIN public_archive_list_sessions s
        ON s.list_id = l.id AND s.id = ?
      WHERE a.alias = ? AND l.is_published = 1 AND l.deleted_at IS NULL
        AND (? IS NULL OR s.id IS NOT NULL)`)
      .get(req.params.archiveSessionId ?? null, alias, req.params.archiveSessionId ?? null);
    if (!published) return next();
    return res.sendFile(path.join(liveDist, 'index.html'));
  });
  app.get(
    [
      '/',
      '/login',
      '/register',
      '/bootstrap',
      '/connect',
      '/app',
      '/app/*',
      '/admin',
      '/admin/*',
    ],
    (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    },
  );

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);
  return app;
}
