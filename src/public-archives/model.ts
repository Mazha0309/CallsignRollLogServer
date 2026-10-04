import { AppError } from '../errors/app-error';

export const PUBLIC_ARCHIVE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
export const RESERVED_PUBLIC_ARCHIVE_ALIASES = new Set([
  'api',
  'admin',
  'app',
  'assets',
  'bootstrap',
  'client',
  'connect',
  'favicon.ico',
  'health',
  'live',
  'login',
  'register',
  'robots.txt',
  'web',
  'ws',
]);

export interface PublicArchiveListDto {
  id: string;
  title: string;
}

export interface PublicArchiveSessionDto {
  id: string;
  title: string;
  closedAt: string;
  displayOrder: number;
  logCount: number;
}

export interface PublicArchiveLogDto {
  ordinal: number;
  time: string;
  controller: string;
  callsign: string;
  rstSent: string | null;
  rstRcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
}

export interface PublicArchiveListRow {
  id: string;
  title: string;
}

export interface PublicArchiveSessionRow {
  id: string;
  title: string;
  closed_at: string;
  display_order: number;
  log_count: number;
}

export interface PublicArchiveLogRow {
  ordinal: number;
  time: string;
  controller: string;
  callsign: string;
  rst_sent: string | null;
  rst_rcvd: string | null;
  qth: string | null;
  device: string | null;
  power: string | null;
  antenna: string | null;
  height: string | null;
  remarks: string | null;
}

export function normalizePublicArchiveAlias(value: string): string {
  const alias = publicArchiveAliasDisplay(value).toLowerCase();
  return alias;
}

export function publicArchiveAliasDisplay(value: string): string {
  const alias = value.trim();
  if (!PUBLIC_ARCHIVE_ALIAS.test(alias) || RESERVED_PUBLIC_ARCHIVE_ALIASES.has(alias.toLowerCase())) {
    throw new AppError(422, 'ARCHIVE_ALIAS_INVALID', 'Archive alias is invalid');
  }
  return alias;
}

export function publicArchiveListDto(row: PublicArchiveListRow): PublicArchiveListDto {
  return { id: row.id, title: row.title };
}

export function publicArchiveSessionDto(
  row: PublicArchiveSessionRow,
): PublicArchiveSessionDto {
  return {
    id: row.id,
    title: row.title,
    closedAt: row.closed_at,
    displayOrder: row.display_order,
    logCount: row.log_count,
  };
}

export function publicArchiveLogDto(row: PublicArchiveLogRow): PublicArchiveLogDto {
  return {
    ordinal: row.ordinal,
    time: row.time,
    controller: row.controller,
    callsign: row.callsign,
    rstSent: row.rst_sent,
    rstRcvd: row.rst_rcvd,
    qth: row.qth,
    device: row.device,
    power: row.power,
    antenna: row.antenna,
    height: row.height,
    remarks: row.remarks,
  };
}
