import express, { type Request, type Response } from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import { type Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { activeSockets, createSocketServer, getPrivateRoomId, verifySocketAuthToken } from './socket-server';
import { getVisibleLastSeen, shouldRefreshLastSeen } from './last-seen';
import { createMessagePayload, persistMessageWithTransaction, resolveReceiverSocketId, socketUserIdMap } from './message-flow';
import { ensureDemoUsersExist } from './demo-users';
import { fetchUnreadMessages, markMessageAsRead, saveMessage } from './message-persistence';
import { resolveUserId } from './user-service';

export { ensureDemoUsersExist } from './demo-users';

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
  showOnlineStatus?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected';

export interface FriendRequest {
  id: string;
  senderId: string;
  receiverId: string;
  status: FriendRequestStatus;
  createdAt: string;
  updatedAt: string;
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageRoot = path.resolve(__dirname, '../storage');
const uploadsRoot = path.join(storageRoot, 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });

const app = express();
const server = http.createServer(app);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? process.env.SUPABASE_ANON_KEY;
const isTestRuntime = process.env.NODE_ENV === 'test'
  || process.argv.includes('--test')
  || process.execArgv.includes('--test')
  || process.argv.some((argument) => /\.test\.[cm]?[jt]sx?$/.test(argument));
if (!SUPABASE_URL || !SUPABASE_KEY) {
  const message = 'Missing required Supabase environment variables: SUPABASE_URL and SUPABASE_KEY or SUPABASE_ANON_KEY.';
  if (process.env.E2E_TEST_MODE !== 'true' && !isTestRuntime) {
    console.error(`[startup] ${message}`);
    process.exit(1);
  }
  console.warn(`[startup] ${message} Using in-memory test fallback.`);
}
const API_PORT = Number(process.env.API_PORT || process.env.PORT || 3000);
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:5173';
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || `http://localhost:${API_PORT}`).replace(/\/$/, '');
const EMAIL_VERIFICATION_ENABLED = process.env.EMAIL_VERIFICATION_ENABLED === 'true';
const USE_SUPABASE = process.env.E2E_TEST_MODE !== 'true' && Boolean(SUPABASE_URL && SUPABASE_KEY);

const supabase = USE_SUPABASE
  ? createClient(SUPABASE_URL as string, SUPABASE_KEY as string, { auth: { persistSession: false } })
  : null;

function getRequestSupabaseClient(req: Request) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return supabase;
  const authHeader = String(req.headers.authorization ?? '').trim();
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  if (!accessToken) return supabase;
  return supabase;
}

const socketServer = await createSocketServer({
  httpServer: server,
  path: '/api/socket.io',
  corsOrigin: FRONTEND_URL,
  supabaseUrl: USE_SUPABASE ? SUPABASE_URL : undefined,
  supabaseKey: USE_SUPABASE ? SUPABASE_KEY : undefined,
  supabaseServiceRoleKey: USE_SUPABASE ? process.env.SUPABASE_SERVICE_ROLE_KEY : undefined,
});
const io = socketServer.io;

const inMemoryUsers: Array<{
  id: string;
  email: string;
  username: string;
  display_name: string;
  profile_picture: string | null;
  created_at: string;
  password_hash: string;
  email_verified: boolean;
  last_seen: string | null;
  hide_last_seen: boolean;
  show_online_status?: boolean;
}> = [];

const inMemoryFriendRequests: Array<{
  id: string;
  senderId: string;
  receiverId: string;
  status: FriendRequestStatus;
  createdAt: string;
  updatedAt: string;
}> = [];

const inMemoryVerificationTokens = new Map<string, string>();
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.AUTH_SECRET || 'uchat-development-session-secret';
const JWT_SECRET_FALLBACK = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || 'uchat-development-jwt-secret';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

ensureDemoUsersExist(inMemoryUsers as Array<{
  id: string;
  email: string;
  username: string;
  display_name: string;
  profile_picture: string | null;
  created_at: string;
  password_hash: string;
  email_verified: boolean;
  last_seen: string | null;
  hide_last_seen: boolean;
}>);

function createSessionToken(userId: string, username: string) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    username,
    issuedAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `uchat_${payload}.${signature}`;
}

function createSupabaseAccessToken(user: { id: string; email: string; username: string }) {
  const secret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || JWT_SECRET_FALLBACK;
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    sub: user.id,
    email: user.email,
    username: user.username,
    role: 'authenticated',
    iss: 'supabase',
    iat: now,
    exp: now + 3600,
  }, secret, { algorithm: 'HS256' });
}

function resolveTokenSession(token: string | undefined) {
  if (!token?.startsWith('uchat_')) return null;
  const tokenBody = token.slice('uchat_'.length);
  const separator = tokenBody.lastIndexOf('.');
  if (separator <= 0) return null;

  const payload = tokenBody.slice(0, separator);
  const signature = tokenBody.slice(separator + 1);
  const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      userId?: string;
      username?: string;
      issuedAt?: string;
      expiresAt?: number;
    };
    if (!session.userId || !session.username || !session.expiresAt || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, expected] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function resolveUsernameHeader(header: string | string[] | undefined) {
  return Array.isArray(header) ? header[0] : header;
}

function getAuthenticatedUsername(req: Request): string | null {
  const authHeader = String(req.headers['authorization'] ?? '').trim();
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const xUser = resolveUsernameHeader(req.headers['x-username']);

  if (bearer) {
    const session = resolveTokenSession(bearer);
    if (session?.username) return session.username;

    try {
      const payload = jwt.verify(
        bearer,
        process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || JWT_SECRET_FALLBACK,
        { algorithms: ['HS256'] },
      ) as { username?: unknown };
      if (typeof payload.username === 'string' && payload.username) return payload.username;
    } catch {
      // Fall back to the legacy x-username header below.
    }
  }

  if (xUser) return xUser;
  return null;
}

async function getAuthenticatedUserFromRequest(req: Request, requireBearer = false) {
  const authHeader = String(req.headers.authorization ?? '').trim();
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;

  if (token) {
    const authResult = await verifySocketAuthToken({ auth: { token }, headers: {} }, supabase);
    if (authResult.ok && authResult.userId) {
      const user = await getUserById(authResult.userId);
      if (user) return user;
    }
    const session = resolveTokenSession(token);
    if (session?.userId) {
      const user = await getUserById(session.userId);
      if (user) return user;
    }
    return null;
  }

  if (requireBearer) return null;

  const username = getAuthenticatedUsername(req);
  return username ? getUserByUsername(username) : null;
}

function resolveRouteParam(param: string | string[] | undefined): string {
  return Array.isArray(param) ? (param[0] ?? '') : (param ?? '');
}

const getChatIdForUsers = (userId1: string, userId2: string) => `chat-${[userId1, userId2].sort().join('-')}`;
async function hasActivePrivateChatRelationship(userId: string, targetUserId: string) {
  if (!userId || !targetUserId || userId === targetUserId) return false;

  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('friend_requests')
      .select('id')
      .eq('status', 'accepted')
      .or(`and(sender_id.eq.${userId},receiver_id.eq.${targetUserId}),and(sender_id.eq.${targetUserId},receiver_id.eq.${userId})`)
      .limit(1);
    if (error) throw error;
    return (data ?? []).length > 0;
  }

  return inMemoryFriendRequests.some((request) => request.status === 'accepted' && (
    (request.senderId === userId && request.receiverId === targetUserId) ||
    (request.senderId === targetUserId && request.receiverId === userId)
  ));
}

async function getUserByUsername(username: string) {
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('id,email,username,display_name,profile_picture,avatar_url,password_hash,created_at,last_seen,hide_last_seen,show_online_status')
      .eq('username', username)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id,
      email: data.email,
      username: data.username,
      display_name: data.display_name,
      profile_picture: data.profile_picture ?? data.avatar_url ?? null,
      created_at: data.created_at,
      password_hash: data.password_hash,
      email_verified: false,
      last_seen: data.last_seen ?? null,
      hide_last_seen: Boolean(data.hide_last_seen),
      show_online_status: data.show_online_status !== false,
    };
  }
  return inMemoryUsers.find((user) => user.username === username) ?? null;
}

async function getUserById(id: string) {
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('id,email,username,display_name,profile_picture,avatar_url,created_at,last_seen,hide_last_seen,show_online_status')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id,
      email: data.email,
      username: data.username,
      display_name: data.display_name,
      profile_picture: data.profile_picture ?? data.avatar_url ?? null,
      created_at: data.created_at,
      password_hash: '' as string,
      email_verified: false,
      last_seen: data.last_seen ?? null,
      hide_last_seen: Boolean(data.hide_last_seen),
      show_online_status: data.show_online_status !== false,
    };
  }
  return inMemoryUsers.find((user) => user.id === id) ?? null;
}

