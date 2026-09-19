import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Table } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { accountApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { LogRecord } from '../../types';

export default function SharedSessionDetailPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { source = 'collaboration', sessionId = '' } = useParams();
  const typedSource = source === 'personal' ? 'personal' : 'collaboration';
  const detail = useAsync(() => accountApi.sharedSession(typedSource, sessionId), [typedSource, sessionId]);
  const logs = useAsync(() => accountApi.sharedSessionLogs(typedSource, sessionId, { page: 1, pageSize: 50 }), [typedSource, sessionId]);
  return <>
    <PageHeader title={detail.data?.title ?? t('sharing.sharedSession')} actions={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/app/sessions')}>{t('nav.sessions')}</Button>} />
    <AsyncContent loading={detail.loading} error={detail.error} onRetry={detail.reload}>
      <Card className="surface" style={{ marginBottom: 16 }}>
        <Descriptions column={2}>
          <Descriptions.Item label={t('sharing.grantor')}>{detail.data?.grantorUsername}</Descriptions.Item>
          <Descriptions.Item label={t('common.status')}>{detail.data?.status}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card className="surface table-card" title={t('sessions.logs')}>
        <AsyncContent loading={logs.loading} error={logs.error} empty={!logs.loading && !(logs.data?.items.length)} onRetry={logs.reload}>
          <Table<LogRecord> rowKey="syncId" dataSource={logs.data?.items ?? []} pagination={false} columns={[
            { title: t('common.time'), dataIndex: 'time' },
            { title: t('logs.callsign'), dataIndex: 'callsign' },
            { title: t('logs.controller'), dataIndex: 'controller' },
          ]} />
        </AsyncContent>
      </Card>
    </AsyncContent>
  </>;
}
