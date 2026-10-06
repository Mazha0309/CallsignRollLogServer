import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import './App.css';
import { ArchiveBreadcrumb, ArchiveSessionLink, fetchArchive, parseArchiveRoute, sortArchiveLogs, type ArchiveRoute } from './archive';
import { consumePublicLink } from './link';
import { translate, type Locale, type MessageKey } from './i18n';
import { formatLogTime } from './time';
import type { ArchiveDirectory, ArchiveSessionDetail, FatalReason, LivePhase, PublicArchiveLog, PublicLog } from './types';
import { usePublicLiveshare } from './usePublicLiveshare';

type Theme = 'system' | 'light' | 'dark';

const PAGE_SIZE = 50;
const REPOSITORY_URL = 'https://github.com/Mazha0309/CallsignRollLogServer';

function storedPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    if (value && allowed.includes(value as T)) return value as T;
  } catch {
    // Preferences are optional; capability credentials never use storage.
  }
  return fallback;
}

function persistPreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A privacy-restricted browser can continue with in-memory preferences.
  }
}

function preferredLocale(): Locale {
  const browserLocale: Locale = navigator.languages.some((value) => value.toLowerCase().startsWith('zh'))
    ? 'zh-CN'
    : 'en-US';
  return storedPreference('openlogtool.live.locale', ['zh-CN', 'en-US'], browserLocale);
}

function formatTimestamp(value: string | undefined, locale: Locale): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function sessionStatusKey(status: string, deletedAt: string | null): MessageKey {
  if (deletedAt) return 'sessionDeleted';
  return status === 'closed' ? 'sessionClosed' : 'sessionActive';
}

function phaseKey(phase: LivePhase): MessageKey {
  const keys: Record<Exclude<LivePhase, 'fatal'>, MessageKey> = {
    initializing: 'initializing',
    loadingSnapshot: 'loadingSnapshot',
    connecting: 'connecting',
    live: 'live',
    reconnecting: 'reconnecting',
    degraded: 'degraded',
    offline: 'offline',
    ended: 'ended',
  };
  return phase === 'fatal' ? 'fatalUnavailableTitle' : keys[phase];
}

function fatalCopy(reason: FatalReason): [MessageKey, MessageKey] {
  const copy: Record<FatalReason, [MessageKey, MessageKey]> = {
    invalidLink: ['fatalInvalidLinkTitle', 'fatalInvalidLinkBody'],
    unavailable: ['fatalUnavailableTitle', 'fatalUnavailableBody'],
    unsupported: ['fatalUnsupportedTitle', 'fatalUnsupportedBody'],
    snapshotTooLarge: ['fatalSnapshotTooLargeTitle', 'fatalSnapshotTooLargeBody'],
    protocolError: ['fatalProtocolTitle', 'fatalProtocolBody'],
  };
  return copy[reason];
}

function HeaderControls({
  locale,
  setLocale,
  theme,
  setTheme,
  t,
}: {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="header-controls">
      <label className="select-control select-language">
        <span className="sr-only">{t('language')}</span>
        <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
          <option value="zh-CN">简体中文</option>
          <option value="en-US">English</option>
        </select>
      </label>
      <label className="select-control select-theme">
        <span className="sr-only">{t('theme')}</span>
        <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
          <option value="system">{t('themeSystem')}</option>
          <option value="light">{t('themeLight')}</option>
          <option value="dark">{t('themeDark')}</option>
        </select>
      </label>
    </div>
  );
}

function StatusPill({ phase, text }: { phase: LivePhase; text: string }) {
  return (
    <span className={`status-pill status-${phase}`} role="status">
      <span className="status-dot" />
      {text}
    </span>
  );
}

function Value({ children }: { children: string | null | undefined }) {
  return <>{children || '—'}</>;
}

function SiteFooter({ t }: {
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}) {
  return (
    <footer className="site-footer">
      <p>{t('footer')}</p>
      <p className="project-note">
        {t('footerProject')}{' '}
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
          {t('footerRepository')}
        </a>
      </p>
      <p className="copyright">{t('footerCopyright')}</p>
    </footer>
  );
}

function ArchiveFooter({ t }: {
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}) {
  return (
    <footer className="site-footer">
      <p>{t('archiveFooter')}</p>
      <p className="project-note">
        {t('footerProject')}{' '}
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
          {t('footerRepository')}
        </a>
      </p>
      <p className="copyright">{t('footerCopyright')}</p>
    </footer>
  );
}

