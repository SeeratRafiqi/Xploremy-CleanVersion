-- Repeat engagement stats for admin dashboard (run once in Supabase SQL Editor).
-- Matches: GROUP BY user_id with COUNT(DISTINCT COALESCE(event_id, event_name)).

CREATE OR REPLACE FUNCTION public.repeat_engagement_stats()
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH per_user AS (
    SELECT
      user_id,
      COUNT(DISTINCT COALESCE(event_id, event_name)) AS distinct_events
    FROM public.event_clicks
    WHERE user_id IS NOT NULL
    GROUP BY user_id
  )
  SELECT json_build_object(
    'totalActiveUsers', (SELECT COUNT(*)::int FROM per_user),
    'repeatEngagers', (SELECT COUNT(*)::int FROM per_user WHERE distinct_events > 1),
    'repeatRatePercent', (
      SELECT CASE
        WHEN COUNT(*) = 0 THEN NULL
        ELSE ROUND(
          (COUNT(*) FILTER (WHERE distinct_events > 1)::numeric / COUNT(*)::numeric) * 1000
        ) / 10
      END
      FROM per_user
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.repeat_engagement_stats() TO service_role;
