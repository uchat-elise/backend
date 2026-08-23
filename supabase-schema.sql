-- Users table stores auth data and verification state.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  username text not null unique,
  display_name text,
  -- profile_picture is the canonical field used by the app.
  profile_picture text,
  -- avatar_url is kept as a compatibility alias for legacy clients/data.
  avatar_url text,
  is_online boolean not null default false,
  status text not null default 'offline' check (status in ('online', 'offline')),
  show_online_status boolean not null default true,
  last_seen timestamp with time zone default now(),
  hide_last_seen boolean not null default false,
  password_hash text not null,
  email_verified boolean not null default false,
  verification_token text,
  token_expires_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists idx_users_username_lower on users (lower(username));
create unique index if not exists idx_users_email_lower on users (lower(email));

create index if not exists idx_users_username_search on users (lower(username));
create index if not exists idx_users_email_search on users (lower(email));
create index if not exists idx_users_profile_picture on users (profile_picture) where profile_picture is not null;
create index if not exists idx_users_hide_last_seen on users (hide_last_seen);
create index if not exists idx_users_last_seen on users (last_seen);
create unique index if not exists idx_users_verification_token on users (verification_token)
  where verification_token is not null;

-- Persistent session table used by Supabase auth/session handling.
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone
);

create index if not exists idx_sessions_user_id on sessions(user_id);
create index if not exists idx_sessions_active on sessions(token_hash) where revoked_at is null;

create table if not exists friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references users(id) on delete cascade,
  receiver_id uuid not null references users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint chk_friend_request_not_self check (sender_id <> receiver_id)
);

create unique index if not exists idx_friend_requests_pending_unique
  on friend_requests (sender_id, receiver_id)
  where status = 'pending';

create index if not exists idx_friend_requests_receiver_status
  on friend_requests (receiver_id, status);

create index if not exists idx_friend_requests_sender_status
  on friend_requests (sender_id, status);

create table if not exists chat_threads (
  id text primary key,
  user_a uuid not null references users(id) on delete cascade,
  user_b uuid not null references users(id) on delete cascade,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint chk_chat_thread_users check (user_a <> user_b)
);

create unique index if not exists idx_chat_threads_unique_users
  on chat_threads (least(user_a, user_b), greatest(user_a, user_b));

-- Sequence for per-chat monotonic message sequencing
create sequence if not exists private_messages_seq;

-- Per-chat sequence table to provide monotonic per-chat sequence numbers
create table if not exists chat_seq (
  chat_id text primary key,
  last_seq bigint not null default 0
);

create or replace function next_chat_seq(p_chat_id text) returns bigint language plpgsql as $$
declare
  v bigint;
begin
  loop
    update chat_seq set last_seq = last_seq + 1 where chat_id = p_chat_id returning last_seq into v;
    if found then
      return v;
    end if;
    begin
      insert into chat_seq(chat_id, last_seq) values (p_chat_id, 1);
      return 1;
    exception when unique_violation then
      -- concurrent insert, retry
      null;
    end;
  end loop;
end;
$$;

-- Outbox table for reliable publish-after-persist pattern
create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed')),
  attempts integer not null default 0,
  created_at timestamp with time zone not null default now(),
  sent_at timestamp with time zone
);

create index if not exists idx_outbox_status_created on outbox(status, created_at);

-- Claim a batch of outbox items atomically for processing
create or replace function claim_outbox(p_limit integer) returns setof outbox language plpgsql as $$
declare
  rec outbox%rowtype;
begin
  for rec in
    select * from outbox where status = 'pending' order by created_at limit p_limit for update skip locked
  loop
    update outbox set status = 'processing', attempts = attempts + 1 where id = rec.id;
    return next rec;
  end loop;
  return;
end;
$$;

create function ensure_chat_thread_after_friend_request() returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' or old.status <> new.status) then
    if new.status = 'accepted' then
      insert into chat_threads (id, user_a, user_b)
      values (
        format('chat-%s-%s', least(new.sender_id, new.receiver_id), greatest(new.sender_id, new.receiver_id)),
        least(new.sender_id, new.receiver_id),
        greatest(new.sender_id, new.receiver_id)
      )
      on conflict do nothing;
    elsif new.status = 'rejected' then
      delete from friend_requests where id = new.id;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_friend_requests_status_change
  after insert or update on friend_requests
  for each row execute function ensure_chat_thread_after_friend_request();

-- Email verification tokens for registering and re-sending verification links.
create table if not exists email_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  token text not null unique,
  expires_at timestamp with time zone not null,
  used boolean not null default false,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_email_verification_tokens_user_id on email_verification_tokens(user_id);
create index if not exists idx_email_verification_tokens_token on email_verification_tokens(token);

create table if not exists private_messages (
  id text primary key,
  chat_id text not null,
  -- Per-chat monotonic sequence number assigned at insert time for deterministic ordering
  seq bigint not null default nextval('private_messages_seq'),
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

create index if not exists idx_private_messages_chat_id on private_messages(chat_id);
create index if not exists idx_private_messages_chat_seq on private_messages(chat_id, seq);
create index if not exists idx_private_messages_sender_username on private_messages(sender_username);

-- PostgreSQL notification channels are limited to 63 bytes. Chat IDs contain
-- two UUIDs, so message triggers must use a fixed short channel and retain
-- chat_id in the notification payload.
create or replace function public.broadcast_message_event()
returns trigger as $$
begin
  perform pg_notify('private_messages', json_build_object(
    'type', 'INSERT', 'id', new.id, 'chat_id', new.chat_id,
    'sender_username', new.sender_username,
    'sender_display_name', new.sender_display_name,
    'content', new.content, 'created_at', new.created_at,
    'attachments', new.attachments, 'voice_note', new.voice_note
  )::text);
  return new;
end;
$$ language plpgsql;

create or replace function public.broadcast_message_edit()
returns trigger as $$
begin
  if old.content is distinct from new.content or old.edited is distinct from new.edited then
    perform pg_notify('private_messages', json_build_object(
      'type', 'UPDATE', 'id', new.id, 'chat_id', new.chat_id,
      'content', new.content, 'edited', new.edited, 'updated_at', new.updated_at
    )::text);
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function public.broadcast_message_delete()
returns trigger as $$
begin
  perform pg_notify('private_messages', json_build_object(
    'type', 'DELETE', 'id', old.id, 'chat_id', old.chat_id
  )::text);
  return old;
end;
$$ language plpgsql;

create table if not exists private_message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id text not null references private_messages(id) on delete cascade,
  emoji text not null,
  username text not null,
  created_at timestamp with time zone not null default now(),
  constraint unique_reaction_per_user unique(message_id, emoji, username)
);

create index if not exists idx_private_message_reactions_message_id on private_message_reactions(message_id);

create table if not exists private_message_stars (
  id uuid primary key default gen_random_uuid(),
  message_id text not null references private_messages(id) on delete cascade,
  username text not null,
  starred_at timestamp with time zone not null default now(),
  constraint unique_star_per_user unique(message_id, username)
);

create index if not exists idx_private_message_stars_message_id on private_message_stars(message_id);

-- message_reads stores per-message read receipts (history preserved)
create table if not exists message_reads (
  id uuid primary key default gen_random_uuid(),
  message_id text not null references private_messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  read_at timestamp with time zone not null default now(),
  constraint uq_message_reads_message_user unique (message_id, user_id)
);

-- Composite unique index for fast lookups by message and user (enforces one receipt per user+message)
create unique index if not exists idx_message_reads_message_user on message_reads (message_id, user_id);