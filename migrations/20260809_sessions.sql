-- Persistent session shape for deployments that use the Supabase session store.
-- Tokens are stored as SHA-256 hashes so a database read cannot replay a token.
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