function FatalView({
  reason,
  t,
}: {
  reason: FatalReason;
  t: (key: MessageKey) => string;
}) {
  const [title, body] = fatalCopy(reason);
  return (
    <main className="center-state">
      <div className="state-symbol" aria-hidden="true">×</div>
      <h1>{t(title)}</h1>
      <p>{t(body)}</p>
    </main>
  );
}

function LoadingView({ phase, t }: {
  phase: LivePhase;
  t: (key: MessageKey) => string;
}) {
  return (
    <main className="center-state" aria-live="polite">
      <div className="radio-loader" aria-hidden="true"><span /><span /><span /></div>
      <h1>{t(phaseKey(phase))}</h1>
      <p>{t('secureNotice')}</p>
    </main>
  );
}

function LogCard({
  log,
  ordinal,
  locale,
  t,
}: {
  log: PublicLog | PublicArchiveLog;
  ordinal: number;
  locale: Locale;
  t: (key: MessageKey) => string;
}) {
  return (
    <article className="log-card">
      <div className="log-card-heading">
        <span className="ordinal">#{ordinal}</span>
        <strong>{log.callsign}</strong>
        <time dateTime={log.time}>{formatLogTime(log.time, locale)}</time>
      </div>
      <dl>
        <div><dt>{t('controller')}</dt><dd><Value>{log.controller}</Value></dd></div>
        <div><dt>{t('rstSent')} / {t('rstReceived')}</dt><dd>{log.rstSent || '—'} / {log.rstRcvd || '—'}</dd></div>
        <div><dt>{t('qth')}</dt><dd><Value>{log.qth}</Value></dd></div>
        <div><dt>{t('device')}</dt><dd><Value>{log.device}</Value></dd></div>
        <div><dt>{t('power')}</dt><dd><Value>{log.power}</Value></dd></div>
        <div><dt>{t('antenna')}</dt><dd><Value>{log.antenna}</Value></dd></div>
        <div><dt>{t('height')}</dt><dd><Value>{log.height}</Value></dd></div>
        {log.remarks && <div className="card-remarks"><dt>{t('remarks')}</dt><dd>{log.remarks}</dd></div>}
      </dl>
    </article>
  );
}

