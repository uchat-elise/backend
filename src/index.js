import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import { getFriendRelationship, resolveTargetUser } from './friend-requests.js';
import { EmailService } from './email-service.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  path: '/api/socket.io',
  cors: { origin: 'http://localhost:5173', credentials: true },
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const API_PORT = Number(process.env.API_PORT || process.env.PORT || 3001);
let useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
let supabaseReady = false;
let useSupabaseSessionStorage = false;
const APP_URL = process.env.APP_URL;
const emailService = new EmailService();
const VERIFICATION_TOKEN_TTL_MS = 15 * 60 * 1000;

const supabase = useSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

const ensureSupabaseReady = async () => {
  if (!useSupabase || !supabase) return;
  try {
    const { error: usersError } = await supabase.from('users').select('id').limit(1).maybeSingle();
    if (usersError) {
      console.warn('Supabase users table not available, falling back to in-memory storage:', usersError.message);
      useSupabase = false;
      return;
    }

    const { error: sessionsError } = await supabase.from('sessions').select('id').limit(1).maybeSingle();
    if (sessionsError) {
      console.warn('Supabase sessions table not available; using in-memory session store only:', sessionsError.message);
      useSupabaseSessionStorage = false;
    } else {
      useSupabaseSessionStorage = true;
    }

    supabaseReady = true;
    console.log('Supabase backend ready.', useSupabaseSessionStorage ? 'Session storage enabled.' : 'Session storage disabled.');
  } catch (error) {
    console.warn('Supabase initialization failed, using in-memory storage instead.', error instanceof Error ? error.message : error);
    useSupabase = false;
    useSupabaseSessionStorage = false;
  }
};

const inMemoryUsers = [];
const inMemoryRooms = [];
const inMemoryRoomMembers = [];
const inMemoryRoomMessages = [];
const pendingUploads = new Map();
const sessions = new Map();
const liveShareSessions = new Map();
const inMemoryPrivateChats = [];
const inMemoryPrivateMessages = [];
const privateTypingStates = new Map();
const userSocketMap = new Map();
const pendingLiveShareSignals = new Map();
const inMemoryFriendRequests = [];
const inMemoryRefreshTokens = new Map();
// token blacklist for JWT-style tokens or short-lived invalidation. Map<token, expiresAtMs>
const tokenBlacklist = new Map();

// Periodically clean expired blacklist entries
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tokenBlacklist.entries()) {
    if (exp <= now) tokenBlacklist.delete(t);
  }
}, 60_000).unref();

const STORAGE_ROOT = path.resolve('storage');
const UPLOAD_ROOT = path.join(STORAGE_ROOT, 'uploads');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  filename: (_req, file, cb) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const allowedContentTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);

const runVirusScanPlaceholder = async (filePath) => {
  console.info(`Virus scan placeholder passed for ${path.basename(filePath)}`);
  return true;
};

app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/], credentials: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

const buildErrorResponse = (code, message, details = null) => ({
  success: false,
  error: { code, message, details },
});

const mapErrorToResponse = (error, fallbackMessage = 'Something went wrong') => {
  if (error?.statusCode && error?.code) {
    return { statusCode: error.statusCode, ...buildErrorResponse(error.code, error.message || fallbackMessage, error.details ?? null) };
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes('duplicate') || lower.includes('already exists') || lower.includes('unique constraint')) {
      return { statusCode: 409, ...buildErrorResponse('DUPLICATE_RESOURCE', 'That item already exists.', error.message) };
    }
    if (lower.includes('not found')) {
      return { statusCode: 404, ...buildErrorResponse('NOT_FOUND', 'The requested resource was not found.', error.message) };
    }
    if (lower.includes('unauthorized') || lower.includes('not authenticated')) {
      return { statusCode: 401, ...buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', error.message) };
    }
    if (lower.includes('forbidden') || lower.includes('permission')) {
      return { statusCode: 403, ...buildErrorResponse('FORBIDDEN', 'You do not have permission to perform that action.', error.message) };
    }
  }

  return { statusCode: 500, ...buildErrorResponse('INTERNAL_ERROR', fallbackMessage, error instanceof Error ? error.message : null) };
};

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((error) => next(error));

const publicApiRoutes = new Set([
  '/healthz',
  '/test/cleanup',
  '/auth/register',
  '/auth/login',
  '/auth/logout',
  '/auth/verify-email',
  '/auth/resend-verification',
  '/auth/forgot-password',
  '/auth/reset-password',
]);

const protect = async (req, res, next) => {
  const token = getSessionTokenFromRequest(req);
  if (!token || tokenBlacklist.has(token)) {
    return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', 'Please sign in and try again.'));
  }

  let userId = sessions.get(token);
  if (!userId && useSupabase) {
    userId = await loadSessionUserIdFromDatabase(token);
    if (userId) {
      sessions.set(token, userId);
    }
  }

  if (!userId) {
    return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', 'Please sign in and try again.'));
  }

  req.userId = userId;
  next();
};

const authGuard = asyncHandler(async (req, res, next) => {
  if (req.path === '/healthz' || publicApiRoutes.has(req.path) || req.path.startsWith('/storage/')) {
    return next();
  }
  return protect(req, res, next);
});

app.use('/api', authGuard);

ensureSupabaseReady();

if (!useSupabase) {
  console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set or Supabase is unavailable. Using in-memory fallback database.');
}

app.get('/api/healthz', (_req, res) => res.json({ ok: true }));

// Idempotent logout endpoint: revoke current access token and optional refresh token.
app.post('/api/auth/logout', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const authHeader = req.headers.authorization;
  const token = typeof authHeader === 'string' ? authHeader.split(' ')[1] : null;
  const { refreshToken } = req.body ?? {};

  try {
    if (token) {
      // Determine expiry for blacklist entry (best-effort from DB session expires_at)
      let expiryMs = Date.now() + (Number(process.env.SESSION_TTL_MS) || 60 * 60 * 1000); // default 1h
      if (supabase && useSupabase) {
        try {
          const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
          // fetch session to obtain expires_at
          const { data: sessionRow } = await supabase.from('sessions').select('expires_at').eq('token_hash', tokenHash).maybeSingle();
          if (sessionRow?.expires_at) {
            const exp = new Date(sessionRow.expires_at).getTime();
            if (!Number.isNaN(exp) && exp > Date.now()) expiryMs = exp;
          }
          await supabase.from('sessions').update({ revoked_at: new Date().toISOString() }).eq('token_hash', tokenHash);
        } catch (e) {
          console.warn('Failed to revoke DB session (best-effort):', e instanceof Error ? e.message : e);
        }
      }

      // Add to in-memory blacklist until expiry to defend against JWT replay across nodes
      try {
        tokenBlacklist.set(token, expiryMs);
      } catch (e) {
        // ignore
      }

      // In-memory session store: remove the token so it's invalidated for this server instance
      if (sessions.has(token)) sessions.delete(token);
    }

    if (refreshToken) {
      if (supabase && useSupabase) {
        try {
          const refreshHash = crypto.createHash('sha256').update(String(refreshToken)).digest('hex');
          await supabase.from('refresh_tokens').update({ revoked_at: new Date().toISOString() }).eq('token_hash', refreshHash);
        } catch (e) {
          console.warn('Failed to revoke DB refresh token (best-effort):', e instanceof Error ? e.message : e);
        }
      }
      if (inMemoryRefreshTokens.has(refreshToken)) inMemoryRefreshTokens.delete(refreshToken);
    }
  } catch (err) {
    console.warn('Logout cleanup error:', err instanceof Error ? err.message : err);
  }

  // Always return 200 OK to keep the operation idempotent from the client's perspective
  return res.status(200).json({ success: true, message: 'Logged out' });
});

app.delete('/api/test/cleanup', asyncHandler(async (req, res) => {
  if (process.env.E2E_TEST_MODE !== 'true') return res.status(404).end();

  const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames.filter((value) => typeof value === 'string') : [];
  if (usernames.length === 0) return res.status(400).json({ error: 'At least one username is required' });

  const usersToRemove = inMemoryUsers.filter((user) => usernames.includes(user.username));
  const removedIds = new Set(usersToRemove.map((user) => user.id));

  if (useSupabase && supabase) {
    const { error } = await supabase.from('users').delete().in('username', usernames);
    if (error) return res.status(500).json({ error: error.message });
  }

  for (let index = inMemoryUsers.length - 1; index >= 0; index -= 1) {
    if (usernames.includes(inMemoryUsers[index].username)) inMemoryUsers.splice(index, 1);
  }
  for (let index = inMemoryFriendRequests.length - 1; index >= 0; index -= 1) {
    const request = inMemoryFriendRequests[index];
    if (removedIds.has(request.senderId) || removedIds.has(request.receiverId)) inMemoryFriendRequests.splice(index, 1);
  }
  for (let index = inMemoryPrivateMessages.length - 1; index >= 0; index -= 1) {
    if (removedIds.has(inMemoryPrivateMessages[index].senderId)) inMemoryPrivateMessages.splice(index, 1);
  }

  for (const [token, userId] of sessions) {
    if (removedIds.has(userId)) sessions.delete(token);
  }

  return res.json({ ok: true });
}));

