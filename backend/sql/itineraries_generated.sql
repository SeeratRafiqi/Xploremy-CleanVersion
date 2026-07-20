-- Optional storage for Trip Planner generations (run once in Supabase SQL editor).
-- Does not modify existing tables.

CREATE TABLE IF NOT EXISTS public.itineraries_generated (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT,
  event_id TEXT,
  arrival_date DATE NOT NULL,
  departure_date DATE NOT NULL,
  city TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.itineraries_generated ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS itineraries_generated_created_at
  ON public.itineraries_generated (created_at DESC);

CREATE INDEX IF NOT EXISTS itineraries_generated_user_id_idx
  ON public.itineraries_generated (user_id);

COMMENT ON TABLE public.itineraries_generated IS 'Trip Planner saves from POST /api/itinerary/save; listed by GET /api/itinerary/history';
