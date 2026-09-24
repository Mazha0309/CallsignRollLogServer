import { ArrowLeftOutlined, EyeOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, Input, Select, Space, Table, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { SessionRoleTag, SessionSourceTag, SessionStatusTag } from '../../components/SessionBadges';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { AccountSessionSource, AccountSessionSummary } from '../../types';

export default function AdminAccountSessionsPage() {
  const { userId = '' } = useParams();
  // Reuse one audited visit ID while this account page remains mounted.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const accessId = useMemo(() => crypto.randomUUID(), [userId]);
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
  const state = useAsync(() => adminApi.accountSessions(userId, accessId, {
    page,
    pageSize,
    q: query || undefined,
    source: source === 'shared' ? undefined : source,
    status,
    role: source === 'personal' ? undefined : role,
    includeDeleted: includeDeleted || undefined,
  }), [userId, accessId, page, pageSize, query, source, status, role, includeDeleted]);
  const owner = state.data?.user;
  const catalog = state.data?.catalog;
  const open = (row: AccountSessionSummary) => navigate(
    `/admin/sessions/accounts/${encodeURIComponent(userId)}/${row.source}/${encodeURIComponent(row.sessionId)}`,
  );
  return <>
    <PageHeader
      title={owner?.username ?? t('admin.accountSessionsTitle')}
      description={owner ? `${t('admin.accountSessionsDescription')} · ${owner.id}` : t('admin.accountSessionsDescription')}
      actions={<Space wrap><Button icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button><Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin/sessions')}>{t('admin.backToSessionAccounts')}</Button></Space>}
    />
    <Card className="surface table-card" title={<Space className="table-toolbar" wrap>
      <Input.Search className="table-toolbar-search" allowClear prefix={<SearchOutlined />} placeholder={t('common.search')} value={input} onChange={(event) => setInput(event.target.value)} onSearch={() => setQuery(input.trim())} />
      <Select allowClear placeholder={t('sessions.type')} value={source} onChange={setSource} style={{ width: 150 }} options={[
        { value: 'collaboration', label: t('sessionSource.collaboration') },
        { value: 'personal', label: t('sessionSource.personal') },
      ]} />
      <Select allowClear placeholder={t('common.status')} value={status} onChange={setStatus} style={{ width: 145 }} options={[
        { value: 'active', label: t('session.active') },
        { value: 'closed', label: t('session.closed') },
        { value: 'archived', label: t('session.archived') },
        { value: 'initializing', label: t('session.initializing') },
        { value: 'deleted', label: t('session.deleted') },
      ]} />
      <Select disabled={source === 'personal'} allowClear placeholder={t('common.role')} value={role} onChange={setRole} style={{ width: 135 }} options={[
        { value: 'owner', label: t('role.owner') },
        { value: 'editor', label: t('role.editor') },
        { value: 'viewer', label: t('role.viewer') },
      ]} />
      <Checkbox checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)}>{t('logs.includeDeleted')}</Checkbox>
    </Space>}>
      <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !catalog?.items.length} onRetry={state.reload}>
        <Table<AccountSessionSummary>
          rowKey={(row) => `${row.source}:${row.sessionId}`}
          dataSource={catalog?.items ?? []}
          scroll={{ x: 1100 }}
          pagination={{ current: page, pageSize, total: catalog?.total, showSizeChanger: true, onChange: (next, size) => { setPage(next); setPageSize(size); } }}
          columns={[
            { title: t('sessions.session'), dataIndex: 'title', render: (value: string, row) => <div><Space size={4} wrap><Typography.Text strong>{value}</Typography.Text><SessionSourceTag source={row.source} /></Space><br /><span className="error-code">{row.sessionId}</span></div> },
            { title: t('common.status'), dataIndex: 'status', width: 120, render: (value: AccountSessionSummary['status']) => <SessionStatusTag status={value} /> },
            { title: t('admin.accountRole'), dataIndex: 'role', width: 120, render: (value: AccountSessionSummary['role']) => value ? <SessionRoleTag role={value} /> : t('sessionSource.personalOwner') },
            { title: t('admin.owner'), dataIndex: 'ownerUsername', width: 150 },
            { title: t('sessions.logs'), dataIndex: 'logCount', width: 100 },
            { title: t('sessions.updatedAt'), dataIndex: 'updatedAt', width: 190, render: (value: string) => new Date(value).toLocaleString(locale) },
            { title: t('common.actions'), width: 100, render: (_, row) => <Button type="link" icon={<EyeOutlined />} onClick={() => open(row)}>{t('common.details')}</Button> },
          ]}
        />
      </AsyncContent>
    </Card>
  </>;
}