app.post('/api/friends/requests', asyncHandler(async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) return res.status(401).json({ error: 'Not authenticated' });

  const { targetUserId, targetUsername } = req.body ?? {};
  console.log('[api/friends/requests] incoming', {
    currentUserId,
    targetUserId: typeof targetUserId === 'string' ? targetUserId : null,
    targetUsername: typeof targetUsername === 'string' ? targetUsername : null,
    useSupabase,
  });

  if (!targetUserId && !targetUsername) return res.status(400).json({ error: 'Missing target user' });

  let resolvedTargetUser = null;
  try {
    if (typeof targetUserId === 'string' && targetUserId.trim()) {
      resolvedTargetUser = await loadUserById(targetUserId);
    } else if (typeof targetUsername === 'string' && targetUsername.trim()) {
      resolvedTargetUser = await loadUserByUsername(targetUsername);
    }
  } catch (error) {
    console.error('[api/friends/requests] user lookup failed', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'User lookup failed' });
  }

  if (!resolvedTargetUser) return res.status(404).json({ error: 'User not found' });
  if (resolvedTargetUser.id === currentUserId) return res.status(400).json({ error: 'Cannot send a request to yourself' });

  const resolvedTargetId = resolvedTargetUser.id;
  const existingRequest = inMemoryFriendRequests.find((request) =>
    (request.senderId === currentUserId && request.receiverId === resolvedTargetId) ||
    (request.senderId === resolvedTargetId && request.receiverId === currentUserId),
  );

  if (existingRequest) {
    if (existingRequest.status === 'pending') return res.status(409).json({ error: 'Request already sent' });
    if (existingRequest.status === 'accepted') return res.status(409).json({ error: 'You are already friends' });
  }

  const request = {
    id: crypto.randomUUID(),
    senderId: currentUserId,
    receiverId: resolvedTargetId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  inMemoryFriendRequests.push(request);

  const currentUser = await loadUserById(currentUserId);
  const payload = {
    id: request.id,
    senderId: request.senderId,
    receiverId: request.receiverId,
    status: request.status,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    sender: currentUser ? mapUser(currentUser) : { id: currentUserId },
    receiver: mapUser(resolvedTargetUser),
  };

  emitToUser(resolvedTargetId, 'friend_request_received', { request: payload });
  return res.json({ message: 'Friend request sent', request: payload });
}));

app.get('/api/friends/requests', asyncHandler(async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) return res.status(401).json({ error: 'Not authenticated' });

  const statusFilter = req.query.status;
  const requests = inMemoryFriendRequests
    .filter((request) => (request.senderId === currentUserId || request.receiverId === currentUserId) && (!statusFilter || request.status === statusFilter))
    .map((request) => ({
      ...request,
      sender: mapUser(getUserById(request.senderId)),
      receiver: mapUser(getUserById(request.receiverId)),
    }));

  return res.json({ requests });
}));

app.post('/api/friends/requests/:requestId/accept', asyncHandler(async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) return res.status(401).json({ error: 'Not authenticated' });

  const request = getFriendRequestById(req.params.requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.receiverId !== currentUserId) return res.status(403).json({ error: 'You cannot accept this request' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is no longer pending' });

  request.status = 'accepted';
  request.updatedAt = new Date().toISOString();
  const chat = ensurePrivateChatForUsers(request.senderId, request.receiverId);

  const payload = {
    requestId: request.id,
    status: request.status,
    senderId: request.senderId,
    receiverId: request.receiverId,
  };

  emitToUser(request.senderId, 'friend_request_updated', payload);
  emitToUser(request.receiverId, 'friend_request_updated', payload);

  return res.json({ message: 'Friend request accepted', chat: { id: chat.id } });
}));

app.post('/api/friends/requests/:requestId/decline', asyncHandler(async (req, res) => {
  const currentUserId = getSessionUserId(req);
  if (!currentUserId) return res.status(401).json({ error: 'Not authenticated' });

  const request = getFriendRequestById(req.params.requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.receiverId !== currentUserId) return res.status(403).json({ error: 'You cannot decline this request' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request is no longer pending' });

  request.status = 'rejected';
  request.updatedAt = new Date().toISOString();

  const payload = {
    requestId: request.id,
    status: request.status,
    senderId: request.senderId,
    receiverId: request.receiverId,
  };

  emitToUser(request.senderId, 'friend_request_updated', payload);
  emitToUser(request.receiverId, 'friend_request_updated', payload);

  return res.json({ message: 'Friend request declined' });
}));

app.post('/api/uploads', uploadMiddleware.single('file'), async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  if (!req.file) return res.status(400).json({ error: 'Missing file upload' });
  if (!allowedContentTypes.has(req.file.mimetype)) {
    fs.unlinkSync(req.file.path);
    return res.status(415).json({ error: 'Unsupported content type' });
  }

  try {
    const didScan = await runVirusScanPlaceholder(req.file.path);
    if (!didScan) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'File scan failed' });
    }

    const publicUrl = `/api/storage/uploads/${encodeURIComponent(path.basename(req.file.path))}`;
    return res.json({
      ok: true,
      file: {
        id: crypto.randomUUID(),
        fileName: req.file.originalname,
        storedName: path.basename(req.file.path),
        mimeType: req.file.mimetype,
        size: req.file.size,
        url: publicUrl,
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Upload failed' });
  }
});

app.post('/api/live-share/signaling', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { roomId, toUserId, type, payload } = req.body;
  if (!roomId || !toUserId || !type || payload === undefined) {
    return res.status(400).json({ error: 'Missing signaling payload' });
  }

  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const signal = {
    id: crypto.randomUUID(),
    roomId,
    fromUserId: userId,
    toUserId,
    type,
    payload,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  const key = `${roomId}:${toUserId}`;
  const existing = pendingLiveShareSignals.get(key) ?? [];
  pendingLiveShareSignals.set(key, [...existing, signal].slice(-20));

  return res.json({ signal });
});

app.get('/api/live-share/signaling/:roomId', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const key = `${roomId}:${userId}`;
  const pending = (pendingLiveShareSignals.get(key) ?? []).filter((signal) => new Date(signal.expiresAt) > new Date());
  pendingLiveShareSignals.delete(key);

  return res.json({ signals: pending });
});

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
};

const verifyPassword = (password, storedHash) => {
  const [algorithm, salt, expected] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
};

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const normalizeUsername = (value) => String(value ?? '').trim().toLowerCase();
const escapeIlike = (value) => String(value).replace(/[%_\\]/g, '\\$&');

const createSessionToken = async (userId) => {
  const token = crypto.randomUUID();
  if (useSupabase && supabase && useSupabaseSessionStorage) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = process.env.SESSION_TTL_MS
      ? new Date(Date.now() + Number(process.env.SESSION_TTL_MS)).toISOString()
      : null;

    const { error } = await supabase.from('sessions').insert([{
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    }]);

    if (error) {
      console.warn('Supabase session insert failed, falling back to in-memory session store:', error.message);
      useSupabaseSessionStorage = false;
    }
  }

  sessions.set(token, userId);
  return token;
};

const mapUser = (user) => ({
  id: user.id,
  email: user.email,
  username: user.username,
  displayName: user.display_name,
  profilePicture: user.profile_picture ?? null,
  createdAt: user.created_at,
});

const getSessionTokenFromRequest = (req) => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string') return null;
  const [, token] = authHeader.split(' ');
  return token ?? null;
};

const loadSessionUserIdFromDatabase = async (token) => {
  if (!useSupabase || !supabase || !useSupabaseSessionStorage || !token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const { data: sessionRow, error } = await supabase
      .from('sessions')
      .select('user_id,expires_at,revoked_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (error) {
      console.warn('Failed to resolve session token from database, ignoring DB session store:', error.message);
      useSupabaseSessionStorage = false;
      return null;
    }
    if (!sessionRow || sessionRow.revoked_at) return null;
    if (sessionRow.expires_at && new Date(sessionRow.expires_at) <= new Date()) return null;
    return sessionRow.user_id;
  } catch (error) {
    console.warn('Failed to resolve session token from database, ignoring DB session store:', error instanceof Error ? error.message : error);
    useSupabaseSessionStorage = false;
    return null;
  }
};

const createVerificationToken = async (userId) => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();

  if (useSupabase) {
    const { error } = await supabase.from('email_verification_tokens').insert([{
      user_id: userId,
      token: tokenHash,
      expires_at: expiresAt,
      used: false,
    }]);
    if (error) throw new Error(`Failed to store verification token: ${error.message}`);
    return token;
  }

  const user = inMemoryUsers.find((candidate) => candidate.id === userId);
  if (!user) throw new Error('User not found while creating verification token');
  user.verification_token = tokenHash;
  user.token_expires_at = expiresAt;
  return token;
};

const getSessionUserId = (req) => {
  if (req.userId) return req.userId;
  const token = getSessionTokenFromRequest(req);
  if (!token || !sessions.has(token)) return null;
  return sessions.get(token);
};

const normalizeChatParticipants = (userAId, userBId) => {
  const [firstId, secondId] = [userAId, userBId].sort();
  return { userAId: firstId, userBId: secondId };
};