async function resolveUserIdForBackend(value: string | null | undefined) {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue) return null;
  if (isUuid(normalizedValue)) return normalizedValue;
  if (USE_SUPABASE && supabase) return resolveUserId(supabase, normalizedValue);
  return (await getUserByUsername(normalizedValue))?.id ?? null;
}

async function updateUserLastSeen(userId: string, timestamp = new Date()) {
  if (!userId) return null;

  const existingUser = await getUserById(userId);
  if (!existingUser) return null;
  if (!shouldRefreshLastSeen(existingUser.last_seen ?? null, timestamp)) {
    return existingUser.last_seen ?? null;
  }

  const iso = timestamp.toISOString();

  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('users')
      .update({ last_seen: iso, updated_at: iso })
      .eq('id', userId)
      .select('id,last_seen')
      .maybeSingle();
    if (error) throw error;
    return data?.last_seen ?? iso;
  }

  const user = inMemoryUsers.find((candidate) => candidate.id === userId);
  if (!user) return null;
  user.last_seen = iso;
  return iso;
}

function getOnlineUsers() {
  return Array.from(activeSockets.values()).map((socket) => socket.data.username).filter(Boolean);
}

async function getFriendRequestsForUser(currentUserId: string, status?: FriendRequestStatus) {
  if (USE_SUPABASE && supabase) {
    let query = supabase.from('friend_requests').select('id,sender_id,receiver_id,status,created_at,updated_at');
    if (status) query = query.eq('status', status);
    query = query.or(`sender_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map((request: any) => ({
      id: request.id,
      senderId: request.sender_id,
      receiverId: request.receiver_id,
      status: request.status as FriendRequestStatus,
      createdAt: request.created_at,
      updatedAt: request.updated_at,
    }));
  }

  return inMemoryFriendRequests
    .filter((request) => request.senderId === currentUserId || request.receiverId === currentUserId)
    .filter((request) => (status ? request.status === status : true));
}

async function getFriendRequestById(requestId: string) {
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('friend_requests')
      .select('id,sender_id,receiver_id,status,created_at,updated_at')
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id,
      senderId: data.sender_id,
      receiverId: data.receiver_id,
      status: data.status as FriendRequestStatus,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
  return inMemoryFriendRequests.find((request) => request.id === requestId) ?? null;
}

async function getFriendRequestBetweenUsers(userAId: string, userBId: string) {
  const requests = await getFriendRequestsForUser(userAId);
  return requests.find(
    (request) =>
      (request.senderId === userAId && request.receiverId === userBId) ||
      (request.senderId === userBId && request.receiverId === userAId),
  ) ?? null;
}

async function createFriendRequest(senderId: string, receiverId: string) {
  const existing = await getFriendRequestBetweenUsers(senderId, receiverId);
  if (existing) {
    if (existing.status === 'accepted') {
      throw new Error('You are already friends with this user');
    }
    if (existing.status === 'pending') {
      throw new Error('A friend request is already pending with this user');
    }
  }

  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('friend_requests')
      .insert([{ sender_id: senderId, receiver_id: receiverId, status: 'pending' }])
      .select('id,sender_id,receiver_id,status,created_at,updated_at')
      .single();
    if (error) throw error;
    return {
      id: data.id,
      senderId: data.sender_id,
      receiverId: data.receiver_id,
      status: data.status as FriendRequestStatus,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  const request = {
    id: `request-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    senderId,
    receiverId,
    status: 'pending' as FriendRequestStatus,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  inMemoryFriendRequests.push(request);
  return request;
}

async function updateFriendRequestStatus(requestId: string, status: FriendRequestStatus) {
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('friend_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .select('id,sender_id,receiver_id,status,created_at,updated_at')
      .single();
    if (error) throw error;
    return {
      id: data.id,
      senderId: data.sender_id,
      receiverId: data.receiver_id,
      status: data.status as FriendRequestStatus,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  const request = inMemoryFriendRequests.find((item) => item.id === requestId);
  if (!request) return null;
  request.status = status;
  request.updatedAt = new Date().toISOString();
  return request;
}

export async function rejectRequest(
  requestId: string,
  currentUserId: string,
): Promise<void> {
  if (!supabase) throw new Error('Supabase client is not initialized.');

  const { data: requestData, error: fetchError } = await supabase
    .from('friend_requests')
    .select('id,sender_id,receiver_id,status')
    .eq('id', requestId)
    .single();

  if (fetchError) throw fetchError;
  if (!requestData) throw new Error('Friend request not found.');
  if (requestData.receiver_id !== currentUserId) {
    throw new Error('Not authorized to reject this request.');
  }
  if (requestData.status !== 'pending') {
    throw new Error('Only pending requests may be rejected.');
  }

  const { error: deleteError } = await supabase
    .from('friend_requests')
    .delete()
    .eq('id', requestId);

  if (deleteError) throw deleteError;
}

async function getFriendRelationship(currentUserId: string, targetUserId: string) {
  if (currentUserId === targetUserId) return 'self';
  const requests = await getFriendRequestsForUser(currentUserId);
  const related = requests.find((request) => request.senderId === targetUserId || request.receiverId === targetUserId);
  if (!related) return 'none';
  return related.status === 'accepted' ? 'friend' : 'pending';
}

async function getAcceptedFriendChats(currentUserId: string) {
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('friend_requests')
      .select('sender_id,receiver_id')
      .or(`sender_id.eq.${currentUserId},receiver_id.eq.${currentUserId}`)
      .eq('status', 'accepted');
    if (error) throw error;
    const ids = (data ?? []).flatMap((request: any) => [request.sender_id, request.receiver_id]).filter((id: string) => id !== currentUserId);
    const uniqueIds = Array.from(new Set(ids));
    const users = uniqueIds.length > 0 ? await (async () => {
      const { data: userData, error: usersError } = await supabase
        .from('users')
        .select('id,username,display_name,profile_picture,last_seen,hide_last_seen,show_online_status')
        .in('id', uniqueIds);
      if (usersError) throw usersError;
      return userData ?? [];
    })() : [];
    return users.map((user: any) => ({
      id: getChatIdForUsers(currentUserId, user.id),
      otherUser: {
        id: user.id,
        username: user.username,
        displayName: user.display_name ?? user.username,
        profilePicture: user.profile_picture ?? null,
        lastSeen: user.last_seen ?? null,
        hideLastSeen: Boolean(user.hide_last_seen),
        showOnlineStatus: user.show_online_status !== false,
      },
      online: user.show_online_status !== false && getOnlineUsers().includes(user.username),
    }));
  }

  const accepted = inMemoryFriendRequests.filter((request) => request.status === 'accepted' && (request.senderId === currentUserId || request.receiverId === currentUserId));
    return accepted.map((request) => {
    const otherUserId = request.senderId === currentUserId ? request.receiverId : request.senderId;
    const otherUser = inMemoryUsers.find((user) => user.id === otherUserId);
    return {
      id: getChatIdForUsers(currentUserId, otherUserId),
      otherUser: {
        id: otherUserId,
        username: otherUser?.username ?? 'unknown',
        displayName: otherUser?.display_name ?? otherUser?.username ?? 'unknown',
        profilePicture: otherUser?.profile_picture ?? null,
        lastSeen: otherUser?.last_seen ?? null,
        hideLastSeen: Boolean(otherUser?.hide_last_seen),
        showOnlineStatus: otherUser?.show_online_status !== false,
      },
      online: otherUser?.show_online_status !== false && Boolean(getOnlineUsers().includes(otherUser?.username ?? '')),
    };
  });
}

async function findChatByParticipants(userAId: string, userBId: string) {
  const chatId = getChatIdForUsers(userAId, userBId);
  // For Supabase mode, we can check friend_requests table for accepted status
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('friend_requests')
      .select('id,sender_id,receiver_id,status')
      .or(`sender_id.eq.${userAId},receiver_id.eq.${userAId}`)
      .or(`sender_id.eq.${userBId},receiver_id.eq.${userBId}`)
      .eq('status', 'accepted');
    if (error) throw error;
    const accepted = (data ?? []).some((r: any) => (r.sender_id === userAId && r.receiver_id === userBId) || (r.sender_id === userBId && r.receiver_id === userAId));
    return accepted ? chatId : null;
  }

  const accepted = inMemoryFriendRequests.some((r) => r.status === 'accepted' && ((r.senderId === userAId && r.receiverId === userBId) || (r.senderId === userBId && r.receiverId === userAId)));
  return accepted ? chatId : null;
}

async function ensureChatThread(userAId: string, userBId: string) {
  const chatId = getChatIdForUsers(userAId, userBId);
  if (!USE_SUPABASE || !supabase) return chatId;

  const { error } = await supabase.from('chat_threads').upsert({
    id: chatId,
    user_a: userAId,
    user_b: userBId,
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
  return chatId;
}

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use('/api/storage', express.static(storageRoot));

app.post('/api/storage/uploads/request-url', (req: Request, res: Response) => {
  const fileName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const fileSize = Number(req.body?.size ?? 0);

  if (!fileName) return res.status(400).json({ error: 'Missing file name' });
  if (!Number.isFinite(fileSize) || fileSize <= 0) return res.status(400).json({ error: 'Missing file size' });

  const safeName = fileName
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || `upload-${Date.now()}`;

  const objectPath = `/uploads/${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`;
  const uploadURL = `${PUBLIC_API_URL}/api/storage${objectPath}`;
  return res.json({ uploadURL, objectPath });
});

app.put('/api/storage/*', express.raw({ type: '*/*', limit: '10mb' }), (req: Request, res: Response) => {
  const relativePath = decodeURIComponent((req as any).path || '').replace(/^\/api\/storage\/?/, '');
  if (!relativePath) return res.status(400).json({ error: 'Missing upload path' });

  const targetPath = path.join(storageRoot, relativePath);
  const targetDir = path.dirname(targetPath);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(req.body ?? []));
  return res.status(200).json({ ok: true, path: relativePath });
});

app.get('/api/auth/me', async (req: Request, res: Response) => {
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(401).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    return res.json({
      id: currentUser.id,
      email: currentUser.email,
      username: currentUser.username,
      displayName: currentUser.display_name,
      profilePicture: currentUser.profile_picture ?? null,
      hideLastSeen: Boolean(currentUser.hide_last_seen),
      showOnlineStatus: currentUser.show_online_status !== false,
      lastSeen: currentUser.last_seen ?? null,
      createdAt: currentUser.created_at,
    });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message || 'Unable to load profile' });
  }
});

