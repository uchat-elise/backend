alter table users
  add column if not exists email_verified boolean not null default false,
  add column if not exists verification_token text,
  add column if not exists token_expires_at timestamp with time zone;

create unique index if not exists idx_users_verification_token
  on users (verification_token)
  where verification_token is not null;