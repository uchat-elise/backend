-- Socket.IO is the only message delivery pipeline.
-- Messages are written through a Supabase client authenticated as the socket user.

-- Remove legacy PostgreSQL notification delivery from private_messages.
drop trigger if exists trg_broadcast_new_message on public.private_messages;
drop trigger if exists trg_broadcast_message_edit on public.private_messages;
drop trigger if exists trg_broadcast_message_delete on public.private_messages;
drop function if exists public.broadcast_message_event();
drop function if exists public.broadcast_message_edit();
drop function if exists public.broadcast_message_delete();

alter table public.messages enable row level security;
alter table public.chat_threads enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
exception
  when undefined_object then null;
end;
$$;

drop policy if exists "Users can view messages in their own chats" on public.messages;
drop policy if exists "Users can insert messages in their own chats" on public.messages;
drop policy if exists "Users can update only their own message status" on public.messages;
drop policy if exists "Users can delete only their own messages" on public.messages;
drop policy if exists "messages_select_participant" on public.messages;
drop policy if exists "messages_insert_sender_participant" on public.messages;
drop policy if exists "messages_update_read_participant" on public.messages;

create policy "messages_select_participant"
on public.messages for select
to authenticated
using (
  exists (
    select 1
    from public.chat_threads ct
    where ct.id = messages.chat_id
      and (ct.user_a = auth.uid() or ct.user_b = auth.uid())
  )
);

create policy "messages_insert_sender_participant"
on public.messages for insert
to authenticated
with check (
  sender_id = auth.uid()
  and exists (
    select 1
    from public.chat_threads ct
    where ct.id = messages.chat_id
      and (ct.user_a = auth.uid() or ct.user_b = auth.uid())
  )
);

create policy "messages_update_read_participant"
on public.messages for update
to authenticated
using (
  exists (
    select 1
    from public.chat_threads ct
    where ct.id = messages.chat_id
      and (ct.user_a = auth.uid() or ct.user_b = auth.uid())
  )
)
with check (
  status = 'read'
  and exists (
    select 1
    from public.chat_threads ct
    where ct.id = messages.chat_id
      and (ct.user_a = auth.uid() or ct.user_b = auth.uid())
  )
);

create or replace function public.prevent_message_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
    or new.chat_id is distinct from old.chat_id
    or new.sender_id is distinct from old.sender_id
    or new.content is distinct from old.content
    or new.created_at is distinct from old.created_at
    or new.client_message_id is distinct from old.client_message_id
    or new.status <> 'read' then
    raise exception 'Only message status may be changed to read';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_message_mutation on public.messages;
create trigger trg_prevent_message_mutation
before update on public.messages
for each row execute function public.prevent_message_mutation();

drop policy if exists "chat_threads_select_participant" on public.chat_threads;
create policy "chat_threads_select_participant"
on public.chat_threads for select
to authenticated
using (user_a = auth.uid() or user_b = auth.uid());
