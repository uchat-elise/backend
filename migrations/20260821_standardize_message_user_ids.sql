-- Ensure canonical messages use UUID user references.
-- This is a no-op when messages.sender_id is already uuid (the current schema).
do $$
declare
  sender_type text;
begin
  select data_type into sender_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'messages'
    and column_name = 'sender_id';

  if sender_type = 'text' then
    -- Abort instead of silently corrupting rows that cannot be mapped.
    if exists (
      select 1
      from public.messages m
      left join public.users u on lower(u.username) = lower(m.sender_id)
      where u.id is null
    ) then
      raise exception 'Cannot convert messages.sender_id: one or more values do not match users.username';
    end if;

    alter table public.messages add column sender_id_uuid uuid;
    update public.messages m
    set sender_id_uuid = u.id
    from public.users u
    where lower(u.username) = lower(m.sender_id);
    alter table public.messages drop column sender_id;
    alter table public.messages rename column sender_id_uuid to sender_id;
    alter table public.messages alter column sender_id set not null;
  end if;
end $$;

alter table public.messages
  drop constraint if exists messages_sender_id_fkey;

alter table public.messages
  add constraint messages_sender_id_fkey
  foreign key (sender_id) references public.users(id) on delete cascade;

create index if not exists idx_messages_sender_id on public.messages(sender_id);