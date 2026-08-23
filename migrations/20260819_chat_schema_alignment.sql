-- Align the live chat schema with the backend message persistence contract.

alter table public.chat_threads
  add column if not exists updated_at timestamp with time zone not null default now();

create table if not exists public.outbox (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts integer not null default 0,
  created_at timestamp with time zone not null default now(),
  sent_at timestamp with time zone
);

create index if not exists idx_outbox_status_created
  on public.outbox(status, created_at);

create or replace function public.claim_outbox(p_limit integer)
returns setof public.outbox
language plpgsql
as $$
declare
  rec public.outbox%rowtype;
begin
  for rec in
    select *
    from public.outbox
    where status = 'pending'
    order by created_at
    limit p_limit
    for update skip locked
  loop
    update public.outbox
      set status = 'processing', attempts = attempts + 1
      where id = rec.id;
    return next rec;
  end loop;
  return;
end;
$$;