-- Luxoria backend schema. Run once in Supabase > SQL Editor.
-- Security model:
--   * anon (public website) has NO direct access to any table.
--   * Quotations are inserted only by the `submit-quote` Edge Function (secret key, server side).
--   * Admins read quotes / manage prices only when listed in public.admins AND signed in
--     with two-factor authentication (JWT aal = 'aal2').

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.quotes (
  id              uuid primary key default gen_random_uuid(),
  ref             text not null unique check (ref ~ '^[A-Z0-9]{6,10}$'),
  created_at      timestamptz not null default now(),
  channel         text not null check (channel in ('quotation', 'whatsapp', 'email')),
  request_type    text not null check (request_type in ('Quotation', 'Swatches', 'Private viewing', 'Video walkthrough')),
  client_name     text not null check (char_length(client_name) between 2 and 80),
  client_whatsapp text not null check (client_whatsapp ~ '^\+[0-9]{7,15}$'),
  client_email    text check (client_email is null or (char_length(client_email) <= 254 and client_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  message         text check (message is null or char_length(message) <= 1000),
  items           jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 200),
  status          text not null default 'new' check (status in ('new', 'contacted', 'quoted', 'won', 'closed')),
  admin_note      text check (admin_note is null or char_length(admin_note) <= 2000),
  ip_hash         text,
  notified        jsonb
);
create index if not exists quotes_created_idx on public.quotes (created_at desc);
create index if not exists quotes_ip_idx on public.quotes (ip_hash, created_at);

create table if not exists public.prices (
  product_id text primary key check (product_id ~ '^[a-z0-9-]{1,60}$'),
  price      numeric(12, 2) not null check (price >= 0),
  currency   text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- ---------------------------------------------------------------- admin check
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
     and coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2';
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.touch_price()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger if exists prices_touch on public.prices;
create trigger prices_touch before insert or update on public.prices
  for each row execute function public.touch_price();

-- ---------------------------------------------------------------- privileges
alter table public.admins enable row level security;
alter table public.quotes enable row level security;
alter table public.prices enable row level security;

revoke all on public.admins, public.quotes, public.prices from anon, authenticated;

grant select on public.admins to authenticated;
grant select, delete on public.quotes to authenticated;
grant update (status, admin_note) on public.quotes to authenticated;  -- admins cannot rewrite client data
grant select, insert, update, delete on public.prices to authenticated;

-- ---------------------------------------------------------------- policies
drop policy if exists "admin reads own row" on public.admins;
create policy "admin reads own row" on public.admins
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "admins read quotes" on public.quotes;
create policy "admins read quotes" on public.quotes
  for select to authenticated using ((select public.is_admin()));

drop policy if exists "admins update quotes" on public.quotes;
create policy "admins update quotes" on public.quotes
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "admins delete quotes" on public.quotes;
create policy "admins delete quotes" on public.quotes
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "admins manage prices" on public.prices;
create policy "admins manage prices" on public.prices
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------------------------------------------------------------- make yourself admin
-- 1. Supabase > Authentication > Users > "Add user" (email + strong password, auto-confirm).
-- 2. Then run, with your email:
--    insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';

-- ---------------------------------------------------------------- fabric edits (admin catalogue editor)
-- Corrections the admin makes to the public catalogue (name, metres, design no., ...).
-- The public site reads them (they are public details, never prices) and lays them over
-- data/products.json; only admins signed in with two-factor authentication can write.
create table if not exists public.product_edits (
  product_id    text primary key check (product_id ~ '^[a-z0-9-]{1,60}$'),
  article       text not null check (char_length(article) between 1 and 60),
  name          text not null default '' check (char_length(name) <= 80),
  category      text not null check (char_length(category) between 1 and 40),
  design_no     text not null default '' check (char_length(design_no) <= 40),
  quantity      numeric(9, 2) check (quantity is null or (quantity >= 0 and quantity <= 100000)),
  width         numeric(6, 1) check (width is null or (width > 0 and width <= 1000)),
  composition   text not null default '' check (char_length(composition) <= 80),
  colour_family text not null check (colour_family in ('Black', 'Grey', 'Ivory', 'Beige', 'Brown', 'Gold', 'Orange',
                  'Red', 'Pink', 'Purple', 'Blue', 'Teal', 'Green', 'Multicolour')),
  status        text not null default 'available' check (status in ('available', 'reserved', 'sold', 'hidden')),
  featured      boolean not null default false,
  notes         text not null default '' check (char_length(notes) <= 300),
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid()
);

drop trigger if exists product_edits_touch on public.product_edits;
create trigger product_edits_touch before insert or update on public.product_edits
  for each row execute function public.touch_price();

alter table public.product_edits enable row level security;
revoke all on public.product_edits from anon, authenticated;
grant select (product_id, article, name, category, design_no, quantity, width, composition,
              colour_family, status, featured, notes) on public.product_edits to anon, authenticated;
grant insert, update, delete on public.product_edits to authenticated;

drop policy if exists "anyone reads fabric edits" on public.product_edits;
create policy "anyone reads fabric edits" on public.product_edits
  for select to anon, authenticated using (true);

drop policy if exists "admins write fabric edits" on public.product_edits;
create policy "admins write fabric edits" on public.product_edits
  for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "admins update fabric edits" on public.product_edits;
create policy "admins update fabric edits" on public.product_edits
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "admins delete fabric edits" on public.product_edits;
create policy "admins delete fabric edits" on public.product_edits
  for delete to authenticated using ((select public.is_admin()));

-- Prices are kept in Malaysian ringgit.
alter table public.prices alter column currency set default 'MYR';
update public.prices set currency = 'MYR' where currency <> 'MYR';

-- Photo + delete (2026-11): also run supabase/migrations/2026-11-photo-and-delete.sql on existing projects.
