import { CheckOutlined, CloseOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, Form, AutoComplete, Select, Space, Table, Tag, Alert, Popconfirm, message } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { ApiError, accountApi, socialApi } from '../../api';
import { useAuth } from '../../AuthContext';
import { subscribeSocialUpdates } from '../../social-realtime';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { AccountShareGrant } from '../../types';

export default function SharingPage() {
  const { user } = useAuth();
  return <SharingWorkspace key={user?.id} />;
}
function SharingWorkspace() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [editing, setEditing] = useState<AccountShareGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const pending = useRef(new Map<string, string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<{
    granteeUsername: string;
    scopeMode: 'all' | 'selected'; selection: string[];
    canEditLogs: boolean; canDeleteLogs: boolean;
  }>();
  const mode = Form.useWatch('scopeMode', form);
  const canEdit = Form.useWatch('canEditLogs', form);
  const candidates = useAsync(() => accountApi.allSessionCatalog(), []);
  const friends = useAsync(socialApi.dashboard, []);
  const inbox = useAsync(() => accountApi.sessionShares('inbox'), []);
  const outbox = useAsync(() => accountApi.sessionShares('outbox'), []);
  const active = useAsync(() => accountApi.sessionShares('active'), []);
  const reloadInbox = inbox.reload, reloadOutbox = outbox.reload, reloadActive = active.reload, reloadCandidates = candidates.reload, reloadFriends = friends.reload;
  useEffect(() => user?.id ? subscribeSocialUpdates({ userId: user.id, ticket: socialApi.ticket, invalidate: () => { reloadInbox(); reloadOutbox(); reloadActive(); reloadCandidates(); reloadFriends(); } }) : undefined, [user?.id, reloadInbox, reloadOutbox, reloadActive, reloadCandidates, reloadFriends]);
  const reloadAll = () => { inbox.reload(); outbox.reload(); active.reload(); };
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      if (!alive.current) return;
      messageApi.success(t('settings.applied'));
      reloadAll();
    } catch (reason) {
      if (alive.current) messageApi.error(reason instanceof ApiError ? `${reason.message} (${reason.code})` : t('error.default'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const edit = (grant: AccountShareGrant) => {
    setEditing(grant); form.setFieldsValue({ granteeUsername: grant.granteeUsername ?? grant.granteeUserId, scopeMode: grant.scopeMode ?? 'all',
      selection: (grant.selectedSessions ?? []).map(s => JSON.stringify([s.source,s.sessionId])), canEditLogs: grant.canEditLogs ?? false, canDeleteLogs: grant.canDeleteLogs ?? false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const scopeColumn = { title: t('sharing.scope'), render: (_: unknown, grant: AccountShareGrant) => <Space wrap><Tag>{t(grant.scopeMode === 'selected' ? 'sharing.selected' : 'sharing.all')}{grant.scopeMode === 'selected' ? ` (${grant.selectedSessions?.length ?? 0})` : ''}</Tag><Tag>{t(grant.canEditLogs ? 'sharing.editLogs' : 'sharing.readOnly')}</Tag>{grant.canDeleteLogs && <Tag>{t('sharing.deleteLogs')}</Tag>}</Space> };
  return <>
    {contextHolder}
    <PageHeader title={t('sharing.title')} description={t('sharing.description')} actions={<Button icon={<ReloadOutlined />} onClick={reloadAll}>{t('common.refresh')}</Button>} />
    <Card className="surface" title={t('sharing.create')} style={{ marginBottom: 16 }}>
      <Alert type="info" showIcon message={t('sharing.hint')} style={{ marginBottom: 16 }} />
      <Form form={form} layout="vertical" disabled={busy} initialValues={{ scopeMode: 'selected', selection: [], canEditLogs: false, canDeleteLogs: false }} onFinish={(values) => run(async () => {
        const body = { ...(editing ? {} : { granteeUsername: values.granteeUsername }), scopeMode: values.scopeMode,
          selectedSessions: values.scopeMode === 'all' ? [] : values.selection.map(s => { const [source, sessionId] = JSON.parse(s); return { source, sessionId }; }),
          canEditLogs: values.canEditLogs, canDeleteLogs: values.canEditLogs && values.canDeleteLogs };
        const operation = JSON.stringify([editing?.id,body]);
        const key = pending.current.get(operation) ?? crypto.randomUUID(); pending.current.set(operation,key);
        await accountApi.saveBatchShare(body, editing?.id, key);
        if (alive.current) { pending.current.delete(operation); setEditing(null); form.resetFields(); }
      })}>
        <Form.Item name="granteeUsername" label={t('sharing.grantee')} rules={[{ required: true }]}><AutoComplete disabled={!!editing} options={friends.data?.friends.map(p => ({value:p.username}))} filterOption={(input, option) => String(option?.value).toLowerCase().includes(input.toLowerCase())} /></Form.Item>
        <Form.Item name="scopeMode" label={t('sharing.scope')}><Select options={[{value:'selected',label:t('sharing.selected')},{value:'all',label:t('sharing.all')}]} /></Form.Item>
        {mode === 'all' ? <Alert type="warning" message={t('sharing.allHint')} /> : <Form.Item name="selection" label={t('sharing.selected')} rules={[{required:true,type:'array',min:1}]}><Select mode="multiple" optionFilterProp="label" loading={candidates.loading} options={candidates.data?.filter(s=>s.source==='personal'||s.role==='owner').map(s=>({value:JSON.stringify([s.source,s.sessionId]),label:s.title}))} /></Form.Item>}
        <Form.Item name="canEditLogs" valuePropName="checked"><Checkbox onChange={event=>{if(!event.target.checked) form.setFieldValue('canDeleteLogs',false);}}>{t('sharing.editLogs')}</Checkbox></Form.Item>
        <Form.Item name="canDeleteLogs" valuePropName="checked"><Checkbox disabled={!canEdit}>{t('sharing.deleteLogs')}</Checkbox></Form.Item>
        <Space><Button type="primary" htmlType="submit" loading={busy} icon={<PlusOutlined />}>{t(editing ? 'common.save' : 'sharing.send')}</Button>{editing && <Button onClick={()=>{setEditing(null);form.resetFields();}}>{t('common.cancel')}</Button>}</Space>
      </Form>
    </Card>
    <Card className="surface table-card" title={t('sharing.inbox')} style={{ marginBottom: 16 }}>
      <AsyncContent loading={inbox.loading} error={inbox.error} empty={!inbox.loading && !(inbox.data?.items.length)} onRetry={inbox.reload}>
        <Table<AccountShareGrant> rowKey="id" dataSource={inbox.data?.items ?? []} pagination={false} columns={[
          { title: t('sharing.grantor'), render: (_, row) => row.grantorUsername ?? row.grantorUserId },
          scopeColumn,
          { title: t('common.status'), dataIndex: 'status', render: (value: string) => <Tag>{value}</Tag> },
          { title: t('common.actions'), render: (_, row) => <Space>
            <Button type="primary" icon={<CheckOutlined />} onClick={() => run(() => accountApi.acceptSessionShare(row.id))}>{t('sharing.accept')}</Button>
            <Button danger icon={<CloseOutlined />} onClick={() => run(() => accountApi.rejectSessionShare(row.id))}>{t('sharing.reject')}</Button>
          </Space> },
        ]} />
      </AsyncContent>
    </Card>
    <Card className="surface table-card" title={t('sharing.outbox')} style={{ marginBottom: 16 }}>
      <AsyncContent loading={outbox.loading} error={outbox.error} empty={!outbox.loading && !(outbox.data?.items.length)} onRetry={outbox.reload}>
        <Table<AccountShareGrant> rowKey="id" dataSource={outbox.data?.items ?? []} pagination={false} columns={[
          { title: t('sharing.grantee'), render: (_, row) => row.granteeUsername ?? row.granteeUserId },
          scopeColumn,
          { title: t('common.status'), dataIndex: 'status' },
          { title: t('common.actions'), render: (_, row) => <Space><Button disabled={busy} onClick={()=>edit(row)}>{t('common.edit')}</Button><Button disabled={busy} icon={<StopOutlined />} onClick={() => run(() => accountApi.cancelSessionShare(row.id))}>{t('common.cancel')}</Button></Space> },
        ]} />
      </AsyncContent>
    </Card>
    <Card className="surface table-card" title={t('sharing.active')}>
      <AsyncContent loading={active.loading} error={active.error} empty={!active.loading && !(active.data?.items.length)} onRetry={active.reload}>
        <Table<AccountShareGrant> rowKey="id" dataSource={active.data?.items ?? []} pagination={false} columns={[
          { title: t('sharing.grantor'), render: (_, row) => row.grantorUsername ?? row.grantorUserId },
          { title: t('sharing.grantee'), render: (_, row) => row.granteeUsername ?? row.granteeUserId },
          scopeColumn,
          { title: t('common.status'), dataIndex: 'status' },
          { title: t('common.actions'), render: (_, row) => row.grantorUserId === user?.id && <Space><Button disabled={busy} onClick={()=>edit(row)}>{t('common.edit')}</Button><Popconfirm title={t('sharing.revokeHint')} onConfirm={() => run(() => accountApi.revokeSessionShare(row.id))}><Button disabled={busy} danger>{t('common.revoke')}</Button></Popconfirm></Space> },
        ]} />
      </AsyncContent>
    </Card>
  </>;
}