app.patch('/api/user/settings', async (req: Request, res: Response) => {
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(401).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const hideLastSeen = typeof req.body?.hideLastSeen === 'boolean'
      ? req.body.hideLastSeen
      : typeof req.body?.hide_last_seen === 'boolean'
        ? req.body.hide_last_seen
        : Boolean(currentUser.hide_last_seen);
    const showOnlineStatus = typeof req.body?.showOnlineStatus === 'boolean'
      ? req.body.showOnlineStatus
      : typeof req.body?.show_online_status === 'boolean'
        ? req.body.show_online_status
        : currentUser.show_online_status !== false;

    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase
        .from('users')
        .update({ hide_last_seen: hideLastSeen, show_online_status: showOnlineStatus, updated_at: new Date().toISOString() })
        .eq('id', currentUser.id)
        .select('id,hide_last_seen,show_online_status,last_seen')
        .single();
      if (error) throw error;
      const ownerSocket = Array.from(activeSockets.values()).find((socket) => socket.data.userId === currentUser.id);
      if (ownerSocket) {
        ownerSocket.data.showOnlineStatus = showOnlineStatus;
        if (!showOnlineStatus) {
          for (const room of ownerSocket.rooms) {
            if (room !== ownerSocket.id) ownerSocket.to(room).emit('presence_hidden', { userId: currentUser.id });
          }
        }
      }
      return res.json({ hideLastSeen: Boolean(data.hide_last_seen), showOnlineStatus: data.show_online_status !== false, lastSeen: data.last_seen ?? null });
    }

    currentUser.hide_last_seen = hideLastSeen;
    currentUser.show_online_status = showOnlineStatus;
    const ownerSocket = Array.from(activeSockets.values()).find((socket) => socket.data.userId === currentUser.id);
    if (ownerSocket) {
      ownerSocket.data.showOnlineStatus = showOnlineStatus;
      if (!showOnlineStatus) {
        for (const room of ownerSocket.rooms) {
          if (room !== ownerSocket.id) ownerSocket.to(room).emit('presence_hidden', { userId: currentUser.id });
        }
      }
    }
    return res.json({ hideLastSeen: Boolean(currentUser.hide_last_seen), showOnlineStatus: currentUser.show_online_status !== false, lastSeen: currentUser.last_seen ?? null });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message || 'Unable to update settings' });
  }
});

app.patch('/api/auth/profile', async (req: Request, res: Response) => {
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(401).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const nextDisplayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() || currentUser.display_name : currentUser.display_name;
    const nextUsername = typeof req.body?.username === 'string' ? req.body.username.trim() || currentUser.username : currentUser.username;
    const nextProfilePicture = typeof req.body?.profilePicture === 'string'
      ? req.body.profilePicture
      : typeof req.body?.avatarUrl === 'string'
        ? req.body.avatarUrl
        : typeof req.body?.profile_picture === 'string'
          ? req.body.profile_picture
          : (currentUser.profile_picture ?? null);

    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase
        .from('users')
        .update({
          display_name: nextDisplayName,
          username: nextUsername,
          profile_picture: nextProfilePicture,
          avatar_url: nextProfilePicture,
        })
        .eq('id', currentUser.id)
        .select('id,email,username,display_name,profile_picture,avatar_url,created_at')
        .single();

      if (error) throw error;

      const normalizedProfilePicture = data.profile_picture ?? data.avatar_url ?? null;

      io.emit('user_profile_updated', {
        id: data.id,
        username: data.username,
        displayName: data.display_name,
        profilePicture: normalizedProfilePicture,
      });

      return res.json({
        id: data.id,
        email: data.email,
        username: data.username,
        displayName: data.display_name,
        profilePicture: normalizedProfilePicture,
        createdAt: data.created_at,
      });
    }

    currentUser.display_name = nextDisplayName;
    currentUser.username = nextUsername;
    currentUser.profile_picture = nextProfilePicture;

    io.emit('user_profile_updated', {
      id: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.display_name,
      profilePicture: currentUser.profile_picture ?? null,
    });

    return res.json({
      id: currentUser.id,
      email: currentUser.email,
      username: currentUser.username,
      displayName: currentUser.display_name,
      profilePicture: currentUser.profile_picture ?? null,
      createdAt: currentUser.created_at,
    });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message || 'Unable to update profile' });
  }
});

if (!USE_SUPABASE) {
  console.warn('SUPABASE_URL or SUPABASE_KEY/SUPABASE_ANON_KEY not set. Using in-memory fallback database.');
}

app.get('/api/healthz', (_req, res) => res.json({ ok: true }));

