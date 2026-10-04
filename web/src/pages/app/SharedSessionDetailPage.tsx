import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Table, Space, Modal, Form, Input, Popconfirm, message } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { accountApi, socialApi, ApiError, type LogPatch } from '../../api';
import { useAuth } from '../../AuthContext';
import { subscribeSocialUpdates } from '../../social-realtime';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import type { LogRecord, SharedSessionSummary } from '../../types';

const fields = ['time','controller','callsign','rstSent','rstRcvd','qth','device','power','antenna','height','remarks'] as const;

export default function SharedSessionDetailPage() {
  const { user } = useAuth();
  const { source, sessionId } = useParams();
  const [query] = useSearchParams();
  return <SharedRecords key={`${user?.id}:${source}:${sessionId}:${query.get('grantId')}`} />;
}
function SharedRecords() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { source = 'collaboration', sessionId = '' } = useParams();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const grantId = params.get('grantId') ?? undefined;
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{session: SharedSessionSummary; record?: LogRecord; syncId: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<LogPatch>();
  const [messages, holder] = message.useMessage();
  const alive = useRef(true);
  const pending = useRef(new Map<string,string>());
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const typedSource = source === 'personal' ? 'personal' : 'collaboration';
  const detail = useAsync(() => accountApi.sharedSession(typedSource, sessionId, grantId), [typedSource, sessionId, grantId]);
  const logs = useAsync(() => accountApi.sharedSessionLogs(typedSource, sessionId, { page, pageSize: 50, grantId, q: query || undefined }), [typedSource, sessionId, grantId, page, query]);
  const reloadDetail = detail.reload, reloadLogs = logs.reload;
  useEffect(()=> user?.id ? subscribeSocialUpdates({userId:user.id,ticket:socialApi.ticket,invalidate:()=>{reloadDetail();reloadLogs();}}):undefined,[user?.id,reloadDetail,reloadLogs]);
  const current = logs.data?.session ?? detail.data;
  const mutate = async (session: SharedSessionSummary, body: Record<string,unknown>) => {
    if(busy) return;
    setBusy(true);
    const operation=JSON.stringify([session.grantId,session.sessionId,body]);
    const key=pending.current.get(operation)??crypto.randomUUID();pending.current.set(operation,key);
    try { await accountApi.mutateSharedRecord(session,body,key); if(alive.current){pending.current.delete(operation);setEditor(null);logs.reload();detail.reload();} }
    catch(e){if(alive.current) messages.error(e instanceof ApiError ? e.message : t('error.default'));}
    finally{if(alive.current) setBusy(false);}
  };
  const open = (record?:LogRecord) => {
    if(!current?.canEditLogs) return;
    form.resetFields();
    form.setFieldsValue(record ? Object.fromEntries(fields.map(f=>[f,record[f]])) : {time:new Date().toISOString(),rstSent:'59',rstRcvd:'59'});
    setEditor({session:current,record,syncId:record?.syncId??crypto.randomUUID()});
  };
  return <>
    {holder}
    <PageHeader title={detail.error ? t('sharing.sharedSession') : detail.data?.title ?? t('sharing.sharedSession')} actions={<Space><Button onClick={()=>{detail.reload();logs.reload();}}>{t('common.refresh')}</Button><Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/app/sessions')}>{t('nav.sessions')}</Button></Space>} />
    <AsyncContent loading={detail.loading} error={detail.error} onRetry={detail.reload}>
      <Card className="surface" style={{ marginBottom: 16 }}>
        <Descriptions column={2}>
          <Descriptions.Item label={t('sharing.grantor')}>{detail.data?.grantorUsername}</Descriptions.Item>
          <Descriptions.Item label={t('common.status')}>{detail.data?.status}</Descriptions.Item>
        </Descriptions>
      </Card>
      <Card className="surface table-card" title={t('sessions.logs')} extra={<Space wrap><Input.Search allowClear placeholder={t('common.search')} onSearch={q=>{setPage(1);setQuery(q);}} />{current?.canEditLogs && <Button disabled={busy} onClick={()=>open()}>{t('common.create')}</Button>}</Space>}>
        <AsyncContent loading={logs.loading} error={logs.error} onRetry={logs.reload}>
          <Table<LogRecord> rowKey="syncId" dataSource={logs.data?.items ?? []} pagination={{current:page,pageSize:50,total:logs.data?.total,showSizeChanger:false,onChange:setPage}} scroll={{x:700}} expandable={{expandedRowRender: row => <Descriptions column={2}>{fields.map(field=><Descriptions.Item key={field} label={t(field==='time'?'common.time':`logs.${field}`)}>{row[field]}</Descriptions.Item>)}</Descriptions>}} columns={[
            { title: t('common.time'), dataIndex: 'time' },
            { title: t('logs.callsign'), dataIndex: 'callsign' },
            { title: t('logs.controller'), dataIndex: 'controller' },
            { title: t('common.actions'), render: (_,record) => <Space>{current?.canEditLogs && <Button disabled={busy} onClick={()=>open(record)}>{t('common.edit')}</Button>}{current?.canDeleteLogs && <Popconfirm title={t('common.delete')} onConfirm={()=>mutate(current,{operation:'delete',syncId:record.syncId,...(typedSource==='personal'?{expectedRevision:current.snapshotRevision}:{baseVersion:record.version})})}><Button danger disabled={busy}>{t('common.delete')}</Button></Popconfirm>}</Space> },
          ]} />
        </AsyncContent>
      </Card>
    </AsyncContent>
    <Modal open={!!editor && !logs.error && !detail.error && !!current?.canEditLogs} title={t(editor?.record?'common.edit':'common.create')} confirmLoading={busy} onCancel={()=>setEditor(null)} onOk={()=>form.submit()} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={values=>{
        if(!editor) return;
        const payload=Object.fromEntries(fields.filter(field=>!editor.record || (values[field]??null)!==(editor.record[field]??null)).map(field=>[field,values[field]??null]));
        if(editor.record && !Object.keys(payload).length){setEditor(null);return;}
        void mutate(editor.session,{operation:editor.record?'update':'create',syncId:editor.syncId,
          ...(typedSource==='personal'?{expectedRevision:editor.session.snapshotRevision}:{baseVersion:editor.record?.version??0}),
          [editor.record?'patch':'value']:payload});
      }}>{fields.map(field=><Form.Item key={field} name={field} label={t(field==='time'?'common.time':`logs.${field}`)} rules={['time','controller','callsign'].includes(field)?[{required:true}]:[]}><Input /></Form.Item>)}</Form>
    </Modal>
  </>;
}
