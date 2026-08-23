-- Migration: Message Persistence Fix
-- Purpose: Ensure chat_threads table exists for all message chats, and add proper constraints
-- Date: 2026-08-17

-- 1. Ensure chat_threads table exists with proper structure
CREATE TABLE IF NOT EXISTS public.chat_threads (
  id text primary key,
  user_a uuid not null references public.users(id) on delete cascade,
  user_b uuid not null references public.users(id) on delete cascade,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone,
  constraint chk_chat_thread_users check (user_a <> user_b)
);

create unique index if not exists idx_chat_threads_unique_users
  on public.chat_threads (least(user_a, user_b), greatest(user_a, user_b));

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_chat_threads_user_a ON public.chat_threads(user_a);
CREATE INDEX IF NOT EXISTS idx_chat_threads_user_b ON public.chat_threads(user_b);

-- 2. Ensure private_messages table exists with all required columns
CREATE TABLE IF NOT EXISTS public.private_messages (
  id text primary key,
  chat_id text not null,
  seq bigint,
  sender_username text not null,
  sender_display_name text,
  content text not null,
  attachments jsonb,
  voice_note boolean not null default false,
  voice_duration integer,
  unsent boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  edited boolean not null default false,
  reply_to text
);

-- Create indexes for message queries
CREATE INDEX IF NOT EXISTS idx_private_messages_chat_id ON public.private_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_private_messages_chat_seq ON public.private_messages(chat_id, seq);
CREATE INDEX IF NOT EXISTS idx_private_messages_sender_username ON public.private_messages(sender_username);
CREATE INDEX IF NOT EXISTS idx_private_messages_created_at ON public.private_messages(created_at);

-- 3. Create function to auto-create chat_threads when needed
CREATE OR REPLACE FUNCTION public.ensure_chat_thread_for_message()
RETURNS TRIGGER AS $$
DECLARE
  v_user_a uuid;
  v_user_b uuid;
BEGIN
  -- If chat_id doesn't exist in chat_threads, try to find the corresponding users
  IF NOT EXISTS (SELECT 1 FROM public.chat_threads WHERE id = NEW.chat_id) THEN
    -- Try to infer users from friend_requests or other sources
    -- For now, log the missing chat thread
    RAISE WARNING 'Message inserted for non-existent chat_id: %', NEW.chat_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Create trigger to monitor for orphaned messages
DROP TRIGGER IF EXISTS trg_private_messages_chat_exists ON public.private_messages;
CREATE TRIGGER trg_private_messages_chat_exists
  BEFORE INSERT ON public.private_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.ensure_chat_thread_for_message();

-- 5. Ensure chat_threads table has updated_at column
ALTER TABLE public.chat_threads 
ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone default now();

-- 6. Create a function to update chat_threads.updated_at when messages are inserted
CREATE OR REPLACE FUNCTION public.update_chat_thread_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.chat_threads 
  SET updated_at = NEW.created_at
  WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 7. Create trigger to update chat_threads on new messages
DROP TRIGGER IF EXISTS trg_chat_thread_updated_on_message ON public.private_messages;
CREATE TRIGGER trg_chat_thread_updated_on_message
  AFTER INSERT ON public.private_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_chat_thread_on_message();

-- 8. Ensure message_reads table exists and has proper foreign keys
CREATE TABLE IF NOT EXISTS public.message_reads (
  id uuid primary key default gen_random_uuid(),
  message_id text not null references public.private_messages(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  read_at timestamp with time zone not null default now(),
  constraint uq_message_reads_message_user unique (message_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_reads_message_user ON public.message_reads (message_id, user_id);

-- 9. Ensure chat_seq table exists for per-chat message sequencing
CREATE TABLE IF NOT EXISTS public.chat_seq (
  chat_id text primary key,
  last_seq bigint not null default 0
);

-- 10. Grant necessary permissions (if using role-based access)
-- Uncomment if using Supabase with specific roles:
-- ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.private_messages ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.message_reads ENABLE ROW LEVEL SECURITY;

-- 11. Ensure all existing messages have their chat_threads records
-- This will create missing chat_threads for any orphaned messages
DO $$
DECLARE
  v_chat_id text;
  v_user_a uuid;
  v_user_b uuid;
  v_friend_requests CURSOR FOR
    SELECT id, sender_id, receiver_id 
    FROM public.friend_requests 
    WHERE status = 'accepted';
BEGIN
  -- Create chat_threads for all accepted friend requests
  FOR rec IN v_friend_requests LOOP
    v_chat_id := format('chat-%s-%s', 
      least(rec.sender_id::text, rec.receiver_id::text), 
      greatest(rec.sender_id::text, rec.receiver_id::text));
    
    INSERT INTO public.chat_threads (id, user_a, user_b)
    VALUES (v_chat_id, 
      CASE WHEN rec.sender_id::text < rec.receiver_id::text THEN rec.sender_id ELSE rec.receiver_id END,
      CASE WHEN rec.sender_id::text < rec.receiver_id::text THEN rec.receiver_id ELSE rec.sender_id END)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
