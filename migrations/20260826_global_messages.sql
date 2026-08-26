create table if not exists public.global_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.users(id) on delete cascade,
  content text not null default '',
  attachments jsonb,
  reactions jsonb not null default '[]'::jsonb,
  voice_note boolean not null default false,
  voice_duration integer,
  audio_url text,
  voice_mime_type text,
  voice_size integer,
  client_message_id uuid not null unique,
  unsent boolean not null default false,
  edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_global_message_content check (
    (voice_note = true and audio_url is not null and length(trim(audio_url)) > 0)
    or (voice_note = false and length(trim(content)) > 0)
  )
);

alter table public.global_messages
  add column if not exists voice_note boolean not null default false,
  add column if not exists voice_duration integer,
  add column if not exists audio_url text,
  add column if not exists voice_mime_type text,
  add column if not exists voice_size integer;

alter table public.global_messages
  drop constraint if exists chk_global_message_content;

alter table public.global_messages
  add constraint chk_global_message_content check (
    (voice_note = true and audio_url is not null and length(trim(audio_url)) > 0
      and voice_duration is not null and voice_duration > 0
      and voice_size is not null and voice_size > 0 and voice_size <= 5242880
      and voice_mime_type is not null and voice_mime_type like 'audio/%')
    or (voice_note = false and length(trim(content)) > 0)
  );

create index if not exists idx_global_messages_created_at on public.global_messages(created_at desc);
create index if not exists idx_global_messages_voice_note on public.global_messages(voice_note) where voice_note = true;

alter table public.global_messages enable row level security;

drop policy if exists "Authenticated users can read global messages" on public.global_messages;
create policy "Authenticated users can read global messages"
  on public.global_messages for select
  to authenticated
  using (true);

drop policy if exists "Users can insert their global messages" on public.global_messages;
create policy "Users can insert their global messages"
  on public.global_messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and (
      (voice_note = false and length(trim(content)) > 0)
      or (voice_note = true and audio_url is not null and length(trim(audio_url)) > 0)
    )
  );

drop policy if exists "Users can update their global messages" on public.global_messages;
create policy "Users can update their global messages"
  on public.global_messages for update
  to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

drop policy if exists "Users can delete their global messages" on public.global_messages;
create policy "Users can delete their global messages"
  on public.global_messages for delete
  to authenticated
  using (sender_id = auth.uid());
