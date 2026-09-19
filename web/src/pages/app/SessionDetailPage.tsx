import {
  ArrowLeftOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, accountApi, sessionsApi, type LogPatch, type MutationResult } from '../../api';
import { useAuth } from '../../AuthContext';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { ExcelExportActions } from '../../components/ExcelExportActions';
import { ExcelCorrectionActions } from '../../components/ExcelCorrectionActions';
import { SessionRoleTag, SessionStatusTag } from '../../components/SessionBadges';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { AuditEvent, Invite, LogRecord, Member, PublicShare, SessionSummary } from '../../types';
import {
  DEFAULT_LIVE_SHARE_EXPIRY_HOURS,
  LIVE_SHARE_EXPIRY_PRESETS,
  MAX_LIVE_SHARE_EXPIRY_HOURS,
  MIN_LIVE_SHARE_EXPIRY_HOURS,
  liveShareExpiresAt,
  resolveLiveShareExpiryHours,
  type LiveShareExpiryPreset,
  type LiveShareExpirySelection,
} from '../../utils/liveShareExpiry';
import { canEditLog, canManageSession } from '../../utils/permissions';

function resultError(result: MutationResult, t: ReturnType<typeof useI18n>['t']): string | null {
  if (result.status === 'accepted') return null;
  if (result.status === 'conflict') return t('logs.conflict');
  return result.message ?? result.code ?? t('error.default');
}

