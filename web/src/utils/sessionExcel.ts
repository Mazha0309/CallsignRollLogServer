import { strToU8, zipSync } from 'fflate';
import type { ExcelExportSettings, LogRecord, Page } from '../types';

// Keep this at the strictest session-log endpoint limit.  The regular
// account endpoint accepts 200 rows, while the administrator endpoint caps
// requests at 100; exports share this collector and must work through both.
const PAGE_SIZE = 100;
const HEADERS = [
  '#',
  '时间',
  '呼号',
  'RST发',
  'RST收',
  'QTH',
  '设备',
  '功率',
  '天线',
  '高度',
  '备注',
] as const;
const COLUMN_WIDTHS = [10, 8, 10, 8, 8, 22, 20, 7, 22, 7, 10] as const;
const FOOTER_TEXTS = [
  '此表格由 Callsign Roll Log 生成导出，本项目使用开源协议: GNU Affero General Public License V3',
  '项目仓库地址: https://github.com/Mazha0309/CallsignRollLog',
  '分享点名记录时无须携带本条说明',
] as const;

export const DEFAULT_EXCEL_EXPORT_SETTINGS: Readonly<ExcelExportSettings> = Object.freeze({
  formatVersion: 1,
  headerText: '{yyyy}-{MM}-{dd}日点名记录',
  useSessionTitleAsHeader: true,
  useSessionTitleAsFileName: true,
  headerBackgroundColor: '#1E84D2FF',
  headerRowBackgroundColor: '#CFE7FFFF',
  controllerBackgroundColor: '#FFFFC3FF',
  tableBackgroundColor: '#FFFFFFFF',
  alternateRowColor: '#C0E5F2FF',
  useAlternateColors: true,
  fontFamily: 'SarasaGothicSC',
  showFooter: true,
  fileNameTemplate: '点名记录_{yyyy}-{MM}-{dd}',
});

export interface SessionExcelRequest {
  page: number;
  pageSize: number;
  includeDeleted?: boolean;
  sort?: 'timeAsc' | 'timeDesc' | 'updatedDesc';
}

export interface SessionExcelOptions {
  title: string;
  settings: ExcelExportSettings;
  loadLogs: (request: SessionExcelRequest) => Promise<Page<LogRecord>>;
  now?: Date;
}

export async function collectSessionLogs(
  loadLogs: SessionExcelOptions['loadLogs'],
): Promise<LogRecord[]> {
  const logs: LogRecord[] = [];
  let page = 1;
  while (true) {
    const result = await loadLogs({
      page,
      pageSize: PAGE_SIZE,
      includeDeleted: false,
      sort: 'timeAsc',
    });
    logs.push(...result.items.filter((item) => !item.deletedAt));
    if (page >= result.totalPages || result.items.length === 0) break;
    page += 1;
    if (page > 10_000) throw new Error('SESSION_EXCEL_PAGE_LIMIT');
  }
  return logs.sort((left, right) =>
    left.time.localeCompare(right.time) || left.syncId.localeCompare(right.syncId),
  );
}

