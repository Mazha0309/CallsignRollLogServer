import { CheckOutlined, CloseOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, Form, Input, Select, Space, Table, Tag, message } from 'antd';
import { ApiError, accountApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { AccountShareGrant } from '../../types';

export default function SharingPage() {
  const { t } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<{
    granteeUsername: string;
    includePersonal: boolean;
    includeOwned: boolean;
    includeEditor: boolean;
    canJoinAs: 'editor' | 'viewer' | 'none';
  }>();
  const inbox = useAsync(() => accountApi.sessionShares('inbox'), []);
  const outbox = useAsync(() => accountApi.sessionShares('outbox'), []);
  const active = useAsync(() => accountApi.sessionShares('active'), []);
  const reloadAll = () => { inbox.reload(); outbox.reload(); active.reload(); };
  const run = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
      messageApi.success(t('settings.applied'));
      reloadAll();
    } catch (reason) {
      messageApi.error(reason instanceof ApiError ? `${reason.message} (${reason.code})` : t('error.default'));
    }
  };
  return <>
    {contextHolder}
    <PageHeader title={t('sharing.title')} description={t('sharing.description')} actions={<Button icon={<ReloadOutlined />} onClick={reloadAll}>{t('common.refresh')}</Button>} />
    <Card className="surface" title={t('sharing.create')} style={{ marginBottom: 16 }}>
      <Form form={form} layout="inline" initialValues={{ includePersonal: true, includeOwned: true, includeEditor: true, canJoinAs: 'editor' }} onFinish={(values) => run(() => accountApi.createSessionShare(values))}>
        <Form.Item name="granteeUsername" rules={[{ required: true }]}><Input placeholder={t('auth.username')} /></Form.Item>
        <Form.Item name="includePersonal" valuePropName="checked"><Checkbox>{t('sharing.includePersonal')}</Checkbox></Form.Item>
        <Form.Item name="includeOwned" valuePropName="checked"><Checkbox>{t('sharing.includeOwned')}</Checkbox></Form.Item>
        <Form.Item name="includeEditor" valuePropName="checked"><Checkbox>{t('sharing.includeEditor')}</Checkbox></Form.Item>
        <Form.Item name="canJoinAs"><Select style={{ width: 140 }} options={[{ value: 'editor', label: t('role.editor') }, { value: 'viewer', label: t('role.viewer') }, { value: 'none', label: t('sharing.readOnly') }]} /></Form.Item>
        <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>{t('sharing.send')}</Button>
      </Form>
    </Card>
    <Card className="surface table-card" title={t('sharing.inbox')} style={{ marginBottom: 16 }}>
      <AsyncContent loading={inbox.loading} error={inbox.error} empty={!inbox.loading && !(inbox.data?.items.length)} onRetry={inbox.reload}>
        <Table<AccountShareGrant> rowKey="id" dataSource={inbox.data?.items ?? []} pagination={false} columns={[
          { title: t('sharing.grantor'), dataIndex: 'grantorUserId' },
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
          { title: t('sharing.grantee'), dataIndex: 'granteeUserId' },
          { title: t('common.status'), dataIndex: 'status' },
          { title: t('common.actions'), render: (_, row) => <Button icon={<StopOutlined />} onClick={() => run(() => accountApi.cancelSessionShare(row.id))}>{t('common.cancel')}</Button> },
        ]} />
      </AsyncContent>
    </Card>
    <Card className="surface table-card" title={t('sharing.active')}>
      <AsyncContent loading={active.loading} error={active.error} empty={!active.loading && !(active.data?.items.length)} onRetry={active.reload}>
        <Table<AccountShareGrant> rowKey="id" dataSource={active.data?.items ?? []} pagination={false} columns={[
          { title: t('sharing.grantor'), dataIndex: 'grantorUserId' },
          { title: t('sharing.grantee'), dataIndex: 'granteeUserId' },
          { title: t('common.status'), dataIndex: 'status' },
          { title: t('common.actions'), render: (_, row) => <Button danger onClick={() => run(() => accountApi.revokeSessionShare(row.id))}>{t('common.revoke')}</Button> },
        ]} />
      </AsyncContent>
    </Card>
  </>;
}
