-- ============================================================================
-- PRIVATE CHAT MESSAGING - Complete Migration for 2 Users
-- Run these migrations in order after the base schema is set up
-- ============================================================================

-- ============================================================================
-- STEP 1: Verify chat_threads table (for 1-on-1 chats)
-- ============================================================================
-- This should already exist from base schema, but verify it's correct:

create table if not exists chat_threads (
  id text primary key,
  user_a uuid not null references users(id) on delete cascade,
  user_b uuid not null references users(id) on delete cascade,
  created_at timestamp with time zone not null default now(),
  constraint chk_chat_thread_users check (user_a <> user_b)
);

create unique index if not exists idx_chat_threads_unique_users
  on chat_threads (least(user_a, user_b), greatest(user_a, user_b));

-- ============================================================================
-- STEP 2: Update message_delivery to track recipient properly
-- ============================================================================

drop table if exists message_delivery cascade;

create table if not exists message_delivery (
  id uuid primary key default gen_random_uuid(),
  message_id text not null references private_messages(id) on delete cascade,
  recipient_user_id uuid not null references users(id) on delete cascade,
  recipient_username text not null,
  delivered_at timestamp with time zone,
  read_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_message_delivery_message_id on message_delivery(message_id);
create index if not exists idx_message_delivery_recipient_id on message_delivery(recipient_user_id);
create index if not exists idx_message_delivery_recipient_username on message_delivery(recipient_username);
create unique index if not exists idx_message_delivery_unique on message_delivery(message_id, recipient_user_id);
create index if not exists idx_message_delivery_delivered on message_delivery(delivered_at);
create index if not exists idx_message_delivery_read on message_delivery(read_at);

-- ============================================================================
-- STEP 3: Create chat_mutes table (user can mute conversations)
-- ============================================================================

create table if not exists chat_mutes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  chat_id text not null references chat_threads(id) on delete cascade,
  muted_at timestamp with time zone not null default now(),
  constraint unique_mute unique(user_id, chat_id)
);

create index if not exists idx_chat_mutes_user_id on chat_mutes(user_id);
create index if not exists idx_chat_mutes_chat_id on chat_mutes(chat_id);

-- ============================================================================
-- STEP 4: Create chat_blocks table (user can block another user)
-- ============================================================================

create table if not exists chat_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  blocked_at timestamp with time zone not null default now(),
  reason text,
  constraint chk_not_self check (blocker_id <> blocked_id),
  constraint unique_block unique(blocker_id, blocked_id)
);

create index if not exists idx_chat_blocks_blocker_id on chat_blocks(blocker_id);
create index if not exists idx_chat_blocks_blocked_id on chat_blocks(blocked_id);

-- ============================================================================
-- STEP 5: Create chat_last_read table (track last read message per user)
-- ============================================================================

create table if not exists chat_last_read (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  chat_id text not null references chat_threads(id) on delete cascade,
  last_read_message_id text references private_messages(id) on delete set null,
  last_read_at timestamp with time zone not null default now(),
  constraint unique_chat_read unique(user_id, chat_id)
);

create index if not exists idx_chat_last_read_user_id on chat_last_read(user_id);
create index if not exists idx_chat_last_read_chat_id on chat_last_read(chat_id);

-- ============================================================================
-- STEP 6: Helper functions for private messaging
-- ============================================================================

-- Function to get or create a 1-on-1 chat thread
create or replace function get_or_create_chat_thread(p_user_a uuid, p_user_b uuid) returns text as $$
declare
  v_chat_id text;
begin
  -- Ensure consistent ordering (smaller ID first)
  if p_user_a > p_user_b then
    v_chat_id := 'chat-' || p_user_b || '-' || p_user_a;
  else
    v_chat_id := 'chat-' || p_user_a || '-' || p_user_b;
  end if;
  
  -- Insert if doesn't exist
  insert into chat_threads (id, user_a, user_b)
  values (v_chat_id, least(p_user_a, p_user_b), greatest(p_user_a, p_user_b))
  on conflict (id) do nothing;
  
  return v_chat_id;
end;
$$ language plpgsql;

