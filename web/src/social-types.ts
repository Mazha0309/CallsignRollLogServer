export interface SocialPerson { userId: string; username: string }
export interface SocialUserSearchItem extends SocialPerson {
  relationship: 'none' | 'friend' | 'outgoing' | 'incoming';
  requestId?: string;
}
export interface SocialUserSearchResult { items: SocialUserSearchItem[]; hasMore: boolean }
export interface SocialRequest {
  id: string; senderId: string; senderUsername: string; recipientId: string;
  recipientUsername: string; status: string; sessionId?: string; sessionTitle?: string;
  kind?: 'invitation' | 'application'; role?: 'editor' | 'viewer';
}
export interface FriendSession {
  sessionId: string; title: string; ownerId: string; ownerUsername: string;
  visibility: 'private' | 'friends';
  joinPolicy?: 'approval' | 'direct';
  defaultRole?: 'viewer' | 'editor';
}
export interface SocialSnapshot {
  friends: SocialPerson[]; friendRequests: SocialRequest[]; sessionRequests: SocialRequest[];
  sessions: FriendSession[]; blocks: SocialPerson[];
}
