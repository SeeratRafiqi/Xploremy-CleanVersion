# Chat history sync (hero + drawer assistant)

The top-of-page **Eventra** chat and the floating **Event assistant** drawer share one browser storage key.

## Storage key

| Key | Purpose |
|-----|---------|
| `ticket_scraper_ai_conversations_v2` | Array of conversation objects (`messages`, `rounds`, timestamps) |

Both UIs read and write this key. Clearing history from the hero **Past searches** panel removes the same data the drawer **History** view uses.

## Hero history panel

- **Button:** circular **◷** control in the chat card header (`#hero-history-btn`)
- **Panel:** `#hero-history-overlay` (slide-over; full width on small screens)
- **Entries:** deduplicated user messages from all stored conversations, newest first (max 40)
- **Events per entry:** each item prefers the `rounds[].events` snapshot saved for that query. Tapping a row restores **that search’s grid results** (not the latest search).
- If no events were saved for a query, a fresh `/api/chat` call runs with an empty hero context (`heroChatHistory` only — not the full drawer thread).

## Events

| Event | When |
|-------|------|
| `ticket-scraper:conversations-updated` | After a chat is saved to `localStorage` |
| `ticket-scraper:conversations-cleared` | After **Clear history** (hero or programmatic clear) |

The hero badge and list listen to these events (and `storage` for other tabs).

## Chat → events (UI only)

Hero submit does **not** open the drawer. It calls `/api/chat`, filters the main `#grid`, scrolls to `#events-section` (with sticky header offset), highlights matched terms, and announces via `#events-announcer` (`role="status"`, `aria-live="polite"`).

No backend or trip-planner APIs were changed for this flow.

## GoLive Asia images

| File | Role |
|------|------|
| `data/goliveasia-image-map.json` | Event id → fresh HTTPS image URL (from last successful scrape) |
| `GET /api/golive-image/:id` | Streams the image using the map, then live API |

Re-run when images break (URLs expire ~10h): `npm run scrape:goliveasia`