const getPrivateChatByUsers = (userAId, userBId) => {
  const { userAId: firstId, userBId: secondId } = normalizeChatParticipants(userAId, userBId);
  return inMemoryPrivateChats.find((chat) => chat.userA_id === firstId && chat.userB_id === secondId) ?? null;
};

const ensurePrivateChatForUsers = (userAId, userBId) => {
  const existing = getPrivateChatByUsers(userAId, userBId);
  if (existing) return existing;

  const { userAId: firstId, userBId: secondId } = normalizeChatParticipants(userAId, userBId);
  const chat = {
    id: crypto.randomUUID(),
    userA_id: firstId,
    userB_id: secondId,
    createdAt: new Date().toISOString(),
  };
  inMemoryPrivateChats.push(chat);
  return chat;
};

const getPrivateChatById = (chatId) => inMemoryPrivateChats.find((chat) => chat.id === chatId) ?? null;

const isChatParticipant = (chat, userId) => chat.userA_id === userId || chat.userB_id === userId;

const getUserById = (userId) => inMemoryUsers.find((user) => user.id === userId) ?? null;
const getUserByUsername = (username) => inMemoryUsers.find((user) => user.username === username) ?? null;

const loadUserById = async (userId) => {
  if (useSupabase && supabase) {
    const { data, error } = await supabase
      .from('users')
      .select('id,email,username,display_name,profile_picture,password_hash,created_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      return {
        id: data.id,
        email: data.email,
        username: data.username,
        display_name: data.display_name,
        profile_picture: data.profile_picture,
        created_at: data.created_at,
        password_hash: data.password_hash ?? '',
        email_verified: true,
      };
    }
  }
  return getUserById(userId);
};

const loadUserByUsername = async (username) => {
  if (useSupabase && supabase) {
    const normalized = username.trim();
    const { data, error } = await supabase
      .from('users')
      .select('id,email,username,display_name,profile_picture,password_hash,created_at')
      .eq('username', normalized)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      return {
        id: data.id,
        email: data.email,
        username: data.username,
        display_name: data.display_name,
        profile_picture: data.profile_picture,
        created_at: data.created_at,
        password_hash: data.password_hash ?? '',
        email_verified: true,
      };
    }
  }
  return getUserByUsername(username);
};

const getFriendRequestById = (requestId) => inMemoryFriendRequests.find((request) => request.id === requestId) ?? null;

const getFriendsByUserId = () => {
  const friendsByUserId = new Map();
  inMemoryFriendRequests.forEach((request) => {
    if (request.status !== 'accepted') return;
    const senderFriends = friendsByUserId.get(request.senderId) ?? new Set();
    const receiverFriends = friendsByUserId.get(request.receiverId) ?? new Set();
    senderFriends.add(request.receiverId);
    receiverFriends.add(request.senderId);
    friendsByUserId.set(request.senderId, senderFriends);
    friendsByUserId.set(request.receiverId, receiverFriends);
  });
  return friendsByUserId;
};

const mapPrivateMessage = (message) => ({
  id: message.id,
  chatId: message.chatId,
  senderId: message.senderId,
  content: message.content,
  type: message.type,
  mediaUrl: message.mediaUrl ?? null,
  status: message.status,
  createdAt: message.createdAt,
});

const mapPrivateChat = (chat, currentUserId) => {
  const otherUserId = currentUserId === chat.userA_id ? chat.userB_id : chat.userA_id;
  const otherUser = getUserById(otherUserId);
  const lastMessage = [...inMemoryPrivateMessages]
    .filter((message) => message.chatId === chat.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null;

  return {
    id: chat.id,
    createdAt: chat.createdAt,
    otherUser: otherUser
      ? {
          id: otherUser.id,
          username: otherUser.username,
          displayName: otherUser.display_name,
          profilePicture: otherUser.profile_picture ?? null,
        }
      : null,
    lastMessage: lastMessage ? mapPrivateMessage(lastMessage) : null,
  };
};

const emitToUser = (userId, eventName, payload) => {
  const sockets = userSocketMap.get(userId);
  if (!sockets) return;
  sockets.forEach((socketId) => {
    io.to(socketId).emit(eventName, payload);
  });
};

const generateRoomCode = () => {
  let code = '';
  do {
    code = crypto.randomBytes(4).toString('base64url').replace(/[^A-Z0-9]/g, '').slice(0, 6).toUpperCase();
  } while (!code || (!useSupabase && inMemoryRooms.some((room) => room.room_code === code)));
  return code;
};

const mapRoom = (room, currentUserId, memberCount = 0, isMember = false, isOwner = false) => ({
  id: room.id,
  name: room.name,
  description: room.description,
  privacy: room.privacy,
  ownerId: room.owner_id ?? room.ownerId,
  roomCode: isOwner ? room.room_code : undefined,
  createdAt: room.created_at,
  memberCount,
  isMember,
  isOwner,
});

const getRoomById = async (roomId) => {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  return inMemoryRooms.find((room) => room.id === roomId) ?? null;
};

const getRoomMembers = async (roomId) => {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('room_members')
      .select('user_id, role, users ( id, username, display_name )')
      .eq('room_id', roomId);
    if (error) throw new Error(error.message);
    return data.map((row) => ({
      id: row.users.id,
      username: row.users.username,
      displayName: row.users.display_name,
      role: row.role,
    }));
  }

  return inMemoryRoomMembers
    .filter((member) => member.roomId === roomId)
    .map((member) => {
      const user = inMemoryUsers.find((u) => u.id === member.userId);
      return user
        ? { id: user.id, username: user.username, displayName: user.display_name, role: member.role }
        : null;
    })
    .filter(Boolean);
};

const getRoomMemberCount = async (roomId) => {
  if (useSupabase) {
    const { count, error } = await supabase
      .from('room_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('room_id', roomId);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  return inMemoryRoomMembers.filter((member) => member.roomId === roomId).length;
};

const userIsRoomMember = async (userId, roomId) => {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('room_members')
      .select('id')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }
  return inMemoryRoomMembers.some((member) => member.roomId === roomId && member.userId === userId);
};

const addRoomMember = async (roomId, userId, role = 'member') => {
  if (useSupabase) {
    const { error } = await supabase.from('room_members').insert([{ room_id: roomId, user_id: userId, role }]);
    if (error) throw new Error(error.message);
    return;
  }
  if (!inMemoryRoomMembers.some((member) => member.roomId === roomId && member.userId === userId)) {
    inMemoryRoomMembers.push({ roomId, userId, role, joinedAt: new Date().toISOString() });
  }
};

const removeRoomMember = async (roomId, userId) => {
  if (useSupabase) {
    const { error } = await supabase.from('room_members').delete().eq('room_id', roomId).eq('user_id', userId);
    if (error) throw new Error(error.message);
    return;
  }
  const index = inMemoryRoomMembers.findIndex((member) => member.roomId === roomId && member.userId === userId);
  if (index !== -1) inMemoryRoomMembers.splice(index, 1);
};

const getRoomMessages = async (roomId, limit = 50) => {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('room_messages')
      .select('id,room_id,sender_name,message,created_at,attachments,reply_to')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((msg) => ({
      id: msg.id,
      roomId: msg.room_id,
      senderName: msg.sender_name,
      message: msg.message,
      timestamp: msg.created_at,
      attachments: msg.attachments ?? undefined,
      replyTo: msg.reply_to ?? null,
    })).reverse();
  }

  return inMemoryRoomMessages
    .filter((msg) => msg.roomId === roomId)
    .slice(-limit)
    .map((msg) => ({
      id: msg.id,
      roomId: msg.roomId,
      senderName: msg.senderName,
      message: msg.message,
      timestamp: msg.timestamp,
      attachments: msg.attachments,
      replyTo: msg.replyTo ?? null,
    }));
};

const createRoomMessage = async (roomId, senderId, senderName, message, attachments, replyTo) => {
  const newMessage = {
    id: crypto.randomUUID(),
    roomId,
    senderId,
    senderName,
    message,
    timestamp: new Date().toISOString(),
    attachments,
    replyTo: replyTo ?? null,
  };
  if (useSupabase) {
    const { error } = await supabase.from('room_messages').insert([
      {
        id: newMessage.id,
        room_id: roomId,
        sender_id: senderId,
        sender_name: senderName,
        message,
        attachments,
        reply_to: replyTo ?? null,
      },
    ]);
    if (error) throw new Error(error.message);
  } else {
    inMemoryRoomMessages.push(newMessage);
  }
  return newMessage;
};

app.post('/api/rooms', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { name, description, privacy } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing room name' });
  if (privacy !== 'public' && privacy !== 'private') return res.status(400).json({ error: 'Invalid privacy' });

  const roomId = crypto.randomUUID();
  const roomCode = privacy === 'private' ? generateRoomCode() : null;
  const room = {
    id: roomId,
    name,
    description: description || '',
    privacy,
    owner_id: userId,
    room_code: roomCode,
    created_at: new Date().toISOString(),
  };

  if (useSupabase) {
    const { data, error } = await supabase.from('rooms').insert([room]).select('id').single();
    if (error || !data) return res.status(500).json({ error: error?.message ?? 'Failed to create room' });
    await addRoomMember(data.id, userId, 'owner');
    const memberCount = await getRoomMemberCount(data.id);
    return res.json(mapRoom({ ...room, id: data.id }, userId, memberCount, true, true));
  }

  inMemoryRooms.push(room);
  inMemoryRoomMembers.push({ roomId, userId, role: 'owner', joinedAt: new Date().toISOString() });
  const memberCount = 1;
  return res.json(mapRoom(room, userId, memberCount, true, true));
});

