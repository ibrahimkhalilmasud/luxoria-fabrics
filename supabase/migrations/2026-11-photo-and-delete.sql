-- Admin: change a fabric's photo. (Deleting a fabric needs no database change: it is hidden.)
-- Run ONCE in Supabase > SQL Editor. Safe to run again. The site works without it;
-- until it is run, the "Change photo" button stays switched off.

-- ---------------------------------------------------------------- columns on product_edits
alter table public.product_edits
  add column if not exists image_url text,
  add column if not exists thumb_url text,
  add column if not exists image_w   integer,
  add column if not exists image_h   integer;

-- Photo URLs may only point at a public fabric-photos bucket on Supabase.
alter table public.product_edits drop constraint if exists product_edits_image_url_chk;
alter table public.product_edits add constraint product_edits_image_url_chk check (
  (image_url is null and thumb_url is null and image_w is null and image_h is null)
  or (image_url ~ '^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/fabric-photos/[A-Za-z0-9._/-]+$'
      and thumb_url ~ '^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/fabric-photos/[A-Za-z0-9._/-]+$'
      and image_w between 1 and 5000 and image_h between 1 and 5000)
);

-- The public site reads the new columns too (they are public, never prices).
grant select (image_url, thumb_url, image_w, image_h) on public.product_edits to anon, authenticated;

-- ---------------------------------------------------------------- photo storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fabric-photos', 'fabric-photos', true, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = true, file_size_limit = 5242880, allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png'];

-- Anyone may view the photos (public bucket); only 2FA admins may add, replace or remove them.
drop policy if exists "admins add fabric photos" on storage.objects;
create policy "admins add fabric photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'fabric-photos' and (select public.is_admin()));

drop policy if exists "admins change fabric photos" on storage.objects;
create policy "admins change fabric photos" on storage.objects
  for update to authenticated using (bucket_id = 'fabric-photos' and (select public.is_admin()))
  with check (bucket_id = 'fabric-photos' and (select public.is_admin()));

drop policy if exists "admins remove fabric photos" on storage.objects;
create policy "admins remove fabric photos" on storage.objects
  for delete to authenticated using (bucket_id = 'fabric-photos' and (select public.is_admin()));
