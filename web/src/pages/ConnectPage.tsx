import { Alert, Button, Card, Modal, QRCode, Space, Typography } from 'antd';
import { useAsync } from '../hooks/useAsync';
import { useI18n } from '../useI18n';
import { clientConnectionUrl } from '../utils/clientConnection';

export default function ConnectPage() {
  const { t } = useI18n();
  const client = useAsync(async () => {
    const response = await fetch('/api/v1/server-info', { credentials: 'omit' });
    if (!response.ok) throw new Error(t('error.default'));
    return await response.json() as { webClientUrl?: string };
  }, []);
  const [modal, modalContext] = Modal.useModal();
  const origin = window.location.origin;
  const destination = clientConnectionUrl(client.data?.webClientUrl ?? '', origin);
  const openClient = () => {
    if (!destination) return;
    modal.confirm({ title: t('connect.leaveTitle'), okText: t('connect.continue'), cancelText: t('common.cancel'),
      content: <><Typography.Paragraph>{t('connect.leaveHint')}</Typography.Paragraph>
        <Typography.Paragraph copyable>{destination}</Typography.Paragraph>
        <Typography.Paragraph>{t('connect.noCredentials')}</Typography.Paragraph></>,
      onOk: () => { window.open(destination, '_blank', 'noopener,noreferrer'); },
    });
  };
  return <main style={{ maxWidth: 560, margin: '48px auto', padding: 16 }}>
    {modalContext}
    <Card title="OpenLogTool">
      <Typography.Title level={3}>{t('connect.title')}</Typography.Title>
      <Typography.Paragraph>{t('connect.description')}</Typography.Paragraph>
      <Typography.Paragraph copyable={{ text: `${origin}/connect` }}>{origin}</Typography.Paragraph>
      <div style={{ display: 'flex', justifyContent: 'center', margin: '24px 0' }}><QRCode value={`${origin}/connect`} size={220} /></div>
      <Space wrap>
        {destination && <Button type="primary" onClick={openClient}>{t('connect.webClient')}</Button>}
        <Button href="/app">{t('nav.memberPortal')}</Button>
      </Space>
      {!client.loading && !destination && <Alert type="info" showIcon message={t('connect.notConfigured')} style={{ marginTop: 16 }} />}
      <Typography.Paragraph type="secondary" style={{ marginTop: 20 }}>{t('connect.native')}</Typography.Paragraph>
    </Card>
  </main>;
}
