import { createServer, Server } from 'http';
import { createApp } from './app';
import { config, validateRuntimeConfig } from './config';
import { applyStoredConfigOverrides, rememberBaseConfig } from './config-overrides';
import { getDb } from './db/database';
import { createCollaborationWsServer } from './ws';
import { applyPendingDatabaseRestore } from './admin/database-recovery';

export function startServer(): Server {
  validateRuntimeConfig(config);
  const db = getDb();
  const recovery = applyPendingDatabaseRestore(db);
  if (recovery) console.log('Database recovery:', recovery.status, recovery.id);
  const baseConfig = rememberBaseConfig(config);
  applyStoredConfigOverrides(db, config);
  validateRuntimeConfig(config);
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  validateRuntimeConfig(config, {
    requireBootstrapSecret: Number(users.count) === 0,
    requireInviteHmacKey: true,
    requirePublicShareHmacKey: true,
  });

  const app = createApp({ db, config, baseConfig, onRestoreQueued: () => shutdown(true) });
  const runtimeConfig = (app.locals.openLogTool as { config: typeof config }).config;
  const server = createServer(app);
  const collaborationWs = createCollaborationWsServer(server, { db, config: runtimeConfig });
  // Session lifetime is explicit. Idle time is not permission to end a shared
  // recording or discard its draft; no inactivity monitor runs by default.
  server.listen(runtimeConfig.port, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : runtimeConfig.port;
    console.log(`OpenLogTool Server listening on port ${port}`);
  });

  let shuttingDown = false;
  const shutdown = (restart = false) => {
    if (shuttingDown) return;
    shuttingDown = true;
    collaborationWs.close();
    server.close(() => { db.close(); if (restart) process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown());
  process.once('SIGTERM', () => shutdown());
  return server;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    console.error('Failed to start OpenLogTool Server:', error);
    process.exitCode = 1;
  }
}
