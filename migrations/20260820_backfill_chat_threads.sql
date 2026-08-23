-- Backfill canonical chat threads for accepted friendships.

insert into public.chat_threads (id, user_a, user_b)
select
  format('chat-%s-%s', least(sender_id::text, receiver_id::text), greatest(sender_id::text, receiver_id::text)),
  least(sender_id, receiver_id),
  greatest(sender_id, receiver_id)
from public.friend_requests
where status = 'accepted'
on conflict (id) do nothing;