-- Run once in Supabase SQL Editor if overlay Book tickets clicks fail to save or chart is empty.
-- Safe to re-run.

ALTER TABLE public.event_clicks ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE public.event_clicks ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE public.event_clicks ADD COLUMN IF NOT EXISTS click_source TEXT;

CREATE INDEX IF NOT EXISTS event_clicks_click_source_idx
  ON public.event_clicks (click_source);

CREATE INDEX IF NOT EXISTS event_clicks_clicked_at_idx
  ON public.event_clicks (clicked_at DESC);

COMMENT ON COLUMN public.event_clicks.click_source IS
  'overlay_book = Book tickets button in event hub overlay';
