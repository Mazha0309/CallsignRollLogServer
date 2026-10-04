import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Tabs, Typography, message } from 'antd';
import { ApiError, socialApi } from '../../api';
import { useAuth } from '../../AuthContext';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import type { FriendSession, SocialRequest } from '../../social-types';
import { subscribeSocialUpdates } from '../../social-realtime';

export default function FriendsPage() {
  const { user } = useAuth();
  return <FriendWorkspace key={user?.id} />;
}

function FriendWorkspace() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const state = useAsync(socialApi.dashboard, [user?.id]);
  const [messages, holder] = message.useMessage();
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<FriendSession | null>(null);
  const [form] = Form.useForm<{ username: string }>();
  const [inviteForm] = Form.useForm<{ username?: string; role: 'editor' | 'viewer' }>();
  const pending = useRef(new Map<string, string>());
  const running = useRef(false);
  const generation = useRef(0);
  useEffect(() => { const lifecycle = generation; lifecycle.current++; return () => { lifecycle.current++; }; }, []);
  useEffect(() => user?.id ? subscribeSocialUpdates({ userId: user.id, ticket: socialApi.ticket, invalidate: state.reload }) : undefined, [user?.id, state.reload]);
  const mutate = async (method: 'POST' | 'PUT' | 'DELETE', path: string, body: Record<string, unknown> = {}) => {
    if (running.current) return false;
    const current = generation.current;
    const operation = JSON.stringify([method, path, body]);
    const key = pending.current.get(operation) ?? crypto.randomUUID();
    pending.current.set(operation, key);
    running.current = true;
    setBusy(true);
    try {
      await socialApi.mutate(method, path, body, key);
      if (current !== generation.current) return false;
      pending.current.delete(operation);
      state.reload();
      messages.success(t('socialDone'));
      return true;
    } catch (error) {
      if (current === generation.current) {
        const code = error instanceof ApiError ? error.code : '';
        messages.error(code === 'USER_NOT_FOUND' ? t('socialErrorUser') : code === 'FRIEND_REQUIRED' ? t('socialErrorFriends') : code === 'FRIEND_SELF' ? t('socialErrorSelf') : code === 'FRIEND_BLOCKED' ? t('socialErrorBlocked') : code === 'REQUEST_CLOSED' ? t('socialErrorClosed') : error instanceof ApiError ? error.message : t('error.default'));
      }
      return false;
    } finally { if (current === generation.current) { setBusy(false); running.current = false; } }
  };
  const open = (id: string) => navigate(`/app/sessions/collaboration/${encodeURIComponent(id)}`);
  const respond = async (r: SocialRequest, action: string) => {
    const ok = await mutate('POST', `/${r.sessionId ? 'session-requests' : 'friend-requests'}/${encodeURIComponent(r.id)}/${action}`);
    if (ok && action === 'accept' && r.kind === 'invitation' && r.sessionId) open(r.sessionId);
  };
  const rows = [...(state.data?.friendRequests ?? []), ...(state.data?.sessionRequests ?? [])];
  const incoming = rows.filter(r => r.recipientId === user?.id && r.status === 'pending').length;
  const requestCard = (r: SocialRequest) => {
    const inbound = r.recipientId === user?.id;
    const subject = r.kind === 'invitation' ? r.recipientId : r.senderId;
    return <Card key={r.id} size="small" style={{ marginBottom: 12 }} title={`${t(!r.kind ? 'socialFriendRequest' : r.kind === 'invitation' ? 'socialInvitation' : 'socialApplication')} · ${inbound ? r.senderUsername : r.recipientUsername}`}>
      <Typography.Paragraph type="secondary">{t(inbound ? 'socialReceived' : 'socialSent')}</Typography.Paragraph>
      {r.sessionTitle && <Typography.Paragraph>{r.sessionTitle} · {t(r.role === 'editor' ? 'socialEdit' : 'socialView')}</Typography.Paragraph>}
      {r.status === 'pending' ? <Space wrap>
        {inbound ? <><Button type="primary" disabled={busy} onClick={() => respond(r, 'accept')}>{t('socialAccept')}</Button><Button disabled={busy} onClick={() => respond(r, 'reject')}>{t('socialReject')}</Button></>
          : <><span>{t('socialPending')}</span><Button disabled={busy} onClick={() => respond(r, 'cancel')}>{t('common.cancel')}</Button></>}
      </Space> : r.sessionId && subject === user?.id ? <Button onClick={() => open(r.sessionId!)}>{t('socialOpen')}</Button> : t('socialAccepted')}
    </Card>;
  };
  return <>
    {holder}
    <PageHeader title={t('socialTitle')} description={t('socialIntro')} actions={<Button loading={state.loading} disabled={busy} onClick={state.reload}>{t('common.refresh')}</Button>} />
    <AsyncContent loading={state.loading && !state.data} error={state.error} onRetry={state.reload}>
      <Tabs items={[
        { key: 'friends', label: t('socialFriends'), children: <>
          <Card className="surface" title={t('socialAddFriend')} style={{ marginBottom: 16 }}>
            <Form form={form} layout="inline" onFinish={async values => { if (await mutate('POST', '/friend-requests', { username: values.username.trim() })) form.resetFields(); }}>
              <Form.Item name="username" rules={[{ required: true, whitespace: true }, { max: 64 }]}><Input aria-label={t('socialUsername')} placeholder={t('socialUsername')} maxLength={64} /></Form.Item>
              <Button type="primary" htmlType="submit" loading={busy}>{t('socialSend')}</Button>
            </Form>
          </Card>
          {!state.data?.friends.length && <Typography.Paragraph>{t('socialNoFriends')}</Typography.Paragraph>}
          {state.data?.friends.map(f => <Card key={f.userId} size="small" title={f.username} style={{ marginBottom: 12 }}><Space wrap>
            <Popconfirm title={t('socialRemove')} description={t('socialRemoveHint')} onConfirm={() => mutate('DELETE', `/friends/${encodeURIComponent(f.userId)}`)}><Button disabled={busy}>{t('socialRemove')}</Button></Popconfirm>
            <Popconfirm title={t('socialBlock')} description={t('socialRemoveHint')} onConfirm={() => mutate('PUT', `/blocks/${encodeURIComponent(f.username)}`)}><Button disabled={busy}>{t('socialBlock')}</Button></Popconfirm>
          </Space></Card>)}
          {!!state.data?.blocks.length && <Card title={t('socialBlocked')}>{state.data.blocks.map(f => <p key={f.userId}>{f.username} <Button disabled={busy} onClick={() => mutate('DELETE', `/blocks/${encodeURIComponent(f.username)}`)}>{t('socialUnblock')}</Button></p>)}</Card>}
        </> },
        { key: 'messages', label: `${t('socialMessages')}${incoming ? ` (${incoming})` : ''}`, children: rows.length ? rows.map(requestCard) : <Typography.Paragraph>{t('socialNoMessages')}</Typography.Paragraph> },
        { key: 'sessions', label: t('socialSessions'), children: <>
          <Alert type="info" showIcon title={t('socialVisibilityHint')} style={{ marginBottom: 16 }} />
          {!state.data?.sessions.length && <Typography.Paragraph>{t('socialNoSessions')}</Typography.Paragraph>}
          {state.data?.sessions.map(s => <Card key={s.sessionId} title={s.title} style={{ marginBottom: 12 }}>
            <Typography.Paragraph>{s.ownerUsername}</Typography.Paragraph>
            <Space wrap>
              {s.ownerId === user?.id && <><Switch aria-label={t('socialDiscoverable')} disabled={busy} checked={s.visibility === 'friends'} onChange={checked => mutate('PUT', `/sessions/${encodeURIComponent(s.sessionId)}`, { visibility: checked ? 'friends' : 'private' })} /><span>{t('socialDiscoverable')}</span><Button onClick={() => open(s.sessionId)}>{t('socialManage')}</Button></>}
              <Button disabled={busy || (s.ownerId === user?.id ? !state.data?.friends.length : rows.some(r => r.sessionId === s.sessionId && r.status === 'pending'))} onClick={() => { inviteForm.setFieldsValue({ username: state.data?.friends[0]?.username, role: 'editor' }); setInvite(s); }}>{t(s.ownerId === user?.id ? 'socialInvite' : 'socialApply')}</Button>
            </Space>
          </Card>)}
        </> },
      ]} />
    </AsyncContent>
    <Button type="link" onClick={() => navigate('/app/legacy-sharing')}>{t('socialLegacy')}</Button>
    <Modal open={!!invite} title={invite?.title} confirmLoading={busy} onCancel={() => { if (!busy) setInvite(null); }} onOk={async () => {
      if (!invite) return;
      const values = await inviteForm.validateFields();
      const inviting = invite.ownerId === user?.id;
      if (await mutate('POST', `/sessions/${encodeURIComponent(invite.sessionId)}/${inviting ? 'invitations' : 'applications'}`, { role: values.role, ...(inviting ? { username: values.username } : {}) })) setInvite(null);
    }}>
      <Form form={inviteForm} layout="vertical">
        {invite?.ownerId === user?.id && <Form.Item name="username" label={t('socialChooseFriend')} rules={[{ required: true }]}><Select options={state.data?.friends.map(f => ({ value: f.username, label: f.username }))} /></Form.Item>}
        <Form.Item name="role" label={t('common.role')} rules={[{ required: true }]}><Select options={[{ value: 'editor', label: t('socialEdit') }, { value: 'viewer', label: t('socialView') }]} /></Form.Item>
      </Form>
    </Modal>
  </>;
}