app.get('/api/rooms', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const search = String(req.query.search || '').trim().toLowerCase();

  if (useSupabase) {
    const { data: memberRows, error: memberError } = await supabase
      .from('room_members')
      .select('room_id')
      .eq('user_id', userId);
    if (memberError) return res.status(500).json({ error: memberError.message });
    const roomIds = memberRows.map((row) => row.room_id);
    const { data: rooms, error: roomError } = await supabase
      .from('rooms')
      .select('*')
      .in('id', roomIds)
      .order('created_at', { ascending: false });
    if (roomError) return res.status(500).json({ error: roomError.message });

    const roomResults = await Promise.all(
      (rooms ?? []).map(async (room) => {
        const memberCount = await getRoomMemberCount(room.id);
        return mapRoom(room, userId, memberCount, true, room.owner_id === userId);
      }),
    );
    return res.json({ rooms: roomResults });
  }

  const rooms = inMemoryRooms.filter((room) =>
    inMemoryRoomMembers.some((member) => member.roomId === room.id && member.userId === userId),
  );

  const filtered = rooms.filter((room) =>
    !search || room.name.toLowerCase().includes(search) || room.description.toLowerCase().includes(search),
  );

  const results = await Promise.all(filtered.map(async (room) => {
    const memberCount = await getRoomMemberCount(room.id);
    return mapRoom(room, userId, memberCount, true, room.owner_id === userId);
  }));
  return res.json({ rooms: results });
});

app.get('/api/rooms/discover', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const search = String(req.query.search || '').trim().toLowerCase();

  if (useSupabase) {
    const { data: rooms, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('privacy', 'public')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const response = await Promise.all((rooms ?? []).map(async (room) => {
      const isMember = await userIsRoomMember(userId, room.id);
      const memberCount = await getRoomMemberCount(room.id);
      return mapRoom(room, userId, memberCount, isMember, room.owner_id === userId);
    }));

    const filtered = response.filter((room) =>
      !search || room.name.toLowerCase().includes(search) || room.description.toLowerCase().includes(search),
    );
    return res.json({ rooms: filtered });
  }

  const rooms = inMemoryRooms.filter((room) => room.privacy === 'public');
  const filtered = rooms.filter((room) =>
    !search || room.name.toLowerCase().includes(search) || room.description.toLowerCase().includes(search),
  );

  const results = await Promise.all(filtered.map(async (room) => {
    const isMember = await userIsRoomMember(userId, room.id);
    const memberCount = await getRoomMemberCount(room.id);
    return mapRoom(room, userId, memberCount, isMember, room.owner_id === userId);
  }));
  return res.json({ rooms: results });
});

app.get('/api/rooms/:roomId', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  try {
    const room = await getRoomById(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const isMember = await userIsRoomMember(userId, roomId);
    if (room.privacy === 'private' && !isMember) return res.status(403).json({ error: 'Room is private' });

    const members = await getRoomMembers(roomId);
    const memberCount = await getRoomMemberCount(roomId);
    const detail = mapRoom(room, userId, memberCount, isMember, room.owner_id === userId);
    return res.json({ ...detail, members });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load room' });
  }
});

app.get('/api/rooms/:roomId/messages', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (room.privacy === 'private' && !isMember) return res.status(403).json({ error: 'Room is private' });
  const messages = await getRoomMessages(roomId, 200);
  return res.json({ messages });
});

app.post('/api/rooms/:roomId/join', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const alreadyMember = await userIsRoomMember(userId, roomId);
  if (alreadyMember) return res.json({ message: 'Already joined' });
  if (room.privacy === 'private') return res.status(403).json({ error: 'Private rooms require a code' });
  await addRoomMember(roomId, userId);
  io.emit('room_member_joined', { roomId, userId });
  io.emit('room:user:joined', { roomId, userId });
  return res.json({ message: 'Joined room' });
});

app.post('/api/rooms/join-code', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { roomCode } = req.body;
  if (!roomCode) return res.status(400).json({ error: 'Missing room code' });

  if (useSupabase) {
    const { data: room, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('room_code', roomCode)
      .limit(1)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!room) return res.status(404).json({ error: 'Invalid room code' });
    const alreadyMember = await userIsRoomMember(userId, room.id);
    if (!alreadyMember) {
      await addRoomMember(room.id, userId);
      io.emit('room_member_joined', { roomId: room.id, userId });
      io.emit('room:user:joined', { roomId: room.id, userId });
    }
    const memberCount = await getRoomMemberCount(room.id);
    return res.json(mapRoom(room, userId, memberCount, true, room.owner_id === userId));
  }

  const room = inMemoryRooms.find((room) => room.room_code === roomCode);
  if (!room) return res.status(404).json({ error: 'Invalid room code' });
  const alreadyMember = await userIsRoomMember(userId, room.id);
  if (!alreadyMember) {
    await addRoomMember(room.id, userId);
    io.emit('room_member_joined', { roomId: room.id, userId });
    io.emit('room:user:joined', { roomId: room.id, userId });
  }
  const memberCount = await getRoomMemberCount(room.id);
  return res.json(mapRoom(room, userId, memberCount, true, room.owner_id === userId));
});

app.post('/api/rooms/:roomId/invite', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if ((room.owner_id ?? room.ownerId) !== userId) return res.status(403).json({ error: 'Only owner can generate invites' });
  return res.json({ inviteLink: `${APP_URL}/invite/${roomId}` });
});

app.post('/api/rooms/:roomId/leave', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(400).json({ error: 'Not a member' });

  const ownerId = room.owner_id ?? room.ownerId;
  if (ownerId === userId) {
    const members = await getRoomMembers(roomId);
    const nextOwner = members.find((m) => m.id !== userId);
    if (nextOwner) {
      if (useSupabase) {
        await supabase.from('rooms').update({ owner_id: nextOwner.id }).eq('id', roomId);
        await supabase.from('room_members').update({ role: 'owner' }).eq('room_id', roomId).eq('user_id', nextOwner.id);
      } else {
        const roomIdx = inMemoryRooms.findIndex((r) => r.id === roomId);
        if (roomIdx !== -1) inMemoryRooms[roomIdx].ownerId = nextOwner.id;
        const member = inMemoryRoomMembers.find((m) => m.roomId === roomId && m.userId === nextOwner.id);
        if (member) member.role = 'owner';
      }
    }
  }

  await removeRoomMember(roomId, userId);
  io.emit('room_member_left', { roomId, userId });
  io.emit('room:user:left', { roomId, userId });
  return res.json({ message: 'Left room' });
});

app.patch('/api/rooms/:roomId', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const { name, description, privacy } = req.body;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if ((room.owner_id ?? room.ownerId) !== userId) return res.status(403).json({ error: 'Only owner can update room' });
  if (privacy && privacy !== 'public' && privacy !== 'private') return res.status(400).json({ error: 'Invalid privacy' });

  const updates = {};
  if (typeof name === 'string' && name.trim()) updates.name = name.trim();
  if (typeof description === 'string') updates.description = description.trim();
  if (privacy) updates.privacy = privacy;
  if (privacy === 'private' && !(room.room_code ?? room.room_code)) updates.room_code = room.room_code || generateRoomCode();

  if (useSupabase) {
    const { data, error } = await supabase.from('rooms').update(updates).eq('id', roomId).select('*').single();
    if (error || !data) return res.status(500).json({ error: error?.message ?? 'Failed to update room' });
    const memberCount = await getRoomMemberCount(roomId);
    return res.json(mapRoom(data, userId, memberCount, true, true));
  }

  const roomIndex = inMemoryRooms.findIndex((r) => r.id === roomId);
  if (roomIndex === -1) return res.status(500).json({ error: 'Room update failed' });
  inMemoryRooms[roomIndex] = { ...inMemoryRooms[roomIndex], ...updates };
  const updatedRoom = inMemoryRooms[roomIndex];
  const memberCount = await getRoomMemberCount(roomId);
  return res.json(mapRoom(updatedRoom, userId, memberCount, true, true));
});

app.post('/api/rooms/:roomId/generate-code', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if ((room.owner_id ?? room.ownerId) !== userId) return res.status(403).json({ error: 'Only owner can generate a room code' });
  const code = generateRoomCode();
  if (useSupabase) {
    const { error } = await supabase.from('rooms').update({ room_code: code }).eq('id', roomId);
    if (error) return res.status(500).json({ error: error.message });
  } else {
    const idx = inMemoryRooms.findIndex((r) => r.id === roomId);
    if (idx !== -1) inMemoryRooms[idx].room_code = code;
  }
  return res.json({ roomCode: code });
});

