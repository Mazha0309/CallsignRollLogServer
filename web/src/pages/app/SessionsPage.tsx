import { EyeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, Input, Select, Space, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { accountApi } from '../../api';
import { useAuth } from '../../AuthContext';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { SessionRoleTag, SessionSourceTag, SessionStatusTag } from '../../components/SessionBadges';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { AccountSessionSource, AccountSessionSummary } from '../../types';

export default function SessionsPage() {
  const { user } = useAuth();
  return <SessionHistory key={user?.id} />;
}
function SessionHistory() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<AccountSessionSource>();
  const [status, setStatus] = useState<string>();
  const [role, setRole] = useState<string>();
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => setPage(1), [query, source, status, role, includeDeleted]);
  const catalog = useAsync(() => accountApi.allSessionCatalog({
    q: query || undefined,
    source: source === 'shared' ? undefined : source,
    status,
    role: source === 'personal' || source === 'shared' ? undefined : role,
    includeDeleted: includeDeleted || undefined,
  }), [query, source, status, role, includeDeleted]);
  const shared = useAsync(() => accountApi.sharedSessions(), []);
  const ownedItems = catalog.data ?? [];
  const sharedItems: AccountSessionSummary[] = (shared.data?.items ?? []).map((row): AccountSessionSummary => ({
    source: 'shared',
    sessionId: row.sessionId,
    title: row.title,
    status: row.status as AccountSessionSummary['status'],
    role: row.canEditLogs ? 'editor' : 'viewer',
    ownerUserId: row.grantorUserId,
    ownerUsername: row.grantorUsername,
    logCount: row.logCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
    deletedAt: row.deletedAt,
    snapshotRevision: null,
    sharedSource: row.source,
    grantId: row.grantId,
  })).filter(row => (!status || row.status === status) && (!query || `${row.title} ${row.ownerUsername} ${row.sessionId}`.toLowerCase().includes(query.toLowerCase())) && (!role || source === 'shared' || row.role === role));
  const merged = source === 'shared' ? sharedItems : source ? ownedItems : [...ownedItems, ...sharedItems];
  const items = [...new Map(merged.map(row => [row.source === 'shared' ? `${row.sharedSource}:${row.ownerUserId}:${row.sessionId}` : `${row.source}:${row.ownerUserId}:${row.sessionId}`,row])).values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const open = (row: AccountSessionSummary) => navigate(
    row.source === 'shared'
      ? `/app/sessions/shared/${row.sharedSource ?? 'collaboration'}/${encodeURIComponent(row.sessionId)}?grantId=${encodeURIComponent(row.grantId ?? '')}`
      : `/app/sessions/${row.source}/${encodeURIComponent(row.sessionId)}`,
  );
  const columns = [
    {
      title: t('sessions.session'),
      dataIndex: 'title',
      key: 'title',
      render: (value: string, row: AccountSessionSummary) => <div>
        <Space size={4} wrap><Typography.Text strong>{value}</Typography.Text><SessionSourceTag source={row.source} /></Space><br />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.source === 'shared' ? `${t('sharing.grantor')}: ${row.ownerUsername} · ` : ''}{row.sessionId}</Typography.Text>
      </div>,
    },
    { title: t('common.status'), dataIndex: 'status', width: 120, render: (value: AccountSessionSummary['status']) => <SessionStatusTag status={value} /> },
    { title: t('common.role'), dataIndex: 'role', width: 120, render: (value: AccountSessionSummary['role']) => value ? <SessionRoleTag role={value} /> : t('sessionSource.personalOwner') },
    { title: t('sessions.logs'), dataIndex: 'logCount', width: 100 },
    { title: t('sessions.updatedAt'), dataIndex: 'updatedAt', width: 190, render: (value: string) => new Date(value).toLocaleString(locale) },
    { title: t('common.actions'), key: 'actions', width: 100, render: (_: unknown, row: AccountSessionSummary) => <Button type="link" icon={<EyeOutlined />} onClick={() => open(row)}>{t('common.details')}</Button> },
  ];
  return <>
    <PageHeader title={t('sessions.unifiedTitle')} description={t('sessions.unifiedDescription')} actions={<Space><Button onClick={()=>navigate('/app/sharing')}>{t('sharing.title')}</Button><Button icon={<ReloadOutlined />} onClick={() => { catalog.reload(); shared.reload(); }}>{t('common.refresh')}</Button></Space>} />
    <Card className="surface table-card" title={<Space className="table-toolbar" wrap>
      <Input.Search className="table-toolbar-search" allowClear prefix={<SearchOutlined />} placeholder={t('common.search')} value={input} onChange={(event) => setInput(event.target.value)} onSearch={() => setQuery(input.trim())} />
      <Select allowClear placeholder={t('sessions.type')} value={source} onChange={setSource} style={{ width: 150 }} options={[
        { value: 'collaboration', label: t('sessionSource.collaboration') },
        { value: 'personal', label: t('sessionSource.personal') },
        { value: 'shared', label: t('sessionSource.shared') },
      ]} />
      <Select allowClear placeholder={t('common.status')} value={status} onChange={setStatus} style={{ width: 145 }} options={[
        { value: 'active', label: t('session.active') },
        { value: 'closed', label: t('session.closed') },
        { value: 'archived', label: t('session.archived') },
        { value: 'initializing', label: t('session.initializing') },
        { value: 'deleted', label: t('session.deleted') },
      ]} />
      <Select disabled={source === 'personal' || source === 'shared'} allowClear placeholder={t('common.role')} value={role} onChange={setRole} style={{ width: 135 }} options={[
        { value: 'owner', label: t('role.owner') },
        { value: 'editor', label: t('role.editor') },
        { value: 'viewer', label: t('role.viewer') },
      ]} />
      <Checkbox checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)}>{t('logs.includeDeleted')}</Checkbox>
    </Space>}>
      <AsyncContent loading={catalog.loading || shared.loading} error={catalog.error ?? shared.error} empty={!catalog.loading && !shared.loading && items.length === 0} onRetry={() => { catalog.reload(); shared.reload(); }}>
        <Table<AccountSessionSummary>
          rowKey={(row) => `${row.source}:${row.sharedSource}:${row.ownerUserId}:${row.sessionId}`}
          columns={columns}
          dataSource={items}
          pagination={{
            current: page,
            pageSize,
            total: items.length,
            showSizeChanger: true,
            onChange: (next, size) => { setPage(next); setPageSize(size); },
          }}
          scroll={{ x: 960 }}
        />
      </AsyncContent>
    </Card>
  </>;
}
