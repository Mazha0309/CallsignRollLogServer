import { describe, expect, it } from 'vitest';
import type { LogRecord } from '../types';
import { buildSessionExcel, DEFAULT_EXCEL_EXPORT_SETTINGS } from './sessionExcel';
import { parseXlsxWorkbook } from './sessionExcelImport';

const log = (overrides: Partial<LogRecord> = {}): LogRecord => ({
  syncId: 'log-1',
  sessionId: 'session-1',
  version: 1,
  time: '20:03:47',
  controller: 'BG5CRL',
  callsign: 'BG5CRL',
  rstSent: '59',
  rstRcvd: '57',
  qth: '浙江杭州',
  device: 'IC-705',
  power: '5W',
  antenna: '八木天线',
  height: '5楼',
  remarks: '已人工修正',
  createdAt: '2026-08-24T12:03:47.000Z',
  updatedAt: '2026-08-24T12:03:47.000Z',
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deletedAt: null,
  ...overrides,
});

describe('session Excel import parser', () => {
  it('parses a WebUI export into bounded worksheet rows for AI correction', () => {
    const bytes = buildSessionExcel({
      title: '周末点名',
      settings: { ...DEFAULT_EXCEL_EXPORT_SETTINGS, showFooter: false },
      logs: [
        log(),
        log({ syncId: 'log-2', callsign: 'BG5TWO', time: '20:04:12' }),
      ],
    });

    const parsed = parseXlsxWorkbook(bytes, '周末点名.xlsx', 480);

    expect(parsed.fileName).toBe('周末点名.xlsx');
    expect(parsed.utcOffsetMinutes).toBe(480);
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0].name).toBe('点名记录');
    expect(parsed.sheets[0].rows).toEqual(expect.arrayContaining([
      { rowNumber: 1, cells: ['周末点名'] },
      { rowNumber: 2, cells: ['#', '时间', '呼号', 'RST发', 'RST收', 'QTH', '设备', '功率', '天线', '高度', '备注'] },
      { rowNumber: 3, cells: ['点名主控:', '20:02', 'BG5CRL'] },
      { rowNumber: 4, cells: ['1', '20:03', 'BG5CRL', '59', '57', '浙江杭州', 'IC-705', '5W', '八木天线', '5楼', '已人工修正'] },
      { rowNumber: 5, cells: ['2', '20:04', 'BG5TWO', '59', '57', '浙江杭州', 'IC-705', '5W', '八木天线', '5楼', '已人工修正'] },
    ]));
  });

  it('rejects non-XLSX bytes instead of forwarding them to the server', () => {
    expect(() => parseXlsxWorkbook(new Uint8Array([1, 2, 3]), 'fake.xlsx'))
      .toThrow('EXCEL_ARCHIVE_INVALID');
  });
});
