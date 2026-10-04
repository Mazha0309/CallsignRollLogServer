import {
  DashboardOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  HddOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import type {
  CollaborationMetrics,
  PublicLiveshareStatItem,
  PublicLiveshareState,
  PublicLiveshareStats,
} from '../../types';
import { useI18n } from '../../useI18n';

interface OperationsSnapshot {
  metrics: CollaborationMetrics;
  liveShare: PublicLiveshareStats;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function progressPercent(value: number): number {
  return Math.min(100, Math.max(0, finite(value)));
}

function formatPercent(value: number): string {
  const normalized = finite(value);
  return `${normalized.toFixed(normalized >= 100 ? 0 : 1)}%`;
}

function formatOpenCount(value: number, saturated: boolean, locale: string): string {
  return `${Math.max(0, finite(value)).toLocaleString(locale)}${saturated ? '+' : ''}`;
}

function formatBytes(value: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Math.max(0, finite(value));
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: amount >= 100 ? 0 : 1 }).format(amount)} ${units[unit]}`;
}

function formatDuration(seconds: number, locale: string): string {
  let remaining = Math.max(0, Math.floor(finite(seconds)));
  const days = Math.floor(remaining / 86_400);
  remaining %= 86_400;
  const hours = Math.floor(remaining / 3_600);
  remaining %= 3_600;
  const minutes = Math.floor(remaining / 60);
  const finalSeconds = remaining % 60;
  const values = [[days, locale === 'zh-CN' ? '天' : 'd'], [hours, locale === 'zh-CN' ? '小时' : 'h'], [minutes, locale === 'zh-CN' ? '分钟' : 'm']]
    .filter(([value]) => Number(value) > 0)
    .slice(0, 2)
    .map(([value, unit]) => `${value}${locale === 'zh-CN' ? '' : ' '}${unit}`);
  if (!values.length) return `${finalSeconds}${locale === 'zh-CN' ? ' 秒' : ' s'}`;
  return values.join(locale === 'zh-CN' ? ' ' : ' ');
}

function formatTimestamp(value: string | null, locale: string, fallback = '—'): string {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(locale) : fallback;
}

function uptimeSeconds(metrics: CollaborationMetrics): number {
  const generated = Date.parse(metrics.generatedAt);
  const started = Date.parse(metrics.scope.countersStartedAt);
  if (!Number.isFinite(generated) || !Number.isFinite(started)) return 0;
  return Math.max(0, (generated - started) / 1_000);
}

function errorTotals(metrics: CollaborationMetrics): { client: number; server: number } {
  return Object.values(metrics.runtime.http.bySurface).reduce(
    (total, surface) => ({
      client: total.client + finite(surface.clientError),
      server: total.server + finite(surface.serverError),
    }),
    { client: 0, server: 0 },
  );
}

function stateColor(state: PublicLiveshareState): string {
  if (state === 'active') return 'green';
  if (state === 'expired') return 'orange';
  if (state === 'revoked') return 'red';
  return 'magenta';
}

export default function OperationsPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const dashboard = useAsync<OperationsSnapshot>(async () => {
    const [metrics, liveShare] = await Promise.all([
      adminApi.metrics(),
      adminApi.publicLiveshareStats(50),
    ]);
    return { metrics, liveShare };
  }, []);
  const reloadDashboard = dashboard.reload;
  const dashboardRefreshInFlight = useRef(true);
  const refreshDashboard = useCallback(() => {
    if (dashboardRefreshInFlight.current) return;
    dashboardRefreshInFlight.current = true;
    reloadDashboard();
  }, [reloadDashboard]);
  const [days, setDays] = useState(30);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [working, setWorking] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruneForm] = Form.useForm();
  const [pruning, setPruning] = useState(false);

  useEffect(() => {
    if (!dashboard.loading) dashboardRefreshInFlight.current = false;
  }, [dashboard.loading]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (!document.hidden) refreshDashboard();
    };
    const timer = window.setInterval(refreshWhenVisible, 10_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshDashboard]);

  const previewRetention = async () => {
    setWorking(true);
    try {
      setPreview(await adminApi.retentionPreview(days));
    } finally { setWorking(false); }
  };
  const pruneRetention = async () => {
    const { password, reason } = await pruneForm.validateFields();
    setPruning(true);
    try {
      await adminApi.elevate(password);
      const result = await adminApi.retentionPrune(days, reason.trim());
      setPreview(result);
      setPruneOpen(false);
      pruneForm.resetFields();
      messageApi.success(t('settings.applied'));
      refreshDashboard();
    } finally { setPruning(false); }
  };

  const snapshot = dashboard.data;
  const metrics = snapshot?.metrics;
  const liveShare = snapshot?.liveShare;
  const cgroup = metrics?.runtime.system.cgroupV2;
  const cgroupMemory = cgroup?.available && cgroup.memoryBytes.current !== null
    ? cgroup.memoryBytes
    : undefined;
  const environmentMemory = metrics
    ? cgroupMemory
      ? {
          used: cgroupMemory.current ?? 0,
          total: cgroupMemory.max,
          cgroup: true,
          unlimited: cgroupMemory.unlimited,
        }
      : {
          used: metrics.runtime.system.memoryBytes.used,
          total: metrics.runtime.system.memoryBytes.total,
          cgroup: false,
          unlimited: false,
        }
    : null;
  const environmentCpuPercent = metrics
    ? metrics.runtime.system.cpu.percentOfMachineCapacity
    : 0;
  const errors = metrics ? errorTotals(metrics) : { client: 0, server: 0 };
  const memoryPercent = environmentMemory?.total
    ? (environmentMemory.used / environmentMemory.total) * 100
    : null;

  const stateLabel = (state: PublicLiveshareState) => {
    if (state === 'active') return t('admin.liveShareState.active');
    if (state === 'expired') return t('admin.liveShareState.expired');
    if (state === 'revoked') return t('admin.liveShareState.revoked');
    return t('admin.liveShareState.sessionDeleted');
  };

  return <>{contextHolder}<PageHeader
    title={t('nav.operations')}
    description={<div>
      <div>{t('admin.operationsDescription')}</div>
      {metrics && <div className="operations-updated-at">
        {t('admin.metricsUpdatedAt', { time: formatTimestamp(metrics.generatedAt, locale) })}
      </div>}
    </div>}
    actions={<Space wrap>
      {metrics && <Tag className="server-version-tag" color="blue">
        {t('admin.serverVersion')}: v{metrics.serverVersion}
      </Tag>}
      <Button
        icon={<ReloadOutlined />}
        loading={dashboard.loading}
        onClick={refreshDashboard}
      >{t('common.refresh')}</Button>
    </Space>}
  />
    {dashboard.error && snapshot && <Alert
      showIcon
      type="warning"
      message={t('admin.metricsRefreshFailed')}
      style={{ marginBottom: 16 }}
    />}
    <AsyncContent
      loading={dashboard.loading && !snapshot}
      error={snapshot ? null : dashboard.error}
      onRetry={refreshDashboard}
    >
      {metrics && liveShare && <>
        <Alert
          showIcon
          type="info"
          message={t('admin.liveShareCountingHint')}
          description={<div>
            <div>{t('admin.metricsScopeHint')}</div>
            {liveShare.scope.trackingStartedAt && <div>{t('admin.openTrackingStartedAt', {
              time: formatTimestamp(liveShare.scope.trackingStartedAt, locale),
            })}</div>}
            {liveShare.totals.saturatedShares > 0 && <div>{t('admin.analyticsSaturatedHint', {
              count: liveShare.totals.saturatedShares.toLocaleString(locale),
            })}</div>}
          </div>}
          style={{ marginBottom: 18 }}
        />
        <div className="stat-grid operations-stat-grid">
          <Card className="surface"><Statistic
            title={t('admin.currentViewConnections')}
            value={liveShare.totals.currentConnections}
            prefix={<EyeOutlined />}
          /></Card>
          <Card className="surface"><Statistic
            title={t('admin.totalValidOpens')}
            value={formatOpenCount(
              liveShare.totals.totalOpens,
              liveShare.totals.saturatedShares > 0,
              locale,
            )}
            prefix={<LinkOutlined />}
          /></Card>
          <Card className="surface"><Statistic
            title={t('admin.processCpu')}
            value={finite(metrics.runtime.process.cpu.percentOfOneCore)}
            precision={1}
            suffix="%"
            prefix={<DashboardOutlined />}
          /><div className="metric-card-note">{t('admin.machineCapacityUsage')}: {formatPercent(metrics.runtime.process.cpu.percentOfMachineCapacity)}</div></Card>
          <Card className="surface"><Statistic
            title={t('admin.environmentMemory')}
            value={formatBytes(environmentMemory?.used ?? 0, locale)}
            suffix={environmentMemory?.total ? <span className="metric-stat-suffix">/ {formatBytes(environmentMemory.total, locale)}</span> : undefined}
            prefix={<HddOutlined />}
          /><div className="metric-card-note">{environmentMemory?.cgroup ? t('admin.containerCgroup') : t('admin.hostSystem')}</div></Card>
        </div>

        <div className="content-grid operations-runtime-grid">
          <Card className="surface" title={t('admin.processRuntime')}>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
              { key: 'version', label: t('admin.serverVersion'), children: <Typography.Text code>v{metrics.serverVersion}</Typography.Text> },
              { key: 'instance', label: t('admin.instance'), span: 2, children: <Typography.Text className="identifier-value" copyable>{metrics.serverInstanceId}</Typography.Text> },
              { key: 'cpu-one', label: t('admin.oneCoreUsage'), children: formatPercent(metrics.runtime.process.cpu.percentOfOneCore) },
              { key: 'cpu-machine', label: t('admin.machineCapacityUsage'), children: formatPercent(metrics.runtime.process.cpu.percentOfMachineCapacity) },
              { key: 'rss', label: t('admin.rssMemory'), children: formatBytes(metrics.runtime.process.memoryBytes.rss, locale) },
              { key: 'heap', label: t('admin.heapMemory'), children: `${formatBytes(metrics.runtime.process.memoryBytes.heapUsed, locale)} / ${formatBytes(metrics.runtime.process.memoryBytes.heapTotal, locale)}` },
              { key: 'uptime', label: t('admin.uptime'), children: formatDuration(uptimeSeconds(metrics), locale) },
              { key: 'window', label: t('admin.sampleWindow'), children: formatDuration(metrics.runtime.process.cpu.sampleWindowMs / 1_000, locale) },
              { key: 'cpus', label: t('admin.logicalCpus'), children: metrics.runtime.process.cpu.logicalCpuCount },
              { key: 'since', label: t('admin.countersStartedAt'), children: formatTimestamp(metrics.scope.countersStartedAt, locale) },
            ]} />
          </Card>
          <Card className="surface" title={t('admin.runtimeEnvironment')}>
            <div className="metric-meter">
              <div className="metric-meter-heading"><span>{t('admin.cpuUsage')}</span><Tag>{t('admin.hostSystem')}</Tag></div>
              <Progress percent={progressPercent(environmentCpuPercent)} format={() => formatPercent(environmentCpuPercent)} status="normal" />
            </div>
            <div className="metric-meter">
              <div className="metric-meter-heading"><span>{t('admin.memoryUsage')}</span><Tag>{environmentMemory?.cgroup ? t('admin.containerCgroup') : t('admin.hostSystem')}</Tag></div>
              {memoryPercent === null
                ? <div className="metric-unbounded"><strong>{formatBytes(environmentMemory?.used ?? 0, locale)}</strong><span>{environmentMemory?.unlimited ? t('admin.unlimited') : t('admin.limitUnavailable')}</span></div>
                : <Progress percent={progressPercent(memoryPercent)} format={() => formatPercent(memoryPercent)} status="normal" />}
            </div>
            <Descriptions size="small" column={1} items={[
              { key: 'load', label: t('admin.loadAverage'), children: `${metrics.runtime.system.loadAverage.oneMinute.toFixed(2)} / ${metrics.runtime.system.loadAverage.fiveMinutes.toFixed(2)} / ${metrics.runtime.system.loadAverage.fifteenMinutes.toFixed(2)}` },
              { key: 'cpus', label: t('admin.logicalCpus'), children: metrics.runtime.system.logicalCpuCount },
            ]} />
          </Card>
          <Card className="surface" title={t('admin.serviceActivity')}>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
              { key: 'requests', label: t('admin.requestsTotal'), children: metrics.runtime.http.total.toLocaleString(locale) },
              { key: 'in-flight', label: t('admin.requestsInFlight'), children: metrics.runtime.http.inFlight.toLocaleString(locale) },
              { key: 'client-errors', label: t('admin.clientErrors'), children: errors.client.toLocaleString(locale) },
              { key: 'server-errors', label: t('admin.serverErrors'), children: errors.server.toLocaleString(locale) },
              { key: 'rate-limited', label: t('admin.rateLimited'), children: metrics.runtime.http.rateLimited.toLocaleString(locale) },
              { key: 'member-ws', label: t('admin.memberConnections'), children: metrics.runtime.webSockets.active.member.toLocaleString(locale) },
              { key: 'public-ws', label: t('admin.publicConnections'), children: metrics.runtime.webSockets.active.public.toLocaleString(locale) },
              { key: 'active-shares', label: t('admin.activePublicShares'), children: liveShare.totals.activeShares.toLocaleString(locale) },
            ]} />
          </Card>
          <Card className="surface" title={t('admin.liveShareOverview')}>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
              { key: 'connections', label: t('admin.currentViewConnections'), children: liveShare.totals.currentConnections.toLocaleString(locale) },
              { key: 'opens', label: t('admin.totalValidOpens'), children: formatOpenCount(liveShare.totals.totalOpens, liveShare.totals.saturatedShares > 0, locale) },
              { key: 'active', label: t('admin.activePublicShares'), children: liveShare.totals.activeShares.toLocaleString(locale) },
              { key: 'opened', label: t('admin.sharesWithOpens'), children: liveShare.totals.sharesWithOpens.toLocaleString(locale) },
              { key: 'saturated', label: t('admin.saturatedShares'), children: liveShare.totals.saturatedShares.toLocaleString(locale) },
            ]} />
          </Card>
        </div>

        <Card
          className="surface table-card operations-liveshare-table"
          title={t('admin.liveShareDetails')}
          extra={<Typography.Text type="secondary">{t('admin.metricsUpdatedAt', { time: formatTimestamp(liveShare.generatedAt, locale) })}</Typography.Text>}
        >
          <Table<PublicLiveshareStatItem>
            rowKey="publicShareId"
            dataSource={liveShare.items}
            size="middle"
            scroll={{ x: 1_000 }}
            pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
            rowClassName="clickable-table-row"
            onRow={(row) => ({
              role: 'link',
              tabIndex: 0,
              onClick: () => navigate(`/admin/operations/liveshares/${encodeURIComponent(row.publicShareId)}`),
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  navigate(`/admin/operations/liveshares/${encodeURIComponent(row.publicShareId)}`);
                }
              },
            })}
            columns={[
              {
                title: t('admin.liveShareSession'),
                key: 'session',
                width: 310,
                render: (_, row) => <div className="metric-session-cell">
                  <strong>{row.sessionTitle}</strong>
                  <span>{row.publicShareId}</span>
                </div>,
              },
              { title: t('admin.shareState'), dataIndex: 'state', width: 130, render: (state: PublicLiveshareState) => <Tag color={stateColor(state)}>{stateLabel(state)}</Tag> },
              { title: t('admin.currentViewConnections'), dataIndex: 'currentConnections', width: 150, align: 'right' },
              {
                title: t('admin.totalValidOpens'),
                dataIndex: 'totalOpens',
                width: 140,
                align: 'right',
                render: (value: number, row) => <span title={row.openCountSaturatedAt
                  ? t('admin.openCountSaturatedAt', {
                      time: formatTimestamp(row.openCountSaturatedAt, locale),
                    })
                  : undefined}
                >{formatOpenCount(value, row.openCountSaturated, locale)}</span>,
              },
              { title: t('admin.lastOpenedAt'), dataIndex: 'lastOpenedAt', width: 190, render: (value: string | null) => formatTimestamp(value, locale, t('admin.neverOpened')) },
              { title: t('admin.lastAccessedAt'), dataIndex: 'lastAccessedAt', width: 190, render: (value: string | null) => formatTimestamp(value, locale, t('admin.neverOpened')) },
              { title: t('invites.expires'), dataIndex: 'expiresAt', width: 190, render: (value: string) => formatTimestamp(value, locale) },
              {
                title: t('common.actions'),
                key: 'actions',
                fixed: 'right',
                width: 110,
                render: (_, row) => <Button
                  type="link"
                  icon={<EyeOutlined />}
                  onClick={(event) => {
                    event.stopPropagation();
                    navigate(`/admin/operations/liveshares/${encodeURIComponent(row.publicShareId)}`);
                  }}
                >{t('common.details')}</Button>,
              },
            ]}
          />
        </Card>
      </>}
    </AsyncContent>

    <Typography.Title className="operations-section-title" level={2}>{t('admin.maintenance')}</Typography.Title>
    <div className="content-grid">
      <Card className="surface" title={t('admin.retention')}>
        <Alert showIcon type="warning" message={t('admin.pruneWarning')} style={{ marginBottom: 18 }} />
        <Form layout="vertical"><Form.Item label={t('admin.retentionDays')}><InputNumber min={1} max={3650} value={days} onChange={(value) => setDays(value ?? 30)} style={{ width: '100%' }} /></Form.Item></Form>
        <Space wrap><Button icon={<SearchOutlined />} loading={working} onClick={() => void previewRetention()}>{t('admin.preview')}</Button><Button danger type="primary" icon={<DeleteOutlined />} onClick={() => setPruneOpen(true)}>{t('admin.prune')}</Button></Space>
        {preview && <pre className="json-preview" style={{ marginTop: 18 }}>{JSON.stringify(preview, null, 2)}</pre>}
      </Card>
      <Card className="surface" title={t('backup.title')}><Alert showIcon type="info" message={t('backup.scope')} style={{ marginBottom: 16 }} /><Button type="primary" icon={<DownloadOutlined />} onClick={() => navigate('/admin/backups')}>{t('backup.title')}</Button></Card>
    </div>
    <Modal open={pruneOpen} title={t('admin.prune')} okText={t('admin.prune')} cancelText={t('common.cancel')} confirmLoading={pruning} onCancel={() => { setPruneOpen(false); pruneForm.resetFields(); }} onOk={() => void pruneRetention()}><Alert type="warning" showIcon message={t('admin.pruneWarning')} style={{ marginBottom: 16 }} /><Form form={pruneForm} layout="vertical"><Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }, { max: 500 }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item></Form></Modal>
  </>;
}
