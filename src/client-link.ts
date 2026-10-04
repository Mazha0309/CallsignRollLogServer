import { AppError } from './errors/app-error';

export function validateWebClientUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new AppError(422, 'VALIDATION_FAILED', 'webClientUrl must be a URL or empty string');
  }
  if (!value.trim()) return '';
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new AppError(422, 'VALIDATION_FAILED', 'webClientUrl must be an absolute HTTP(S) URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Client URLs must use HTTP(S), with no credentials, query or fragment');
  }
  return url.href;
}