function LogsTab({ session }: { session: SessionSummary }) {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const [messageApi, contextHolder] = message.useMessage();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [search, setSearch] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [editing, setEditing] = useState<LogRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<LogPatch>();
  const state = useAsync(() => sessionsApi.logs(session.sessionId, {
    page, pageSize, q: search || undefined, includeDeleted, sort: 'timeDesc',
  }), [session.sessionId, page, pageSize, search, includeDeleted]);
  useEffect(() => {
    if (editing) form.setFieldsValue({
      time: editing.time, controller: editing.controller, callsign: editing.callsign,
      rstSent: editing.rstSent, rstRcvd: editing.rstRcvd, qth: editing.qth,
      device: editing.device, power: editing.power, antenna: editing.antenna,
      height: editing.height, remarks: editing.remarks,
    });
  }, [editing, form]);

  const act = async (log: LogRecord, operation: 'delete' | 'restore') => {
    const result = operation === 'delete'
      ? await sessionsApi.deleteLog(log.sessionId, log)
      : await sessionsApi.restoreLog(log.sessionId, log);
    const issue = resultError(result, t);
    if (issue) { messageApi.error(issue); return; }
    messageApi.success(operation === 'delete' ? t('logs.deleted') : t('logs.restored'));
    state.reload();
  };
  const save = async () => {
    if (!editing) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      const optional = (value: string | null | undefined) => value?.trim() ? value.trim() : null;
      const result = await sessionsApi.updateLog(editing.sessionId, editing, {
        time: values.time,
        controller: values.controller.trim().toUpperCase(),
        callsign: values.callsign.trim().toUpperCase(),
        rstSent: optional(values.rstSent), rstRcvd: optional(values.rstRcvd), qth: optional(values.qth),
        device: optional(values.device), power: optional(values.power), antenna: optional(values.antenna),
        height: optional(values.height), remarks: optional(values.remarks),
      });
      const issue = resultError(result, t);
      if (issue) { messageApi.error(issue); return; }
      messageApi.success(t('logs.saved')); setEditing(null); state.reload();
    } catch (reason) {
      if (reason instanceof ApiError) messageApi.error(`${reason.message} (${reason.code})`);
    } finally { setSaving(false); }
  };

  const columns = [
    { title: t('common.time'), dataIndex: 'time', width: 178, fixed: 'left' as const, render: (value: string) => new Date(value).toLocaleString(locale) },
    { title: t('logs.callsign'), dataIndex: 'callsign', width: 115, fixed: 'left' as const, render: (value: string, row: LogRecord) => <Space><Typography.Text strong>{value}</Typography.Text>{row.deletedAt && <Tag color="red">{t('session.deleted')}</Tag>}</Space> },
    { title: t('logs.controller'), dataIndex: 'controller', width: 110 },
    { title: t('logs.rstSent'), dataIndex: 'rstSent', width: 88, render: (value: string | null) => value ?? '—' },
    { title: t('logs.rstRcvd'), dataIndex: 'rstRcvd', width: 88, render: (value: string | null) => value ?? '—' },
    { title: t('logs.qth'), dataIndex: 'qth', width: 150, ellipsis: true, render: (value: string | null) => value ?? '—' },
    { title: t('logs.device'), dataIndex: 'device', width: 135, ellipsis: true, render: (value: string | null) => value ?? '—' },
    { title: t('logs.power'), dataIndex: 'power', width: 90, render: (value: string | null) => value ?? '—' },
    { title: t('logs.antenna'), dataIndex: 'antenna', width: 130, ellipsis: true, render: (value: string | null) => value ?? '—' },
    { title: t('logs.remarks'), dataIndex: 'remarks', width: 220, ellipsis: true, render: (value: string | null) => value ?? '—' },
    { title: t('logs.author'), dataIndex: 'createdBy', width: 170, render: (value: string | null, row: LogRecord) => value === user?.id || row.ownedByCurrentUser ? <Tag color="blue">{t('logs.mine')}</Tag> : value ? <Typography.Text type="secondary">{t('logs.otherMember')}</Typography.Text> : <Tag>{t('logs.authorUnknown')}</Tag> },
    { title: t('common.actions'), key: 'actions', width: 170, fixed: 'right' as const, render: (_: unknown, row: LogRecord) => canEditLog(session.role, session.status, row) ? row.deletedAt
      ? <Button type="link" icon={<UndoOutlined />} onClick={() => void act(row, 'restore')}>{t('common.restore')}</Button>
      : <Space size={0}><Button type="link" icon={<EditOutlined />} onClick={() => setEditing(row)}>{t('common.edit')}</Button><Popconfirm title={t('common.delete')} onConfirm={() => void act(row, 'delete')}><Button danger type="link" icon={<DeleteOutlined />}>{t('common.delete')}</Button></Popconfirm></Space>
      : null },
  ];
  return (
    <>
      {contextHolder}
      <Alert showIcon type="info" message={t('logs.sharedEditingHint')} style={{ marginBottom: 12 }} />
      <Card className="surface table-card" title={<Space className="table-toolbar" wrap><Input.Search className="table-toolbar-search" allowClear placeholder={t('common.search')} onSearch={(value) => { setPage(1); setSearch(value.trim()); }} /><Checkbox checked={includeDeleted} onChange={(event) => { setPage(1); setIncludeDeleted(event.target.checked); }}>{t('logs.includeDeleted')}</Checkbox></Space>} extra={<Space wrap><ExcelCorrectionActions session={session} onApplied={state.reload} /><Button type="text" icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button></Space>}>
        <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
          <Table<LogRecord> rowKey="syncId" dataSource={state.data?.items ?? []} columns={columns} size="middle" scroll={{ x: 1430 }} pagination={{ current: page, pageSize, total: state.data?.total, showSizeChanger: true, showTotal: (total) => t('sessions.logCount', { count: total }), onChange: (next, size) => { setPage(next); setPageSize(size); } }} rowClassName={(row) => row.deletedAt ? 'ant-table-row-disabled' : ''} />
        </AsyncContent>
      </Card>
      <Drawer width={520} open={Boolean(editing)} title={t('logs.editTitle')} onClose={() => setEditing(null)} extra={<Space><Button onClick={() => setEditing(null)}>{t('common.cancel')}</Button><Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>{t('common.save')}</Button></Space>}>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="time" label={t('common.time')} rules={[{ required: true }]}><Input /></Form.Item>
          <div className="content-grid"><Form.Item name="callsign" label={t('logs.callsign')} rules={[{ required: true }, { max: 32 }]}><Input /></Form.Item><Form.Item name="controller" label={t('logs.controller')} rules={[{ required: true }, { max: 32 }]}><Input /></Form.Item></div>
          <div className="content-grid"><Form.Item name="rstSent" label={t('logs.rstSent')}><Input maxLength={16} /></Form.Item><Form.Item name="rstRcvd" label={t('logs.rstRcvd')}><Input maxLength={16} /></Form.Item></div>
          <Form.Item name="qth" label={t('logs.qth')}><Input maxLength={200} /></Form.Item>
          <div className="content-grid"><Form.Item name="device" label={t('logs.device')}><Input maxLength={200} /></Form.Item><Form.Item name="power" label={t('logs.power')}><Input maxLength={64} /></Form.Item></div>
          <div className="content-grid"><Form.Item name="antenna" label={t('logs.antenna')}><Input maxLength={200} /></Form.Item><Form.Item name="height" label={t('logs.height')}><Input maxLength={64} /></Form.Item></div>
          <Form.Item name="remarks" label={t('logs.remarks')}><Input.TextArea rows={5} maxLength={2000} showCount /></Form.Item>
        </Form>
      </Drawer>
    </>
  );
}

