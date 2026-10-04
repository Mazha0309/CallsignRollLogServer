import Database from 'better-sqlite3';
import { AppConfig } from './config';
import { validateWebClientUrl } from './client-link';

const baseConfigs = new WeakMap<AppConfig, AppConfig>();

function cloneConfig(value: AppConfig): AppConfig {
  return { ...value, corsOrigins: [...value.corsOrigins] };
}

export function rememberBaseConfig(value: AppConfig): AppConfig {
  let stored = baseConfigs.get(value);
  if (!stored) {
    stored = cloneConfig(value);
    baseConfigs.set(value, stored);
  }
  return cloneConfig(stored);
}

export function bindBaseConfig(value: AppConfig, base: AppConfig): void {
  baseConfigs.set(value, cloneConfig(base));
}

export function applyStoredConfigOverrides(
  db: Database.Database,
  value: AppConfig,
): AppConfig {
  rememberBaseConfig(value);
  const rows = db.prepare(
    'SELECT key, value_json FROM server_config_overrides ORDER BY key',
  ).all() as Array<{ key: string; value_json: string }>;
  for (const row of rows) {
    if (row.key === 'port' && value.containerMode === true) continue;
    const parsed = JSON.parse(row.value_json) as unknown;
    switch (row.key) {
      case 'webClientUrl':
        value.webClientUrl = validateWebClientUrl(parsed);
        break;
      case 'corsOrigins':
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
          throw new Error('Stored corsOrigins override is invalid');
        }
        value.corsOrigins = [...parsed];
        break;
      case 'accessTokenTtlSeconds':
      case 'refreshTokenTtlSeconds':
      case 'port':
        if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) {
          throw new Error(`Stored ${row.key} override is invalid`);
        }
        value[row.key] = Number(parsed);
        break;
      case 'rateLimitEnabled':
        if (typeof parsed !== 'boolean') throw new Error('Stored rateLimitEnabled override is invalid');
        value.rateLimitEnabled = parsed;
        break;
      case 'llmProvider':
        if (
          parsed !== 'disabled' &&
          parsed !== 'openai-responses' &&
          parsed !== 'openai-chat' &&
          parsed !== 'anthropic'
        ) {
          throw new Error('Stored llmProvider override is invalid');
        }
        value.llmProvider = parsed;
        break;
      case 'llmBaseUrl':
      case 'llmModel':
        if (typeof parsed !== 'string') {
          throw new Error(`Stored ${row.key} override is invalid`);
        }
        value[row.key] = parsed;
        break;
      case 'llmTimeoutSeconds':
        if (!Number.isSafeInteger(parsed) || Number(parsed) < 10 || Number(parsed) > 300) {
          throw new Error('Stored llmTimeoutSeconds override is invalid');
        }
        value.llmTimeoutSeconds = Number(parsed);
        break;
      case 'trustProxy':
        if (typeof parsed !== 'boolean' && (!Number.isSafeInteger(parsed) || Number(parsed) < 0)) {
          throw new Error('Stored trustProxy override is invalid');
        }
        value.trustProxy = parsed as boolean | number;
        break;
      case 'jsonBodyLimit':
        if (typeof parsed !== 'string' || !/^\d+(?:kb|mb)$/i.test(parsed)) {
          throw new Error('Stored jsonBodyLimit override is invalid');
        }
        value.jsonBodyLimit = parsed.toLowerCase();
        break;
      default:
        throw new Error(`Unknown stored server configuration override: ${row.key}`);
    }
  }
  return value;
}