app.delete('/api/test/cleanup', async (req, res) => {
  if (process.env.E2E_TEST_MODE !== 'true') return res.status(404).end();

  const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames.filter((value: unknown): value is string => typeof value === 'string') : [];
  if (usernames.length === 0) return res.status(400).json({ error: 'At least one username is required' });

  try {
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase.from('users').delete().in('username', usernames);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const removedIds = new Set(inMemoryUsers.filter((user) => usernames.includes(user.username)).map((user) => user.id));
      for (let index = inMemoryUsers.length - 1; index >= 0; index -= 1) {
        if (usernames.includes(inMemoryUsers[index].username)) inMemoryUsers.splice(index, 1);
      }
      for (let index = inMemoryFriendRequests.length - 1; index >= 0; index -= 1) {
        const request = inMemoryFriendRequests[index];
        if (removedIds.has(request.senderId) || removedIds.has(request.receiverId)) inMemoryFriendRequests.splice(index, 1);
      }
      for (let index = inMemoryPrivateMessages.length - 1; index >= 0; index -= 1) {
        if (usernames.includes(inMemoryPrivateMessages[index].sender_username)) inMemoryPrivateMessages.splice(index, 1);
      }
      for (let index = inMemoryMessageReads.length - 1; index >= 0; index -= 1) {
        if (removedIds.has(inMemoryMessageReads[index].userId)) inMemoryMessageReads.splice(index, 1);
      }
      for (const [token, userId] of inMemoryVerificationTokens) {
        if (removedIds.has(userId)) inMemoryVerificationTokens.delete(token);
      }
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message || 'Cleanup failed' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { email, username, displayName, password, confirmPassword } = req.body;
  if (!email || !username || !password || !confirmPassword) return res.status(400).json({ error: 'Missing fields' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Ooops! Passwords don’t match. Try again.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  if (USE_SUPABASE) {
    if (!supabase) throw new Error('Supabase client is not initialized.');
    const { data: existing, error: existingError } = await supabase
      .from('users')
      .select('id')
      .or(`email.eq.${email},username.eq.${username}`)
      .limit(1)
      .maybeSingle();

    if (existingError) return res.status(500).json({ error: existingError.message });
    if (existing) return res.status(400).json({ error: 'Email or username already exists' });

    const { data, error } = await supabase.from('users').insert([
      { email, username, display_name: displayName, password_hash: hashPassword(password), email_verified: !EMAIL_VERIFICATION_ENABLED },
    ]).select('id').single();

    if (error || !data) return res.status(500).json({ error: error?.message ?? 'Registration failed' });

    return res.json({ message: EMAIL_VERIFICATION_ENABLED ? 'Verification email sent' : 'Account created', userId: data.id, verificationRequired: EMAIL_VERIFICATION_ENABLED });
  }

  const existingLocal = inMemoryUsers.find((u) => u.email === email || u.username === username);
  if (existingLocal) return res.status(400).json({ error: 'Email or username already exists' });

  const newUser = {
    id: `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    email,
    username,
    display_name: displayName,
    profile_picture: null,
    created_at: new Date().toISOString(),
    password_hash: hashPassword(password),
    email_verified: !EMAIL_VERIFICATION_ENABLED,
    last_seen: null,
    hide_last_seen: false,
  };
  inMemoryUsers.push(newUser);
  if (!EMAIL_VERIFICATION_ENABLED) {
    return res.json({ message: 'Account created', userId: newUser.id, verificationRequired: false });
  }

  const verificationToken = crypto.randomUUID();
  inMemoryVerificationTokens.set(verificationToken, newUser.id);
  return res.json({ message: 'Verification email sent', userId: newUser.id, verificationToken, verificationRequired: true });
});

async function authenticateUserWithIdentifier(identifier: string, password: string) {
  const normalizedIdentifier = identifier.trim();
  const lowerIdentifier = normalizedIdentifier.toLowerCase();

  if (USE_SUPABASE) {
    if (!supabase) throw new Error('Supabase client is not initialized.');

    const { data, error } = await supabase
      .from('users')
      .select('id,email,username,display_name,profile_picture,avatar_url,email_verified,created_at,password_hash,hide_last_seen,show_online_status')
      .or(`email.ilike.${lowerIdentifier},username.ilike.${lowerIdentifier}`)
      .limit(2);

    if (error) throw new Error(error.message);

    const matches = (data ?? []).filter((entry) => entry && (entry.username?.toLowerCase() === lowerIdentifier || entry.email?.toLowerCase() === lowerIdentifier));
    const user = matches.length === 1 ? matches[0] : null;

    if (!user) {
      return { status: 401, body: { error: 'Invalid credentials' } };
    }

    if (!verifyPassword(password, user.password_hash ?? '')) {
      return { status: 401, body: { error: 'Invalid credentials' } };
    }

    if (EMAIL_VERIFICATION_ENABLED && !user.email_verified) {
      return { status: 403, body: { error: 'Email not verified' } };
    }

    const accessToken = createSupabaseAccessToken({ id: user.id, email: user.email, username: user.username });
    return {
      status: 200,
      body: {
        access_token: accessToken,
        token: accessToken,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          displayName: user.display_name,
          profilePicture: user.profile_picture ?? user.avatar_url ?? null,
          hideLastSeen: Boolean(user.hide_last_seen),
          showOnlineStatus: user.show_online_status !== false,
          createdAt: user.created_at,
        },
      },
    };
  }

  const matches = inMemoryUsers.filter((user) => {
    const usernameMatches = user.username.toLowerCase() === lowerIdentifier;
    const emailMatches = user.email.toLowerCase() === lowerIdentifier;
    return usernameMatches || emailMatches;
  });

  if (matches.length !== 1) {
    return { status: 401, body: { error: 'Invalid credentials' } };
  }

  const user = matches[0];
  if (!verifyPassword(password, user.password_hash)) {
    return { status: 401, body: { error: 'Invalid credentials' } };
  }

  if (EMAIL_VERIFICATION_ENABLED && !user.email_verified) {
    return { status: 403, body: { error: 'Email not verified' } };
  }

  const accessToken = createSupabaseAccessToken({ id: user.id, email: user.email, username: user.username });
  return {
    status: 200,
    body: {
      access_token: accessToken,
      token: accessToken,
      supabase_access_token: accessToken,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
        profilePicture: user.profile_picture ?? null,
        hideLastSeen: Boolean(user.hide_last_seen),
        showOnlineStatus: user.show_online_status !== false,
        createdAt: user.created_at,
      },
    },
  };
}

app.post('/api/login', async (req, res) => {
  const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const result = await authenticateUserWithIdentifier(identifier, password);
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message || 'Authentication failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const result = await authenticateUserWithIdentifier(identifier, password);
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message || 'Authentication failed' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  if (!USE_SUPABASE) {
    const userId = inMemoryVerificationTokens.get(token);
    const user = userId ? inMemoryUsers.find((candidate) => candidate.id === userId) : null;
    if (!user) return res.status(400).json({ error: 'Invalid verification token' });
    user.email_verified = true;
    inMemoryVerificationTokens.delete(token);
    return res.json({
      message: 'Email verification successful',
      token: 'local-dev-token',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
        profilePicture: user.profile_picture,
        createdAt: user.created_at,
      },
    });
  }

  return res.status(400).json({ error: 'Verification is unavailable in this environment' });
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  return res.json({ message: 'Verification email resent' });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  return res.json({ message: 'Password reset email sent' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password, confirmPassword } = req.body;
  if (!token || !password || !confirmPassword) return res.status(400).json({ error: 'Missing fields' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Ooops! Passwords don’t match. Try again.' });
  return res.json({ message: 'Password reset successful' });
});

app.delete('/api/auth/account', async (req: Request, res: Response) => {
  const currentUsername = getAuthenticatedUsername(req);
  const { password } = req.body ?? {};
  if (!currentUsername || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser || !verifyPassword(password, currentUser.password_hash)) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    if (USE_SUPABASE && supabase) {
      const { data: chatRows, error: chatError } = await supabase
        .from('chat_threads')
        .select('id')
        .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`);
      if (chatError) throw chatError;

      const chatIds = (chatRows ?? []).map((chat: any) => chat.id);
      if (chatIds.length > 0) {
        const { error: messagesError } = await supabase
          .from('messages')
          .delete()
          .in('chat_id', chatIds);
        if (messagesError) throw messagesError;
      }

      const { error: ownMessagesError } = await supabase
        .from('messages')
        .delete()
        .eq('sender_id', currentUser.id);
      if (ownMessagesError) throw ownMessagesError;

      const { error } = await supabase.from('users').delete().eq('id', currentUser.id);
      if (error) throw error;
    } else {
      const userIndex = inMemoryUsers.findIndex((user) => user.id === currentUser.id);
      if (userIndex !== -1) inMemoryUsers.splice(userIndex, 1);

      for (let index = inMemoryFriendRequests.length - 1; index >= 0; index -= 1) {
        const request = inMemoryFriendRequests[index];
        if (request.senderId === currentUser.id || request.receiverId === currentUser.id) {
          inMemoryFriendRequests.splice(index, 1);
        }
      }

      for (let index = inMemoryPrivateMessages.length - 1; index >= 0; index -= 1) {
        const message = inMemoryPrivateMessages[index];
        if (message.sender_username === currentUsername || message.chatId.includes(currentUser.id)) {
          inMemoryPrivateMessages.splice(index, 1);
        }
      }

      for (let index = inMemoryMessageReads.length - 1; index >= 0; index -= 1) {
        const read = inMemoryMessageReads[index];
        if (read.userId === currentUser.id || !inMemoryPrivateMessages.some((message) => message.id === read.messageId)) {
          inMemoryMessageReads.splice(index, 1);
        }
      }
    }

    for (const [socketId, socket] of activeSockets.entries()) {
      if (socket.data.username === currentUsername) {
        socket.disconnect(true);
        activeSockets.delete(socketId);
      }
    }

    res.json({ message: 'Account deleted' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to delete account' });
  }
});

export { socketUserIdMap };
const pendingPresenceDisconnects = new Map<string, ReturnType<typeof setTimeout>>();
const PRESENCE_DISCONNECT_DEBOUNCE_MS = 7000;

async function isChatParticipant(chatId: string, userId: string) {
  if (!chatId || !userId) return false;
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('chat_threads')
      .select('user_a,user_b')
      .eq('id', chatId)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data && (data.user_a === userId || data.user_b === userId));
  }
  return inMemoryFriendRequests.some((request) => request.status === 'accepted' &&
    getChatIdForUsers(request.senderId, request.receiverId) === chatId &&
    (request.senderId === userId || request.receiverId === userId));
}

async function setPresenceStatus(userId: string, online: boolean) {
  const timestamp = new Date().toISOString();
  if (USE_SUPABASE && supabase) {
    const { error } = await supabase
      .from('users')
      .update({ is_online: online, status: online ? 'online' : 'offline', last_seen: timestamp, updated_at: timestamp })
      .eq('id', userId);
    if (error && !/status|column/i.test(error.message ?? '')) throw error;
  } else {
    const user = inMemoryUsers.find((candidate) => candidate.id === userId);
    if (user) user.last_seen = timestamp;
  }
  return timestamp;
}

function emitPresenceToRooms(socket: Socket, event: 'user_online' | 'user_offline', payload: Record<string, unknown>) {
  for (const room of socket.rooms) {
    if (room === socket.id) continue;
    socket.to(room).emit(event, payload);
  }
}

function schedulePresenceOffline(socket: Socket) {
  const userId = socket.data.userId as string | undefined;
  const username = socket.data.username as string | undefined;
  if (!userId || !username) return;

  const existing = pendingPresenceDisconnects.get(userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingPresenceDisconnects.delete(userId);
    const mappedSocketId = socketUserIdMap.get(userId);
    if (mappedSocketId && mappedSocketId !== socket.id) return;

    void (async () => {
      try {
        const lastSeen = await setPresenceStatus(userId, false);
        socketUserIdMap.delete(userId);
        const payload = { userId, username, online: false, lastSeen, timestamp: Date.now() };
        emitPresenceToRooms(socket, 'user_offline', payload);
        io.emit('user_presence_change', payload);
      } catch (error) {
        console.error('[presence] offline update failed:', (error as Error).message);
      }
    })();
  }, PRESENCE_DISCONNECT_DEBOUNCE_MS);
  pendingPresenceDisconnects.set(userId, timer);
}

