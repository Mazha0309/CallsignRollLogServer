import { CopyOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Card, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ApiError, archiveApi } from '../../api';
import { AsyncContent } from '../../components/AsyncContent';
import { PageHeader } from '../../components/PageHeader';
import { useAsync } from '../../hooks/useAsync';
import type { AvailableArchiveSourceSession, PublicArchiveListUser, PublicArchiveSession } from '../../types';
import { useI18n } from '../../useI18n';
import { archiveAliasPublicUrl, archiveListPublicUrl } from '../../utils/publicArchiveUrls';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : fallback;
}

export default function PublicArchiveListDetailPage() {
  const { listId = '' } = useParams();
  const { t, locale } = useI18n();
  const [messageApi, contextHolder] = message.useMessage();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [source, setSource] = useState<'personal' | 'collaboration'>();
  const [availablePage, setAvailablePage] = useState(1);
  const [selectedSession, setSelectedSession] = useState<AvailableArchiveSourceSession | null>(null);
  const [candidateKind, setCandidateKind] = useState<'members' | 'sources'>('members');
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidateId, setCandidateId] = useState<{ members?: string; sources?: string }>({});
  const [username, setUsername] = useState({ members: '', sources: '' });
  const detail = useAsync(() => archiveApi.detail(listId), [listId]);
  const available = useAsync(() => pickerOpen ? archiveApi.availableSessions(listId, { page: availablePage, pageSize: 25, source }) : Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 }), [listId, pickerOpen, availablePage, source]);
  const canManageAccounts = Boolean(detail.data?.capabilities.canManageAccounts);
  const members = useAsync(() => canManageAccounts ? archiveApi.members(listId) : Promise.resolve([]), [listId, canManageAccounts]);
  const sources = useAsync(() => canManageAccounts ? archiveApi.sources(listId) : Promise.resolve([]), [listId, canManageAccounts]);
  const candidates = useAsync(() => canManageAccounts ? archiveApi.candidateAccounts(listId, { kind: candidateKind, page: 1, pageSize: 25, q: candidateQuery }) : Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 }), [listId, canManageAccounts, candidateKind, candidateQuery]);
  useEffect(() => setSelectedSession(null), [pickerOpen, source, availablePage, available.data]);
  const reload = () => detail.reload();
  const mutate = async (action: () => Promise<unknown>) => { try { await action(); reload(); members.reload(); sources.reload(); } catch (error) { messageApi.error(errorMessage(error, t('error.default'))); } };
  const copy = async (path: string) => { try { await window.navigator.clipboard.writeText(`${window.location.origin}${path}`); messageApi.success(t('common.copied')); } catch { messageApi.error(t('error.default')); } };

  return <>{contextHolder}<PageHeader title={detail.data?.title ?? t('archives.detailTitle')} actions={<Link to="/app/public-archives">{t('archives.backToLists')}</Link>} />
    <AsyncContent loading={detail.loading} error={detail.error} onRetry={reload}>
      {detail.data && (() => {
        const list = detail.data;
        const publicUrl = list.displayAlias ? archiveAliasPublicUrl(list.displayAlias) : archiveListPublicUrl(list.id);
        const canManageContents = list.capabilities.canManageContents;
        const accountCard = (kind: 'members' | 'sources', rows: PublicArchiveListUser[]) => <Card className="surface" title={kind === 'members' ? t('archives.members') : t('archives.sources')}>
          <Space.Compact style={{ width: '100%', marginBottom: 12 }}><Select showSearch value={candidateKind === kind ? candidateId[kind] : undefined} filterOption={false} onSearch={(value) => { setCandidateKind(kind); setCandidateQuery(value); setCandidateId((current) => ({ ...current, [kind]: undefined })); }} onChange={(value) => { setCandidateKind(kind); setCandidateId((current) => ({ ...current, [kind]: value })); }} options={(candidateKind === kind ? candidates.data?.items ?? [] : []).map((item) => ({ value: item.userId, label: item.username }))} placeholder={t('archives.searchAccounts')} /><Button disabled={!candidateId[kind]} onClick={() => void mutate(() => kind === 'members' ? archiveApi.addMember(listId, candidateId.members!) : archiveApi.addSource(listId, candidateId.sources!))}>{t('archives.add')}</Button></Space.Compact>
          <Space.Compact style={{ width: '100%', marginBottom: 12 }}><Input aria-label={t('archives.addByExactUsername')} value={username[kind]} onChange={(event) => setUsername((current) => ({ ...current, [kind]: event.target.value }))} /><Button disabled={!username[kind].trim()} onClick={() => void mutate(async () => { if (kind === 'members') await archiveApi.addMemberByUsername(listId, username.members.trim()); else await archiveApi.addSourceByUsername(listId, username.sources.trim()); setUsername((current) => ({ ...current, [kind]: '' })); })}>{t('archives.addUsername')}</Button></Space.Compact>
          <Table<PublicArchiveListUser> rowKey="userId" size="small" dataSource={rows} pagination={false} columns={[{ title: t('archives.username'), dataIndex: 'username' }, { title: t('common.actions'), render: (_: unknown, row) => <Button danger onClick={() => void mutate(() => kind === 'members' ? archiveApi.removeMember(listId, row.userId) : archiveApi.removeSource(listId, row.userId))}>{t('common.delete')}</Button> }]} />
        </Card>;
        return <Space orientation="vertical" size="large" style={{ width: '100%' }}><Card className="surface"><Space wrap><Typography.Text>{t('archives.owner')}: <span>{list.ownerUsername}</span></Typography.Text><Tag color={list.isPublished ? 'green' : 'default'}>{list.isPublished ? t('archives.published') : t('archives.unpublished')}</Tag><Typography.Text>{list.displayAlias ?? publicUrl}</Typography.Text><Button icon={<CopyOutlined />} onClick={() => void copy(publicUrl)}>{t('archives.copyPublicLink')}</Button>{list.isPublished && <Button icon={<LinkOutlined />} href={publicUrl} target="_blank">{t('archives.openPublicPage')}</Button>}</Space></Card>
           <Card className="surface" title={t('archives.snapshots')} extra={canManageContents ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setPickerOpen(true)}>{t('archives.addClosedSession')}</Button> : undefined}><Table<PublicArchiveSession> rowKey="id" dataSource={list.sessions} pagination={false} locale={{ emptyText: t('archives.snapshotUnavailable') }} columns={[{ title: t('sessions.session'), dataIndex: 'title' }, { title: t('sessions.updatedAt'), dataIndex: 'closedAt', render: (value) => new Date(value).toLocaleString(locale) }, { title: t('common.actions'), render: (_: unknown, row) => canManageContents && <Space><Button onClick={() => void mutate(() => archiveApi.refreshSession(listId, row.id))}>{t('common.refresh')}</Button><Button disabled={list.sessions?.findIndex((item) => item.id === row.id) === 0} onClick={() => { const sessions = [...(list.sessions ?? [])]; const index = sessions.findIndex((item) => item.id === row.id); if (index > 0) { [sessions[index], sessions[index - 1]] = [sessions[index - 1], sessions[index]]; void mutate(() => archiveApi.reorderSessions(listId, sessions.map((item) => item.id))); } }}>{t('archives.moveUp')}</Button><Button disabled={list.sessions?.findIndex((item) => item.id === row.id) === (list.sessions?.length ?? 0) - 1} onClick={() => { const sessions = [...(list.sessions ?? [])]; const index = sessions.findIndex((item) => item.id === row.id); if (index < sessions.length - 1) { [sessions[index], sessions[index + 1]] = [sessions[index + 1], sessions[index]]; void mutate(() => archiveApi.reorderSessions(listId, sessions.map((item) => item.id))); } }}>{t('archives.moveDown')}</Button><Popconfirm title={t('archives.removeSnapshotConfirm')} onConfirm={() => void mutate(() => archiveApi.removeSession(listId, row.id))}><Button danger>{t('common.delete')}</Button></Popconfirm></Space> }]} /></Card>
          {canManageAccounts && <Space orientation="vertical" size="large" style={{ width: '100%' }}>{accountCard('members', members.data ?? [])}{accountCard('sources', sources.data ?? [])}</Space>}
        </Space>;
      })()}
    </AsyncContent>
    <Modal open={pickerOpen} title={t('archives.addClosedSession')} onCancel={() => setPickerOpen(false)} onOk={() => { const session = selectedSession;         if (session && available.data?.items.some((item) => item.source === session.source && item.sessionId === session.sessionId)) void mutate(async () => { await archiveApi.addSession(listId, { sourceUserId: session.ownerUserId, sourceKind: session.source, sourceSessionId: session.sessionId }); setPickerOpen(false); }); }} okButtonProps={{ disabled: !selectedSession }} okText={t('archives.add')}><Select allowClear value={source} onChange={(value) => { setSource(value); setAvailablePage(1); }} options={[{ value: 'collaboration', label: t('sessionSource.collaboration') }, { value: 'personal', label: t('sessionSource.personal') }]} style={{ width: 180, marginBottom: 16 }} /><AsyncContent loading={available.loading} error={available.error} empty={!available.loading && !available.data?.items.length} onRetry={available.reload}><Table<AvailableArchiveSourceSession> rowKey={(row) => `${row.source}:${row.sessionId}`} rowSelection={{ type: 'radio', selectedRowKeys: selectedSession ? [`${selectedSession.source}:${selectedSession.sessionId}`] : [], onChange: (_, rows) => setSelectedSession(rows[0] ?? null) }} dataSource={available.data?.items} pagination={{ current: availablePage, pageSize: 25, total: available.data?.total, onChange: (next) => setAvailablePage(next) }} columns={[{ title: t('sessions.session'), dataIndex: 'title' }, { title: t('archives.owner'), dataIndex: 'ownerUsername' }]} /></AsyncContent></Modal>
  </>;
}