function OwnerGate({ role, children }: { role: SessionSummary['role']; children: React.ReactNode }) {
  const { t } = useI18n();
  return canManageSession(role) ? children : <Alert showIcon type="info" message={t('members.ownerOnly')} />;
}

function MembersTab({ session }: { session: SessionSummary }) {
  const { t, locale } = useI18n();
  const state = useAsync(() => session.role === 'owner' ? sessionsApi.members(session.sessionId) : Promise.resolve({ members: [] }), [session.sessionId, session.role]);
  return <OwnerGate role={session.role}><Card className="surface table-card" extra={<Button type="text" icon={<ReloadOutlined />} onClick={state.reload}>{t('common.refresh')}</Button>}>
    <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.members.length} onRetry={state.reload}>
      <Table<Member> rowKey="membershipId" dataSource={state.data?.members ?? []} pagination={false} scroll={{ x: 760 }} columns={[
        { title: t('members.user'), dataIndex: 'username', render: (value: string, row) => <div><Typography.Text strong>{value}</Typography.Text><br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.userId}</Typography.Text></div> },
        { title: t('common.role'), dataIndex: 'role', width: 180, render: (value: Member['role'], row) => value === 'owner' ? <SessionRoleTag role={value} /> : <Select value={value} style={{ width: 130 }} options={[{ value: 'editor', label: t('role.editor') }, { value: 'viewer', label: t('role.viewer') }]} onChange={async (role) => { await sessionsApi.updateMember(session.sessionId, row.userId, role); state.reload(); }} /> },
        { title: t('members.joinedAt'), dataIndex: 'joinedAt', width: 190, render: (value: string) => new Date(value).toLocaleString(locale) },
        { title: t('common.actions'), width: 120, render: (_: unknown, row) => row.role === 'owner' ? null : <Popconfirm title={t('common.delete')} onConfirm={async () => { await sessionsApi.removeMember(session.sessionId, row.userId); state.reload(); }}><Button danger type="link" icon={<DeleteOutlined />}>{t('common.delete')}</Button></Popconfirm> },
      ]} />
    </AsyncContent>
  </Card></OwnerGate>;
}

