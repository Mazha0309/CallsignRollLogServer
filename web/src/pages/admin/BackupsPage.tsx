import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import { adminApi, type DatabaseRestorePreview } from '../../api';
import { PageHeader } from '../../components/PageHeader';
import { AsyncContent } from '../../components/AsyncContent';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';

export default function BackupsPage() {
  const { t } = useI18n();
  const status = useAsync(adminApi.recoveryStatus, []);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DatabaseRestorePreview | null>(null);
  const [action, setAction] = useState<'backup' | 'preview' | 'restore' | 'safety' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(false);
  const [mutationId, setMutationId] = useState('');
  const [form] = Form.useForm();
  const open = (next: typeof action) => { form.resetFields(); setError(''); setAction(next); };
  const submit = async () => {
    if (busy) return;
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setBusy(true); setError('');
    try {
      await adminApi.elevate(values.password);
      if (action === 'backup') await adminApi.downloadBackup(values.reason.trim());
      else if (action === 'safety') await adminApi.downloadSafetyBackup(values.reason.trim());
      else if (action === 'preview' && file) {
        const result = await adminApi.previewRestore(file);
        setPreview(result); setMutationId(crypto.randomUUID());
      } else if (action === 'restore' && preview) {
        await adminApi.confirmRestore(preview, values.reason.trim(), values.confirmation, mutationId);
        setQueued(true); setPreview(null);
      }
      setAction(null); form.resetFields();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <><PageHeader title={t('backup.title')} />
    <Alert showIcon type="info" title={t('backup.scope')} style={{ marginBottom: 16 }} />
    {queued ? <Card className="surface"><Alert showIcon type="warning" title={t('backup.queued')} description={t(status.data?.automaticRestart ? 'backup.restartAuto' : 'backup.restartManual')} /><Typography.Paragraph>{t('backup.reconnect')}</Typography.Paragraph><Button href="/login">{t('auth.login')}</Button></Card>
      : <AsyncContent loading={status.loading} error={status.error} onRetry={status.reload}>
        {status.data?.lastResult && <Alert showIcon style={{ marginBottom: 16 }} type={status.data.lastResult.status === 'completed' ? 'success' : 'error'}
          title={t(status.data.lastResult.status === 'completed' ? 'backup.completed' : 'backup.failed')}
          description={`${status.data.lastResult.finishedAt}${status.data.lastResult.error ? ' · ' + status.data.lastResult.error : ''}`} />}
        <div className="content-grid">
          <Card className="surface" title={t('admin.backup')}>
            <Typography.Paragraph>{t('backup.downloadHint')}</Typography.Paragraph>
            <Space wrap><Button type="primary" icon={<DownloadOutlined />} disabled={status.data?.pending} onClick={() => open('backup')}>{t('admin.downloadBackup')}</Button>
              {status.data?.lastResult?.safetyBackup && <Button icon={<DownloadOutlined />} onClick={() => open('safety')}>{t('backup.safety')}</Button>}</Space>
          </Card>
          <Card className="surface" title={t('backup.restore')}>
            <Alert showIcon type="warning" title={t('backup.restoreWarning')} style={{ marginBottom: 16 }} />
            <Typography.Paragraph>{t('backup.compatibility')}</Typography.Paragraph>
            {!status.data?.restoreAvailable && <Alert type="info" title={t('backup.unavailable')} />}
            <Space orientation="vertical" style={{ width: '100%' }}>
              <label>{t('backup.file')}<input aria-label={t('backup.file')} type="file" accept=".db,.sqlite,.sqlite3" disabled={!status.data?.restoreAvailable || status.data.pending}
                onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(''); }} /></label>
              {file && file.size > (status.data?.maxBytes ?? 0) && <Alert type="error" title={t('backup.tooLarge')} />}
              <Button icon={<UploadOutlined />} disabled={!file || !status.data?.restoreAvailable || status.data.pending || file.size > status.data.maxBytes} onClick={() => open('preview')}>{t('backup.validate')}</Button>
            </Space>
          </Card>
        </div>
        {preview && <Card className="surface" title={t('backup.preview')} style={{ marginTop: 16 }}>
          <Descriptions column={1} items={[
            { key: 'counts', label: t('backup.contents'), children: t('backup.counts', { users: preview.users, sessions: preview.sessions, logs: preview.logs }) },
            { key: 'schema', label: t('backup.schema'), children: preview.schemaVersion },
            { key: 'size', label: t('backup.size'), children: `${(preview.bytes / 1024 / 1024).toFixed(2)} MiB` },
            { key: 'hash', label: 'SHA-256', children: <Typography.Text copyable style={{ overflowWrap: 'anywhere' }}>{preview.sha256}</Typography.Text> },
            { key: 'admin', label: t('backup.admin'), children: preview.adminUsername },
            { key: 'expiry', label: t('backup.expires'), children: preview.expiresAt },
          ]} />
          <Button danger type="primary" disabled={status.data?.pending} onClick={() => open('restore')}>{t('backup.restore')}</Button>
        </Card>}
      </AsyncContent>}
    <Modal open={action !== null} title={t(action === 'restore' ? 'backup.restore' : 'admin.reauthenticateHint')} confirmLoading={busy} closable={!busy} mask={{ closable: false }}
      cancelButtonProps={{ disabled: busy }} okButtonProps={{ danger: action === 'restore' }} okText={t(action === 'restore' ? 'backup.restore' : 'common.confirm')} cancelText={t('common.cancel')}
      onCancel={() => { setAction(null); form.resetFields(); }} onOk={submit}>
      {action === 'restore' && <Alert showIcon type="warning" title={t('backup.restoreWarning')} description={t(status.data?.automaticRestart ? 'backup.restartAuto' : 'backup.restartManual')} style={{ marginBottom: 16 }} />}
      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical">
        <Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
        {action !== 'preview' && <Form.Item name="reason" label={t('admin.reason')} rules={[{ required: true }, { min: 3 }, { max: 1000 }, { validator: async (_, value) => { if ((value ?? '').trim().length < 3) throw new Error(t('admin.reason')); } }]}><Input.TextArea rows={3} /></Form.Item>}
        {action === 'restore' && <Form.Item name="confirmation" label={t('backup.confirm')} rules={[{ required: true }, { pattern: /^RESTORE$/, message: t('backup.confirm') }]}><Input autoComplete="off" placeholder="RESTORE" /></Form.Item>}
      </Form>
    </Modal>
  </>;
}
