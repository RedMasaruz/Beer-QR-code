create table if not exists public.app_state (
  id smallint primary key check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;
revoke all on table public.app_state from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', false, 614400, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
