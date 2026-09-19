import { Tag } from 'antd';
import type { AccountSessionSource, SessionRole, SessionStatus } from '../types';
import { useI18n } from '../useI18n';

export function SessionStatusTag({ status }: { status: SessionStatus | string }) {
  const { t } = useI18n();
  const color = status === 'active' ? 'green' : status === 'initializing' ? 'blue' : status === 'deleted' ? 'red' : 'default';
  const key = status === 'active' ? 'session.active' : status === 'initializing' ? 'session.initializing'
    : status === 'deleted' ? 'session.deleted' : status === 'archived' ? 'session.archived' : 'session.closed';
  return <Tag color={color}>{t(key)}</Tag>;
}

export function SessionSourceTag({ source }: { source: AccountSessionSource }) {
  const { t } = useI18n();
  const color = source === 'collaboration' ? 'purple' : source === 'shared' ? 'orange' : 'cyan';
  return <Tag color={color}>{t(`sessionSource.${source}`)}</Tag>;
}

export function SessionRoleTag({ role }: { role: SessionRole }) {
  const { t } = useI18n();
  return <Tag color={role === 'owner' ? 'gold' : role === 'editor' ? 'blue' : 'default'}>{t(`role.${role}`)}</Tag>;
}
