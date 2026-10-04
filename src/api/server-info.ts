import Database from 'better-sqlite3';
import { Router } from 'express';
import { AppConfig, config } from '../config';
import { getDb } from '../db/database';
import { AppError } from '../errors/app-error';
import { publicShareFeatureAvailable } from '../collaboration/public';
import { SERVER_VERSION } from '../server-version';
import { llmConfigured } from '../llm/json-client';
import { llmCredentialStatus } from '../llm/credential-store';

interface ServerInfoDependencies {
  db?: Database.Database;
  config?: AppConfig;
}

export function createServerInfoRouter(dependencies: ServerInfoDependencies = {}): Router {
  const router = Router();
  router.get('/', (_req, res, next) => {
    try {
      const db = dependencies.db ?? getDb();
      const runtimeConfig = dependencies.config ?? config;
      const row = db
        .prepare('SELECT instance_id FROM server_settings WHERE id = 1')
        .get() as { instance_id?: string | null } | undefined;
      if (!row?.instance_id) {
        throw new AppError(500, 'SERVER_IDENTITY_MISSING', 'Server identity is not initialized');
      }
      res.setHeader('Cache-Control', 'no-store');
      const features = [
        'collaboration',
        'authRefresh',
        'webCookieAuth',
        'accountManagement',
        'personalCloudSnapshots',
        'personalDictionarySnapshots',
        'accountSessionSharing',
        'batchSessionSharing',
        'friendCollaboration',
        'friendUserSearch',
        'friendDirectJoin',
        'socialWebSocket',
        'requiredPasswordChange',
        'serverAdministration',
        'serverAdministrationAudit',
        'databaseMigrations',
        'sessionPublishing',
        'sessionBootstrap',
        'sessionSnapshots',
        'memberCatalogPagination',
        'logAuthorship',
        'collaborationSharedLogEditing',
        'administratorGovernance',
        'operationalSettings',
        'databaseBackup',
        'sessionSnapshotTombstones',
        'sessionDeletion',
        'sessionMembership',
        'collaborationSecurityAudit',
        'sessionMutations',
        'sessionEvents',
        'collaborationWebSocket',
        ...(Buffer.byteLength(runtimeConfig.inviteHmacKey || '', 'utf8') >= 32
          ? ['collaborationInvites']
          : []),
        ...(publicShareFeatureAvailable(db, runtimeConfig)
          ? ['publicLiveshare', 'publicLivesharePage']
          : []),
        'collaborationOperationalMetrics',
        'sessionEventRetention',
        'collaborationLiveDraft',
        ...(llmConfigured(
          runtimeConfig,
          llmCredentialStatus(db, runtimeConfig).configured ? 'configured' : '',
        ) ? ['llmExcelCorrections'] : []),
      ];
      res.json({
        serverInstanceId: row.instance_id,
        serverVersion: SERVER_VERSION,
        protocolMin: 1,
        protocolMax: 1,
        features,
        serverTime: new Date().toISOString(),
        environment: runtimeConfig.environment,
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

export const serverInfoRouter = createServerInfoRouter();
