ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachments jsonb;