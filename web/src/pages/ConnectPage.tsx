import { Button, Card, QRCode, Space, Typography } from 'antd';
import { useAsync } from '../hooks/useAsync';
import { useI18n } from '../useI18n';

export default function ConnectPage() {
  const { t } = useI18n();
  const client = useAsync(async () => (await fetch('/client/', { method: 'HEAD' })).ok, []);
  const origin = window.location.origin;
  return <main style={{ maxWidth: 560, margin: '48px auto', padding: 16 }}>
    <Card title="OpenLogTool">
      <Typography.Title level={3}>{t('connect.title')}</Typography.Title>
      <Typography.Paragraph>{t('connect.description')}</Typography.Paragraph>
      <Typography.Paragraph copyable={{ text: `${origin}/connect` }}>{origin}</Typography.Paragraph>
      <div style={{ display: 'flex', justifyContent: 'center', margin: '24px 0' }}><QRCode value={`${origin}/connect`} size={220} /></div>
      <Space wrap>
        {client.data && <Button type="primary" href="/client/">{t('connect.webClient')}</Button>}
        <Button href="/app">{t('nav.memberPortal')}</Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: 20 }}>{t('connect.native')}</Typography.Paragraph>
    </Card>
  </main>;
}
