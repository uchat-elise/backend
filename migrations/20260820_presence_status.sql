-- Presence is event-driven in Socket.IO; these columns are the durable last-known state.
do $$
begin
  create type public.presence_status as enum ('online', 'offline');
exception
  when duplicate_object then null;
end $$;

alter table public.users
  add column if not exists status public.presence_status not null default 'offline',
  add column if not exists show_online_status boolean not null default true,
  add column if not exists last_seen timestamptz;

alter table public.users
  drop constraint if exists users_status_check;

alter table public.users
  add constraint users_status_check check (status in ('online', 'offline'));

create index if not exists idx_users_status on public.users(status);

-- The messages migration owns this column and its enum type. Add it only when
-- repairing a database where public.messages exists without the column.
do $$
begin
  if to_regclass('public.messages') is not null
     and not exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'messages'
         and column_name = 'status'
     ) then
    alter table public.messages
      add column status public.message_status not null default 'sent';
  end if;
end $$;
