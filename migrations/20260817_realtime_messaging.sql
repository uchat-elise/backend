-- Real-Time Messaging Schema Extension
-- This SQL adds real-time capabilities to the messaging system using Supabase Realtime

-- ============================================================================
-- 1. TYPING INDICATORS - Track who is currently typing
-- ============================================================================
create table if not exists typing_indicators (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  username text not null,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_typing_indicators_chat_id on typing_indicators(chat_id);
create index if not exists idx_typing_indicators_expires_at on typing_indicators(expires_at);
create unique index if not exists idx_typing_indicators_chat_username on typing_indicators(chat_id, username);

-- ============================================================================
-- 2. MESSAGE DELIVERY STATUS - Track message delivery state
-- ============================================================================
create table if not exists message_delivery (
  id uuid primary key default gen_random_uuid(),
  message_id text not null references private_messages(id) on delete cascade,
  recipient_username text not null,
  delivered_at timestamp with time zone,
  read_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_message_delivery_message_id on message_delivery(message_id);
create index if not exists idx_message_delivery_recipient on message_delivery(recipient_username);
create unique index if not exists idx_message_delivery_unique on message_delivery(message_id, recipient_username);

-- ============================================================================
-- 3. ONLINE STATUS - Real-time user presence
-- ============================================================================
create table if not exists user_presence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  username text not null,
  status text not null default 'online' check (status in ('online', 'away', 'offline')),
  last_active_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists idx_user_presence_user_id on user_presence(user_id);
create index if not exists idx_user_presence_username on user_presence(username);
create index if not exists idx_user_presence_status on user_presence(status);

-- ============================================================================
-- 4. FUNCTION: Insert or update typing indicator
-- ============================================================================
create or replace function upsert_typing_indicator(
  p_chat_id text,
  p_username text,
  p_expires_at timestamp with time zone default now() + interval '5 seconds'
) returns typing_indicators as $$
  insert into typing_indicators (chat_id, username, expires_at)
  values (p_chat_id, p_username, p_expires_at)
  on conflict (chat_id, username) do update
  set expires_at = excluded.expires_at
  returning *;
$$ language sql;

-- ============================================================================
-- 5. FUNCTION: Clean expired typing indicators
-- ============================================================================
drop function if exists public.cleanup_expired_typing_indicators();

create or replace function cleanup_expired_typing_indicators()
  returns table (cleaned_count bigint) as $$
  with deleted as (
    delete from typing_indicators
    where expires_at < now()
    returning 1
  )
  select count(*)::bigint from deleted;
$$ language sql;

-- ============================================================================
-- 6. FUNCTION: Mark message as delivered
-- ============================================================================
drop function if exists public.mark_message_read_v2(text, uuid);
drop function if exists public.mark_message_delivered(text, text);
drop function if exists public.mark_message_read(text, text);

create or replace function mark_message_delivered(
  p_message_id text,
  p_recipient_username text
) returns message_delivery as $$
  insert into message_delivery (message_id, recipient_user_id, recipient_username, delivered_at)
  values (p_message_id, (select id from users where username = p_recipient_username), p_recipient_username, now())
  on conflict (message_id, recipient_username) do update
  set delivered_at = now()
  returning *;
$$ language sql;

-- ============================================================================
-- 7. FUNCTION: Mark message as read
-- ============================================================================
create or replace function mark_message_read(
  p_message_id text,
  p_recipient_username text
) returns message_delivery as $$
  insert into message_delivery (message_id, recipient_user_id, recipient_username, read_at, delivered_at)
  values (p_message_id, (select id from users where username = p_recipient_username), p_recipient_username, now(), now())
  on conflict (message_id, recipient_username) do update
  set read_at = now(),
      delivered_at = coalesce(excluded.delivered_at, message_delivery.delivered_at, now())
  returning *;
$$ language sql;

create or replace function mark_message_read_v2(p_message_id text, p_user_id uuid) returns message_delivery as $$
begin
  return mark_message_read(p_message_id, (select username from users where id = p_user_id));
end;
$$ language plpgsql;

-- ============================================================================
-- 8. FUNCTION: Update user presence
-- ============================================================================
create or replace function update_user_presence(
  p_user_id uuid,
  p_username text,
  p_status text default 'online'
) returns user_presence as $$
  insert into user_presence (user_id, username, status, last_active_at)
  values (p_user_id, p_username, p_status, now())
  on conflict (user_id) do update
  set status = excluded.status,
      last_active_at = now(),
      updated_at = now()
  returning *;
$$ language sql;

-- ============================================================================
-- 9. FUNCTION: Insert message with delivery tracking
-- ============================================================================
create or replace function insert_message_with_delivery(
  p_id text,
  p_chat_id text,
  p_sender_username text,
  p_sender_display_name text,
  p_content text,
  p_recipient_username text,
  p_attachments jsonb default null,
  p_voice_note boolean default false,
  p_voice_duration integer default null
) returns private_messages as $$
declare
  v_message private_messages;
begin
  insert into private_messages (id, chat_id, sender_username, sender_display_name, content, attachments, voice_note, voice_duration)
  values (p_id, p_chat_id, p_sender_username, p_sender_display_name, p_content, p_attachments, p_voice_note, p_voice_duration)
  returning * into v_message;
  
  -- Create delivery record for recipient
  insert into message_delivery (message_id, recipient_user_id, recipient_username)
  values (p_id, (select id from users where username = p_recipient_username), p_recipient_username)
  on conflict do nothing;
  
  return v_message;
end;
$$ language plpgsql;

-- ============================================================================
-- 10. TRIGGER: Auto-update user last_seen on activity
-- ============================================================================
create or replace function update_user_last_seen()
  returns trigger as $$
begin
  update users
  set last_seen = now(), updated_at = now()
  where username = new.sender_username;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_message_updates_last_seen on private_messages;
create trigger trg_message_updates_last_seen
  after insert on private_messages
  for each row execute function update_user_last_seen();

-- ============================================================================
-- 11. TRIGGER: Broadcast new messages via Supabase Realtime
-- ============================================================================
create or replace function broadcast_message_event()
  returns trigger as $$
begin
  perform pg_notify(
    'messages:' || new.chat_id,
    json_build_object(
      'type', 'INSERT',
      'id', new.id,
      'chat_id', new.chat_id,
      'sender_username', new.sender_username,
      'sender_display_name', new.sender_display_name,
      'content', new.content,
      'created_at', new.created_at,
      'attachments', new.attachments,
      'voice_note', new.voice_note
    )::text
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_broadcast_new_message on private_messages;
create trigger trg_broadcast_new_message
  after insert on private_messages
  for each row execute function broadcast_message_event();

-- ============================================================================
-- 12. TRIGGER: Broadcast message edits
-- ============================================================================
create or replace function broadcast_message_edit()
  returns trigger as $$
begin
  if old.content is distinct from new.content or old.edited is distinct from new.edited then
    perform pg_notify(
      'messages:' || new.chat_id,
      json_build_object(
        'type', 'UPDATE',
        'id', new.id,
        'chat_id', new.chat_id,
        'content', new.content,
        'edited', new.edited,
        'updated_at', new.updated_at
      )::text
    );
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_broadcast_message_edit on private_messages;
create trigger trg_broadcast_message_edit
  after update on private_messages
  for each row execute function broadcast_message_edit();

-- ============================================================================
-- 13. TRIGGER: Broadcast message deletions
-- ============================================================================
create or replace function broadcast_message_delete()
  returns trigger as $$
begin
  perform pg_notify(
    'messages:' || old.chat_id,
    json_build_object(
      'type', 'DELETE',
      'id', old.id,
      'chat_id', old.chat_id
    )::text
  );
  return old;
end;
$$ language plpgsql;

drop trigger if exists trg_broadcast_message_delete on private_messages;
create trigger trg_broadcast_message_delete
  before delete on private_messages
  for each row execute function broadcast_message_delete();

-- ============================================================================
-- 14. TRIGGER: Broadcast reactions
-- ============================================================================
create or replace function broadcast_reaction_change()
  returns trigger as $$
begin
  if tg_op = 'INSERT' then
    perform pg_notify(
      'reactions:' || new.message_id,
      json_build_object(
        'type', 'INSERT',
        'message_id', new.message_id,
        'emoji', new.emoji,
        'username', new.username
      )::text
    );
  elsif tg_op = 'DELETE' then
    perform pg_notify(
      'reactions:' || old.message_id,
      json_build_object(
        'type', 'DELETE',
        'message_id', old.message_id,
        'emoji', old.emoji,
        'username', old.username
      )::text
    );
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_broadcast_reaction_add on private_message_reactions;
create trigger trg_broadcast_reaction_add
  after insert on private_message_reactions
  for each row execute function broadcast_reaction_change();

drop trigger if exists trg_broadcast_reaction_delete on private_message_reactions;
create trigger trg_broadcast_reaction_delete
  after delete on private_message_reactions
  for each row execute function broadcast_reaction_change();

-- ============================================================================
-- 15. VIEW: Active users in a chat (for real-time subscriptions)
-- ============================================================================
create or replace view active_chat_users as
  select distinct
    t.chat_id,
    t.username,
    u.profile_picture,
    t.expires_at
  from typing_indicators t
  left join users u on u.username = t.username
  where t.expires_at > now()
  order by t.chat_id, t.username;

-- ============================================================================
-- 16. VIEW: Message read status
-- ============================================================================
create or replace view message_read_status as
  select
    pm.id as message_id,
    pm.chat_id,
    pm.sender_username,
    count(distinct md.recipient_username) as total_recipients,
    count(distinct case when md.delivered_at is not null then md.recipient_username end) as delivered_count,
    count(distinct case when md.read_at is not null then md.recipient_username end) as read_count
  from private_messages pm
  left join message_delivery md on md.message_id = pm.id
  group by pm.id, pm.chat_id, pm.sender_username;

-- ============================================================================
-- 17. Indexes for performance
-- ============================================================================
create index if not exists idx_message_delivery_delivered on message_delivery(delivered_at);
create index if not exists idx_message_delivery_read on message_delivery(read_at);
create index if not exists idx_user_presence_last_active on user_presence(last_active_at);
create index if not exists idx_private_messages_created_at on private_messages(created_at);
create index if not exists idx_private_messages_updated_at on private_messages(updated_at);

-- ============================================================================
-- NOTES FOR FRONTEND INTEGRATION
-- ============================================================================
-- 1. Subscribe to message channels:
--    supabase.channel('messages:' + chatId).subscribe()
--
-- 2. Subscribe to reaction channels:
--    supabase.channel('reactions:' + messageId).subscribe()
--
-- 3. Subscribe to typing indicators:
--    supabase.channel('typing:' + chatId).subscribe()
--
-- 4. On message send:
--    - Call INSERT into private_messages
--    - Channel broadcasts automatically via trigger
--    - Frontend receives via channel listener
--
-- 5. To mark as delivered:
--    SELECT mark_message_delivered(messageId, username)
--
-- 6. To mark as read:
--    SELECT mark_message_read(messageId, username)
--
-- 7. For typing indicators:
--    SELECT upsert_typing_indicator(chatId, username, now() + '5 seconds'::interval)