export function ArchiveApp({ route }: { route: ArchiveRoute }) {
  const [locale, setLocaleState] = useState<Locale>(preferredLocale);
  const [theme, setThemeState] = useState<Theme>(() => (
    storedPreference('openlogtool.live.theme', ['system', 'light', 'dark'], 'system')
  ));
  const [archive, setArchive] = useState<ArchiveDirectory | ArchiveSessionDetail | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const deferredQuery = useDeferredValue(query);
  const t = (key: MessageKey, values?: Record<string, string | number>) => translate(locale, key, values);

  const setLocale = (nextLocale: Locale) => {
    setLocaleState(nextLocale);
    persistPreference('openlogtool.live.locale', nextLocale);
  };
  const setTheme = (nextTheme: Theme) => {
    setThemeState(nextTheme);
    persistPreference('openlogtool.live.theme', nextTheme);
  };
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale;
  }, [locale, theme]);
  useEffect(() => {
    let cancelled = false;
    setArchive(null);
    setUnavailable(false);
    fetchArchive(route).then(
      (data) => { if (!cancelled) setArchive(data); },
      () => { if (!cancelled) setUnavailable(true); },
    );
    return () => { cancelled = true; };
  }, [route]);
  useEffect(() => {
    if (!archive) {
      document.title = 'OpenLogTool Archive';
      return;
    }
    document.title = `${route.kind === 'list'
      ? (archive as ArchiveDirectory).title
      : (archive as ArchiveSessionDetail).session.title} · OpenLogTool Archive`;
  }, [archive, route.kind]);
  const detail = route.kind === 'session' && archive ? archive as ArchiveSessionDetail : null;
  const normalizedQuery = deferredQuery.trim().toLocaleUpperCase(locale);
  const sortedLogs = detail ? sortArchiveLogs(detail.logs) : [];
  if (sortOrder === 'asc') sortedLogs.reverse();
  const filtered = normalizedQuery ? sortedLogs.filter((log) => [log.callsign, log.controller, log.qth ?? ''].some(
    (value) => value.toLocaleUpperCase(locale).includes(normalizedQuery),
  )) : sortedLogs;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visibleLogs = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => setPage(1), [normalizedQuery]);
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);

  const shellHeader = (
    <header className="site-header">
      <div className="brand" aria-label={t('brand')}>
        <img className="brand-mark" src="/live/openlogtool-logo.png" alt="" />
        <span><strong>{t('brand')}</strong><small>{t('publicArchive')}</small></span>
      </div>
      <HeaderControls locale={locale} setLocale={setLocale} theme={theme} setTheme={setTheme} t={t} />
    </header>
  );
  if (unavailable) {
    return <div className="app-shell">{shellHeader}<main className="center-state"><div className="state-symbol" aria-hidden="true">×</div><h1>{t('archiveUnavailable')}</h1></main><ArchiveFooter t={t} /></div>;
  }
  if (!archive) {
    return <div className="app-shell">{shellHeader}<main className="center-state" aria-live="polite"><h1>{t('archiveStatic')}</h1></main><ArchiveFooter t={t} /></div>;
  }
  if (route.kind === 'list') {
    const directory = archive as ArchiveDirectory;
    return (
      <div className="app-shell">{shellHeader}<main className="content archive-content">
        <section className="session-heading"><div><div className="eyebrow"><span className="read-only-badge">{t('readOnly')}</span><span>{t('archiveDirectory')}</span></div><h1>{directory.title}</h1></div><span className="archive-static-label">{t('archiveStatic')}</span></section>
        <section className="archive-directory" aria-label={t('archiveDirectory')}>
          {directory.sessions.length ? directory.sessions.map((session) => (
            <ArchiveSessionLink className="archive-session-card" key={session.id} route={route} archiveSessionId={session.id}>
              <span>{t('archivedSession')}</span><strong>{session.title}</strong><time dateTime={session.closedAt}>{formatTimestamp(session.closedAt, locale)}</time><small>{t('archiveRecordCount', { count: session.logCount.toLocaleString(locale) })}</small>
            </ArchiveSessionLink>
          )) : <div className="empty-history">{t('noRecords')}</div>}
        </section>
      </main><ArchiveFooter t={t} /></div>
    );
  }

  const sessionDetail = archive as ArchiveSessionDetail;
  return (
    <div className="app-shell">{shellHeader}<main className="content archive-content">
      <nav className="archive-breadcrumb" aria-label={t('archiveDirectory')}><ArchiveBreadcrumb route={route}>{t('backToArchive')}</ArchiveBreadcrumb><span>/</span><span>{sessionDetail.session.title}</span></nav>
      <section className="session-heading"><div><div className="eyebrow"><span className="read-only-badge">{t('readOnly')}</span><span>{t('archivedSession')}</span></div><h1>{sessionDetail.session.title}</h1></div><div className="archive-meta"><time dateTime={sessionDetail.session.closedAt}>{formatTimestamp(sessionDetail.session.closedAt, locale)}</time><span>{t('archiveRecordCount', { count: sessionDetail.session.logCount.toLocaleString(locale) })}</span></div></section>
      <section className="history-panel"><div className="history-heading"><div className="history-title"><div className="history-title-row"><h2>{t('history')}</h2><label className="select-control"><span className="sr-only">{t('archiveSort')}</span><select aria-label={t('archiveSort')} value={sortOrder} onChange={(event) => { setSortOrder(event.target.value as 'asc' | 'desc'); setPage(1); }}><option value="asc">{t('archiveOldestFirst')}</option><option value="desc">{t('archiveNewestFirst')}</option></select></label></div><p>{t('archiveHistoryHint')}</p></div><label className="search-field"><span className="sr-only">{t('searchPlaceholder')}</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchPlaceholder')} /></label></div>
        {visibleLogs.length ? <><div className="desktop-table"><table><thead><tr><th>{t('number')}</th><th>{t('time')}</th><th>{t('controller')}</th><th>{t('callsign')}</th><th>{t('rstSent')}</th><th>{t('rstReceived')}</th><th>{t('qth')}</th><th>{t('device')}</th><th>{t('power')}</th><th>{t('antenna')}</th><th>{t('height')}</th><th>{t('remarks')}</th></tr></thead><tbody>{visibleLogs.map((log) => <tr key={log.ordinal}><td className="ordinal-cell">#{log.ordinal}</td><td><time dateTime={log.time}>{formatLogTime(log.time, locale)}</time></td><td>{log.controller}</td><td className="callsign-cell">{log.callsign}</td><td>{log.rstSent || '—'}</td><td>{log.rstRcvd || '—'}</td><td><Value>{log.qth}</Value></td><td><Value>{log.device}</Value></td><td><Value>{log.power}</Value></td><td><Value>{log.antenna}</Value></td><td><Value>{log.height}</Value></td><td className="remarks-cell"><Value>{log.remarks}</Value></td></tr>)}</tbody></table></div><div className="mobile-cards">{visibleLogs.map((log) => <LogCard key={log.ordinal} log={log} ordinal={log.ordinal} locale={locale} t={t} />)}</div></> : <div className="empty-history">{sessionDetail.logs.length ? t('noSearchResults') : t('noRecords')}</div>}
        {filtered.length > PAGE_SIZE && <nav className="pagination" aria-label={t('history')}><button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t('previousPage')}</button><span>{t('pageStatus', { page, pages, count: filtered.length })}</span><button type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>{t('nextPage')}</button></nav>}
      </section>
    </main><ArchiveFooter t={t} /></div>
  );
}

function LiveShareApp() {
  const [locale, setLocaleState] = useState<Locale>(preferredLocale);
  const [theme, setThemeState] = useState<Theme>(() => (
    storedPreference('openlogtool.live.theme', ['system', 'light', 'dark'], 'system')
  ));
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [publicLink] = useState(consumePublicLink);
  const deferredQuery = useDeferredValue(query);
  const { state, retryNow } = usePublicLiveshare(publicLink);
  const t = (key: MessageKey, values?: Record<string, string | number>) => (
    translate(locale, key, values)
  );

  const setLocale = (nextLocale: Locale) => {
    setLocaleState(nextLocale);
    persistPreference('openlogtool.live.locale', nextLocale);
  };
  const setTheme = (nextTheme: Theme) => {
    setThemeState(nextTheme);
    persistPreference('openlogtool.live.theme', nextTheme);
  };

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale;
  }, [locale, theme]);

  useEffect(() => {
    document.title = state.session?.title
      ? `${state.session.title} · OpenLogTool Live`
      : 'OpenLogTool Live';
  }, [state.session?.title]);

  const chronological = useMemo(() => [...state.logs].sort((left, right) => (
    left.time.localeCompare(right.time) || left.syncId.localeCompare(right.syncId)
  )), [state.logs]);
  const ordinalById = useMemo(() => new Map(
    chronological.map((log, index) => [log.syncId, index + 1]),
  ), [chronological]);
  const newestFirst = useMemo(() => [...chronological].reverse(), [chronological]);
  const latest = newestFirst[0];
  const normalizedQuery = deferredQuery.trim().toLocaleUpperCase(locale);
  const filtered = useMemo(() => normalizedQuery
    ? newestFirst.filter((log) => [log.callsign, log.controller, log.qth ?? ''].some(
        (value) => value.toLocaleUpperCase(locale).includes(normalizedQuery),
      ))
    : newestFirst,
  [locale, newestFirst, normalizedQuery]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visibleLogs = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => setPage(1), [normalizedQuery]);
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);

  const shellHeader = (
    <header className="site-header">
      <div className="brand" aria-label={t('brand')}>
        <img className="brand-mark" src="/live/openlogtool-logo.png" alt="" />
        <span><strong>{t('brand')}</strong><small>{t('publicLive')}</small></span>
      </div>
      <HeaderControls
        locale={locale}
        setLocale={setLocale}
        theme={theme}
        setTheme={setTheme}
        t={t}
      />
    </header>
  );
  const shellFooter = <SiteFooter t={t} />;

  if (state.phase === 'fatal') {
    return <div className="app-shell">{shellHeader}<FatalView reason={state.fatalReason ?? 'unavailable'} t={t} />{shellFooter}</div>;
  }

  if (!state.session) {
    return <div className="app-shell">{shellHeader}<LoadingView phase={state.phase} t={t} />{shellFooter}</div>;
  }

  const isInterrupted = ['reconnecting', 'degraded', 'offline', 'connecting', 'loadingSnapshot'].includes(state.phase);

  return (
    <div className="app-shell">
      {shellHeader}
      <main className="content">
        <section className="session-heading">
          <div>
            <div className="eyebrow">
              <span className="read-only-badge">{t('readOnly')}</span>
              <span>{t('publicSession')}</span>
            </div>
            <h1>{state.session.title}</h1>
          </div>
          <div className="session-state">
            <span className={`session-badge session-${state.session.deletedAt ? 'deleted' : state.session.status}`}>
              {t(sessionStatusKey(state.session.status, state.session.deletedAt))}
            </span>
            <StatusPill phase={state.phase} text={t(phaseKey(state.phase))} />
          </div>
        </section>

        {(isInterrupted || state.phase === 'ended') && (
          <section className={`connection-banner banner-${state.phase}`} aria-live="polite">
            <span className="connection-copy">
              <strong>{t(phaseKey(state.phase))}</strong>
              {state.phase === 'degraded' && <small>{t('realtimeProxyHint')}</small>}
            </span>
            {isInterrupted && <button type="button" onClick={retryNow}>{t('retryNow')}</button>}
          </section>
        )}

        <section className="stats-grid" aria-label={t('publicLive')}>
          <article><span>{t('records')}</span><strong>{state.logs.length.toLocaleString(locale)}</strong></article>
          <article><span>{t('latestController')}</span><strong>{latest?.controller || t('notAvailable')}</strong></article>
          <article><span>{t('shareExpires')}</span><strong>{formatTimestamp(state.shareExpiresAt, locale)}</strong></article>
          <article><span>{t('lastSync')}</span><strong>{formatTimestamp(state.lastSyncedAt, locale)}</strong></article>
        </section>

        <section className="latest-panel">
          <div className="section-label">{t('latestRecord')}</div>
          {latest ? (
            <div className="latest-grid">
              <div className="latest-primary">
                <span className="latest-number">#{ordinalById.get(latest.syncId)}</span>
                <strong>{latest.callsign}</strong>
                <time dateTime={latest.time}>{formatLogTime(latest.time, locale)}</time>
              </div>
              <dl className="latest-details">
                <div><dt>{t('controller')}</dt><dd>{latest.controller}</dd></div>
                <div><dt>{t('rstSent')} / {t('rstReceived')}</dt><dd>{latest.rstSent || '—'} / {latest.rstRcvd || '—'}</dd></div>
                <div><dt>{t('qth')}</dt><dd><Value>{latest.qth}</Value></dd></div>
                <div><dt>{t('device')}</dt><dd><Value>{latest.device}</Value></dd></div>
              </dl>
            </div>
          ) : <p className="empty-latest">{t('noLatestRecord')}</p>}
        </section>

        <section className="history-panel">
          <div className="history-heading">
            <div><h2>{t('history')}</h2><p>{t('historyHint')}</p></div>
            <label className="search-field">
              <span className="sr-only">{t('searchPlaceholder')}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('searchPlaceholder')}
              />
            </label>
          </div>

          {visibleLogs.length ? (
            <>
              <div className="desktop-table">
                <table>
                  <thead><tr>
                    <th>{t('number')}</th><th>{t('time')}</th><th>{t('controller')}</th>
                    <th>{t('callsign')}</th><th>{t('rstSent')}</th><th>{t('rstReceived')}</th>
                    <th>{t('qth')}</th><th>{t('device')}</th><th>{t('power')}</th>
                    <th>{t('antenna')}</th><th>{t('height')}</th><th>{t('remarks')}</th>
                  </tr></thead>
                  <tbody>{visibleLogs.map((log) => (
                    <tr key={log.syncId}>
                      <td className="ordinal-cell">#{ordinalById.get(log.syncId)}</td>
                      <td><time dateTime={log.time}>{formatLogTime(log.time, locale)}</time></td>
                      <td>{log.controller}</td><td className="callsign-cell">{log.callsign}</td>
                      <td>{log.rstSent || '—'}</td><td>{log.rstRcvd || '—'}</td>
                      <td><Value>{log.qth}</Value></td><td><Value>{log.device}</Value></td>
                      <td><Value>{log.power}</Value></td><td><Value>{log.antenna}</Value></td>
                      <td><Value>{log.height}</Value></td><td className="remarks-cell"><Value>{log.remarks}</Value></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="mobile-cards">
                {visibleLogs.map((log) => (
                  <LogCard key={log.syncId} log={log} ordinal={ordinalById.get(log.syncId) ?? 0} locale={locale} t={t} />
                ))}
              </div>
            </>
          ) : (
            <div className="empty-history">{state.logs.length ? t('noSearchResults') : t('noRecords')}</div>
          )}

          {filtered.length > PAGE_SIZE && (
            <nav className="pagination" aria-label={t('history')}>
              <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t('previousPage')}</button>
              <span>{t('pageStatus', { page, pages, count: filtered.length })}</span>
              <button type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>{t('nextPage')}</button>
            </nav>
          )}
        </section>

        <p className="security-note">{t('secureNotice')}</p>
      </main>
      {shellFooter}
    </div>
  );
}

export default function App() {
  const archiveRoute = parseArchiveRoute(window.location.pathname);
  return archiveRoute ? <ArchiveApp route={archiveRoute} /> : <LiveShareApp />;
}