app.post('/api/storage/uploads/request-url', (req, res) => {
  const { name, size, contentType } = req.body;
  if (!name || !size || !contentType) return res.status(400).json({ error: 'Missing file metadata' });
  if (typeof size !== 'number' || size > 25 * 1024 * 1024) return res.status(400).json({ error: 'File too large' });

  const safeName = path.basename(name).replace(/[^ -]/g, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectPath = `/uploads/${crypto.randomUUID()}-${safeName}`;
  const host = req.get('host');
  const protocol = req.protocol;
  const uploadURL = `${protocol}://${host}/api/storage${objectPath}`;
  pendingUploads.set(objectPath, { contentType });
  return res.json({ uploadURL, objectPath });
});

app.put('/api/storage/uploads/*', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  const objectPath = req.path.replace('/api/storage', '');
  if (!pendingUploads.has(objectPath)) return res.status(404).send('Upload URL not found');
  const filePath = path.join(UPLOAD_ROOT, objectPath.replace(/^\/uploads\//, ''));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, req.body);
  pendingUploads.delete(objectPath);
  return res.json({ ok: true });
});

app.get('/api/storage/*', (req, res) => {
  const objectPath = req.path.replace('/api/storage', '');
  const filePath = path.join(UPLOAD_ROOT, objectPath.replace(/^\/uploads\//, ''));
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  return res.sendFile(filePath);
});

const serializeLiveShareSession = (session, currentUserId) => ({
  id: session.id,
  roomId: session.roomId,
  hostId: session.hostId,
  hostName: session.hostName,
  status: session.status,
  contentType: session.contentType,
  content: session.content,
  title: session.title,
  mimeType: session.mimeType,
  fileName: session.fileName,
  createdAt: session.createdAt,
  participantCount: session.participants.length,
  participants: session.participants,
  reactions: session.reactions,
  isHost: session.hostId === currentUserId,
  isJoined: session.participants.some((participant) => participant.id === currentUserId),
});

const getLiveShareSession = (roomId) => {
  const session = liveShareSessions.get(roomId);
  return session ? { ...session, participants: [...session.participants], reactions: [...(session.reactions || [])] } : null;
};

const saveLiveShareSession = (roomId, session) => {
  liveShareSessions.set(roomId, session);
  return session;
};

app.get('/api/rooms/:roomId/live-share', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const session = getLiveShareSession(roomId);
  return res.json({ session: session ? serializeLiveShareSession(session, userId) : null });
});

app.post('/api/rooms/:roomId/live-share', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const { title, mode, content, contentType, mimeType, fileName, hostName } = req.body;
  const existing = getLiveShareSession(roomId);
  const nextSession = existing || {
    id: crypto.randomUUID(),
    roomId,
    hostId: userId,
    hostName: hostName || 'You',
    status: 'active',
    contentType: 'url',
    content: '',
    title: 'Shared content',
    mimeType: undefined,
    fileName: undefined,
    createdAt: new Date().toISOString(),
    participants: [],
    reactions: [],
  };

  if (nextSession.hostId !== userId) return res.status(403).json({ error: 'Only the host can control the session' });

  nextSession.hostName = hostName || nextSession.hostName || 'You';
  nextSession.status = 'active';
  nextSession.contentType = contentType || mode || nextSession.contentType || 'url';
  nextSession.content = content ?? nextSession.content;
  nextSession.title = title || nextSession.title || 'Shared content';
  nextSession.mimeType = mimeType || nextSession.mimeType;
  nextSession.fileName = fileName || nextSession.fileName;
  if (!nextSession.participants.some((participant) => participant.id === userId)) {
    nextSession.participants = [{ id: userId, name: nextSession.hostName }, ...nextSession.participants];
  }

  saveLiveShareSession(roomId, nextSession);
  return res.json({ session: serializeLiveShareSession(nextSession, userId) });
});

app.patch('/api/rooms/:roomId/live-share', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const existing = getLiveShareSession(roomId);
  if (!existing) return res.status(404).json({ error: 'Live share session not found' });
  if (existing.hostId !== userId) return res.status(403).json({ error: 'Only the host can update the session' });

  const { status, title, content, contentType, mimeType, fileName } = req.body;
  if (status) existing.status = status;
  if (title) existing.title = title;
  if (content !== undefined) existing.content = content;
  if (contentType) existing.contentType = contentType;
  if (mimeType !== undefined) existing.mimeType = mimeType;
  if (fileName !== undefined) existing.fileName = fileName;

  saveLiveShareSession(roomId, existing);
  return res.json({ session: serializeLiveShareSession(existing, userId) });
});

app.post('/api/rooms/:roomId/live-share/join', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const existing = getLiveShareSession(roomId);
  if (!existing) return res.status(404).json({ error: 'Live share session not found' });
  if (!existing.participants.some((participant) => participant.id === userId)) {
    existing.participants.push({ id: userId, name: req.body.name || 'Guest' });
  }
  saveLiveShareSession(roomId, existing);
  return res.json({ session: serializeLiveShareSession(existing, userId) });
});

app.post('/api/rooms/:roomId/live-share/leave', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const existing = getLiveShareSession(roomId);
  if (!existing) return res.status(404).json({ error: 'Live share session not found' });
  existing.participants = existing.participants.filter((participant) => participant.id !== userId);
  if (existing.hostId === userId) {
    existing.status = 'ended';
    existing.content = '';
  }
  saveLiveShareSession(roomId, existing);
  return res.json({ session: serializeLiveShareSession(existing, userId) });
});

app.post('/api/rooms/:roomId/live-share/react', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const existing = getLiveShareSession(roomId);
  if (!existing) return res.status(404).json({ error: 'Live share session not found' });
  const { emoji, userName } = req.body;
  if (!emoji) return res.status(400).json({ error: 'Missing emoji' });
  existing.reactions = [...(existing.reactions || []), { emoji, userName: userName || 'Guest' }].slice(-8);
  saveLiveShareSession(roomId, existing);
  return res.json({ session: serializeLiveShareSession(existing, userId) });
});

app.post('/api/rooms/:roomId/live-share/end', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });

  const existing = getLiveShareSession(roomId);
  if (!existing) return res.status(404).json({ error: 'Live share session not found' });
  if (existing.hostId !== userId) return res.status(403).json({ error: 'Only the host can end the session' });
  liveShareSessions.delete(roomId);
  return res.json({ session: null });
});

app.post('/api/rooms/:roomId/message', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const { message, attachments, replyTo } = req.body;
  if (!message && !(attachments && attachments.length)) return res.status(400).json({ error: 'Cannot send empty message' });
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isMember = await userIsRoomMember(userId, roomId);
  if (!isMember) return res.status(403).json({ error: 'Not a room member' });
  const newMessage = await createRoomMessage(roomId, userId, req.body.senderName || 'Unknown', message || '', attachments, replyTo);
  io.emit('room_new_message', newMessage);
  io.emit('room:message:new', newMessage);
  return res.json({ message: newMessage });
});

app.post('/api/rooms/:roomId/delete', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if ((room.owner_id ?? room.ownerId) !== userId) return res.status(403).json({ error: 'Only owner can delete room' });

  if (useSupabase) {
    const { error } = await supabase.from('room_messages').delete().eq('room_id', roomId);
    if (error) return res.status(500).json({ error: error.message });
    await supabase.from('room_members').delete().eq('room_id', roomId);
    await supabase.from('rooms').delete().eq('id', roomId);
  } else {
    const roomIndex = inMemoryRooms.findIndex((room) => room.id === roomId);
    if (roomIndex !== -1) inMemoryRooms.splice(roomIndex, 1);
    for (let i = inMemoryRoomMembers.length - 1; i >= 0; i--) {
      if (inMemoryRoomMembers[i].roomId === roomId) inMemoryRoomMembers.splice(i, 1);
    }
    for (let i = inMemoryRoomMessages.length - 1; i >= 0; i--) {
      if (inMemoryRoomMessages[i].roomId === roomId) inMemoryRoomMessages.splice(i, 1);
    }
  }
  io.emit('room_deleted', { roomId });
  return res.json({ message: 'Room deleted' });
});

