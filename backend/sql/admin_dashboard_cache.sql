-- Admin dashboard response cache (service role writes from fan-dna-routes.js)
create table if not exists public.admin_dashboard_cache (
  id bigint generated always as identity primary key,
  section text not null unique,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists admin_dashboard_cache_updated_at_idx
  on public.admin_dashboard_cache (updated_at desc);

comment on table public.admin_dashboard_cache is
  'Cached JSON payloads for /api/admin/* sections; refreshed by scheduler and on miss.';

alter table public.admin_dashboard_cache enable row level security;
