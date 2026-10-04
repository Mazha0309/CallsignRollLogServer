import { SearchOutlined, UserAddOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Input, List, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { socialApi } from '../api';
import type { SocialSnapshot, SocialUserSearchItem, SocialUserSearchResult } from '../social-types';
import { useI18n } from '../useI18n';

interface Props {
  dashboard: SocialSnapshot | null;
  userId: string | undefined;
  busy: boolean;
  onSend: (username: string) => Promise<boolean>;
  onReview: () => void;
}

/** The enclosing workspace is keyed by account: no search survives sign-out. */
export function FriendSearch({ dashboard, userId, busy, onSend, onReview }: Props) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [result, setResult] = useState<{
    response: SocialUserSearchResult;
    dashboardAtStart: SocialSnapshot | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<'length' | 'failed' | null>(null);
  const sequence = useRef(0);

  const search = useCallback(async (query: string) => {
    const current = ++sequence.current;
    setResult(null);
    setError(null);
    setLoading(true);
    try {
      const response = await socialApi.searchUsers(query);
      if (current === sequence.current) setResult({ response, dashboardAtStart: dashboard });
    } catch {
      if (current === sequence.current) setError('failed');
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [dashboard]);

  useEffect(() => () => { sequence.current++; }, []);
  // WS updates refresh the dashboard, not this rate-limited identity search.
  // A snapshot received after the search started wins even if an older search
  // response arrives later. Before that, the search response is more recent
  // than the dashboard that was already present when the user pressed Search.
  const blockedIds = new Set(dashboard?.blocks.map(person => person.userId));
  const items = result?.response.items.filter(person => !blockedIds.has(person.userId))
    .map((person): SocialUserSearchItem => {
      if (!dashboard || dashboard === result.dashboardAtStart) return person;
      const friend = dashboard.friends.some(friend => friend.userId === person.userId);
      const request = dashboard.friendRequests.find(request => request.status === 'pending' && (
        (request.senderId === userId && request.recipientId === person.userId) ||
        (request.recipientId === userId && request.senderId === person.userId)
      ));
      return {
        userId: person.userId,
        username: person.username,
        relationship: friend ? 'friend' : !request ? 'none' : request.senderId === userId ? 'outgoing' : 'incoming',
        ...(request && !friend ? { requestId: request.id } : {}),
      };
    });

  const submit = () => {
    const query = input.trim();
    const length = Array.from(query).length;
    if (length < 2 || length > 64) {
      sequence.current++;
      setResult(null);
      setLoading(false);
      setError('length');
      return;
    }
    void search(query);
  };

  return <Card className="surface" title={t('socialAddFriend')}>
    <Typography.Paragraph type="secondary">{t('socialSearchHint')}</Typography.Paragraph>
    <Input.Search
      className="social-search-input"
      aria-label={t('socialSearchPlaceholder')}
      aria-invalid={error === 'length'}
      placeholder={t('socialSearchPlaceholder')}
      prefix={<SearchOutlined />}
      enterButton={t('common.search')}
      allowClear
      maxLength={64}
      value={input}
      loading={loading}
      onChange={event => {
        // Editing invalidates old results immediately, even before a new search.
        sequence.current++;
        setInput(event.target.value);
        setResult(null);
        setLoading(false);
        setError(null);
      }}
      onSearch={(_, __, info) => { if (info?.source !== 'clear') submit(); }}
    />
    <div className="social-search-results" aria-live="polite" aria-busy={loading}>
      {error && <Alert type={error === 'length' ? 'info' : 'error'} showIcon title={t(error === 'length' ? 'socialSearchLength' : 'socialSearchFailed')}
        action={error === 'failed' ? <Button size="small" onClick={submit}>{t('common.retry')}</Button> : undefined} />}
      {result && <>
        <List className="social-list" dataSource={items} rowKey="userId"
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('socialSearchEmpty')} /> }}
          renderItem={person => <List.Item actions={[
            person.relationship === 'none'
              ? <Button key="send" type="primary" icon={<UserAddOutlined />} disabled={busy} onClick={() => void onSend(person.username)}>{t('socialSend')}</Button>
              : person.relationship === 'incoming'
                ? <Button key="review" onClick={onReview}>{t('socialReviewRequest')}</Button>
                : <Tag key="status" color={person.relationship === 'friend' ? 'success' : 'processing'}>{t(person.relationship === 'friend' ? 'socialAlreadyFriends' : 'socialRequestSent')}</Tag>,
          ]}>
            <List.Item.Meta title={<Typography.Text strong>{person.username}</Typography.Text>}
              description={person.relationship === 'incoming' ? <Space><Tag>{t('socialRequestReceived')}</Tag></Space> : undefined} />
          </List.Item>}
        />
        {result.response.hasMore && <Typography.Paragraph type="secondary">{t('socialSearchMore')}</Typography.Paragraph>}
      </>}
    </div>
  </Card>;
}
