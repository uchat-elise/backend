export interface User {
  id: string;
  email: string;
  username: string;
  displayName?: string | null;
  profilePicture?: string | null;
  passwordHash: string;
  emailVerified: boolean;
  lastSeen?: string | null;
  hideLastSeen?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FriendRequestStatus = "pending" | "accepted" | "rejected";

export interface FriendRequest {
  id: string;
  senderId: string;
  receiverId: string;
  status: FriendRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  attachments?: any;
  voiceNote?: boolean;
  voiceDuration?: number | null;
  unsent?: boolean;
  createdAt: string;
  status?: MessageStatus;
  starred?: boolean;
  reactions?: Record<string, number>;
  replyTo?: string | null;
  readBy?: string[]; // list of user IDs who have read this message
}
