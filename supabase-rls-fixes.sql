-- RLS policy to allow chat participants to SELECT private_messages
-- Run this in the Supabase SQL editor (or psql as a privileged user)

-- Ensure chat_threads table exists and links chat_id -> chat_threads.id
-- Policy: allow users to read messages for chat threads where they are a participant

CREATE POLICY "Users can read private_messages in their chat threads"
  ON public.private_messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.chat_threads ct
      WHERE ct.id = private_messages.chat_id
        AND (auth.uid()::text = ct.user_a::text OR auth.uid()::text = ct.user_b::text)
    )
  );

-- Example additional policy to allow inserting (so users can send messages)
CREATE POLICY "Users can insert private_messages for chats they participate in"
  ON public.private_messages
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.chat_threads ct
      WHERE ct.id = private_messages.chat_id
        AND (auth.uid()::text = ct.user_a::text OR auth.uid()::text = ct.user_b::text)
    )
  );

-- Note: adjust auth.uid() usage depending on your Supabase auth setup (UUID vs text).
-- After adding policies, test the API and ensure SELECT works for authenticated users that are participants.