function InvitesTab({ session }: { session: SessionSummary }) {
  const { t, locale } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Invite | null>(null);
  const [form] = Form.useForm();
  const state = useAsync(() => session.role === 'owner' ? sessionsApi.invites(session.sessionId) : Promise.resolve({ invites: [] }), [session.sessionId, session.role]);
  const create = async () => {
    const values = await form.validateFields();
    const response = await sessionsApi.createInvite(session.sessionId, values);
    setCreated(response.invite); setOpen(false); state.reload();
  };
  return <OwnerGate role={session.role}>{contextHolder}<Card className="surface table-card" title={<Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>{t('invites.create')}</Button>}>
    <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.invites.length} onRetry={state.reload}>
      <Table<Invite> rowKey="inviteId" dataSource={state.data?.invites ?? []} scroll={{ x: 800 }} columns={[
        { title: t('invites.codeHint'), dataIndex: 'codeHint', render: (value: string) => `••••••${value}` },
        { title: t('common.role'), dataIndex: 'role', render: (value: Invite['role']) => <SessionRoleTag role={value} /> },
        { title: t('invites.uses'), render: (_, row) => `${row.usedCount} / ${row.maxUses}` },
        { title: t('invites.expires'), dataIndex: 'expiresAt', render: (value: string) => new Date(value).toLocaleString(locale) },
        { title: t('common.status'), render: (_, row) => row.revokedAt ? <Tag color="red">{t('common.revoke')}</Tag> : Date.parse(row.expiresAt) < Date.now() ? <Tag>{t('common.close')}</Tag> : <Tag color="green">{t('common.active')}</Tag> },
        { title: t('common.actions'), render: (_, row) => row.revokedAt ? null : <Popconfirm title={t('common.revoke')} onConfirm={async () => { await sessionsApi.revokeInvite(session.sessionId, row.inviteId); state.reload(); }}><Button danger type="link" icon={<StopOutlined />}>{t('common.revoke')}</Button></Popconfirm> },
      ]} />
    </AsyncContent>
  </Card>
  <Modal open={open} title={t('invites.create')} onCancel={() => setOpen(false)} onOk={() => void create()} okText={t('common.create')} cancelText={t('common.cancel')}><Form form={form} layout="vertical" initialValues={{ role: 'editor', expiresInHours: 24, maxUses: 1 }}><Form.Item name="role" label={t('common.role')}><Select options={[{ value: 'editor', label: t('role.editor') }, { value: 'viewer', label: t('role.viewer') }]} /></Form.Item><Form.Item name="expiresInHours" label={t('invites.expires')}><InputNumber min={1} max={720} addonAfter="h" style={{ width: '100%' }} /></Form.Item><Form.Item name="maxUses" label={t('invites.uses')}><InputNumber min={1} max={100} style={{ width: '100%' }} /></Form.Item></Form></Modal>
  <Modal open={Boolean(created)} title={t('invites.create')} footer={<Button type="primary" onClick={() => setCreated(null)}>{t('common.close')}</Button>} onCancel={() => setCreated(null)}><Alert showIcon type="warning" message={t('invites.newCode')} /><Input value={created?.code ?? ''} readOnly style={{ marginTop: 16 }} addonAfter={<Button type="text" icon={<CopyOutlined />} onClick={() => { void navigator.clipboard.writeText(created?.code ?? ''); messageApi.success(t('common.copied')); }}>{t('common.copy')}</Button>} /></Modal>
  </OwnerGate>;
}

