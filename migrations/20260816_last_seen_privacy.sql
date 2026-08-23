alter table users
  add column if not exists last_seen timestamp with time zone default now(),
  add column if not exists hide_last_seen boolean not null default false;

create index if not exists idx_users_hide_last_seen on users (hide_last_seen);
create index if not exists idx_users_last_seen on users (last_seen);
