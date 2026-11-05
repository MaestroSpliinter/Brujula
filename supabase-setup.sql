-- Run this once in Supabase Dashboard > SQL Editor for the Brújula project.
create table if not exists public.brujula_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"events":[],"tasks":[],"notes":[],"settings":{}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.brujula_data enable row level security;

revoke all on public.brujula_data from anon, authenticated;
grant select, insert, update on public.brujula_data to authenticated;

drop policy if exists "Users can read their own Brújula data" on public.brujula_data;
create policy "Users can read their own Brújula data"
  on public.brujula_data for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own Brújula data" on public.brujula_data;
create policy "Users can insert their own Brújula data"
  on public.brujula_data for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own Brújula data" on public.brujula_data;
create policy "Users can update their own Brújula data"
  on public.brujula_data for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