function SharesTab({ session }: { session: SessionSummary }) {
  const { t, locale } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const [created, setCreated] = useState<PublicShare | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expirySelection, setExpirySelection] = useState<LiveShareExpirySelection>(DEFAULT_LIVE_SHARE_EXPIRY_HOURS);
  const [customHours, setCustomHours] = useState<number | null>(DEFAULT_LIVE_SHARE_EXPIRY_HOURS);
  const state = useAsync(() => session.role === 'owner' ? sessionsApi.shares(session.sessionId) : Promise.resolve({ publicShares: [], nextCursor: null }), [session.sessionId, session.role]);
  const expiryHours = resolveLiveShareExpiryHours(expirySelection, customHours);
  const expiryLabels: Record<LiveShareExpiryPreset, string> = {
    1: t('shares.expiry1Hour'),
    6: t('shares.expiry6Hours'),
    12: t('shares.expiry12Hours'),
    24: t('shares.expiry1Day'),
    72: t('shares.expiry3Days'),
    168: t('shares.expiry7Days'),
    720: t('shares.expiry30Days'),
  };
  const shareUrl = (share: PublicShare) => {
    const url = new URL(`/live/${encodeURIComponent(share.publicShareId)}`, window.location.origin);
    if (share.secret) url.hash = `token=${encodeURIComponent(share.secret)}`;
    return url.toString();
  };
  const openCreate = () => {
    setExpirySelection(DEFAULT_LIVE_SHARE_EXPIRY_HOURS);
    setCustomHours(DEFAULT_LIVE_SHARE_EXPIRY_HOURS);
    setCreateOpen(true);
  };
  const create = async () => {
    if (expiryHours === null) return;
    setCreating(true);
    try {
      const response = await sessionsApi.createShare(session.sessionId, expiryHours);
      setCreateOpen(false);
      setCreated(response.publicShare);
      state.reload();
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : t('error.default'));
    } finally {
      setCreating(false);
    }
  };
  return <OwnerGate role={session.role}>{contextHolder}<Card className="surface table-card" title={<Button type="primary" icon={<LinkOutlined />} onClick={openCreate}>{t('shares.create')}</Button>}>
    <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.publicShares.length} onRetry={state.reload}>
      <Table<PublicShare> rowKey="publicShareId" dataSource={state.data?.publicShares ?? []} scroll={{ x: 760 }} columns={[
        { title: 'ID', dataIndex: 'publicShareId', ellipsis: true },
        { title: t('invites.expires'), dataIndex: 'expiresAt', render: (value: string) => new Date(value).toLocaleString(locale) },
        { title: t('common.status'), render: (_, row) => row.revokedAt ? <Tag color="red">{t('common.revoke')}</Tag> : Date.parse(row.expiresAt) < Date.now() ? <Tag>{t('common.close')}</Tag> : <Tag color="green">{t('common.active')}</Tag> },
        { title: t('common.actions'), render: (_, row) => <Space>{!row.revokedAt && <Typography.Text type="secondary">{t('shares.secretUnavailable')}</Typography.Text>}{!row.revokedAt && <Popconfirm title={t('common.revoke')} onConfirm={async () => { await sessionsApi.revokeShare(session.sessionId, row.publicShareId); state.reload(); }}><Button danger type="link" icon={<StopOutlined />}>{t('common.revoke')}</Button></Popconfirm>}</Space> },
      ]} />
    </AsyncContent>
  </Card>
  <Modal
    open={createOpen}
    title={t('shares.create')}
    okText={t('common.create')}
    cancelText={t('common.cancel')}
    okButtonProps={{ disabled: expiryHours === null }}
    confirmLoading={creating}
    onCancel={() => setCreateOpen(false)}
    onOk={() => void create()}
  >
    <Form layout="vertical">
      <Form.Item label={t('shares.expiryPeriod')}>
        <Select
          aria-label={t('shares.expiryPeriod')}
          value={expirySelection}
          onChange={(value: LiveShareExpirySelection) => setExpirySelection(value)}
          options={[
            ...LIVE_SHARE_EXPIRY_PRESETS.map((hours) => ({ value: hours, label: expiryLabels[hours] })),
            { value: 'custom', label: t('shares.expiryCustom') },
          ]}
        />
      </Form.Item>
      {expirySelection === 'custom' && <Form.Item
        label={t('shares.customHours')}
        validateStatus={expiryHours === null ? 'error' : undefined}
        help={expiryHours === null ? t('shares.customHoursHint') : undefined}
      >
        <InputNumber
          aria-label={t('shares.customHours')}
          value={customHours}
          min={MIN_LIVE_SHARE_EXPIRY_HOURS}
          max={MAX_LIVE_SHARE_EXPIRY_HOURS}
          precision={0}
          addonAfter={t('shares.hoursUnit')}
          style={{ width: '100%' }}
          onChange={setCustomHours}
        />
      </Form.Item>}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t('shares.expectedExpiry')}: <Typography.Text>{expiryHours === null ? '—' : liveShareExpiresAt(expiryHours).toLocaleString(locale)}</Typography.Text>
      </Typography.Paragraph>
    </Form>
  </Modal>
  <Modal open={Boolean(created)} title={t('shares.create')} footer={<Button type="primary" onClick={() => setCreated(null)}>{t('common.close')}</Button>} onCancel={() => setCreated(null)}><Alert showIcon type="warning" message={t('shares.secretHint')} /><Input.TextArea value={created ? shareUrl(created) : ''} readOnly autoSize style={{ marginTop: 16 }} /><Space wrap style={{ marginTop: 12 }}><Button icon={<LinkOutlined />} href={created ? shareUrl(created) : undefined} target="_blank" rel="noreferrer">{t('shares.open')}</Button><Button icon={<CopyOutlined />} onClick={() => { if (created) void navigator.clipboard.writeText(shareUrl(created)); messageApi.success(t('common.copied')); }}>{t('common.copy')}</Button></Space></Modal>
  </OwnerGate>;
}

