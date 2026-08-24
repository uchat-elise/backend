import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { saveMessage } from './message-persistence';

const DEFAULT_PORT = Number(process.env.API_PORT || process.env.PORT || 3000);
const DEFAULT_PATH = '/api/socket.io';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const activeSockets = new Map<string, Socket>();
export const socketUserIdMap = new Map<string, string>();

type SocketHandshake = {
  auth?: { token?: unknown };
  headers?: Record<string, string | string[] | undefined>;
};

type AuthResult = {
  ok: boolean;
  code?: 'INVALID_TOKEN' | 'USER_NOT_FOUND';
  error?: string;
  userId?: string;
  username?: string;
};

type SupabaseUser = { id: string; user_metadata?: Record<string, unknown>; email?: string };

type MessageSendErrorCode = 'UNAUTHORIZED' | 'NOT_A_PARTICIPANT' | 'MESSAGE_PERSIST_FAILED';

type AuthenticatedSocketData = {
  userId: string;
  username: string | null;
  supabase: SupabaseClient | null;
  room?: string;
};

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseBearer(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('Bearer ')
    ? value.slice('Bearer '.length).trim()
    : null;
}

function readSessionPayload(token: string): { userId: string; username?: string } | null {
  if (!token.startsWith('uchat_')) return null;
  const tokenBody = token.slice('uchat_'.length);
  const separator = tokenBody.lastIndexOf('.');
  if (separator <= 0) throw new Error('Invalid session token');

  const payloadSegment = tokenBody.slice(0, separator);
  const signature = tokenBody.slice(separator + 1);
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET || 'uchat-development-session-secret';
  const expectedSignature = crypto.createHmac('sha256', secret).update(payloadSegment).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('Invalid session token signature');
  }

  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
    userId?: string;
    username?: string;
    expiresAt?: number;
  };
  if (!payload.userId || (payload.expiresAt !== undefined && payload.expiresAt <= Date.now())) {
    throw new Error('Session token expired or missing user ID');
  }
  return { userId: payload.userId, username: payload.username };
}

export function parseSocketAuthToken(handshake: SocketHandshake = {}): string | null {
  const authToken = typeof handshake.auth?.token === 'string' ? handshake.auth.token : null;
  const headers = handshake.headers ?? {};
  return authToken || parseBearer(headers.authorization) || parseBearer(headers.Authorization) || null;
}

function readJwtPayload(token: string): Record<string, unknown> {
  const secret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || 'uchat-development-jwt-secret';
  return jwt.verify(token, secret, { algorithms: ['HS256', 'HS384', 'HS512'] }) as Record<string, unknown>;
}

async function resolveAuthenticatedUser(
  token: string,
  supabase: SupabaseClient | null,
): Promise<{ userId: string; username?: string }> {
  const session = readSessionPayload(token);
  if (session) {
    if (!isUuid(session.userId)) throw new Error('Session token has no valid UUID user ID');
    return session;
  }

  let payload: Record<string, unknown>;
  let authUser: SupabaseUser | null = null;

  if (supabase) {
    try {
      payload = readJwtPayload(token);
    } catch {
      const result = await supabase.auth.getUser(token);
      if (result.error || !result.data.user) throw new Error('JWT could not be verified');
      authUser = result.data.user as SupabaseUser;
      payload = { sub: authUser.id, ...authUser.user_metadata };
    }
  } else {
    payload = readJwtPayload(token);
  }

  const claimedId = typeof payload.sub === 'string' ? payload.sub : '';
  const claimedUsername = typeof payload.username === 'string'
    ? payload.username.trim()
    : typeof payload.user_name === 'string' ? payload.user_name.trim() : '';
  if (!claimedId) throw new Error('JWT payload has no subject');

  if (!supabase) return { userId: claimedId, username: claimedUsername || undefined };

  const query = supabase.from('users').select('id,username');
  const { data, error } = claimedUsername
    ? await query.ilike('username', claimedUsername).maybeSingle()
    : await query.eq('id', claimedId).maybeSingle();
  if (error) throw new Error(`Unable to resolve authenticated user: ${error.message}`);
  if (!data?.id || !isUuid(data.id) || data.id !== claimedId) throw new Error('Authenticated user was not found');
  return { userId: data.id, username: data.username ?? authUser?.email?.split('@')[0] };
}

export async function verifySocketAuthToken(
  handshake: SocketHandshake = {},
  supabaseClient: SupabaseClient | null = null,
): Promise<AuthResult> {
  const token = parseSocketAuthToken(handshake);
  if (!token) return { ok: false, code: 'INVALID_TOKEN', error: 'Missing auth token' };
  try {
    const user = await resolveAuthenticatedUser(token, supabaseClient);
    return { ok: true, ...user };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid auth token';
    return { ok: false, code: message.includes('not found') ? 'USER_NOT_FOUND' : 'INVALID_TOKEN', error: message };
  }
}