// Simple in-memory reaction & star store for demo/persistence in this dev server
const messageReactions: Record<string, Record<string, Set<string>>> = {};
const messageStars: Record<string, Set<string>> = {};
// In-memory message read receipts for demo mode
const inMemoryMessageReads: Array<{ id: string; messageId: string; userId: string; readAt: string }> = [];
const activeDmTypingByChat = new Map<string, Set<string>>();
// Per-chat monotonic sequence counters for in-memory mode
const inMemoryChatSeqs: Record<string, number> = {};

function getReactionsForMessage(messageId: string) {
  const reactionsForMessage = messageReactions[messageId] ?? {};
  return Object.entries(reactionsForMessage).map(([emoji, users]) => ({
    emoji,
    count: users.size,
    users: Array.from(users),
  }));
}

function getStarredUsersForMessage(messageId: string) {
  return Array.from(messageStars[messageId] ?? new Set<string>());
}

const inMemoryPrivateMessages: Array<{
  id: string;
  chatId: string;
  sender_username: string;
  sender_display_name: string | null;
  content: string;
  seq?: number;
  attachments?: unknown;
  voice_note?: boolean;
  voice_duration?: number | null;
  unsent?: boolean;
  created_at: string;
  updated_at: string;
  edited: boolean;
  reply_to: string | null;
}> = [];

async function savePrivateMessage(message: any) {
  // Generate seq locally (works for both Supabase and in-memory modes)
  const seq = (inMemoryChatSeqs[message.chatId] = (inMemoryChatSeqs[message.chatId] ?? 0) + 1);

  const contentToSave = message.message ?? message.content;
  console.log('[savePrivateMessage] Saving message:', {
    id: message.id,
    chatId: message.chatId,
    sender: message.senderId ?? message.senderName,
    contentLength: contentToSave?.length ?? 0,
    seq,
  });

  if (USE_SUPABASE && supabase) {
    try {
      const clientMessageId = isUuid(message.clientMessageId)
        ? message.clientMessageId
        : crypto.randomUUID();
      const realtimeMessageId = await saveMessage(supabase, {
        id: message.dbId,
        chat_id: message.chatId,
        sender_id: String(message.senderId ?? message.senderName ?? ''),
        content: contentToSave,
        status: 'sent',
        created_at: message.timestamp,
        client_message_id: clientMessageId,
      }, clientMessageId);

      message.dbId = realtimeMessageId;
      message.clientMessageId = clientMessageId;
      console.log('[savePrivateMessage] ✓ Saved to canonical messages table only');
      return;
    } catch (e) {
      console.error('[savePrivateMessage] Supabase exception:', {
        message: (e as Error).message,
        stack: (e as Error).stack,
      });
      throw e;
    }
  }

  console.log('[savePrivateMessage] Storing in-memory fallback');
  inMemoryPrivateMessages.push({
    id: message.id,
    chatId: message.chatId,
    sender_username: message.senderId ?? message.senderName,
    sender_display_name: message.senderDisplayName ?? null,
    content: contentToSave,
    attachments: message.attachments ?? null,
    voice_note: message.voiceNote ?? false,
    voice_duration: message.voiceDuration ?? null,
    unsent: message.unsent ?? false,
    created_at: message.timestamp,
    updated_at: message.timestamp,
    edited: false,
    reply_to: message.replyTo ?? null,
    seq,
  });
  console.log('[savePrivateMessage] ✓ Saved to in-memory. Total for chat:', inMemoryPrivateMessages.filter(m => m.chatId === message.chatId).length);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function updatePrivateMessage(messageId: string, newMessage: string) {
  if (USE_SUPABASE && supabase) {
    const { error } = await supabase
      .from('messages')
      .update({ content: newMessage, status: 'sent', created_at: new Date().toISOString() })
      .eq('id', messageId);
    if (error) throw error;
    return;
  }

  const message = inMemoryPrivateMessages.find((msg) => msg.id === messageId);
  if (message) {
    message.content = newMessage;
    message.edited = true;
    message.updated_at = new Date().toISOString();
  }
}

async function getPrivateMessageById(messageId: string) {
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('messages')
      .select('id,chat_id,sender_id,content,status,created_at,client_message_id')
      .eq('id', messageId)
      .maybeSingle();
    if (error) throw error;
    return data ? {
      id: data.id,
      chatId: data.chat_id,
      seq: null,
      sender_username: data.sender_id,
      sender_display_name: null,
      content: data.content,
      attachments: undefined,
      voice_note: false,
      voice_duration: null,
      unsent: false,
      created_at: data.created_at,
      updated_at: data.created_at,
      edited: false,
      reply_to: null,
    } : null;
  }
  return inMemoryPrivateMessages.find((message) => message.id === messageId) ?? null;
}

async function toggleReaction(messageId: string, username: string, emoji: string) {
  if (USE_SUPABASE && supabase) {
    const { data: existing, error: selectError } = await supabase
      .from('private_message_reactions')
      .select('id')
      .match({ message_id: messageId, emoji, username })
      .maybeSingle();
    if (selectError) throw selectError;
    if (existing) {
      const { error } = await supabase
        .from('private_message_reactions')
        .delete()
        .match({ message_id: messageId, emoji, username });
      if (error) throw error;
      return;
    }
    const { error } = await supabase.from('private_message_reactions').insert([{ message_id: messageId, emoji, username }]);
    if (error) throw error;
    return;
  }

  const reactionsForMessage = messageReactions[messageId] ||= {};
  const users = reactionsForMessage[emoji] ||= new Set<string>();
  if (users.has(username)) {
    users.delete(username);
  } else {
    users.add(username);
  }
}

async function toggleStar(messageId: string, username: string) {
  if (USE_SUPABASE && supabase) {
    const { data: existing, error: selectError } = await supabase
      .from('private_message_stars')
      .select('id')
      .match({ message_id: messageId, username })
      .maybeSingle();
    if (selectError) throw selectError;
    if (existing) {
      const { error } = await supabase
        .from('private_message_stars')
        .delete()
        .match({ message_id: messageId, username });
      if (error) throw error;
      return;
    }
    const { error } = await supabase.from('private_message_stars').insert([{ message_id: messageId, username }]);
    if (error) throw error;
    return;
  }

  const starsForMessage = messageStars[messageId] ||= new Set<string>();
  if (starsForMessage.has(username)) {
    starsForMessage.delete(username);
  } else {
    starsForMessage.add(username);
  }
}

