import { Button, Alert, Modal, Radio, Space, Typography } from 'antd';
import { useState } from 'react';
import type { FriendSession } from '../social-types';
import { useI18n } from '../useI18n';

export interface SessionJoinAccess {
  visibility: 'private' | 'friends';
  joinPolicy?: 'approval' | 'direct';
  defaultRole?: 'viewer' | 'editor';
}

export function SessionJoinSettings({ session, supported, busy, onSave }: {
  session: FriendSession;
  supported: boolean;
  busy: boolean;
  onSave: (access: SessionJoinAccess) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'private' | 'approval' | 'direct'>('private');
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');
  return <>
    <Button disabled={busy || (!supported && session.joinPolicy === 'direct')} onClick={() => {
      setMode(session.visibility === 'private' ? 'private' : session.joinPolicy === 'direct' ? 'direct' : 'approval');
      setRole(session.defaultRole ?? 'viewer');
      setOpen(true);
    }}>{t('socialJoinSettings')}</Button>
    <Modal open={open} title={`${t('socialJoinSettings')} · ${session.title}`} confirmLoading={busy}
      okText={t('common.save')} cancelText={t('common.cancel')}
      onCancel={() => { if (!busy) setOpen(false); }}
      onOk={async () => {
        if (mode === 'direct' && !supported) return;
        const access: SessionJoinAccess = { visibility: mode === 'private' ? 'private' : 'friends' };
        // Older servers reject unknown fields. Never send new settings without
        // their advertised capability, and never enable direct joins by default.
        if (supported) {
          access.joinPolicy = mode === 'direct' ? 'direct' : 'approval';
          access.defaultRole = role;
        }
        if (await onSave(access)) setOpen(false);
      }}>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('socialJoinDefaultHint')}</Typography.Text>
        <Radio.Group aria-label={t('socialJoinSettings')} value={mode} disabled={busy} onChange={event => setMode(event.target.value)}>
          <Space orientation="vertical">
            <Radio value="private">{t('socialJoinInvite')}</Radio>
            <Radio value="approval">{t('socialJoinApproval')}</Radio>
            {supported && <Radio value="direct">{t('socialJoinDirect')}</Radio>}
          </Space>
        </Radio.Group>
        {mode === 'direct' && supported && <>
          <Alert type="warning" showIcon title={t('socialJoinDirectWarning')} />
          <Typography.Text strong>{t('socialJoinRole')}</Typography.Text>
          <Radio.Group aria-label={t('socialJoinRole')} value={role} disabled={busy} onChange={event => setRole(event.target.value)}>
            <Space wrap><Radio value="viewer">{t('socialView')}</Radio><Radio value="editor">{t('socialEdit')}</Radio></Space>
          </Radio.Group>
          <Typography.Text type="secondary">{t('socialJoinRoleHint')}</Typography.Text>
        </>}
      </Space>
    </Modal>
  </>;
}