export function getPrivateRoomId(userIdA: string, userIdB: string): string {
  if (!userIdA || !userIdB || userIdA === userIdB) {
    throw new Error('Two distinct user IDs are required');
  }
  return `private_${[userIdA, userIdB].sort().join('_')}`;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function getMessageSendError(error: unknown): { code: MessageSendErrorCode; reason: string } {
  const message = error instanceof Error ? error.message : 'Unable to persist message';
  if (/JWT|auth|unauthori[sz]|42501/i.test(message)) {
    return { code: 'UNAUTHORIZED', reason: 'Unauthorized' };
  }
  if (/participant|row-level security|chat/i.test(message)) {
    return { code: 'NOT_A_PARTICIPANT', reason: 'Not a participant of this chat' };
  }
  return { code: 'MESSAGE_PERSIST_FAILED', reason: message };
}

async function createAuthenticatedSupabaseClient(
  supabaseUrl: string,
  supabaseAnonKey: string,
  accessToken: string,
): Promise<SupabaseClient> {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { error } = await client.auth.setSession({ access_token: accessToken, refresh_token: '' });
  if (error) throw new Error(`Supabase authentication failed: ${error.message}`);
  return client;
}

async function attachRedisAdapter(io: Server) {
  const redisUrl = process.env.REDIS_URL || process.env.REDIS;
  if (!redisUrl) return null;
  const pubClient = new IORedis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000, retryStrategy: () => null });
  const subClient = pubClient.duplicate();
  try {
    await Promise.all([pubClient.ping(), subClient.ping()]);
    io.adapter(createAdapter(pubClient, subClient));
    return { pubClient, subClient };
  } catch (error) {
    pubClient.disconnect();
    subClient.disconnect();
    if (process.env.REDIS_REQUIRED === 'true') throw error;
    console.warn('[redis] unavailable; continuing without Redis adapter');
    return null;
  }
}

export interface SocketServerOptions {
  port?: number;
  path?: string;
  corsOrigin?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
  supabaseServiceRoleKey?: string;
  httpServer?: http.Server;
  persistMessage?: (message: { id: string; room: string; senderId: string; content: string; timestamp: string }) => Promise<void>;
}

export interface SocketServerRuntime {
  httpServer: http.Server;
  io: Server;
  redis: { pubClient: IORedis; subClient: IORedis } | null;
  close(): Promise<void>;
}

