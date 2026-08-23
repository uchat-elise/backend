-- Safe schema alignment for users table
-- This migration adds missing columns without failing if they already exist
-- It handles partial migrations gracefully

-- Step 1: Add missing columns one at a time (if not exists prevents errors)
alter table public.users
  add column if not exists display_name text;

alter table public.users
  add column if not exists profile_picture text;

alter table public.users
  add column if not exists is_online boolean not null default false;

alter table public.users
  add column if not exists last_seen timestamp with time zone default now();

alter table public.users
  add column if not exists hide_last_seen boolean not null default false;

alter table public.users
  add column if not exists password_hash text;

alter table public.users
  add column if not exists email_verified boolean not null default false;

alter table public.users
  add column if not exists verification_token text;

alter table public.users
  add column if not exists token_expires_at timestamp with time zone;

alter table public.users
  add column if not exists created_at timestamp with time zone not null default now();

alter table public.users
  add column if not exists updated_at timestamp with time zone not null default now();

-- Step 2: Create indexes safely (if not exists prevents errors)
create unique index if not exists idx_users_username_lower on public.users (lower(username));
create unique index if not exists idx_users_email_lower on public.users (lower(email));
create index if not exists idx_users_username_search on public.users (lower(username));
create index if not exists idx_users_email_search on public.users (lower(email));
create index if not exists idx_users_profile_picture on public.users (profile_picture) where profile_picture is not null;
create index if not exists idx_users_hide_last_seen on public.users (hide_last_seen);
create index if not exists idx_users_last_seen on public.users (last_seen);
create unique index if not exists idx_users_verification_token on public.users (verification_token) where verification_token is not null;

-- Step 3: Preserve legacy compatibility column for older app versions
-- The app uses profile_picture as the canonical field, but older clients still read avatar_url.
alter table public.users
  add column if not exists avatar_url text;

update public.users
set profile_picture = avatar_url
where profile_picture is null and avatar_url is not null;