-- Function to send a private message
create or replace function send_private_message(
  p_message_id text,
  p_chat_id text,
  p_sender_id uuid,
  p_sender_username text,
  p_sender_display_name text,
  p_content text,
  p_recipient_id uuid,
  p_attachments jsonb default null,
  p_voice_note boolean default false,
  p_voice_duration integer default null
) returns private_messages as $$
declare
  v_message private_messages;
begin
  -- Check if sender has blocked recipient or vice versa
  if exists (
    select 1 from chat_blocks
    where (blocker_id = p_sender_id and blocked_id = p_recipient_id)
       or (blocker_id = p_recipient_id and blocked_id = p_sender_id)
  ) then
    raise exception 'Message cannot be sent: user is blocked';
  end if;
  
  -- Insert message
  insert into private_messages (id, chat_id, sender_username, sender_display_name, content, attachments, voice_note, voice_duration)
  values (p_message_id, p_chat_id, p_sender_username, p_sender_display_name, p_content, p_attachments, p_voice_note, p_voice_duration)
  returning * into v_message;
  
  -- Create delivery record for recipient
  insert into message_delivery (message_id, recipient_user_id, recipient_username)
  values (p_message_id, p_recipient_id, (select username from users where id = p_recipient_id))
  on conflict do nothing;
  
  -- Update user last_seen
  update users
  set last_seen = now(), updated_at = now()
  where id = p_sender_id;
  
  return v_message;
end;
$$ language plpgsql;

-- Function to mark message as read
create or replace function mark_message_read_v2(p_message_id text, p_user_id uuid) returns message_delivery as $$
begin
  return mark_message_read(p_message_id, (select username from users where id = p_user_id));
end;
$$ language plpgsql;

-- Function to get unread message count for a chat
create or replace function get_unread_count(p_user_id uuid, p_chat_id text) returns bigint as $$
declare
  v_count bigint;
begin
  select count(*)
  into v_count
  from private_messages pm
  left join message_delivery md on md.message_id = pm.id and md.recipient_user_id = p_user_id
  where pm.chat_id = p_chat_id
    and md.read_at is null
    and pm.sender_username <> (select username from users where id = p_user_id);
  
  return v_count;
end;
$$ language plpgsql;

-- ============================================================================
-- STEP 7: View for active chats (user's recent 1-on-1 conversations)
-- ============================================================================

create or replace view user_active_chats as
  select
    ct.id as chat_id,
    ct.user_a,
    ct.user_b,
    case when ct.user_a = (select id from users limit 1) then ct.user_b else ct.user_a end as other_user_id,
    (select username from users where id = case when ct.user_a = (select id from users limit 1) then ct.user_b else ct.user_a end) as other_username,
    (select profile_picture from users where id = case when ct.user_a = (select id from users limit 1) then ct.user_b else ct.user_a end) as other_profile_picture,
    max(pm.created_at) as last_message_at,
    max(pm.content) as last_message_content,
    ct.created_at
  from chat_threads ct
  left join private_messages pm on pm.chat_id = ct.id
  group by ct.id, ct.user_a, ct.user_b
  order by last_message_at desc nulls last;

-- ============================================================================
-- STEP 8: Trigger to update chat_last_read on message read
-- ============================================================================

create or replace function update_chat_last_read() returns trigger as $$
begin
  if new.read_at is not null then
    insert into chat_last_read (user_id, chat_id, last_read_message_id, last_read_at)
    select new.recipient_user_id, pm.chat_id, new.message_id, new.read_at
    from private_messages pm
    where pm.id = new.message_id
    on conflict (user_id, chat_id) do update
    set last_read_message_id = excluded.last_read_message_id,
        last_read_at = excluded.last_read_at;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_update_chat_last_read
  after update on message_delivery
  for each row execute function update_chat_last_read();

-- ============================================================================
-- STEP 9: Trigger to broadcast message delivery status
-- ============================================================================

create or replace function broadcast_delivery_status() returns trigger as $$
begin
  if new.delivered_at is not null or new.read_at is not null then
    perform pg_notify(
      'delivery:' || new.message_id,
      json_build_object(
        'type', case when new.read_at is not null then 'READ' else 'DELIVERED' end,
        'message_id', new.message_id,
        'recipient_id', new.recipient_user_id,
        'read_at', new.read_at,
        'delivered_at', new.delivered_at
      )::text
    );
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_broadcast_delivery_status
  after update on message_delivery
  for each row execute function broadcast_delivery_status();