export async function createSocketServer(options: SocketServerOptions = {}): Promise<SocketServerRuntime> {
  const isTestMode = process.env.E2E_TEST_MODE === 'true' || process.env.NODE_ENV === 'test';
  const supabaseUrl = options.supabaseUrl ?? process.env.SUPABASE_URL;
  const supabaseKey = options.supabaseKey ?? process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_KEY;
  const supabaseServiceRoleKey = options.supabaseServiceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if ((!supabaseUrl || !supabaseKey) && !isTestMode) throw new Error('Missing required Supabase environment variables: SUPABASE_URL and SUPABASE_KEY or SUPABASE_ANON_KEY.');

  const ownsHttpServer = !options.httpServer;
  const httpServer = options.httpServer ?? http.createServer();
  const io = new Server(httpServer, {
    path: options.path ?? DEFAULT_PATH,
    cors: { origin: options.corsOrigin ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173', credentials: true },
    transports: ['websocket', 'polling'],
  });
  const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } }) : null;
  const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } })
    : null;
  const intervals = new Set<ReturnType<typeof setInterval>>();

  io.use(async (socket, next) => {
    const token = parseSocketAuthToken(socket.handshake);
    const result = await verifySocketAuthToken(socket.handshake, supabase);
    console.log('[socket auth]', { socketId: socket.id, hasToken: Boolean(token), ok: result.ok, code: result.code, error: result.ok ? undefined : result.error });
    if (!result.ok || !result.userId) {
      const error = new Error(result.error ?? 'Unauthorized') as Error & { data?: unknown };
      error.data = { code: result.code ?? 'INVALID_TOKEN', status: 401 };
      next(error);
      return;
    }
    let userSupabase: SupabaseClient | null = null;
    if (supabaseUrl && supabaseKey && token) {
      try {
        try {
          readJwtPayload(token);
          userSupabase = supabase;
        } catch {
          userSupabase = await createAuthenticatedSupabaseClient(supabaseUrl, supabaseKey, token);
        }
      } catch (error) {
        const authError = new Error(error instanceof Error ? error.message : 'Supabase authentication failed') as Error & { data?: unknown };
        authError.data = { code: 'INVALID_TOKEN', status: 401 };
        next(authError);
        return;
      }
    }
    const data = socket.data as AuthenticatedSocketData;
    data.userId = result.userId;
    data.username = result.username ?? null;
    data.supabase = userSupabase;
    next();
  });

  io.on('connection', (socket) => {
    const data = socket.data as AuthenticatedSocketData;
    const userId = data.userId;
    activeSockets.set(socket.id, socket);
    socketUserIdMap.set(userId, socket.id);

    socket.on('join_room', async (payload: unknown, ack?: (response: unknown) => void) => {
      if (!payload || typeof payload !== 'object' || !hasOnlyKeys(payload as Record<string, unknown>, ['room'])) {
        ack?.({ ok: false, code: 'INVALID_PAYLOAD' });
        socket.emit('room_error', { code: 'INVALID_PAYLOAD', message: 'join_room requires { room }' });
        return;
      }
      const room = typeof (payload as { room?: unknown }).room === 'string' ? (payload as { room: string }).room.trim() : '';
      if (!room) {
        ack?.({ ok: false, code: 'ROOM_NOT_FOUND' });
        socket.emit('room_error', { code: 'ROOM_NOT_FOUND', message: 'Room is required' });
        return;
      }
      const roomClient = supabaseAdmin ?? data.supabase;
      if (roomClient) {
        const { data: thread, error } = await roomClient.from('chat_threads').select('id').eq('id', room).or(`user_a.eq.${userId},user_b.eq.${userId}`).maybeSingle();
        if (error || !thread) {
          ack?.({ ok: false, code: 'ROOM_NOT_FOUND' });
          socket.emit('room_error', { code: 'ROOM_NOT_FOUND', message: 'Room not found or access denied' });
          return;
        }
      }
      await socket.join(room);
      data.room = room;
      const response = { ok: true, room };
      ack?.(response);
      socket.emit('room_joined', response);
    });

    socket.on('leave_room', (payload: unknown, ack?: (response: unknown) => void) => {
      if (!payload || typeof payload !== 'object' || !hasOnlyKeys(payload as Record<string, unknown>, ['room'])) {
        ack?.({ ok: false, code: 'INVALID_PAYLOAD' });
        return;
      }
      const room = typeof (payload as { room?: unknown }).room === 'string' ? (payload as { room: string }).room.trim() : '';
      if (!room || data.room !== room) {
        ack?.({ ok: false, code: 'ROOM_NOT_JOINED' });
        return;
      }
      void socket.leave(room);
      delete data.room;
      ack?.({ ok: true, room });
    });

    socket.on('send_message', async (payload: unknown, ack?: (response: unknown) => void) => {
      if (!payload || typeof payload !== 'object' || !hasOnlyKeys(payload as Record<string, unknown>, ['room', 'content', 'clientMessageId'])) {
        ack?.({ ok: false, code: 'INVALID_PAYLOAD' });
        return;
      }
      const message = payload as { room?: unknown; content?: unknown; clientMessageId?: unknown };
      const room = typeof message.room === 'string' ? message.room.trim() : '';
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      const clientMessageId = typeof message.clientMessageId === 'string' ? message.clientMessageId : undefined;
      if (!room || !content || data.room !== room || !socket.rooms.has(room)) {
        ack?.({ ok: false, code: 'ROOM_NOT_JOINED' });
        return;
      }
      if (!data.supabase && !options.persistMessage) {
        const response = { ok: false, code: 'UNAUTHORIZED', reason: 'Unauthorized' };
        socket.emit('message_send_error', response);
        ack?.(response);
        return;
      }
      const canonical = { id: crypto.randomUUID(), room, senderId: userId, senderUsername: data.username ?? undefined, content, clientMessageId, timestamp: new Date().toISOString() };
      try {
        if (options.persistMessage) await options.persistMessage(canonical);
        else await saveMessage(data.supabase as SupabaseClient, { id: canonical.id, chat_id: room, sender_id: userId, content, created_at: canonical.timestamp, client_message_id: clientMessageId ?? canonical.id });
      } catch (error) {
        const failure = getMessageSendError(error);
        const response = { ok: false, code: failure.code, reason: failure.reason };
        socket.emit('message_send_error', response);
        ack?.(response);
        return;
      }
      io.to(room).emit('message_received', canonical);
      ack?.({ ok: true, message: canonical });
    });

    socket.on('mark_as_read', (payload: unknown, ack?: (response: unknown) => void) => {
      if (!payload || typeof payload !== 'object' || !hasOnlyKeys(payload as Record<string, unknown>, ['room', 'messageId'])) {
        ack?.({ ok: false, code: 'INVALID_PAYLOAD' });
        return;
      }
      ack?.({ ok: true, status: 'accepted' });
    });

    const heartbeat = setInterval(() => socket.emit('heartbeat', { serverTime: Date.now() }), 20_000);
    intervals.add(heartbeat);
    socket.on('disconnect', () => {
      clearInterval(heartbeat);
      intervals.delete(heartbeat);
      activeSockets.delete(socket.id);
      if (socketUserIdMap.get(userId) === socket.id) socketUserIdMap.delete(userId);
    });
  });

  const redis = await attachRedisAdapter(io);
  if (ownsHttpServer) await new Promise<void>((resolve) => httpServer.listen(options.port ?? DEFAULT_PORT, resolve));
  return {
    httpServer,
    io,
    redis,
    async close() {
      for (const interval of intervals) clearInterval(interval);
      intervals.clear();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (ownsHttpServer && httpServer.listening) await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      for (const client of [redis?.pubClient, redis?.subClient].filter((item): item is IORedis => Boolean(item))) await client.quit().catch(() => undefined);
    },
  };
}

export async function startServer() {
  return createSocketServer();
}

export default createSocketServer;
