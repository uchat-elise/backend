do $$
begin
  create type public.message_status as enum ('sent', 'delivered', 'read');
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  sender_id uuid not null references public.users(id) on delete cascade,
  content text not null,
  status public.message_status not null default 'sent',
  created_at timestamptz not null default now(),
  client_message_id uuid not null unique,
  constraint chk_messages_content_nonempty check (length(trim(content)) > 0)
);

create index if not exists idx_messages_chat_id on public.messages(chat_id);
create index if not exists idx_messages_sender_id on public.messages(sender_id);
create index if not exists idx_messages_created_at on public.messages(created_at);
create index if not exists idx_messages_chat_created_at on public.messages(chat_id, created_at desc);

alter table public.messages enable row level security;

drop policy if exists "Users can view messages in their own chats" on public.messages;
drop policy if exists "Users can insert messages in their own chats" on public.messages;
drop policy if exists "Users can update only their own message status" on public.messages;
drop policy if exists "Users can delete only their own messages" on public.messages;

create policy "Users can view messages in their own chats"
  on public.messages for select
  using (
    exists (
      select 1
      from public.chat_threads ct
      where ct.id = messages.chat_id
        and (
          ct.user_a = auth.uid()
          or ct.user_b = auth.uid()
        )
    )
  );

create policy "Users can insert messages in their own chats"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1
      from public.chat_threads ct
      where ct.id = messages.chat_id
        and (
          ct.user_a = auth.uid()
          or ct.user_b = auth.uid()
        )
    )
  );

create policy "Users can update only their own message status"
  on public.messages for update
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

create policy "Users can delete only their own messages"
  on public.messages for delete
  using (sender_id = auth.uid());

create or replace function public.upsert_message(
  p_chat_id text,
  p_sender_id uuid,
  p_content text,
  p_client_message_id uuid,
  p_status public.message_status default 'sent'
)
returns uuid
language plpgsql
as $$
declare
  v_message_id uuid;
begin
  insert into public.messages (chat_id, sender_id, content, status, client_message_id)
  values (p_chat_id, p_sender_id, p_content, p_status, p_client_message_id)
  on conflict (client_message_id)
  do update set
    content = excluded.content,
    status = excluded.status,
    sender_id = excluded.sender_id,
    chat_id = excluded.chat_id
  returning id into v_message_id;

  if v_message_id is null then
    select id into v_message_id
    from public.messages
    where client_message_id = p_client_message_id;
  end if;

  return v_message_id;
end;
$$;
