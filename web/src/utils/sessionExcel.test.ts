import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { LogRecord, Page } from '../types';
import {
  buildSessionExcel,
  calculateControllerTime,
  collectSessionLogs,
  DEFAULT_EXCEL_EXPORT_SETTINGS,
  excelFileName,
} from './sessionExcel';

const log = (overrides: Partial<LogRecord> = {}): LogRecord => ({
  syncId: 'log-1',
  sessionId: 'session-1',
  version: 1,
  time: '20:03',
  controller: 'BG5CRL',
  callsign: 'BG5CRL',
  rstSent: '59',
  rstRcvd: '57',
  qth: '浙江杭州',
  device: 'IC-705',
  power: '5W',
  antenna: '八木天线',
  height: '5楼',
  remarks: '=1+1',
  createdAt: '2026-08-22T12:03:04.000Z',
  updatedAt: '2026-08-22T12:03:04.000Z',
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deletedAt: null,
  ...overrides,
});

describe('session Excel export', () => {
  it('matches the client 11-column grouped-controller layout and footer', () => {
    const bytes = buildSessionExcel({
      title: '周末 & 点名',
      settings: { ...DEFAULT_EXCEL_EXPORT_SETTINGS },
      logs: [
        log(),
        log({ syncId: 'log-2', callsign: 'BG5TWO', time: '20:04' }),
        log({ syncId: 'log-3', controller: 'BG5NEXT', time: '20:11' }),
        log({ syncId: 'log-4', controller: 'BG5CRL', time: '20:21' }),
      ],
    });
    const archive = unzipSync(bytes);
    expect(Object.keys(archive)).toContain('xl/worksheets/sheet1.xml');
    expect(Object.keys(archive)).toContain('xl/styles.xml');

    const sheet = strFromU8(archive['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('周末 &amp; 点名');
    expect(sheet).toContain('BG5CRL');
    expect(sheet).toContain('浙江杭州');
    expect(sheet).toContain('=1+1');
    expect(sheet).toContain('mergeCell ref="A1:K1"');
    expect(sheet).not.toContain('mergeCell ref="A1:L1"');
    expect(sheet.match(/点名主控:/g)).toHaveLength(3);
    expect(sheet).toContain('GNU Affero General Public License V3');
    expect(sheet).toContain('项目仓库地址');
  });

  it('writes persisted custom colors, font, table background and footer choice', () => {
    const bytes = buildSessionExcel({
      title: 'Styled net',
      settings: {
        ...DEFAULT_EXCEL_EXPORT_SETTINGS,
        headerBackgroundColor: '#11223380',
        headerRowBackgroundColor: '#223344FF',
        controllerBackgroundColor: '#334455FF',
        tableBackgroundColor: '#445566FF',
        alternateRowColor: '#556677FF',
        fontFamily: 'Custom Radio Font',
        showFooter: false,
      },
      logs: [log()],
    });
    const archive = unzipSync(bytes);
    const styles = strFromU8(archive['xl/styles.xml']);
    const sheet = strFromU8(archive['xl/worksheets/sheet1.xml']);
    expect(styles).toContain('rgb="80112233"');
    expect(styles).toContain('rgb="FF445566"');
    expect(styles).toContain('Custom Radio Font');
    expect(sheet).not.toContain('GNU Affero General Public License V3');
  });

  it('uses client-compatible templates and controller time rounding', () => {
    const now = new Date(2026, 7, 23, 9, 5, 7);
    const settings = {
      ...DEFAULT_EXCEL_EXPORT_SETTINGS,
      useSessionTitleAsFileName: false,
      fileNameTemplate: '{session}_{yyyy}-{MM}-{dd}_{HH}-{mm}-{ss}',
    };
    expect(excelFileName('周末/点名', settings, now)).toBe(
      '周末_点名_2026-08-23_09-05-07',
    );
    expect(calculateControllerTime('20:01')).toBe('20:00');
    expect(calculateControllerTime('20:07')).toBe('20:05');
    expect(calculateControllerTime('00:01')).toBe('00:00');
  });

  it('loads every page in ascending order and omits deleted logs', async () => {
    const pages: Page<LogRecord>[] = [
      { items: [log()], page: 1, pageSize: 100, total: 2, totalPages: 2 },
      {
        items: [log({ syncId: 'deleted', deletedAt: '2026-08-22T13:00:00Z' })],
        page: 2,
        pageSize: 100,
        total: 2,
        totalPages: 2,
      },
    ];
    const loader = vi.fn(async ({ page }: { page: number }) => pages[page - 1]);

    await expect(collectSessionLogs(loader)).resolves.toEqual([pages[0].items[0]]);
    expect(loader).toHaveBeenNthCalledWith(1, {
      page: 1,
      pageSize: 100,
      includeDeleted: false,
      sort: 'timeAsc',
    });
    expect(loader).toHaveBeenNthCalledWith(2, {
      page: 2,
      pageSize: 100,
      includeDeleted: false,
      sort: 'timeAsc',
    });
  });
});
