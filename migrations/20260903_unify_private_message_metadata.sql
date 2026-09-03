-- Rebind private-message metadata to the canonical public.messages table.
-- The active Socket.IO flow no longer writes to public.private_messages.

DROP VIEW IF EXISTS public.message_read_status;
DROP VIEW IF EXISTS public.user_active_chats;

DO $$
DECLARE
  table_name text;
  constraint_row record;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['private_message_reactions', 'private_message_stars', 'message_reads', 'message_delivery'] LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      CONTINUE;
    END IF;

    -- Legacy rows may contain text IDs from private_messages. Metadata for
    -- those rows cannot be attached to canonical messages, so remove only it.
    EXECUTE format(
      'DELETE FROM public.%I metadata
       WHERE metadata.message_id::text !~ ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$''
          OR NOT EXISTS (SELECT 1 FROM public.messages message WHERE message.id::text = metadata.message_id::text)',
      table_name
    );

    FOR constraint_row IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = format('public.%I', table_name)::regclass
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%message_id%'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', table_name, constraint_row.conname);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN message_id TYPE uuid USING message_id::text::uuid',
      table_name
    );

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE',
      table_name,
      table_name || '_message_id_fkey'
    );
  END LOOP;
END $$;

DO $$
DECLARE
  constraint_row record;
BEGIN
  IF to_regclass('public.chat_last_read') IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM public.chat_last_read read_state
  WHERE read_state.last_read_message_id IS NOT NULL
    AND (
      read_state.last_read_message_id::text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR NOT EXISTS (
        SELECT 1
        FROM public.messages message
        WHERE message.id::text = read_state.last_read_message_id::text
      )
    );

  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.chat_last_read'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%last_read_message_id%'
  LOOP
    EXECUTE format('ALTER TABLE public.chat_last_read DROP CONSTRAINT %I', constraint_row.conname);
  END LOOP;

  EXECUTE 'ALTER TABLE public.chat_last_read ALTER COLUMN last_read_message_id TYPE uuid USING last_read_message_id::text::uuid';
  EXECUTE 'ALTER TABLE public.chat_last_read ADD CONSTRAINT chat_last_read_message_id_fkey FOREIGN KEY (last_read_message_id) REFERENCES public.messages(id) ON DELETE SET NULL';
END $$;

CREATE OR REPLACE FUNCTION public.get_unread_count(p_user_id uuid, p_chat_id text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  unread_count bigint;
BEGIN
  SELECT count(*)
  INTO unread_count
  FROM public.messages message
  LEFT JOIN public.message_delivery delivery
    ON delivery.message_id = message.id
   AND delivery.recipient_user_id = p_user_id
  WHERE message.chat_id = p_chat_id
    AND delivery.read_at IS NULL
    AND message.sender_id <> p_user_id;

  RETURN unread_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_chat_last_read()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF new.read_at IS NOT NULL THEN
    INSERT INTO public.chat_last_read (user_id, chat_id, last_read_message_id, last_read_at)
    SELECT new.recipient_user_id, message.chat_id, new.message_id, new.read_at
    FROM public.messages message
    WHERE message.id = new.message_id
    ON CONFLICT (user_id, chat_id) DO UPDATE
      SET last_read_message_id = excluded.last_read_message_id,
          last_read_at = excluded.last_read_at;
  END IF;
  RETURN new;
END;
$$;

CREATE OR REPLACE VIEW public.message_read_status AS
SELECT
  message.id AS message_id,
  message.chat_id,
  sender.username AS sender_username,
  count(DISTINCT delivery.recipient_username) AS total_recipients,
  count(DISTINCT CASE WHEN delivery.delivered_at IS NOT NULL THEN delivery.recipient_username END) AS delivered_count,
  count(DISTINCT CASE WHEN delivery.read_at IS NOT NULL THEN delivery.recipient_username END) AS read_count
FROM public.messages message
LEFT JOIN public.users sender ON sender.id = message.sender_id
LEFT JOIN public.message_delivery delivery ON delivery.message_id = message.id
GROUP BY message.id, message.chat_id, sender.username;

CREATE OR REPLACE VIEW public.user_active_chats AS
SELECT
  chat.id AS chat_id,
  chat.user_a,
  chat.user_b,
  chat.user_b AS other_user_id,
  other_user.username AS other_username,
  other_user.profile_picture AS other_profile_picture,
  max(message.created_at) AS last_message_at,
  max(message.content) AS last_message_content,
  chat.created_at
FROM public.chat_threads chat
LEFT JOIN public.users other_user ON other_user.id = chat.user_b
LEFT JOIN public.messages message ON message.chat_id = chat.id
GROUP BY chat.id, chat.user_a, chat.user_b, other_user.username, other_user.profile_picture, chat.created_at
ORDER BY last_message_at DESC NULLS LAST;

CREATE INDEX IF NOT EXISTS idx_private_message_reactions_message_id
  ON public.private_message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_private_message_stars_message_id
  ON public.private_message_stars(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reads_message_id
  ON public.message_reads(message_id);
CREATE INDEX IF NOT EXISTS idx_message_delivery_message_id
  ON public.message_delivery(message_id);
