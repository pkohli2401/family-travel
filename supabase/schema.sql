-- Family travel log: generic document store + family allowlist with row level security.
create table if not exists public.docs (
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create table if not exists public.family_members (
  email text primary key,
  role text not null check (role in ('owner','editor','viewer')),
  name text
);

alter table public.docs enable row level security;
alter table public.family_members enable row level security;

create or replace function public.family_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.family_members where email = lower(auth.jwt() ->> 'email')
$$;
revoke execute on function public.family_role() from public, anon;
grant execute on function public.family_role() to authenticated;

drop policy if exists docs_read on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
drop policy if exists member_self on public.family_members;

-- The settings collection (holds the private TripIt feed link) is owner-only.
create policy docs_read on public.docs for select to authenticated
  using (public.family_role() is not null and (collection <> 'settings' or public.family_role() = 'owner'));
create policy docs_insert on public.docs for insert to authenticated
  with check (public.family_role() in ('owner','editor') and (collection <> 'settings' or public.family_role() = 'owner'));
create policy docs_update on public.docs for update to authenticated
  using (public.family_role() in ('owner','editor') and (collection <> 'settings' or public.family_role() = 'owner'))
  with check (public.family_role() in ('owner','editor') and (collection <> 'settings' or public.family_role() = 'owner'));
create policy docs_delete on public.docs for delete to authenticated
  using (public.family_role() in ('owner','editor') and (collection <> 'settings' or public.family_role() = 'owner'));
create policy member_self on public.family_members for select to authenticated
  using (email = lower(auth.jwt() ->> 'email'));

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.touch_updated_at();

do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

insert into public.family_members (email, role, name)
values ('pkohli24@gmail.com', 'owner', 'Puneet')
on conflict (email) do nothing;
