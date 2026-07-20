-- Auth on Supabase profiles (run once in SQL Editor)
-- Replaces local data/users.json for Vercel / production.

-- Base table (skip if you already created profiles manually)
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  home_airport TEXT,
  last_active TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auth + profile payload columns
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS profile_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_unique_idx
  ON public.profiles (lower(email))
  WHERE email IS NOT NULL AND email <> '';

CREATE INDEX IF NOT EXISTS profiles_last_active_idx
  ON public.profiles (last_active DESC);

CREATE INDEX IF NOT EXISTS profiles_created_at_idx
  ON public.profiles (created_at DESC);

COMMENT ON TABLE public.profiles IS 'App users: auth credentials + questionnaire profile (replaces data/users.json)';
COMMENT ON COLUMN public.profiles.password_hash IS 'scrypt salt:hash hex (same format as legacy auth-store)';
COMMENT ON COLUMN public.profiles.profile_json IS 'displayName, genres, fanDna, pace, budgetLevel, etc.';

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
-- Service role from server bypasses RLS.