async function getPrivateMessagesForChat(chatId: string, currentUsername?: string, currentUserId?: string, req?: Request) {
  console.log('[getPrivateMessagesForChat] Fetching for:', { chatId, currentUsername, currentUserId, useSupabase: USE_SUPABASE });
  
  if (USE_SUPABASE && supabase) {
    const messageClient = getRequestSupabaseClient(req as Request);
    if (!messageClient) throw new Error('Supabase client is not initialized');
    const { data: messages, error } = await messageClient
      .from('messages')
      .select('id,chat_id,sender_id,content,status,created_at,client_message_id')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true });
    if (!error && messages) {
      console.log('[getPrivateMessagesForChat] Loaded', messages.length, 'from canonical messages table');
      const messageIds = messages.map((message: any) => message.id);
      const reactionMap: Record<string, Record<string, number>> = {};
      const starMap: Record<string, Set<string>> = {};
      const readMap: Record<string, string[]> = {};

      try {
        const unreadMessages = await fetchUnreadMessages(messageClient, chatId, currentUserId ?? '', new Date(0).toISOString());
        unreadMessages.forEach((message: any) => {
          if (!readMap[message.id]) readMap[message.id] = [];
        });
      } catch (unreadError) {
        console.warn('[getPrivateMessagesForChat] canonical unread lookup unavailable; continuing without unread details:', (unreadError as Error).message);
      }

      if (messageIds.length > 0) {
        const { data: reactionRows, error: reactionsError } = await messageClient
          .from('private_message_reactions')
          .select('message_id,emoji,username')
          .in('message_id', messageIds);
        if (reactionsError) {
          console.log('Could not load reactions, falling back:', reactionsError.message);
        } else {
          (reactionRows ?? []).forEach((row: any) => {
            reactionMap[row.message_id] ||= {};
            reactionMap[row.message_id][row.emoji] = (reactionMap[row.message_id][row.emoji] ?? 0) + 1;
          });
        }

        const { data: starRows, error: starsError } = await messageClient
          .from('private_message_stars')
          .select('message_id,username')
          .in('message_id', messageIds);
        if (starsError) {
          console.log('Could not load stars, falling back:', starsError.message);
        } else {
          (starRows ?? []).forEach((row: any) => {
            starMap[row.message_id] ||= new Set<string>();
            starMap[row.message_id].add(row.username);
          });
        }

        const { data: readRows, error: readsError } = await messageClient
          .from('message_reads')
          .select('message_id,user_id')
          .in('message_id', messageIds);
        if (readsError) {
          console.log('Could not load reads, falling back:', readsError.message);
        } else {
          (readRows ?? []).forEach((row: any) => {
            readMap[row.message_id] ||= [];
            readMap[row.message_id].push(row.user_id);
          });
        }
      }

      return messages.map((message: any) => ({
        id: message.id,
        chatId: message.chat_id,
        seq: null,
        senderId: message.sender_id,
        senderName: message.sender_id,
        content: message.content,
        attachments: undefined,
        voiceNote: false,
        voiceDuration: null,
        unsent: false,
        createdAt: message.created_at,
        status: (message.status ?? 'sent') as 'sent' | 'delivered' | 'read',
        starred: currentUsername ? (starMap[message.id]?.has(currentUsername) ?? false) : false,
        reactions: reactionMap[message.id] ?? {},
        replyTo: null,
        readBy: readMap[message.id] ?? [],
      }));
    } else {
      // Fallback to in-memory if table doesn't exist or other error
      console.error('[getPrivateMessagesForChat] Supabase error, falling back to in-memory:', error?.message);
    }
  }

  const messages = inMemoryPrivateMessages.filter((message) => message.chatId === chatId);
  console.log('[getPrivateMessagesForChat] In-memory store has', messages.length, 'messages for chat', chatId);

  return messages
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((message) => {
      const result = {
        id: message.id,
        chatId: message.chatId,
        seq: message.seq ?? null,
        senderId: message.sender_username,
        senderName: message.sender_display_name ?? message.sender_username,
        content: message.content,
        attachments: message.attachments ?? undefined,
        voiceNote: message.voice_note ?? false,
        voiceDuration: message.voice_duration ?? null,
        unsent: message.unsent ?? false,
        createdAt: message.created_at,
        status: 'delivered' as const,
        starred: currentUsername ? (messageStars[message.id]?.has(currentUsername) ?? false) : false,
        reactions: Object.fromEntries(
          Object.entries(messageReactions[message.id] ?? {}).map(([emoji, users]) => [emoji, users.size]),
        ),
        replyTo: message.reply_to ?? null,
        readBy: (inMemoryMessageReads.filter((r) => r.messageId === message.id).map((r) => r.userId)) ?? [],
      };
      return result;
    });
  
}


// Background outbox processor: claim pending outbox rows and publish them via Socket.IO
if (USE_SUPABASE && supabase) {
  let outboxUnavailable = false;
  const processOutbox = async () => {
    if (outboxUnavailable) return;
    try {
      const { data: rows, error } = await supabase.rpc('claim_outbox', { p_limit: 20 });
      if (error) {
        if (error.code === '42883' || error.code === 'PGRST202' || /claim_outbox|outbox/i.test(error.message ?? '')) {
          outboxUnavailable = true;
          console.warn('[outbox] Optional outbox schema is unavailable; Socket.IO delivery remains active');
        }
        return;
      }
      const items = (rows as any[]) ?? [];
      for (const item of items) {
        try {
          const topic: string = item.topic;
          const payload = item.payload;
          // Publish based on topic convention: 'dm:${chatId}' -> emit to room
          if (topic && topic.startsWith('dm:')) {
            const chatId = topic.slice(3);
            io.to(chatId).emit('dm_new_message', payload);
          } else if (topic) {
            // generic emit
            io.emit(topic, payload);
          }
          // mark sent
          await supabase.from('outbox').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', item.id);
        } catch (innerErr) {
          // mark failed so we can retry later
          try {
            await supabase.from('outbox').update({ status: 'failed' }).eq('id', item.id);
          } catch (ignore) {
            // ignore
          }
        }
      }
    } catch (err) {
      // ignore
    }
  };

  // Run processor periodically
  setInterval(processOutbox, 1000).unref();
}

app.post('/api/friends/requests', async (req: Request, res: Response) => {
  const { targetUserId, targetUsername } = req.body ?? {};
  const currentUsername = getAuthenticatedUsername(req);
  console.log('[api/friends/requests] incoming', {
    currentUsername,
    targetUserId: typeof targetUserId === 'string' ? targetUserId : null,
    targetUsername: typeof targetUsername === 'string' ? targetUsername : null,
  });

  if (!currentUsername || (!targetUserId && !targetUsername)) {
    return res.status(400).json({ error: 'Missing current user or target user (require Authorization and x-username)' });
  }

  try {
    const currentUser = await getUserByUsername(currentUsername);
    let targetUser = null;
    if (typeof targetUserId === 'string' && targetUserId.trim()) {
      targetUser = await getUserById(targetUserId);
    } else if (typeof targetUsername === 'string' && targetUsername.trim()) {
      targetUser = await getUserByUsername(targetUsername);
    }
    if (!currentUser || !targetUser) return res.status(404).json({ error: 'User not found' });
    if (currentUser.id === targetUser.id) return res.status(400).json({ error: 'Cannot send request to yourself' });

    const existingRequest = await getFriendRequestBetweenUsers(currentUser.id, targetUser.id);
    if (existingRequest) {
      if (existingRequest.status === 'pending') return res.status(409).json({ error: 'Request already sent' });
      if (existingRequest.status === 'accepted') return res.status(409).json({ error: 'You are already friends' });
    }

    const request = await createFriendRequest(currentUser.id, targetUser.id);
    const socket = Array.from(activeSockets.values()).find((s) => s.data.username === targetUser.username);
    if (socket) {
      const receiverSocketId = socket.id;
      console.log('Emitting event to user:', targetUser.id, 'Socket ID:', receiverSocketId);
      // emit a clear event name for frontend to listen to
      io.to(receiverSocketId).emit('new_friend_request', { request, sender: { id: currentUser.id, username: currentUser.username, displayName: currentUser.display_name } });
    }

    res.json({ message: 'Friend request sent', request });
  } catch (error) {
    const message = (error as Error).message || 'Unable to send friend request';
    res.status(500).json({ error: message });
  }
});

app.get('/api/friends/requests', async (req: Request, res: Response) => {
  const status = String(req.query.status ?? '').trim() as FriendRequestStatus | undefined;
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(400).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    const requests = await getFriendRequestsForUser(currentUser.id, status);
    const enriched = await Promise.all(requests.map(async (request) => {
      const sender = await getUserById(request.senderId);
      const receiver = await getUserById(request.receiverId);
      return {
        ...request,
        sender: {
          id: sender?.id ?? null,
          username: sender?.username ?? 'unknown',
          displayName: sender?.display_name ?? sender?.username ?? 'unknown',
        },
        receiver: {
          id: receiver?.id ?? null,
          username: receiver?.username ?? 'unknown',
          displayName: receiver?.display_name ?? receiver?.username ?? 'unknown',
        },
      };
    }));
    res.json({ requests: enriched });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to load friend requests' });
  }
});