app.post('/api/rooms/:roomId/members/remove', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const roomId = req.params.roomId;
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'Missing member id' });
  const room = await getRoomById(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if ((room.owner_id ?? room.ownerId) !== userId) return res.status(403).json({ error: 'Only owner can remove members' });
  if (memberId === userId) return res.status(400).json({ error: 'Owner cannot remove themselves' });
  await removeRoomMember(roomId, memberId);
  io.emit('room_member_left', { roomId, userId: memberId });
  io.emit('room:user:left', { roomId, userId: memberId });
  return res.json({ message: 'Member removed' });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, username, displayName, password, confirmPassword } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = String(displayName ?? '').trim() || username?.trim() || normalizedUsername;

  if (!normalizedEmail || !normalizedUsername || !password || !confirmPassword) return res.status(400).json({ error: 'Missing fields' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const expirationIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const normalizedEmailIlike = escapeIlike(normalizedEmail);
  const normalizedUsernameIlike = escapeIlike(normalizedUsername);

  if (useSupabase) {
    const { error: cleanupError } = await supabase
      .from('users')
      .delete()
      .eq('email_verified', false)
      .lt('created_at', expirationIso);
    if (cleanupError) return res.status(500).json({ error: cleanupError.message });

    const { data: existing, error: existingError } = await supabase
      .from('users')
      .select('id,email,username,email_verified')
      .or(`email.ilike.${normalizedEmailIlike},username.ilike.${normalizedUsernameIlike}`)
      .limit(1)
      .maybeSingle();

    if (existingError) return res.status(500).json({ error: existingError.message });
    if (existing) {
      if (!existing.email_verified) {
        return res.status(400).json({
          error: {
            code: 'UNVERIFIED_ACCOUNT',
            message: 'An account with this email already exists. Please check your inbox for the verification link or reset your password.',
          },
        });
      }
      return res.status(400).json({
        error: {
          code: 'VERIFIED_ACCOUNT',
          message: 'Account already exists.',
        },
      });
    }

    const { data, error } = await supabase.from('users').insert([
      {
        email: normalizedEmail,
        username: normalizedUsername,
        display_name: normalizedDisplayName,
        password_hash: hashPassword(password),
        email_verified: false,
      },
    ]).select('id').single();

    if (error || !data) {
      if (error && /duplicate key value violates unique constraint/i.test(error.message)) {
        const { data: existingAfterError, error: existingAfterErrorError } = await supabase
          .from('users')
          .select('id,email,username,email_verified')
          .or(`email.ilike.${normalizedEmailIlike},username.ilike.${normalizedUsernameIlike}`)
          .limit(1)
          .maybeSingle();

        if (existingAfterErrorError) return res.status(500).json({ error: existingAfterErrorError.message });
        if (existingAfterError) {
          if (!existingAfterError.email_verified) {
            return res.status(400).json({
              error: {
                code: 'UNVERIFIED_ACCOUNT',
                message: 'An account with this email already exists. Please check your inbox for the verification link or reset your password.',
              },
            });
          }
          return res.status(400).json({
            error: {
              code: 'VERIFIED_ACCOUNT',
              message: 'Account already exists.',
            },
          });
        }
      }
      return res.status(500).json({ error: error?.message ?? 'Registration failed' });
    }

    const token = await createVerificationToken(data.id);
    let sendResult;
    try {
      sendResult = await emailService.sendVerificationEmail({ email: normalizedEmail, displayName: normalizedDisplayName, token });
    } catch (sendError) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('Email send failed in development. Falling back to local verification link.', sendError instanceof Error ? sendError.message : sendError);
        return res.json({
          message: 'Verification email sent',
          userId: data.id,
          verificationLink: `${emailService.appUrl}/verify-email?token=${encodeURIComponent(token)}`,
        });
      }
      await supabase.from('users').delete().eq('id', data.id);
      return res.status(502).json({ error: 'Unable to send verification email. Please try again.' });
    }

    return res.json({
      message: 'Verification email sent',
      userId: data.id,
      ...(process.env.NODE_ENV !== 'production' || !emailService.isConfigured ? { verificationLink: sendResult?.verificationLink } : {}),
    });
  }

  for (let index = inMemoryUsers.length - 1; index >= 0; index -= 1) {
    const existingLocal = inMemoryUsers[index];
    if (!existingLocal.email_verified && new Date(existingLocal.created_at).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
      inMemoryUsers.splice(index, 1);
    }
  }

  const existingLocal = inMemoryUsers.find(
    (u) => normalizeEmail(u.email) === normalizedEmail || normalizeUsername(u.username) === normalizedUsername,
  );

  if (existingLocal) {
    if (!existingLocal.email_verified) {
      return res.status(400).json({
        error: {
          code: 'UNVERIFIED_ACCOUNT',
          message: 'An account with this email already exists. Please check your inbox for the verification link or reset your password.',
        },
      });
    }
    return res.status(400).json({
      error: {
        code: 'VERIFIED_ACCOUNT',
        message: 'Account already exists.',
      },
    });
  }

  const newUser = {
    id: `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    email: normalizedEmail,
    username: normalizedUsername,
    display_name: normalizedDisplayName,
    profile_picture: null,
    created_at: new Date().toISOString(),
    password_hash: hashPassword(password),
    email_verified: false,
    verification_token: null,
    token_expires_at: null,
  };
  inMemoryUsers.push(newUser);
  const token = await createVerificationToken(newUser.id);
  let sendResult;
  try {
    sendResult = await emailService.sendVerificationEmail({ email: normalizedEmail, displayName: normalizedDisplayName, token });
  } catch (sendError) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Email send failed in development. Falling back to local verification link.', sendError instanceof Error ? sendError.message : sendError);
      return res.json({
        message: 'Verification email sent',
        userId: newUser.id,
        verificationLink: `${emailService.appUrl}/verify-email?token=${encodeURIComponent(token)}`,
      });
    }
    inMemoryUsers.splice(inMemoryUsers.findIndex((user) => user.id === newUser.id), 1);
    return res.status(502).json({ error: 'Unable to send verification email. Please try again.' });
  }
  return res.json({
    message: 'Verification email sent',
    userId: newUser.id,
    ...(process.env.NODE_ENV !== 'production' || !emailService.isConfigured ? { verificationLink: sendResult?.verificationLink } : {}),
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'Missing fields' });
  const lowered = String(identifier).trim().toLowerCase();

  if (useSupabase) {
    const { data: user, error } = await supabase
      .from('users')
      .select('id,email,username,display_name,profile_picture,email_verified,created_at')
      .or(`email.ilike.${escapeIlike(lowered)},username.ilike.${escapeIlike(lowered)}`)
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const { data: authUser } = await supabase
      .from('users')
      .select('password_hash,email_verified')
      .eq('id', user.id)
      .single();

    if (!authUser || !verifyPassword(password, authUser.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!authUser.email_verified) {
      return res.status(403).json({ error: 'Email not verified' });
    }

    const token = await createSessionToken(user.id);
    return res.json({
      token,
      user: mapUser(user),
    });
  }

  const user = inMemoryUsers.find((u) => u.email === identifier || u.username === identifier);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'Email not verified' });
  }

  const token = await createSessionToken(user.id);
  return res.json({
    token,
    user: mapUser(user),
  });
});

app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');

  if (useSupabase) {
    const { data: tokenRecord, error } = await supabase
      .from('email_verification_tokens')
      .select('id,user_id,expires_at,used')
      .eq('token', tokenHash)
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!tokenRecord || tokenRecord.used || !tokenRecord.expires_at || new Date(tokenRecord.expires_at) <= new Date()) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const { data: updatedUser, error: updateUserError } = await supabase
      .from('users')
      .update({ email_verified: true })
      .eq('id', tokenRecord.user_id)
      .select('id')
      .maybeSingle();

    if (updateUserError) return res.status(500).json({ error: updateUserError.message });
    if (!updatedUser) return res.status(400).json({ error: 'Invalid or expired token' });

    const { error: markUsedError } = await supabase
      .from('email_verification_tokens')
      .update({ used: true })
      .eq('id', tokenRecord.id);

    if (markUsedError) return res.status(500).json({ error: markUsedError.message });
    return res.json({ message: 'Email verified successfully' });
  }

  const user = inMemoryUsers.find((candidate) => candidate.verification_token === tokenHash);
  if (!user || user.email_verified || !user.token_expires_at || new Date(user.token_expires_at) <= new Date()) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }
  user.email_verified = true;
  user.verification_token = null;
  user.token_expires_at = null;
  return res.json({ message: 'Email verified successfully' });
});

app.get('/api/auth/me', async (req, res) => {
  const userId = req.userId ?? getSessionUserId(req);
  if (!userId) return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', 'Please sign in and try again.'));

  if (useSupabase) {
    const { data: user, error } = await supabase
      .from('users')
      .select('id,email,username,display_name,profile_picture,created_at')
      .eq('id', userId)
      .single();

    if (error || !user) return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', 'User not found'));
    return res.json(mapUser(user));
  }

  const user = inMemoryUsers.find((u) => u.id === userId);
  if (!user) return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', 'User not found'));
  return res.json(mapUser(user));
});

app.patch('/api/auth/profile', asyncHandler(async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', 'Please sign in and try again.'));

  const user = inMemoryUsers.find((candidate) => candidate.id === userId);
  if (!user) return res.status(404).json(buildErrorResponse('NOT_FOUND', 'User not found.', null));

  const { displayName, username } = req.body;
  if (typeof username === 'string' && username.trim()) {
    const existing = inMemoryUsers.find((candidate) => candidate.username.toLowerCase() === username.trim().toLowerCase() && candidate.id !== userId);
    if (existing) return res.status(409).json(buildErrorResponse('DUPLICATE_RESOURCE', 'That username is already taken.', null));
    user.username = username.trim();
  }

  if (typeof displayName === 'string') user.display_name = displayName.trim() || user.display_name;
  return res.json(mapUser(user));
}));

app.post('/api/auth/change-password', asyncHandler(async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', 'Please sign in and try again.'));

  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json(buildErrorResponse('VALIDATION_ERROR', 'Please provide the required fields.', null));
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json(buildErrorResponse('VALIDATION_ERROR', 'Passwords do not match.', null));
  }

  const user = inMemoryUsers.find((candidate) => candidate.id === userId);
  if (!user) return res.status(404).json(buildErrorResponse('NOT_FOUND', 'User not found.', null));
  if (user.password_hash !== currentPassword) {
    return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Current password is incorrect.', null));
  }

  user.password_hash = newPassword;
  return res.json({ success: true, message: 'Password updated' });
}));

app.delete('/api/auth/account', asyncHandler(async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Authentication required.', 'Please sign in and try again.'));

  const { password } = req.body ?? {};
  if (!password) return res.status(400).json(buildErrorResponse('VALIDATION_ERROR', 'Current password is required.', null));

  let user;
  if (useSupabase && supabase) {
    const { data, error } = await supabase.from('users').select('id,username,password_hash').eq('id', userId).single();
    if (error) throw new Error(error.message);
    user = data;
  } else {
    user = getUserById(userId);
  }

  if (!user || user.password_hash !== password) {
    return res.status(401).json(buildErrorResponse('AUTH_REQUIRED', 'Current password is incorrect.', null));
  }

  if (useSupabase && supabase) {
    const { data: chats, error: chatsError } = await supabase
      .from('chat_threads')
      .select('id')
      .or(`user_a.eq.${userId},user_b.eq.${userId}`);
    if (chatsError) throw new Error(chatsError.message);

    const chatIds = (chats ?? []).map((chat) => chat.id);
    if (chatIds.length > 0) {
      const { error: messagesError } = await supabase.from('private_messages').delete().in('chat_id', chatIds);
      if (messagesError) throw new Error(messagesError.message);
    }

    const { error: ownMessagesError } = await supabase.from('private_messages').delete().eq('sender_username', user.username);
    if (ownMessagesError) throw new Error(ownMessagesError.message);

    const { error: deleteError } = await supabase.from('users').delete().eq('id', userId);
    if (deleteError) throw new Error(deleteError.message);
  } else {
    for (let index = inMemoryPrivateChats.length - 1; index >= 0; index -= 1) {
      const chat = inMemoryPrivateChats[index];
      if (chat.userA_id === userId || chat.userB_id === userId) inMemoryPrivateChats.splice(index, 1);
    }
    for (let index = inMemoryPrivateMessages.length - 1; index >= 0; index -= 1) {
      const message = inMemoryPrivateMessages[index];
      if (message.senderId === userId || message.senderName === user.username) inMemoryPrivateMessages.splice(index, 1);
    }
    for (let index = inMemoryFriendRequests.length - 1; index >= 0; index -= 1) {
      const request = inMemoryFriendRequests[index];
      if (request.senderId === userId || request.receiverId === userId) inMemoryFriendRequests.splice(index, 1);
    }
    const userIndex = inMemoryUsers.findIndex((candidate) => candidate.id === userId);
    if (userIndex !== -1) inMemoryUsers.splice(userIndex, 1);
  }

  for (const [token, sessionUserId] of sessions.entries()) {
    if (sessionUserId === userId) sessions.delete(token);
  }
  userSocketMap.delete(userId);

  return res.json({ success: true, message: 'Account deleted' });
}));

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = getSessionTokenFromRequest(req);
  if (token) sessions.delete(token);
  return res.json({ success: true, message: 'Logged out' });
});

app.get('/api/private-chats', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const chats = inMemoryPrivateChats
    .filter((chat) => isChatParticipant(chat, userId))
    .map((chat) => mapPrivateChat(chat, userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.json({ chats });
});

app.post('/api/private-chats/start', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { username, targetUserId } = req.body;
  let targetUser = null;

  if (typeof targetUserId === 'string' && targetUserId.trim()) {
    targetUser = inMemoryUsers.find((candidate) => candidate.id === targetUserId);
  } else if (typeof username === 'string' && username.trim()) {
    targetUser = inMemoryUsers.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
  }

  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  if (targetUser.id === userId) return res.status(400).json({ error: 'Cannot start a chat with yourself' });

  const chat = ensurePrivateChatForUsers(userId, targetUser.id);
  return res.json({ chatId: chat.id, chat: mapPrivateChat(chat, userId) });
});

app.get('/api/private-chats/:id/messages', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const chat = getPrivateChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isChatParticipant(chat, userId)) return res.status(403).json({ error: 'Access denied' });

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = typeof req.query.before === 'string' ? req.query.before : null;

  let messages = inMemoryPrivateMessages
    .filter((message) => message.chatId === chat.id)
    .filter((message) => !before || new Date(message.createdAt) < new Date(before))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (before) {
    messages = messages.slice(-limit);
  } else {
    messages = messages.slice(-limit);
  }

  return res.json({ messages: messages.map(mapPrivateMessage) });
});

app.post('/api/private-chats/:id/messages', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const chat = getPrivateChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isChatParticipant(chat, userId)) return res.status(403).json({ error: 'Access denied' });

  const { content, type = 'text', mediaUrl } = req.body;
  if (type === 'text' && (!content || !String(content).trim())) return res.status(400).json({ error: 'Missing content' });
  if (type === 'media' && !mediaUrl) return res.status(400).json({ error: 'Missing mediaUrl' });

  const message = {
    id: crypto.randomUUID(),
    chatId: chat.id,
    senderId: userId,
    content: typeof content === 'string' ? content : '',
    type,
    mediaUrl: mediaUrl ?? null,
    status: 'sent',
    createdAt: new Date().toISOString(),
  };

  inMemoryPrivateMessages.push(message);

  const recipientId = userId === chat.userA_id ? chat.userB_id : chat.userA_id;
  emitToUser(recipientId, 'private:message:new', mapPrivateMessage(message));

  return res.json({ message: mapPrivateMessage(message) });
});

app.patch('/api/private-chats/:id/messages/:msgId/read', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const chat = getPrivateChatById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isChatParticipant(chat, userId)) return res.status(403).json({ error: 'Access denied' });

  const message = inMemoryPrivateMessages.find((candidate) => candidate.id === req.params.msgId && candidate.chatId === chat.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.senderId === userId) return res.status(403).json({ error: 'Cannot mark your own message as read' });

  message.status = 'read';
  const senderId = message.senderId;
  emitToUser(senderId, 'private:message:read', { chatId: chat.id, messageId: message.id, readerId: userId });

  return res.json({ message: mapPrivateMessage(message) });
});

app.get('/api/users/search', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const query = rawQuery.startsWith('@') ? rawQuery.slice(1).trim() : rawQuery;
  const normalizedQuery = query.toLowerCase();

  console.log('[users/search] rawQuery=', rawQuery, 'normalizedQuery=', normalizedQuery, 'userId=', userId);

  if (!normalizedQuery) return res.json({ users: [] });

  // Ensure the query searches username or display name case-insensitively,
  // excludes the current user, and returns required response fields.
  const pendingRequests = inMemoryFriendRequests.filter((request) => request.status === 'pending');
  const friendsByUserId = getFriendsByUserId();

  if (useSupabase && supabase) {
    const searchValue = `%${escapeIlike(normalizedQuery)}%`;
    console.log('[users/search] supabase searchValue=', searchValue);

    const { data, error } = await supabase
      .from('users')
      .select('id,username,display_name,profile_picture')
      .or(`username.ilike.${searchValue},display_name.ilike.${searchValue}`)
      .neq('id', userId)
      .limit(20);

    console.log('[users/search] supabase raw result count=', data?.length, 'error=', error?.message);
    if (error) {
      return res.status(500).json({ error: error.message || 'Search failed' });
    }

    const users = (data ?? []).map((candidate) => ({
      id: candidate.id,
      username: candidate.username,
      displayName: candidate.display_name ?? candidate.username,
      avatar: candidate.profile_picture ?? null,
      status: 'offline',
      profilePicture: candidate.profile_picture ?? null,
      online: false,
      relationship: getFriendRelationship({
        currentUserId: userId,
        targetUserId: candidate.id,
        pendingRequests,
        friendsByUserId,
      }),
    }));

    return res.json({ users });
  }

  const users = inMemoryUsers
    .filter((candidate) => candidate.id !== userId)
    .filter((candidate) =>
      candidate.username.toLowerCase().includes(normalizedQuery) ||
      (candidate.display_name || '').toLowerCase().includes(normalizedQuery),
    )
    .map((candidate) => ({
      id: candidate.id,
      username: candidate.username,
      displayName: candidate.display_name,
      avatar: candidate.profile_picture ?? null,
      status: 'offline',
      profilePicture: candidate.profile_picture ?? null,
      online: false,
      relationship: getFriendRelationship({
        currentUserId: userId,
        targetUserId: candidate.id,
        pendingRequests,
        friendsByUserId,
      }),
    }));

  return res.json({ users });
});

app.get('/api/friends/requests', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const requestedStatus = typeof req.query.status === 'string' ? req.query.status.toLowerCase() : '';
  const requests = inMemoryFriendRequests
    .filter((request) => request.receiverId === userId || request.senderId === userId)
    .filter((request) => !requestedStatus || request.status === requestedStatus)
    .map((request) => ({
      id: request.id,
      senderId: request.senderId,
      receiverId: request.receiverId,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      sender: getUserById(request.senderId)
        ? {
            id: getUserById(request.senderId).id,
            username: getUserById(request.senderId).username,
            displayName: getUserById(request.senderId).display_name,
            profilePicture: getUserById(request.senderId).profile_picture ?? null,
          }
        : null,
      receiver: getUserById(request.receiverId)
        ? {
            id: getUserById(request.receiverId).id,
            username: getUserById(request.receiverId).username,
            displayName: getUserById(request.receiverId).display_name,
            profilePicture: getUserById(request.receiverId).profile_picture ?? null,
          }
        : null,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.json({ requests });
});

app.post('/api/friends/requests', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const { targetUserId, targetUsername } = req.body ?? {};
  console.log('[api/friends/requests] incoming', {
    userId,
    targetUserId: typeof targetUserId === 'string' ? targetUserId : null,
    targetUsername: typeof targetUsername === 'string' ? targetUsername : null,
  });

  if (!targetUserId && !targetUsername) return res.status(400).json({ error: 'Missing target user' });

  const resolvedTargetUser = resolveTargetUser({
    targetUserId: typeof targetUserId === 'string' ? targetUserId : null,
    targetUsername: typeof targetUsername === 'string' ? targetUsername : null,
    users: inMemoryUsers,
  });

  if (!resolvedTargetUser) return res.status(404).json({ error: 'User not found' });
  if (resolvedTargetUser.id === userId) return res.status(400).json({ error: 'Cannot send a request to yourself' });

  const resolvedTargetId = resolvedTargetUser.id;
  const existingRequest = inMemoryFriendRequests.find((request) =>
    (request.senderId === userId && request.receiverId === resolvedTargetId) ||
    (request.senderId === resolvedTargetId && request.receiverId === userId),
  );

  if (existingRequest) {
    if (existingRequest.status === 'pending') return res.status(409).json({ error: 'Request already sent' });
    if (existingRequest.status === 'accepted') return res.status(409).json({ error: 'You are already friends' });
  }

  const request = {
    id: crypto.randomUUID(),
    senderId: userId,
    receiverId: resolvedTargetId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  inMemoryFriendRequests.push(request);

  return res.json({ message: 'Friend request sent', request });
});

app.post('/api/friends/requests/:requestId/accept', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const request = inMemoryFriendRequests.find((candidate) => candidate.id === req.params.requestId);
  if (!request) return res.status(404).json({ error: 'Friend request not found' });
  if (request.receiverId !== userId) return res.status(403).json({ error: 'Only the recipient can accept this request' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Friend request has already been processed' });

  request.status = 'accepted';
  request.updatedAt = new Date().toISOString();
  const chat = ensurePrivateChatForUsers(userId, request.senderId);

  return res.json({
    message: 'Friend request accepted',
    request: {
      id: request.id,
      senderId: request.senderId,
      receiverId: request.receiverId,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    },
    chat: { id: chat.id },
  });
});

app.post('/api/friends/requests/:requestId/decline', async (req, res) => {
  const userId = getSessionUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const request = inMemoryFriendRequests.find((candidate) => candidate.id === req.params.requestId);
  if (!request) return res.status(404).json({ error: 'Friend request not found' });
  if (request.receiverId !== userId) return res.status(403).json({ error: 'Only the recipient can decline this request' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Friend request has already been processed' });

  request.status = 'rejected';
  request.updatedAt = new Date().toISOString();

  return res.json({ message: 'Friend request declined', request: { id: request.id, status: request.status } });
});

app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return res.status(400).json({ error: 'Missing email' });

  if (useSupabase) {
    const normalizedEmailIlike = escapeIlike(normalizedEmail);
    const { data: user, error } = await supabase
      .from('users')
      .select('id,username,email_verified')
      .ilike('email', normalizedEmailIlike)
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified) return res.json({ message: 'Email already verified' });

    const token = await createVerificationToken(user.id);
    let sendResult;
    try {
      sendResult = await emailService.sendVerificationEmail({ email: normalizedEmail, displayName: user.username, token });
    } catch (sendError) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('Resend verification failed in development. Falling back to local verification link.', sendError instanceof Error ? sendError.message : sendError);
        return res.json({
          message: 'Verification email resent',
          verificationLink: `${emailService.appUrl}/verify-email?token=${encodeURIComponent(token)}`,
        });
      }
      return res.status(502).json({ error: 'Unable to send verification email. Please try again.' });
    }
    return res.json({
      message: 'Verification email resent',
      ...(process.env.NODE_ENV !== 'production' || !emailService.isConfigured ? { verificationLink: sendResult?.verificationLink } : {}),
    });
  }

  const user = inMemoryUsers.find((u) => normalizeEmail(u.email) === normalizedEmail);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email_verified) return res.json({ message: 'Email already verified' });

  const token = await createVerificationToken(user.id);
  let sendResult;
  try {
    sendResult = await emailService.sendVerificationEmail({ email: normalizedEmail, displayName: user.username, token });
  } catch (sendError) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Resend verification failed in development. Falling back to local verification link.', sendError instanceof Error ? sendError.message : sendError);
      return res.json({
        message: 'Verification email resent',
        verificationLink: `${emailService.appUrl}/verify-email?token=${encodeURIComponent(token)}`,
      });
    }
    user.verification_token = null;
    user.token_expires_at = null;
    return res.status(502).json({ error: 'Unable to send verification email. Please try again.' });
  }
  return res.json({
    message: 'Verification email resent',
    ...(process.env.NODE_ENV !== 'production' || !emailService.isConfigured ? { verificationLink: sendResult?.verificationLink } : {}),
  });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  return res.json({ message: 'Password reset email sent' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password, confirmPassword } = req.body;
  if (!token || !password || !confirmPassword) return res.status(400).json({ error: 'Missing fields' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match' });
  return res.json({ message: 'Password reset successful' });
});

const activeSockets = new Map();

io.on('connection', (socket) => {
  socket.on('join', ({ username }) => {
    socket.data.username = username;
    activeSockets.set(socket.id, socket);
    socket.emit('join_success');
  });

  socket.on('room_auth', () => {
    socket.emit('room_auth_success');
  });

  socket.on('join_user_channel', () => {
    socket.emit('user_channel_joined');
  });

  socket.on('private_auth', ({ userId }) => {
    if (!userId) return;
    socket.data.userId = userId;
    if (!userSocketMap.has(userId)) userSocketMap.set(userId, new Set());
    userSocketMap.get(userId).add(socket.id);
    socket.emit('private_auth_success');
  });

  socket.on('private:typing:start', ({ chatId, recipientId, userId }) => {
    if (!chatId || !recipientId) return;
    const recipientSockets = userSocketMap.get(recipientId);
    if (!recipientSockets) return;
    const typingSet = privateTypingStates.get(chatId) ?? new Set();
    typingSet.add(userId ?? socket.data.userId);
    privateTypingStates.set(chatId, typingSet);
    recipientSockets.forEach((socketId) => {
      io.to(socketId).emit('private:typing:start', { chatId, userId: userId ?? socket.data.userId, users: Array.from(typingSet) });
    });
  });

  socket.on('private:typing:stop', ({ chatId, recipientId, userId }) => {
    if (!chatId || !recipientId) return;
    const recipientSockets = userSocketMap.get(recipientId);
    if (!recipientSockets) return;
    const typingSet = privateTypingStates.get(chatId);
    if (typingSet) {
      typingSet.delete(userId ?? socket.data.userId);
      if (typingSet.size === 0) privateTypingStates.delete(chatId);
      else privateTypingStates.set(chatId, typingSet);
    }
    recipientSockets.forEach((socketId) => {
      io.to(socketId).emit('private:typing:stop', { chatId, userId: userId ?? socket.data.userId, users: Array.from(typingSet || []) });
    });
  });

  socket.on('send_message', (payload) => {
    const msg = {
      id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      senderName: socket.data.username,
      message: payload.message,
      timestamp: new Date().toISOString(),
      edited: false,
      unsent: false,
      voiceNote: false,
      voiceDuration: null,
      replyTo: payload.replyTo ?? null,
      replyToMessage: null,
      replyToSender: null,
      attachments: payload.attachments ?? undefined,
    };
    socket.broadcast.emit('new_message', msg);
    socket.emit('new_message', msg);
  });

  socket.on('typing', (data) => {
    socket.broadcast.emit('typing_update', [data.username]);
  });

  socket.on('disconnect', () => {
    activeSockets.delete(socket.id);
    const userId = socket.data.userId;
    if (userId && userSocketMap.has(userId)) {
      userSocketMap.get(userId).delete(socket.id);
      if (userSocketMap.get(userId).size === 0) userSocketMap.delete(userId);
    }
  });
});

app.use((req, res) => {
  res.status(404).json(buildErrorResponse('NOT_FOUND', 'Route not found.', { path: req.originalUrl }));
});

app.use((error, req, res, _next) => {
  const { statusCode, error: errorPayload } = mapErrorToResponse(error, 'Something went wrong.');
  res.status(statusCode).json(errorPayload);
});

server.listen(API_PORT, () => {
  console.log(`Backend running on http://localhost:${API_PORT}`);
});