function AuditTab({ session }: { session: SessionSummary }) {
  const { t, locale } = useI18n();
  const state = useAsync(() => session.role === 'owner' ? sessionsApi.audit(session.sessionId) : Promise.resolve({ items: [], pageInfo: { limit: 50, hasMore: false, nextCursor: null } }), [session.sessionId, session.role]);
  return <OwnerGate role={session.role}><Card className="surface table-card">
    <AsyncContent loading={state.loading} error={state.error} empty={!state.loading && !state.data?.items.length} onRetry={state.reload}>
      <Table<AuditEvent> rowKey="auditEventId" dataSource={state.data?.items ?? []} pagination={false} scroll={{ x: 900 }} expandable={{ expandedRowRender: (row) => <pre className="json-preview">{JSON.stringify({ before: row.before, after: row.after, details: row.details }, null, 2)}</pre> }} columns={[
        { title: t('common.time'), dataIndex: 'occurredAt', width: 190, render: (value: string) => new Date(value).toLocaleString(locale) },
        { title: t('audit.action'), dataIndex: 'action', width: 240, render: (value: string) => <Tag>{value}</Tag> },
        { title: t('audit.actor'), dataIndex: 'actorUserId', ellipsis: true },
        { title: t('audit.target'), dataIndex: 'targetUserId', ellipsis: true, render: (value: string | null) => value ?? '—' },
      ]} />
    </AsyncContent>
  </Card></OwnerGate>;
}