app.post('/api/friends/requests/:requestId/accept', async (req: Request, res: Response) => {
  const requestId = resolveRouteParam(req.params.requestId);
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(400).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const request = await getFriendRequestById(requestId);
    if (!request) return res.status(404).json({ error: 'Friend request not found' });
    if (request.receiverId !== currentUser.id) return res.status(403).json({ error: 'Not authorized to accept this request' });

      const updated = await updateFriendRequestStatus(requestId, 'accepted');
    const otherUser = await getUserById(request.senderId);
    const chatId = await ensureChatThread(currentUser.id, request.senderId);
    const payload = {
      request: {
        ...updated,
        sender: { id: request.senderId, username: otherUser?.username, displayName: otherUser?.display_name },
        receiver: { id: currentUser.id, username: currentUser.username, displayName: currentUser.display_name },
      },
      chatId,
    };
    const socket = Array.from(activeSockets.values()).find((s) => s.data.username === otherUser?.username);
    if (socket) {
      socket.emit('friend_request_updated', payload);
    }
    res.json({ message: 'Friend request accepted', chat: { id: chatId } });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to accept friend request' });
  }
});

app.post('/api/friends/requests/:requestId/decline', async (req: Request, res: Response) => {
  const requestId = resolveRouteParam(req.params.requestId);
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(400).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const request = await getFriendRequestById(requestId);
    if (!request) return res.status(404).json({ error: 'Friend request not found' });
    if (request.receiverId !== currentUser.id) return res.status(403).json({ error: 'Not authorized to decline this request' });

      const updated = await updateFriendRequestStatus(requestId, 'rejected');
    const sender = await getUserById(request.senderId);
    const payload = {
      request: {
        ...updated,
        sender: { id: request.senderId, username: sender?.username, displayName: sender?.display_name },
        receiver: { id: currentUser.id, username: currentUsername, displayName: currentUser.display_name },
      },
    };
    const socket = Array.from(activeSockets.values()).find((s) => s.data.username === sender?.username);
    if (socket) {
      socket.emit('friend_request_updated', payload);
    }
    res.json({ message: 'Friend request declined' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to decline friend request' });
  }
});

// Allow the sender to cancel (withdraw) a pending friend request
app.delete('/api/friends/requests/:requestId', async (req: Request, res: Response) => {
  const requestId = resolveRouteParam(req.params.requestId);
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(400).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const request = await getFriendRequestById(requestId);
    if (!request) return res.status(404).json({ error: 'Friend request not found' });
    if (request.senderId !== currentUser.id) return res.status(403).json({ error: 'Not authorized to cancel this request' });

    // Delete the request
    if (USE_SUPABASE && supabase) {
      const { error: deleteError } = await supabase.from('friend_requests').delete().eq('id', requestId);
      if (deleteError) throw deleteError;
    } else {
      const idx = inMemoryFriendRequests.findIndex((r) => r.id === requestId);
      if (idx >= 0) inMemoryFriendRequests.splice(idx, 1);
    }

    const receiver = await getUserById(request.receiverId);
    const payload = {
      request: {
        id: requestId,
        sender: { id: request.senderId, username: currentUser.username, displayName: currentUser.display_name },
        receiver: { id: request.receiverId, username: receiver?.username, displayName: receiver?.display_name },
        status: 'rejected',
      },
    };
    const socket = Array.from(activeSockets.values()).find((s) => s.data.username === receiver?.username);
    if (socket) {
      socket.emit('friend_request_updated', payload);
    }

    res.json({ message: 'Friend request cancelled' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to cancel friend request' });
  }
});

app.get('/api/private-chats', async (req: Request, res: Response) => {
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(400).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });
    await updateUserLastSeen(currentUser.id, new Date());
    const chats = await getAcceptedFriendChats(currentUser.id);
    res.json({ chats });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to load private chats' });
  }
});

// Debug endpoint to list active sockets and mapped usernames
app.get('/api/debug/sockets', async (req: Request, res: Response) => {
  try {
    const list = Array.from(activeSockets.entries()).map(([socketId, socket]) => ({ socketId, username: socket.data.username ?? null }));
    res.json({ sockets: list });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to list sockets' });
  }
});

app.get('/api/users/search', async (req: Request, res: Response) => {
  const rawQuery = String(req.query.q ?? '').trim();
  const query = rawQuery.startsWith('@') ? rawQuery.slice(1).trim() : rawQuery;
  const currentUsername = req.headers['x-username'] as string | undefined;
  const currentUser = currentUsername ? await getUserByUsername(currentUsername) : null;

  if (!query) {
    return res.json({ users: [] });
  }

  try {
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase
        .from('users')
        .select('id,username,display_name,profile_picture')
        .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
        .limit(20);

      if (error) {
        throw error;
      }

      const users = await Promise.all(
        (data ?? [])
          .filter((user: any) => user.username !== currentUsername)
          .map(async (user: any) => ({
            id: user.id,
            username: user.username,
            displayName: user.display_name ?? user.username,
            profilePicture: user.profile_picture ?? null,
            relationship: currentUser ? await getFriendRelationship(currentUser.id, user.id) : 'none',
          })),
      );

      return res.json({ users });
    }

    const normalizedQuery = query.toLowerCase();
    const users = await Promise.all(
      inMemoryUsers
        .filter((user) =>
          user.username.toLowerCase().includes(normalizedQuery) ||
          user.display_name.toLowerCase().includes(normalizedQuery),
        )
        .filter((user) => user.username !== currentUsername)
        .slice(0, 20)
        .map(async (user) => ({
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          profilePicture: user.profile_picture,
          relationship: currentUser ? await getFriendRelationship(currentUser.id, user.id) : 'none',
        })),
    );

    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to search users' });
  }
});

app.get('/api/messages/sync', async (req: Request, res: Response) => {
  const chatId = typeof req.query.chat_id === 'string' ? req.query.chat_id.trim() : '';
  const lastSyncedAt = typeof req.query.last_synced_at === 'string' ? req.query.last_synced_at : new Date(0).toISOString();
  const currentUser = await getAuthenticatedUserFromRequest(req, true);

  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
  if (!chatId) return res.status(400).json({ error: 'Missing chat_id' });
  if (Number.isNaN(Date.parse(lastSyncedAt))) return res.status(400).json({ error: 'Invalid last_synced_at' });

  try {
    if (USE_SUPABASE && supabase) {
      const messageClient = getRequestSupabaseClient(req);
      if (!messageClient) return res.status(500).json({ error: 'Supabase client is not initialized' });
      const { data: thread, error: threadError } = await messageClient
        .from('chat_threads')
        .select('user_a,user_b')
        .eq('id', chatId)
        .maybeSingle();
      if (threadError) throw threadError;
      if (!thread || (thread.user_a !== currentUser.id && thread.user_b !== currentUser.id)) {
        return res.status(403).json({ error: 'Not a participant of this chat' });
      }

      const { data: canonicalMessages, error: canonicalError } = await messageClient
        .from('messages')
        .select('*')
        .eq('chat_id', chatId)
        .gt('created_at', lastSyncedAt)
        .order('created_at', { ascending: true });
      if (canonicalError) throw canonicalError;

      return res.json((canonicalMessages ?? []).map((message: any) => ({
        ...message,
        chatId: message.chat_id,
        senderId: message.sender_id,
        timestamp: message.created_at,
      })));
    }

    const isParticipant = inMemoryFriendRequests.some((request) => request.status === 'accepted' &&
      getChatIdForUsers(request.senderId, request.receiverId) === chatId &&
      (request.senderId === currentUser.id || request.receiverId === currentUser.id));
    if (!isParticipant) return res.status(403).json({ error: 'Not a participant of this chat' });

    return res.json(inMemoryPrivateMessages
      .filter((message) => message.chatId === chatId && message.created_at > lastSyncedAt)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .map((message) => ({
        ...message,
        chatId: message.chatId,
        senderId: message.sender_username,
        senderName: message.sender_display_name ?? message.sender_username,
        content: message.content,
        timestamp: message.created_at,
        status: 'delivered',
      })));
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message || 'Unable to sync messages' });
  }
});

app.get('/api/private-chats/:chatId/messages', async (req: Request, res: Response) => {
  const chatId = resolveRouteParam(req.params.chatId);
  if (!chatId) return res.status(400).json({ error: 'Missing chat id' });

  try {
    const currentUser = await getAuthenticatedUserFromRequest(req, true);
    if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
      const messages = await getPrivateMessagesForChat(chatId, currentUser.username, currentUser.id, req);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to load messages' });
  }
});

