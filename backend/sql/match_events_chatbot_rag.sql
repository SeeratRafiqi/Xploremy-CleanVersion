-- Run in Supabase SQL Editor (once). Adjust vector(384) if your embeddings use another size.
-- Requires: pgvector extension, tables events_chatbot + event_embeddings_chatbot

CREATE OR REPLACE FUNCTION public.match_events_chatbot_rag(
  query_embedding vector(384),
  match_count int DEFAULT 15
)
RETURNS TABLE (
  id uuid,
  title text,
  description text,
  venue text,
  city text,
  date text,
  price text,
  image_url text,
  event_url text,
  source text,
  category text,
  is_free boolean,
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    e.id,
    e.title,
    e.description,
    e.venue,
    e.city,
    e.date::text,
    e.price,
    e.image_url,
    e.event_url,
    e.source,
    e.category,
    e.is_free,
    (1 - (ee.embedding <=> query_embedding))::double precision AS similarity
  FROM public.events_chatbot e
  INNER JOIN public.event_embeddings_chatbot ee ON e.id = ee.event_id
  ORDER BY ee.embedding <=> query_embedding
  LIMIT GREATEST(1, LEAST(match_count, 100));
$$;
