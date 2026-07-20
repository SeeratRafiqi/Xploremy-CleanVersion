-- Fan DNA + Book Now click tracking (run in Supabase SQL Editor)
-- Uses service role from server.js for writes; adjust RLS if you expose anon key.

-- 1) Fan DNA preferences (one row per app user_id from cookie auth)
create table if not exists public.user_preferences (
  user_id text primary key,
  categories text[] not null default '{}',
  vibes text[] not null default '{}',
  event_size text,
  travel_distance text,
  preferred_time text[] not null default '{}',
  budget text,
  home_iata text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences add column if not exists home_iata text;
alter table public.user_preferences add column if not exists user_dna jsonb;
alter table public.user_preferences add column if not exists user_dna_custom boolean not null default false;
alter table public.user_preferences add column if not exists gender text;
-- Crowd-signal fields (Feature 4 — Social Compatibility)
alter table public.user_preferences add column if not exists profession text;
alter table public.user_preferences add column if not exists age_group text;

create index if not exists user_preferences_updated_at_idx
  on public.user_preferences (updated_at desc);

-- 2) Book Now / Book tickets clicks
create table if not exists public.event_clicks (
  id bigint generated always as identity primary key,
  user_id text,
  event_id text,
  event_name text,
  city text,
  platform text,
  clicked_at timestamptz not null default now()
);

alter table public.event_clicks add column if not exists city text;
alter table public.event_clicks add column if not exists platform text;
alter table public.event_clicks add column if not exists click_source text;

create index if not exists event_clicks_user_id_idx on public.event_clicks (user_id);
create index if not exists event_clicks_clicked_at_idx on public.event_clicks (clicked_at desc);

-- Optional: disable RLS for server-only access, or add policies for authenticated roles.
alter table public.user_preferences enable row level security;
alter table public.event_clicks enable row level security;

-- 3) Flight / hotel picks in itinerary flow
create table if not exists public.flight_selections (
  id bigint generated always as identity primary key,
  user_id text,
  event_id text,
  origin_airport text,
  destination_city text,
  flight_date date,
  created_at timestamptz not null default now()
);

create index if not exists flight_selections_user_id_idx on public.flight_selections (user_id);
create index if not exists flight_selections_created_at_idx on public.flight_selections (created_at desc);

create table if not exists public.hotel_selections (
  id bigint generated always as identity primary key,
  user_id text,
  event_id text,
  hotel_name text,
  hotel_price text,
  hotel_price_numeric numeric(12, 2),
  check_in date,
  check_out date,
  city text,
  created_at timestamptz not null default now()
);

create index if not exists hotel_selections_user_id_idx on public.hotel_selections (user_id);
create index if not exists hotel_selections_created_at_idx on public.hotel_selections (created_at desc);

alter table public.flight_selections enable row level security;
alter table public.hotel_selections enable row level security;

-- Service role bypasses RLS. For anon/authenticated clients, add policies as needed.