// Return or create canonical private chat id for two users (friend relationship must exist)
app.post('/api/private-chats', async (req: Request, res: Response) => {
  const { otherUsername, otherUserId } = req.body ?? {};
  const currentUsername = getAuthenticatedUsername(req);
  if (!currentUsername) return res.status(400).json({ error: 'Missing or invalid auth (require Authorization and x-username)' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    let otherUser = null;
    if (otherUserId) otherUser = await getUserById(otherUserId);
    else if (otherUsername) otherUser = await getUserByUsername(otherUsername);
    if (!otherUser) return res.status(404).json({ error: 'Other user not found' });

    const chatId = await findChatByParticipants(currentUser.id, otherUser.id);
    if (!chatId) return res.status(403).json({ error: 'No chat exists between these users' });
    res.json({ chatId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Unable to create/find chat' });
  }
});

// Mark message as read
app.put('/api/messages/:id/read', async (req: Request, res: Response) => {
  const messageId = resolveRouteParam(req.params.id);
  const currentUsername = getAuthenticatedUsername(req);
  
  if (!currentUsername) return res.status(401).json({ error: 'Unauthorized' });
  if (!messageId) return res.status(400).json({ error: 'Missing message id' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase
        .from('message_delivery')
        .update({ read_at: new Date().toISOString() })
        .eq('message_id', messageId)
        .eq('recipient_user_id', currentUser.id)
        .select('*')
        .maybeSingle();

      if (error) throw error;
      return res.json({ success: true, delivery: data });
    }

    // In-memory fallback: mark as read locally
    return res.json({ success: true, message: 'Message marked as read' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to mark message as read' });
  }
});

// Get unread message count for a chat
app.get('/api/private-chats/:chatId/unread', async (req: Request, res: Response) => {
  const chatId = resolveRouteParam(req.params.chatId);
  const currentUsername = getAuthenticatedUsername(req);
  
  if (!chatId) return res.status(400).json({ error: 'Missing chat id' });
  if (!currentUsername) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    if (USE_SUPABASE && supabase) {
      const { data: unreadRows, error: rowsError } = await supabase
        .from('messages')
        .select('id')
        .eq('chat_id', chatId)
        .neq('sender_id', currentUser.id);

      if (rowsError) throw rowsError;

      const messageIds = (unreadRows ?? []).map((row: any) => row.id);
      const { count, error } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('chat_id', chatId)
        .neq('sender_id', currentUser.id);

      if (error) throw error;

      const { data: unreadMessages, error: unreadError } = await supabase
        .from('message_delivery')
        .select('message_id')
        .eq('recipient_user_id', currentUser.id)
        .is('read_at', null)
        .in('message_id', messageIds);

      if (unreadError) throw unreadError;

      return res.json({ unreadCount: unreadMessages?.length ?? 0, totalMessages: count ?? 0 });
    }

    return res.json({ unreadCount: 0, totalMessages: 0 });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to get unread count' });
  }
});

// Block a user
app.post('/api/users/:userId/block', async (req: Request, res: Response) => {
  const blockedUserId = resolveRouteParam(req.params.userId);
  const currentUsername = getAuthenticatedUsername(req);
  
  if (!blockedUserId) return res.status(400).json({ error: 'Missing user id' });
  if (!currentUsername) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase
        .from('chat_blocks')
        .insert([{ blocker_id: currentUser.id, blocked_id: blockedUserId }])
        .select('*')
        .maybeSingle();

      if (error) throw error;
      return res.json({ success: true, block: data });
    }

    return res.json({ success: true, message: 'User blocked' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to block user' });
  }
});

// Unblock a user
app.delete('/api/users/:userId/block', async (req: Request, res: Response) => {
  const blockedUserId = resolveRouteParam(req.params.userId);
  const currentUsername = getAuthenticatedUsername(req);
  
  if (!blockedUserId) return res.status(400).json({ error: 'Missing user id' });
  if (!currentUsername) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from('chat_blocks')
        .delete()
        .eq('blocker_id', currentUser.id)
        .eq('blocked_id', blockedUserId);

      if (error) throw error;
      return res.json({ success: true, message: 'User unblocked' });
    }

    return res.json({ success: true, message: 'User unblocked' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to unblock user' });
  }
});

// Mute a chat
app.put('/api/private-chats/:chatId/mute', async (req: Request, res: Response) => {
  const chatId = resolveRouteParam(req.params.chatId);
  const currentUsername = getAuthenticatedUsername(req);
  
  if (!chatId) return res.status(400).json({ error: 'Missing chat id' });
  if (!currentUsername) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase
        .from('chat_mutes')
        .insert([{ user_id: currentUser.id, chat_id: chatId }])
        .select('*')
        .maybeSingle();

      if (error && !error.message.includes('duplicate')) throw error;
      return res.json({ success: true, message: 'Chat muted' });
    }

    return res.json({ success: true, message: 'Chat muted' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to mute chat' });
  }
});

// Unmute a chat
app.delete('/api/private-chats/:chatId/mute', async (req: Request, res: Response) => {
  const chatId = resolveRouteParam(req.params.chatId);
  const currentUsername = getAuthenticatedUsername(req);
  
  if (!chatId) return res.status(400).json({ error: 'Missing chat id' });
  if (!currentUsername) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const currentUser = await getUserByUsername(currentUsername);
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from('chat_mutes')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('chat_id', chatId);

      if (error) throw error;
      return res.json({ success: true, message: 'Chat unmuted' });
    }

    return res.json({ success: true, message: 'Chat unmuted' });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unable to unmute chat' });
  }
});

if (!isTestRuntime) {
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[startup] Port ${API_PORT} is already in use. Stop the existing backend or set API_PORT to another port.`);
      process.exitCode = 1;
      return;
    }
    console.error('[startup] Backend server error:', error.message);
    process.exitCode = 1;
  });
  server.listen(API_PORT, () => {
    console.log(`Backend running on http://localhost:${API_PORT}`);
  });

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}`);
    try {
      await socketServer.close();
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      console.error('[shutdown] failed gracefully:', (error as Error)?.message || error);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
}

export async function sendMessageController({
  senderId,
  receiverId,
  content,
  chatId,
  type = 'text',
  senderDisplayName,
  socketMap = socketUserIdMap,
}: {
  senderId: string;
  receiverId: string;
  content: string;
  chatId?: string | null;
  type?: string;
  senderDisplayName?: string | null;
  socketMap?: Map<string, string>;
}) {
  const messageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  try {
    const transactionResult = await persistMessageWithTransaction({
      saveMessage: async () => {
        const resolvedChatId = chatId ?? `chat-${[senderId, receiverId].sort().join('-')}`;

        if (USE_SUPABASE && supabase) {
          const savedId = await saveMessage(supabase, {
            id: messageId,
            chat_id: resolvedChatId,
            sender_id: senderId,
            content,
            status: 'sent',
            created_at: timestamp,
            client_message_id: messageId,
          }, messageId);
          if (savedId) return;
        }

        inMemoryPrivateMessages.push({
          id: messageId,
          chatId: resolvedChatId,
          sender_username: senderId,
          sender_display_name: senderDisplayName ?? null,
          content,
          created_at: timestamp,
          updated_at: timestamp,
          edited: false,
          reply_to: null,
        });
      },
      updateConversationLastMessage: async () => {
        if (USE_SUPABASE && supabase) {
          const targetChatId = chatId ?? `chat-${[senderId, receiverId].sort().join('-')}`;
          const { error } = await supabase.from('chat_threads').update({ updated_at: timestamp }).eq('id', targetChatId);
          if (error) throw error;
          return;
        }
      },
      messageId,
      senderId,
      receiverId,
      content,
      type,
      timestamp,
      socketMap,
    });

    if (!transactionResult.ok) {
      return transactionResult;
    }

    if (!transactionResult.offline && transactionResult.receiverSocketId) {
      const canonicalPayload = {
        id: transactionResult.message?.id ?? messageId,
        room: chatId ?? `chat-${[senderId, receiverId].sort().join('-')}`,
        chatId: chatId ?? `chat-${[senderId, receiverId].sort().join('-')}`,
        senderId,
        senderName: senderDisplayName ?? senderId,
        content,
        timestamp,
        status: 'sent',
      };

      io.to(transactionResult.receiverSocketId).emit('message_received', canonicalPayload);
    }

    return transactionResult;
  } catch (error) {
    console.error('sendMessageController failed:', error);
    return { ok: false, error: (error as Error).message || 'Unable to send message' };
  }
}

app.post('/api/messages', async (req: Request, res: Response) => {
  const { senderId, receiverId, content, type, chatId, senderDisplayName } = req.body ?? {};
  const username = getAuthenticatedUsername(req);

  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  if (!senderId || !receiverId || !content) {
    return res.status(400).json({ error: 'senderId, receiverId and content are required' });
  }

  const result = await sendMessageController({
    senderId,
    receiverId,
    content,
    chatId,
    type: type ?? 'text',
    senderDisplayName,
  });

  if (!result.ok) return res.status(500).json({ error: result.error ?? 'Unable to send message' });
  return res.status(200).json(result);
});

