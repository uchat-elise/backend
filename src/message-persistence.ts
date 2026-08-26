import crypto from 'crypto';
import { type SupabaseClient } from '@supabase/supabase-js';

export type MessageStatus = 'sent' | 'delivered' | 'read';

export interface MessagePayload {
  id?: string;
  chat_id: string;
  sender_id: string;
  content: string;
  status?: MessageStatus;
  created_at?: string;
  client_message_id?: string;
  audio_url?: string | null;
  voice_note?: boolean;
  voice_duration?: number | null;
  voice_mime_type?: string | null;
  voice_size?: number | null;
}

function assertUuid(value: string, fieldName: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${fieldName} must be a UUID; received ${value}`);
  }
}

export async function saveMessage(
  supabase: SupabaseClient,
  payload: MessagePayload,
  clientMessageIdOverride?: string,
): Promise<string> {
  assertUuid(payload.sender_id, 'sender_id');
  const clientMessageId = clientMessageIdOverride ?? payload.client_message_id ?? crypto.randomUUID();
  const messageId = payload.id ?? crypto.randomUUID();
  const createdAt = payload.created_at ?? new Date().toISOString();

  const row = {
    id: messageId,
    chat_id: payload.chat_id,
    sender_id: payload.sender_id,
    content: payload.content,
    status: payload.status ?? 'sent',
    created_at: createdAt,
    client_message_id: clientMessageId,
    audio_url: payload.audio_url ?? null,
    voice_note: payload.voice_note ?? false,
    voice_duration: payload.voice_duration ?? null,
    voice_mime_type: payload.voice_mime_type ?? null,
    voice_size: payload.voice_size ?? null,
  };

  const { data, error } = await supabase
    .from('messages')
    .upsert(row, {
      onConflict: 'client_message_id',
      ignoreDuplicates: false,
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`saveMessage failed: ${error.message}`);
  }

  return data?.id ?? row.id;
}

export async function fetchUnreadMessages(
  supabase: SupabaseClient,
  chatId: string,
  userId: string,
  sinceTimestamp: string,
): Promise<Array<Record<string, any>>> {
  assertUuid(userId, 'user_id');
  const { data, error } = await supabase
    .from('messages')
    .select('id, chat_id, sender_id, content, status, created_at, client_message_id')
    .eq('chat_id', chatId)
    .neq('sender_id', userId)
    .gt('created_at', sinceTimestamp)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`fetchUnreadMessages failed: ${error.message}`);
  }

  return (data ?? []).map((message) => ({
    ...message,
    status: message.status ?? 'sent',
  }));
}

export async function markMessageAsRead(
  supabase: SupabaseClient,
  messageId: string,
  userId: string,
): Promise<Record<string, any> | null> {
  assertUuid(userId, 'user_id');
  const { data, error } = await supabase
    .from('message_reads')
    .upsert(
      {
        message_id: messageId,
        user_id: userId,
        read_at: new Date().toISOString(),
      },
      { onConflict: 'message_id,user_id', ignoreDuplicates: false },
    )
    .select()
    .single();

  if (error) {
    throw new Error(`markMessageAsRead failed: ${error.message}`);
  }

  return data ?? null;
}