export async function exportSessionExcel(
  options: SessionExcelOptions,
): Promise<number> {
  const logs = await collectSessionLogs(options.loadLogs);
  const now = options.now ?? new Date();
  const bytes = buildSessionExcel({
    title: options.title,
    settings: options.settings,
    logs,
    now,
  });
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  const blob = new Blob([payload], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `${excelFileName(options.title, options.settings, now)}.xlsx`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return logs.length;
}

export function buildSessionExcel({
  title,
  settings,
  logs,
  now = new Date(),
}: {
  title: string;
  settings: ExcelExportSettings;
  logs: LogRecord[];
  now?: Date;
}): Uint8Array {
  const normalizedTitle = title.trim();
  const headerText = settings.useSessionTitleAsHeader && normalizedTitle
    ? normalizedTitle
    : expandTemplate(settings.headerText, now);
  const columnXml = COLUMN_WIDTHS.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
  ).join('');
  const rows: string[] = [
    `<row r="1" ht="30" customHeight="1">${cell(0, 1, headerText, 1)}</row>`,
    `<row r="2" ht="25" customHeight="1">${rowCells(HEADERS, 2, 2)}</row>`,
  ];
  const merges = ['A1:K1'];
  let excelRow = 3;
  let globalIndex = 1;
  let lastController: string | undefined;
  let blockRowColorIndex = 0;

  for (const log of logs) {
    if (log.controller !== lastController) {
      lastController = log.controller;
      blockRowColorIndex = 0;
      rows.push(
        `<row r="${excelRow}" ht="20" customHeight="1">${rowCells([
          '点名主控:',
          calculateControllerTime(log.time),
          log.controller,
        ], excelRow, 3)}</row>`,
      );
      excelRow += 1;
    }

    const style = settings.useAlternateColors && blockRowColorIndex % 2 === 1 ? 5 : 4;
    blockRowColorIndex += 1;
    rows.push(
      `<row r="${excelRow}" ht="20" customHeight="1">${rowCells([
        String(globalIndex),
        displayTime(log.time),
        log.callsign,
        log.rstSent ?? '',
        log.rstRcvd ?? '',
        log.qth ?? '',
        log.device ?? '',
        log.power ?? '',
        log.antenna ?? '',
        log.height ?? '',
        log.remarks ?? '',
      ], excelRow, style)}</row>`,
    );
    globalIndex += 1;
    excelRow += 1;
  }

  if (settings.showFooter) {
    excelRow += 2;
    for (const text of FOOTER_TEXTS) {
      rows.push(
        `<row r="${excelRow}" ht="22" customHeight="1">${cell(0, excelRow, text, 6)}</row>`,
      );
      merges.push(`A${excelRow}:K${excelRow}`);
      excelRow += 1;
    }
  }

  const lastRow = Math.max(2, excelRow - 1);
  const worksheet = xml(`
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <dimension ref="A1:K${lastRow}"/>
      <sheetViews><sheetView workbookViewId="0"/></sheetViews>
      <sheetFormatPr defaultRowHeight="20"/>
      <cols>${columnXml}</cols>
      <sheetData>${rows.join('')}</sheetData>
      <mergeCells count="${merges.length}">${merges.map((reference) => `<mergeCell ref="${reference}"/>`).join('')}</mergeCells>
      <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
      <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
    </worksheet>
  `);

  return zipSync({
    '[Content_Types].xml': strToU8(xml(`
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      </Types>
    `)),
    '_rels/.rels': strToU8(xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>
    `)),
    'xl/workbook.xml': strToU8(xml(`
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="点名记录" sheetId="1" r:id="rId1"/></sheets>
      </workbook>
    `)),
    'xl/_rels/workbook.xml.rels': strToU8(xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      </Relationships>
    `)),
    'xl/styles.xml': strToU8(stylesXml(settings)),
    'xl/worksheets/sheet1.xml': strToU8(worksheet),
  }, { level: 6 });
}

export function excelFileName(
  sessionTitle: string,
  settings: ExcelExportSettings,
  now: Date,
): string {
  const normalizedTitle = sessionTitle.trim();
  const value = settings.useSessionTitleAsFileName && normalizedTitle
    ? normalizedTitle
    : expandTemplate(settings.fileNameTemplate, now, normalizedTitle || 'session');
  return safeFileName(value);
}

export function calculateControllerTime(value: string): string {
  const normalized = displayTime(value);
  const parts = normalized.split(':');
  if (parts.length < 2) return normalized;
  let hours = Number.parseInt(parts[0], 10);
  let minutes = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return normalized;

  minutes -= 1;
  if (minutes < 0) {
    minutes = 59;
    hours = (hours + 23) % 24;
  }
  if (minutes % 5 === 0) return `${twoDigits(hours)}:${twoDigits(minutes)}`;

  const nearestFive = Math.round(minutes / 5) * 5;
  const nearestTen = Math.round(minutes / 10) * 10;
  const diffToFive = Math.abs(minutes - nearestFive);
  const diffToTen = Math.abs(minutes - nearestTen);
  if (diffToTen === 1 || nearestTen === 60) {
    minutes = nearestTen === 60 ? 0 : nearestTen;
    if (nearestTen === 60) hours = (hours + 1) % 24;
  } else if (diffToFive === 1) {
    minutes = nearestFive % 60;
    if (nearestFive === 60) {
      hours = (hours + 1) % 24;
      minutes = 0;
    }
  }
  return `${twoDigits(hours)}:${twoDigits(minutes)}`;
}

