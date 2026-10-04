import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Form, List, Modal, Popconfirm, Select, Space, Tabs, Tag, message } from 'antd';
import { ApiError, serverApi, socialApi } from '../../api';
import { useAuth } from '../../AuthContext';
import { useAsync } from '../../hooks/useAsync';
import { useI18n } from '../../useI18n';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { FriendSearch } from '../../components/FriendSearch';
import { SessionJoinSettings } from '../../components/SessionJoinSettings';
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
  const server = useAsync(serverApi.info);
  const supportsDirectJoin = server.data?.features?.includes('friendDirectJoin') === true;
  const [messages, holder] = message.useMessage();
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<FriendSession | null>(null);
  const [tab, setTab] = useState('friends');
  const [inviteForm] = Form.useForm<{ username?: string; role: 'editor' | 'viewer' }>();
  const pending = useRef(new Map<string, string>());
  const running = useRef(false);
  const generation = useRef(0);
  const reload = state.reload;
  useEffect(() => { const lifecycle = generation; lifecycle.current++; return () => { lifecycle.current++; }; }, []);
  useEffect(() => user?.id ? subscribeSocialUpdates({ userId: user.id, ticket: socialApi.ticket, invalidate: reload }) : undefined, [user?.id, reload]);
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
      reload();
      messages.success(t('socialDone'));
      return true;
    } catch (error) {
      if (current === generation.current) {
        const code = error instanceof ApiError ? error.code : '';
        messages.error(code === 'USER_NOT_FOUND' ? t('socialErrorUser') : code === 'FRIEND_REQUIRED' ? t('socialErrorFriends') : code === 'FRIEND_SELF' ? t('socialErrorSelf') : code === 'FRIEND_BLOCKED' ? t('socialErrorBlocked') : code === 'REQUEST_CLOSED' ? t('socialErrorClosed') : code === 'APPROVAL_REQUIRED' ? t('socialJoinApprovalRequired') : error instanceof ApiError ? error.message : t('error.default'));
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
  const requestRow = (r: SocialRequest) => {
    const inbound = r.recipientId === user?.id;
    const subject = r.kind === 'invitation' ? r.recipientId : r.senderId;
    return <List.Item key={r.id} actions={[r.status === 'pending' ? <Space key="actions" wrap>
        {inbound ? <><Button type="primary" disabled={busy} onClick={() => respond(r, 'accept')}>{t('socialAccept')}</Button><Button disabled={busy} onClick={() => respond(r, 'reject')}>{t('socialReject')}</Button></>
          : <><span>{t('socialPending')}</span><Button disabled={busy} onClick={() => respond(r, 'cancel')}>{t('common.cancel')}</Button></>}
      </Space> : r.sessionId && subject === user?.id ? <Button key="open" onClick={() => open(r.sessionId!)}>{t('socialOpen')}</Button> : <span key="accepted">{t('socialAccepted')}</span>]}>
      <List.Item.Meta title={`${t(!r.kind ? 'socialFriendRequest' : r.kind === 'invitation' ? 'socialInvitation' : 'socialApplication')} · ${inbound ? r.senderUsername : r.recipientUsername}`}
        description={<>{t(inbound ? 'socialReceived' : 'socialSent')}{r.sessionTitle && <> · {r.sessionTitle} · {t(r.role === 'editor' ? 'socialEdit' : 'socialView')}</>}</>} />
    </List.Item>;
  };
  return <>
    {holder}
    <PageHeader title={t('socialTitle')} description={t('socialIntro')} actions={<Button icon={<ReloadOutlined />} loading={state.loading} disabled={busy} onClick={() => { server.reload(); reload(); }}>{t('common.refresh')}</Button>} />
    <AsyncContent loading={state.loading && !state.data} error={state.error} onRetry={reload}>
      <Tabs className="detail-tabs" activeKey={tab} onChange={setTab} items={[
        { key: 'friends', label: t('socialFriends'), children: <div className="social-workspace">
          <FriendSearch dashboard={state.data} userId={user?.id} busy={busy || state.loading} onSend={username => mutate('POST', '/friend-requests', { username })} onReview={() => { setTab('messages'); reload(); }} />
          <Card className="surface" title={`${t('socialFriends')} (${state.data?.friends.length ?? 0})`}>
            <List className="social-list" dataSource={state.data?.friends ?? []} rowKey="userId"
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('socialNoFriends')} /> }}
              renderItem={f => <List.Item actions={[<Space key="actions" wrap>
                <Popconfirm title={t('socialRemove')} description={t('socialRemoveHint')} onConfirm={() => mutate('DELETE', `/friends/${encodeURIComponent(f.userId)}`)}><Button disabled={busy}>{t('socialRemove')}</Button></Popconfirm>
                <Popconfirm title={t('socialBlock')} description={t('socialRemoveHint')} onConfirm={() => mutate('PUT', `/blocks/${encodeURIComponent(f.username)}`)}><Button disabled={busy}>{t('socialBlock')}</Button></Popconfirm>
              </Space>]}><List.Item.Meta title={f.username} /></List.Item>} />
          </Card>
          {!!state.data?.blocks.length && <Card className="surface" title={t('socialBlocked')}>
            <List className="social-list" dataSource={state.data.blocks} rowKey="userId" renderItem={f => <List.Item actions={[
              <Button key="unblock" disabled={busy} onClick={() => mutate('DELETE', `/blocks/${encodeURIComponent(f.username)}`)}>{t('socialUnblock')}</Button>,
            ]}><List.Item.Meta title={f.username} /></List.Item>} />
          </Card>}
        </div> },
        { key: 'messages', label: `${t('socialMessages')}${incoming ? ` (${incoming})` : ''}`, children: <Card className="surface" title={t('socialMessages')}>
          <List className="social-list" dataSource={rows} rowKey="id" renderItem={requestRow}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('socialNoMessages')} /> }} />
        </Card> },
        { key: 'sessions', label: t('socialSessions'), children: <div className="social-workspace">
          <Alert type="info" showIcon title={t(supportsDirectJoin ? 'socialJoinVisibilityHint' : 'socialVisibilityHint')} />
          <Card className="surface" title={t('socialSessions')}>
            <List className="social-list" dataSource={state.data?.sessions ?? []} rowKey="sessionId"
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('socialNoSessions')} /> }}
              renderItem={s => {
                const owned = s.ownerId === user?.id;
                const direct = supportsDirectJoin && s.visibility === 'friends' && s.joinPolicy === 'direct';
                return <List.Item actions={[<Space key="actions" wrap>
                  {owned && <>
                    <SessionJoinSettings session={s} supported={supportsDirectJoin} busy={busy} onSave={access => mutate('PUT', `/sessions/${encodeURIComponent(s.sessionId)}`, { ...access })} />
                    <Button onClick={() => open(s.sessionId)}>{t('socialManage')}</Button>
                  </>}
                  {!owned && direct
                    ? <Button type="primary" disabled={busy} onClick={async () => { if (await mutate('POST', `/sessions/${encodeURIComponent(s.sessionId)}/join`)) open(s.sessionId); }}>{t('socialJoinButton')}</Button>
                    : <Button disabled={busy || (owned ? !state.data?.friends.length : rows.some(r => r.sessionId === s.sessionId && r.status === 'pending'))} onClick={() => { inviteForm.setFieldsValue({ username: state.data?.friends[0]?.username, role: 'editor' }); setInvite(s); }}>{t(owned ? 'socialInvite' : 'socialApply')}</Button>}
                </Space>]}><List.Item.Meta title={s.title} description={<Space wrap>
                  <span>{s.ownerUsername}</span>
                  <Tag>{t(s.visibility === 'private' ? 'socialJoinInvite' : direct ? 'socialJoinDirect' : 'socialJoinApproval')}</Tag>
                  {direct && <span>{t('socialJoinGrant', { role: t(s.defaultRole === 'editor' ? 'socialEdit' : 'socialView') })}</span>}
                </Space>} /></List.Item>;
              }} />
          </Card>
        </div> },
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
