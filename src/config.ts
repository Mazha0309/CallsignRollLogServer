import dotenv from 'dotenv';
import { validateWebClientUrl } from './client-link';

dotenv.config();

export interface AppConfig {
  port: number;
  dbPath: string;
  jwtSecret: string;
  jwtIssuer: string;
  bootstrapSecret: string;
  inviteHmacKey: string;
  publicShareHmacKey: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  corsOrigins: string[];
  trustProxy: boolean | number;
  jsonBodyLimit: string;
  rateLimitEnabled: boolean;
  environment: string;
  containerMode?: boolean;
  webClientUrl?: string;
  llmProvider: 'disabled' | 'openai-responses' | 'openai-chat' | 'anthropic';
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  llmTimeoutSeconds: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePort(value: string | undefined): number {
  const port = parsePositiveInteger(value, 3000, 'PORT');
  if (port > 65_535) throw new Error('PORT must be between 1 and 65535');
  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseTrustProxy(value: string | undefined): boolean | number {
  if (value == null || value.trim() === '') return false;
  if (/^(true|yes)$/i.test(value)) return true;
  if (/^(false|no)$/i.test(value)) return false;
  const hops = Number(value);
  if (Number.isSafeInteger(hops) && hops >= 0) return hops;
  throw new Error('TRUST_PROXY must be true, false, or a non-negative hop count');
}

function parseLlmProvider(
  value: string | undefined,
): AppConfig['llmProvider'] {
  const normalized = value?.trim().toLowerCase() || 'disabled';
  if (
    normalized === 'disabled' ||
    normalized === 'openai-responses' ||
    normalized === 'openai-chat' ||
    normalized === 'anthropic'
  ) {
    return normalized;
  }
  throw new Error(
    'LLM_PROVIDER must be disabled, openai-responses, openai-chat, or anthropic',
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const refreshSeconds = env.REFRESH_TOKEN_TTL_SECONDS
    ? parsePositiveInteger(env.REFRESH_TOKEN_TTL_SECONDS, 30 * 86_400, 'REFRESH_TOKEN_TTL_SECONDS')
    : parsePositiveInteger(env.REFRESH_TOKEN_TTL_DAYS, 30, 'REFRESH_TOKEN_TTL_DAYS') * 86_400;

  return {
    port: parsePort(env.PORT),
    dbPath: env.DB_PATH?.trim() || './data/openlogtool.db',
    jwtSecret: env.JWT_SECRET?.trim() || '',
    jwtIssuer: env.JWT_ISSUER?.trim() || 'openlogtool-server',
    bootstrapSecret: env.ADMIN_BOOTSTRAP_TOKEN?.trim() || '',
    inviteHmacKey: env.INVITE_HMAC_KEY?.trim() || '',
    publicShareHmacKey: env.PUBLIC_SHARE_HMAC_KEY?.trim() || '',
    accessTokenTtlSeconds: parsePositiveInteger(
      env.ACCESS_TOKEN_TTL_SECONDS,
      15 * 60,
      'ACCESS_TOKEN_TTL_SECONDS',
    ),
    refreshTokenTtlSeconds: refreshSeconds,
    corsOrigins: (env.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    jsonBodyLimit: env.JSON_BODY_LIMIT?.trim() || '1mb',
    rateLimitEnabled: parseBoolean(env.RATE_LIMIT_ENABLED, true),
    environment: env.NODE_ENV?.trim() || 'development',
    containerMode: parseBoolean(env.CONTAINER_MODE, false),
    webClientUrl: validateWebClientUrl(env.WEB_CLIENT_URL ?? ''),
    llmProvider: parseLlmProvider(env.LLM_PROVIDER),
    llmBaseUrl: env.LLM_BASE_URL?.trim() || '',
    llmModel: env.LLM_MODEL?.trim() || '',
    llmApiKey: env.LLM_API_KEY?.trim() || '',
    llmTimeoutSeconds: parsePositiveInteger(
      env.LLM_TIMEOUT_SECONDS,
      90,
      'LLM_TIMEOUT_SECONDS',
    ),
  };
}

export function validateRuntimeConfig(
  value: AppConfig,
  options: {
    requireBootstrapSecret?: boolean;
    requireInviteHmacKey?: boolean;
    requirePublicShareHmacKey?: boolean;
  } = {},
): void {
  if (Buffer.byteLength(value.jwtSecret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must be explicitly set to at least 32 bytes');
  }
  if (
    !Number.isSafeInteger(value.llmTimeoutSeconds) ||
    value.llmTimeoutSeconds < 10 ||
    value.llmTimeoutSeconds > 300
  ) {
    throw new Error('LLM_TIMEOUT_SECONDS must be between 10 and 300');
  }
  if (value.llmModel.length > 200) {
    throw new Error('LLM_MODEL must contain at most 200 characters');
  }
  if (value.llmApiKey.length > 8_192) {
    throw new Error('LLM_API_KEY must contain at most 8192 characters');
  }
  if (value.llmBaseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(value.llmBaseUrl);
    } catch {
      throw new Error('LLM_BASE_URL must be an absolute HTTP URL');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        'LLM_BASE_URL must be an absolute HTTP URL without credentials, a query, or a fragment',
      );
    }
  }
  if (options.requireBootstrapSecret && Buffer.byteLength(value.bootstrapSecret, 'utf8') < 24) {
    throw new Error(
      'ADMIN_BOOTSTRAP_TOKEN must be explicitly set to at least 24 bytes until the first admin is created',
    );
  }
  if (options.requireInviteHmacKey && Buffer.byteLength(value.inviteHmacKey, 'utf8') < 32) {
    throw new Error('INVITE_HMAC_KEY must be explicitly set to at least 32 bytes');
  }
  if (
    options.requirePublicShareHmacKey &&
    Buffer.byteLength(value.publicShareHmacKey, 'utf8') < 32
  ) {
    throw new Error('PUBLIC_SHARE_HMAC_KEY must be explicitly set to at least 32 bytes');
  }
}

export const config = loadConfig();
