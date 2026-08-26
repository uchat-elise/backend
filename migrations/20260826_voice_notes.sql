alter table public.messages
  add column if not exists voice_note boolean not null default false,
  add column if not exists audio_url text,
  add column if not exists voice_duration integer,
  add column if not exists voice_mime_type text,
  add column if not exists voice_size integer;

alter table public.messages
  drop constraint if exists chk_messages_content_nonempty;

alter table public.messages
  add constraint chk_messages_content_or_voice check (
    (voice_note = true and audio_url is not null and length(trim(audio_url)) > 0)
    or (voice_note = false and length(trim(content)) > 0)
  );

create index if not exists idx_messages_voice_note on public.messages(voice_note) where voice_note = true;