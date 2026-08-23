export const socketUserIdMap = new Map<string, string>();

export function resolveReceiverSocketId(receiverId: string | null | undefined, socketMap: Map<string, string> = socketUserIdMap) {
  if (!receiverId) return null;
  return socketMap.get(receiverId) ?? null;
}

export function createMessagePayload({
  id,
  senderId,
  receiverId,
  content,
  type = 'text',
  timestamp,
}: {
  id: string;
  senderId: string | null;
  receiverId: string | null;
  content: string;
  type?: string;
  timestamp: string;
}) {
  return {
    id,
    senderId,
    receiverId,
    content,
    type,
    timestamp,
  };
}

export type MessageDeliveryResult =
  | { ok: true; offline: true; message: ReturnType<typeof createMessagePayload>; createdMessage?: any }
  | { ok: true; offline: false; message: ReturnType<typeof createMessagePayload>; receiverSocketId: string; createdMessage?: any }
  | { ok: false; error: string };

export async function persistMessageWithTransaction({
  saveMessage,
  updateConversationLastMessage,
  messageId,
  senderId,
  receiverId,
  content,
  chatId,
  type,
  timestamp,
  socketMap = socketUserIdMap,
}: {
  saveMessage: () => Promise<void>;
  updateConversationLastMessage: () => Promise<void>;
  messageId: string;
  senderId: string;
  receiverId: string;
  content: string;
  chatId?: string | null;
  type?: string;
  timestamp: string;
  socketMap?: Map<string, string>;
}): Promise<MessageDeliveryResult> {
  const messagePayload = createMessagePayload({
    id: messageId,
    senderId,
    receiverId,
    content,
    type: type ?? 'text',
    timestamp,
  });

  try {
    await saveMessage();
    await updateConversationLastMessage();
  } catch (error) {
    return { ok: false, error: (error as Error).message || 'Unable to persist message' };
  }

  const receiverSocketId = resolveReceiverSocketId(receiverId, socketMap);
  if (!receiverSocketId) {
    console.warn('User offline, message saved but not emitted');
    return { ok: true, offline: true, message: messagePayload };
  }

  console.log('Message sent:', messageId, 'To user:', receiverId, 'Socket ID:', receiverSocketId);
  return { ok: true, offline: false, message: messagePayload, receiverSocketId };
}