function rowCells(values: readonly string[], row: number, style: number): string {
  return Array.from({ length: HEADERS.length }, (_, column) =>
    cell(column, row, values[column] ?? '', style),
  ).join('');
}

function cell(column: number, row: number, value: string, style: number): string {
  const reference = `${columnName(column)}${row}`;
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function displayTime(value: string): string {
  const direct = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (direct) {
    const hour = Number.parseInt(direct[1], 10);
    const minute = Number.parseInt(direct[2], 10);
    if (hour <= 23 && minute <= 59) return `${twoDigits(hour)}:${twoDigits(minute)}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.trim();
  return `${twoDigits(parsed.getHours())}:${twoDigits(parsed.getMinutes())}`;
}

function expandTemplate(
  template: string,
  now: Date,
  sessionTitle = 'session',
): string {
  return template
    .replaceAll('{yyyy}', now.getFullYear().toString())
    .replaceAll('{MM}', twoDigits(now.getMonth() + 1))
    .replaceAll('{dd}', twoDigits(now.getDate()))
    .replaceAll('{HH}', twoDigits(now.getHours()))
    .replaceAll('{mm}', twoDigits(now.getMinutes()))
    .replaceAll('{ss}', twoDigits(now.getSeconds()))
    .replaceAll('{session}', sessionTitle || 'session');
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, '0');
}

function safeFileName(value: string): string {
  const withoutControls = Array.from(value, (character) =>
    character.codePointAt(0)! < 32 ? '_' : character,
  ).join('');
  const sanitized = withoutControls
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100);
  return sanitized || 'session';
}

function escapeXml(value: string): string {
  const validXml = Array.from(value).filter((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint >= 32 || codePoint === 9 || codePoint === 10 || codePoint === 13;
  }).join('');
  return validXml
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body.replace(/>\s+</g, '><').trim()}`;
}

function excelArgb(value: string): string {
  const match = /^#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/.exec(value);
  if (!match) throw new Error('INVALID_EXCEL_COLOR');
  return `${match[2] ?? 'FF'}${match[1]}`.toUpperCase();
}

function fill(color: string): string {
  return `<fill><patternFill patternType="solid"><fgColor rgb="${excelArgb(color)}"/><bgColor indexed="64"/></patternFill></fill>`;
}

function stylesXml(settings: ExcelExportSettings): string {
  const font = escapeXml(settings.fontFamily.trim() || 'Calibri');
  return xml(`
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <fonts count="5">
        <font><sz val="11"/><name val="${font}"/></font>
        <font><b/><sz val="14"/><name val="${font}"/></font>
        <font><b/><sz val="12"/><name val="${font}"/></font>
        <font><b/><sz val="11"/><name val="${font}"/></font>
        <font><sz val="10"/><color rgb="FF808080"/><name val="${font}"/></font>
      </fonts>
      <fills count="8">
        <fill><patternFill patternType="none"/></fill>
        <fill><patternFill patternType="gray125"/></fill>
        ${fill(settings.headerBackgroundColor)}
        ${fill(settings.headerRowBackgroundColor)}
        ${fill(settings.controllerBackgroundColor)}
        ${fill(settings.tableBackgroundColor)}
        ${fill(settings.alternateRowColor)}
        ${fill('#FFFFFFFF')}
      </fills>
      <borders count="3">
        <border><left/><right/><top/><bottom/><diagonal/></border>
        <border><left style="thin"><color rgb="FF808080"/></left><right style="thin"><color rgb="FF808080"/></right><top style="thin"><color rgb="FF808080"/></top><bottom style="thin"><color rgb="FF808080"/></bottom><diagonal/></border>
        <border><left style="thin"><color rgb="FF808080"/></left><right style="thin"><color rgb="FF808080"/></right><top/><bottom/><diagonal/></border>
      </borders>
      <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
      <cellXfs count="7">
        <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
        <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
        <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
        <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
        <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
        <xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
        <xf numFmtId="0" fontId="4" fillId="7" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
      </cellXfs>
      <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
    </styleSheet>
  `);
}