function SettingsTab({ session, reload }: { session: SessionSummary; reload: () => void }) {
  const { t } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const owner = session.role === 'owner';
  const passphrase = useAsync(() => owner ? accountApi.joinPassphrase(session.sessionId) : Promise.resolve({ configured: false, updatedAt: null }), [session.sessionId, owner]);
  const [passphraseValue, setPassphraseValue] = useState('');
  const close = async () => {
    const result = await sessionsApi.close(session.sessionId, session.version);
    if (result.status !== 'accepted') {
      if (result.code === 'LIVE_DRAFT_NOT_EMPTY' || result.code === 'LIVE_DRAFT_BUSY') {
        messageApi.error(t('sessions.closeDraftBlocked'));
      } else {
        messageApi.error(resultError(result, t) ?? t('error.default'));
      }
      return;
    }
    messageApi.success(t('sessions.closedSucceeded'));
    reload();
  };
  return <>{contextHolder}<Card className="surface" style={{ maxWidth: 720 }}><Descriptions column={1} bordered size="small" items={[
    { key: 'id', label: 'Session ID', children: session.sessionId },
    { key: 'role', label: t('settings.permission'), children: <SessionRoleTag role={session.role} /> },
    { key: 'seq', label: 'High-watermark', children: session.highWatermarkSeq },
  ]} />
  <Form layout="vertical" initialValues={{ title: session.title }} onFinish={async ({ title }: { title: string }) => { const result = await sessionsApi.updateTitle(session.sessionId, session.version, title.trim()); const issue = resultError(result, t); if (issue) { messageApi.error(issue); return; } messageApi.success(t('settings.applied')); reload(); }} style={{ marginTop: 20 }}>
    <Form.Item label={t('settings.sessionTitle')} name="title" rules={[{ required: true }, { max: 200 }]}><Input disabled={!owner || session.status !== 'active'} /></Form.Item>
    {owner && session.status === 'active' && <Button type="primary" htmlType="submit" icon={<SaveOutlined />}>{t('common.save')}</Button>}
  </Form>
  {owner && <Card size="small" title={t('sharing.passphrase')} style={{ marginTop: 20 }}>
    <Typography.Paragraph type="secondary">{t('sharing.passphraseHint')}</Typography.Paragraph>
    <Space wrap>
      <Tag>{passphrase.data?.configured ? t('sharing.passphraseConfigured') : t('sharing.passphraseMissing')}</Tag>
      <Input.Password value={passphraseValue} onChange={(event) => setPassphraseValue(event.target.value)} style={{ width: 220 }} />
      <Button onClick={async () => {
        try {
          await accountApi.setJoinPassphrase(session.sessionId, passphraseValue);
          setPassphraseValue('');
          passphrase.reload();
          messageApi.success(t('settings.applied'));
        } catch (reason) {
          messageApi.error(reason instanceof Error ? reason.message : t('error.default'));
        }
      }}>{t('sharing.setPassphrase')}</Button>
    </Space>
  </Card>}
  {owner && session.status === 'active' && <Card size="small" title={t('sessions.closeTitle')} style={{ marginTop: 20 }}>
    <Typography.Paragraph type="secondary">{t('sessions.closeHint')}</Typography.Paragraph>
    <Popconfirm title={t('sessions.closeConfirm')} onConfirm={() => void close()} okButtonProps={{ danger: true }}>
      <Button danger icon={<StopOutlined />}>{t('sessions.closeAction')}</Button>
    </Popconfirm>
  </Card>}
  </Card></>;
}

export default function SessionDetailPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const state = useAsync(async () => {
    const sessions = await sessionsApi.list();
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (!session) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
    return session;
  }, [sessionId]);
  // Do not keep the previous Session mounted while a route change is loading.
  // This also prevents a late mutation response from surfacing in another Session.
  const session = state.data?.sessionId === sessionId ? state.data : null;
  const tabs = session ? [
    { key: 'logs', label: t('sessions.logs'), children: <LogsTab session={session} /> },
    { key: 'members', label: t('sessions.members'), children: <MembersTab session={session} /> },
    { key: 'invites', label: t('sessions.invites'), children: <InvitesTab session={session} /> },
    { key: 'shares', label: t('sessions.shares'), children: <SharesTab session={session} /> },
    { key: 'audit', label: t('sessions.audit'), children: <AuditTab session={session} /> },
    { key: 'settings', label: t('sessions.settings'), children: <SettingsTab session={session} reload={state.reload} /> },
  ] : [];
  return (
    <>
      <PageHeader title={session ? <span className="session-title-row">{session.title}<SessionStatusTag status={session.status} /><SessionRoleTag role={session.role} /></span> : t('sessions.session')} description={session && <div className="session-meta"><span>{session.sessionId}</span></div>} actions={<Space wrap>{session && <ExcelExportActions title={session.title} loadLogs={(params) => sessionsApi.logs(session.sessionId, params)} />}<Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/app/sessions')}>{t('sessions.back')}</Button></Space>} />
      <AsyncContent loading={state.loading || (!session && !state.error)} error={state.error} onRetry={state.reload}>
        {session && <Tabs className="detail-tabs" items={tabs} destroyOnHidden={false} />}
      </AsyncContent>
    </>
  );
}
