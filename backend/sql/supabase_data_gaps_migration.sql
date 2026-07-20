-- =============================================================================
-- Supabase data gaps migration (run once in SQL Editor)
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) itineraries_generated — link saves to app user
-- -----------------------------------------------------------------------------
ALTER TABLE public.itineraries_generated
  ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS itineraries_generated_user_id_idx
  ON public.itineraries_generated (user_id);

COMMENT ON COLUMN public.itineraries_generated.user_id IS
  'App user id from cookie session (auth-store); set on POST /api/itinerary/save';

-- -----------------------------------------------------------------------------
-- 2) event_clicks — platform source (Eventbrite, Ticket2U, etc.)
-- -----------------------------------------------------------------------------
ALTER TABLE public.event_clicks
  ADD COLUMN IF NOT EXISTS platform TEXT;

CREATE INDEX IF NOT EXISTS event_clicks_platform_idx
  ON public.event_clicks (platform);

COMMENT ON COLUMN public.event_clicks.platform IS
  'Event listing platform label, e.g. Eventbrite, Ticket2U, GoLive Asia, Ticketmelon';

ALTER TABLE public.event_clicks
  ADD COLUMN IF NOT EXISTS click_source TEXT;

CREATE INDEX IF NOT EXISTS event_clicks_click_source_idx
  ON public.event_clicks (click_source);

COMMENT ON COLUMN public.event_clicks.click_source IS
  'Where the click happened, e.g. overlay_book for Book tickets in event hub overlay';

-- -----------------------------------------------------------------------------
-- 3) flight_selections — user picks a flight in itinerary flow
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.flight_selections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT,
  event_id TEXT,
  origin_airport TEXT,
  destination_city TEXT,
  flight_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flight_selections_user_id_idx
  ON public.flight_selections (user_id);

CREATE INDEX IF NOT EXISTS flight_selections_event_id_idx
  ON public.flight_selections (event_id);

CREATE INDEX IF NOT EXISTS flight_selections_created_at_idx
  ON public.flight_selections (created_at DESC);

COMMENT ON TABLE public.flight_selections IS
  'Logged when a signed-in user selects a flight in the event hub / trip planner flow';

-- -----------------------------------------------------------------------------
-- 4) hotel_selections — user picks a hotel in itinerary flow
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hotel_selections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT,
  event_id TEXT,
  hotel_name TEXT,
  hotel_price TEXT,
  hotel_price_numeric NUMERIC(12, 2),
  check_in DATE,
  check_out DATE,
  city TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hotel_selections_user_id_idx
  ON public.hotel_selections (user_id);

CREATE INDEX IF NOT EXISTS hotel_selections_event_id_idx
  ON public.hotel_selections (event_id);

CREATE INDEX IF NOT EXISTS hotel_selections_created_at_idx
  ON public.hotel_selections (created_at DESC);

COMMENT ON TABLE public.hotel_selections IS
  'Logged when a signed-in user selects a hotel in the event hub / trip planner flow';

-- Optional: enable RLS (service role from server.js bypasses RLS)
ALTER TABLE public.flight_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hotel_selections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.hotel_selections
  ADD COLUMN IF NOT EXISTS hotel_price_numeric NUMERIC(12, 2);

-- -----------------------------------------------------------------------------
-- 5) chat_history_chatbot — link messages to signed-in user (optional)
-- -----------------------------------------------------------------------------
ALTER TABLE public.chat_history_chatbot
  ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS chat_history_chatbot_user_id_idx
  ON public.chat_history_chatbot (user_id);

COMMENT ON COLUMN public.chat_history_chatbot.user_id IS
  'App user id from cookie session when the chat message was sent';

ALTER TABLE public.chat_history_chatbot
  ADD COLUMN IF NOT EXISTS recommended_event_ids TEXT[];

COMMENT ON COLUMN public.chat_history_chatbot.recommended_event_ids IS
  'events_chatbot.id values returned in the /api/chat response for this turn';
