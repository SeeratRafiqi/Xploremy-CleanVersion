# Eventra UI + AI Transformation Plan

This document is the single source of truth for transforming Eventra into a premium AI-powered Malaysia tourism and event discovery platform.

Use this README before executing any future phase. Each phase is intentionally scoped so it can be executed independently by saying, for example: "Execute Phase 1 only."

## 1. Executive Summary

Eventra should become an AI-powered Malaysia tourism copilot that turns live events into complete travel plans.

The product should help foreign tourists discover what is happening in Malaysia, understand why an event is worth building a trip around, compare external ticket/flight/hotel options, generate AI itineraries, save trip plans, and continue planning later.

Eventra is not a booking platform. It should never behave like it owns ticketing, flight booking, or hotel booking. It should curate, explain, guide, and redirect users to original providers.

Target product statement:

> Eventra turns live Malaysia events into AI-guided travel journeys, helping tourists discover events, plan around them, and continue the trip planning flow with clear external booking handoffs.

## 2. Current Problem Diagnosis

### UI Issues

- The interface still carries several legacy layers from a developer demo.
- Styles are split between large inline CSS in `viewer.html` and `eventra-ticket-theme.css`, making consistency difficult.
- Some sections use premium dark styling while others still feel like raw cards or form panels.
- Event cards can feel repetitive because similar metadata appears across curated sections, search results, chat results, and event detail.
- There are still utility labels, source counts, provider names, and technical copy that make the experience feel like a database viewer.
- Some modal surfaces feel visually disconnected from the homepage.

### UX Issues

- Users do not get one clear path from inspiration to planning.
- Event discovery, AI search, event detail, flight search, hotel search, and itinerary generation exist, but the flow feels assembled rather than guided.
- Users still have to understand which tab to use and what order to use it in.
- The current trip flow can feel like: choose event, manually set dates, manually search flights, manually search hotels, manually generate itinerary.
- The platform should feel like it is guiding the user, not waiting for the user to operate a tool.

### Repeated Sections

- Event data has appeared in multiple places: curated rails, city sections, full grid, chat result cards, and modal recommendations.
- The page should not show the same event visually multiple times on the initial homepage.
- Curated sections and full browsing sections need distinct purposes:
  - Curated sections inspire.
  - City cards guide.
  - The full grid browses/searches.

### Bad Chat Behavior

- `Ask Eventra` currently opens an overlay/drawer that resembles a generic chat UI.
- The AI response can feel text-first instead of result-first.
- Users who ask, "I want a luxury concert weekend in KL," should receive visual event recommendations and next-step chips, not just a chat transcript.
- The current chat pattern risks becoming a support bot instead of an AI event discovery engine.

### Manual Workflows

- Flight search needs explicit origin/date input.
- Hotel search needs explicit city/check-in/check-out input.
- Itinerary generation needs the user to know which controls matter.
- The assistant should infer city, date, venue, travel window, and reasonable defaults from the selected event wherever possible.

### Weak AI Experience

- The app uses Alibaba Qwen/DashScope for chat and itinerary generation, but the user experience does not always make the AI reasoning visible.
- Recommendations need explanations such as:
  - Why this event fits the user.
  - Why this flight timing is safer.
  - Why this hotel area matches the trip.
  - Why the itinerary schedule is realistic.
- AI should ask follow-up questions only when required, not as a long form.

### Confusing Event Discovery

- Homepage discovery needs to be structured as:
  - Inspire.
  - Guide.
  - Browse.
- Event discovery should not feel like scrolling through hundreds of raw scraped records.
- Initial event cards should be limited and curated.
- Full results should appear only in the main browse/search section.

### Weak Event Detail Flow

- The event detail/hub exists in `event-hub.js` and `viewer.html`, but it still behaves partly like a modal tool.
- It should feel like an experience page:
  - Cinematic event visual.
  - AI trip insight.
  - External ticket CTA.
  - Suggested trip duration.
  - Best stay areas.
  - Nearby experiences.
  - Clear next planning step.

### Weak Flight, Hotel, and Itinerary Flow

- Flight and hotel helpers in `serp-flights-helpers.js` and `serp-hotels-helpers.js` render provider data, but the product should present AI-ranked options.
- The app should explain tradeoffs:
  - Best timing.
  - Cheapest.
  - Fastest.
  - Closest to venue.
  - Best nightlife area.
  - Best value.
- `itinerary-routes.js` already contains substantial itinerary logic, variants, enrichment, saving, and history endpoints. The UI needs to make this feel like an AI travel journey, not a generated text output.

## 3. Target Product Experience

### Ideal User Journey

1. User lands on Eventra.
2. The hero immediately communicates: Malaysia is happening now and Eventra can plan around it.
3. If the user is logged in, Eventra uses saved profile/preferences from onboarding/profile.
4. If profile data is incomplete, Eventra asks one or two lightweight preference questions at the right moment.
5. User asks naturally: "I want a luxury concert weekend in KL."
6. Ask Eventra returns a visual recommendation panel:
   - 3 to 6 matching event cards.
   - AI explanation for each.
   - Suggested city/trip angle.
   - Follow-up chips like "Make it cheaper", "Add nightlife", "Family friendly", "This weekend only".
7. User selects an event.
8. Event detail opens as a premium experience page.
9. Eventra explains why the event is worth planning around.
10. User sees one primary CTA: "Plan my trip around this."
11. AI assistant guides the user:

- Ticket provider link first.
- Flight recommendations if origin is known or after one question if missing.
- Hotel/stay recommendations based on venue/city/budget/preferences.
- AI itinerary draft and alternatives.

12. User saves the trip:

- Event.
- External ticket link.
- External flight search/selected option link.
- External hotel search/selected option link.
- Itinerary.
- AI notes.

13. User returns later and continues planning from saved trips/history.

## 4. Phase-by-Phase Transformation Roadmap

## PHASE 1 — Product Structure and UI Cleanup Plan

### Phase Goal

Remove duplicated UI, repeated event sections, clutter, unnecessary data, repeated CTAs, and raw API-looking UI.

### Current Problem

The homepage and event surfaces still contain overlapping concepts:

- Curated event sections.
- City sections.
- Full listing.
- AI chat results.
- Source counts.
- Repeated metadata and CTAs.

Users cannot easily tell where to start.

### Target Behavior

The app should have one clear page hierarchy:

1. Hero / AI command.
2. One curated event section.
3. Trending cities.
4. One All Events browse/search/filter grid.
5. Event detail opens from any event card.

No event should appear visually multiple times on the initial page unless the context is clearly different and intentional.

### Files Likely Involved

- `viewer.html`
- `eventra-ticket-theme.css`
- `event-hub.js`
- `chatbot-utils.js` only if result grouping logic affects repeated results

### Implementation Tasks

- Audit all visible homepage sections.
- Remove or hide duplicate event rails.
- Keep only one curated event section with 6 to 8 cards.
- Keep city cards city-only.
- Keep one All Events grid for browsing.
- Limit initial All Events rendering to a reasonable number.
- Remove repeated source stats from primary UI.
- Remove repeated CTAs in event cards.
- Ensure search/filter results are the only full event browsing surface.

### Non-Goals

- Do not redesign AI logic.
- Do not change backend APIs.
- Do not add saved trips.
- Do not rebuild itinerary generation.

### Acceptance Criteria

- Initial homepage shows one curated event section only.
- Initial homepage does not show the same event in multiple visible sections.
- There is one clear All Events grid.
- Source/provider counts are not visually dominant.
- The page reads as inspire -> guide -> browse.

### Risks

- Removing sections may break assumptions in JS event listeners.
- Existing CSS may still style removed/hidden sections.
- Search/filter counts may not match displayed cards if curated items are excluded.

### Test Checklist

- Load `http://localhost:3040/`.
- Confirm no console errors.
- Confirm curated section renders 6 to 8 cards.
- Confirm old duplicate rails are absent.
- Confirm city cards do not contain event cards.
- Confirm All Events grid works.
- Search an event and confirm relevant cards appear.
- Click an event from curated cards and All Events cards.

### Future Execution Prompt

```text
Execute Phase 1 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect the current homepage structure before editing. Preserve existing backend logic and event data loading. Remove duplicated event sections and repeated visual content. Make a short implementation plan before editing. After completion, list modified files, removed duplicated sections, and test results.
```

## PHASE 2 — Global Visual Design System

### Phase Goal

Create a premium futuristic visual foundation: dark mode, spacing, typography, cards, buttons, modals, loading states, and mobile base.

### Current Problem

Visual styling is inconsistent. Some areas look premium, while others look like a developer demo or raw API output. The app needs one visual language.

### Target Behavior

Eventra should feel like a premium Malaysia tourism operating system:

- Cinematic dark theme.
- Clean glass surfaces.
- Consistent type scale.
- Consistent spacing.
- Premium cards.
- Elegant buttons.
- Calm loading states.
- Responsive mobile base.

### Files Likely Involved

- `eventra-ticket-theme.css`
- `viewer.html`
- `auth.html`
- `onboarding.html`
- `profile.html`
- `event-hub.js` only if class hooks are needed
- `itinerary-modal.js` only if class hooks are needed

### Implementation Tasks

- Define global tokens for color, type, spacing, radii, shadows, and motion.
- Consolidate repeated visual rules where safe.
- Create consistent button variants.
- Create consistent card variants.
- Create consistent modal/panel styles.
- Create skeleton/loading states.
- Create mobile spacing and layout rules.
- Ensure external provider CTAs look consistent.

### Non-Goals

- Do not redesign product flow.
- Do not modify API responses.
- Do not add new AI features.
- Do not implement saved trips beyond existing functionality.

### Acceptance Criteria

- Homepage, event hub, itinerary modal, flight cards, hotel cards, auth/profile/onboarding share the same visual language.
- No random cream/white blocks appear inside the dark theme unless intentionally designed.
- Buttons and cards feel consistent.
- Loading and empty states feel premium.
- Mobile layout is readable and stable.

### Risks

- Existing inline CSS in `viewer.html` may override stylesheet changes.
- Modal components may depend on old dimensions.
- Over-styling can make dense itinerary content harder to read.

### Test Checklist

- Load homepage desktop.
- Load homepage mobile viewport.
- Open Ask Eventra.
- Open event detail.
- Open itinerary modal.
- Open flight/hotel sections.
- Confirm no clipped buttons or overlapping text.
- Confirm no console errors.

### Future Execution Prompt

```text
Execute Phase 2 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect existing CSS and inline styles before editing. Create a consistent premium visual system while preserving current functionality. Avoid adding new product features. Make a short implementation plan before editing. After completion, list modified files, design system changes, and visual test results.
```

## PHASE 3 — Homepage and Event Discovery Rebuild

### Phase Goal

Make homepage/event discovery clean, cinematic, and not repetitive. Use one clear journey:

Hero -> Ask Eventra -> AI Picks -> Trending Cities -> All Events.

### Current Problem

The homepage still feels partly like a visual database. Ask Eventra, curated events, cities, and browsing need stronger hierarchy.

### Target Behavior

The homepage should make users instantly understand:

- Malaysia has live events worth traveling for.
- Eventra can answer natural language travel/event requests.
- A few curated picks are available immediately.
- Cities can be explored.
- All events can be searched/filtered when needed.

### Files Likely Involved

- `viewer.html`
- `eventra-ticket-theme.css`
- `event-hub.js`
- `server.js` only if `/api/events` needs extra fields already available but not exposed

### Implementation Tasks

- Rebuild hero copy and layout around the AI command bar.
- Make Ask Eventra the primary interaction.
- Limit AI Picks to 6 to 8 curated cards.
- Make Trending Cities city-only with no event duplication.
- Make All Events the only full event grid.
- Improve card copy and hierarchy.
- Add clean empty/loading states.
- Ensure card clicks open event detail consistently.

### Non-Goals

- Do not rebuild Ask Eventra AI behavior yet.
- Do not change itinerary generation.
- Do not add new providers.

### Acceptance Criteria

- Homepage has a clear visual journey.
- No duplicate event sections.
- AI command bar is visually primary.
- Event cards are concise.
- All Events grid is clearly secondary to the curated experience.

### Risks

- Hero command may still trigger old chat overlay until Phase 4.
- Existing event data quality may limit premium feel.
- Long event titles may need truncation rules.

### Test Checklist

- Load homepage.
- Verify initial viewport communicates the product.
- Verify AI Picks count.
- Verify city cards count.
- Verify All Events grid.
- Verify search/filter.
- Verify card click opens event detail.

### Future Execution Prompt

```text
Execute Phase 3 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect the existing homepage, event card rendering, and event filtering first. Rebuild only the homepage/event discovery structure around Hero -> Ask Eventra -> AI Picks -> Trending Cities -> All Events. Preserve existing APIs and event hub logic. Make a short implementation plan before editing. After completion, list modified files and browser verification results.
```

## PHASE 4 — Ask Eventra AI Search Experience

### Phase Goal

Ask Eventra must not open a generic chat popup. It must work as an AI event discovery engine that returns visual recommendations and follow-up suggestions.

### Current Problem

The current AI overlay behaves too much like a chatbot. It includes a chat log, drawer UI, history controls, and result cards that feel secondary.

### Target Behavior

Ask Eventra should behave like an AI discovery surface:

- User asks a natural language request.
- Eventra extracts intent: city, date range, event type, mood, budget, traveler style.
- Eventra returns visual event recommendations first.
- Eventra explains why each result fits.
- Eventra offers follow-up chips.
- Eventra can refine results without making users type long prompts repeatedly.

### Files Likely Involved

- `viewer.html`
- `server.js`
- `chatbot-utils.js`
- `event-hub.js`
- `auth-client.js` if profile context is passed

### Implementation Tasks

- Replace generic chat-first overlay with result-first AI discovery panel.
- Keep conversational capability, but make it subordinate to visual recommendations.
- Use `/api/chat` or a new endpoint only if needed.
- Pass user profile/preference context when available.
- Parse AI/event results into structured display sections.
- Add follow-up chips:
  - This weekend.
  - Luxury.
  - Budget.
  - Nightlife.
  - Family friendly.
  - Culture.
  - Food trip.
- Ensure clicking a recommendation opens event detail.

### Non-Goals

- Do not implement full trip planning in this phase.
- Do not add saved trips.
- Do not rewrite itinerary generation.

### Acceptance Criteria

- Ask Eventra opens a discovery experience, not a generic chat popup.
- A prompt like "I want a luxury concert weekend in KL" returns visual event cards.
- Results include AI reasons.
- Follow-up chips refine recommendations.
- Event selection from AI results works.

### Risks

- `/api/chat` may return freeform text that is difficult to parse.
- Supabase/RAG results may be inconsistent.
- Need graceful fallback when AI credentials are missing.

### Test Checklist

- Ask: "I want a luxury concert weekend in KL."
- Ask: "Find cultural experiences in Penang this weekend."
- Ask: "I want a family friendly trip around an event."
- Confirm visual cards appear.
- Confirm follow-up chips work.
- Confirm no generic empty chat screen.
- Confirm AI unavailable state is useful.

### Future Execution Prompt

```text
Execute Phase 4 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect Ask Eventra UI, /api/chat, chatbot-utils.js, and current event result rendering first. Transform Ask Eventra into a result-first AI event discovery engine with visual recommendations and follow-up chips. Preserve existing AI/backend logic where possible. Make a short implementation plan before editing. After completion, list modified files and test prompts used.
```

## PHASE 5 — Event Detail / Experience Page

### Phase Goal

When a user clicks an event, it should open a premium event experience page with AI insight, ticket link, and next planning step.

### Current Problem

The event hub has useful functionality but still feels like a modal with tabs and controls. It should feel like the beginning of a travel experience.

### Target Behavior

Event detail should show:

- Cinematic event image.
- Event title.
- Date, city, venue.
- One external ticket/provider CTA.
- AI insight: why this trip is worth it.
- Suggested trip duration.
- Best stay areas.
- Nearby food/culture/nightlife ideas.
- One primary next step: "Plan my trip around this."

### Files Likely Involved

- `viewer.html`
- `event-hub.js`
- `eventra-ticket-theme.css`
- `serp-flights-helpers.js`
- `serp-hotels-helpers.js`

### Implementation Tasks

- Simplify event hero hierarchy.
- Remove repeated metadata.
- Replace tab-heavy first impression with guided planning layout.
- Keep external ticket redirect clear.
- Add AI trip insight from existing event fields, with Qwen enhancement later if needed.
- Make flight/hotel/itinerary actions feel like steps in one journey.

### Non-Goals

- Do not build a direct booking system.
- Do not change scraping.
- Do not redesign saved trips.

### Acceptance Criteria

- Clicking an event opens a premium experience page/modal.
- One ticket CTA redirects externally.
- User understands the next step.
- Event detail does not repeat the same information in multiple panels.
- Event detail supports desktop and mobile.

### Risks

- Current tab logic may be tightly coupled to flight/hotel/itinerary controls.
- Removing tabs too aggressively may hide existing functions.
- Some events lack images or descriptions.

### Test Checklist

- Open event from AI Picks.
- Open event from All Events.
- Confirm external ticket link opens provider in new tab.
- Confirm "Plan my trip around this" starts guided planning.
- Confirm missing image fallback looks premium.

### Future Execution Prompt

```text
Execute Phase 5 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect event-hub.js and event detail markup/styles first. Redesign event detail into a premium event experience page/modal while preserving ticket, flight, hotel, and itinerary logic. Make a short implementation plan before editing. After completion, list modified files and event-detail test results.
```

## PHASE 6 — AI-Guided Ticket, Flight, and Hotel Flow

### Phase Goal

Reduce manual input. AI assistant should guide users step by step and recommend ticket source, flight options, and hotel/stay options using context.

### Current Problem

Users must manually understand the relationship between event, dates, flight search, hotel search, and itinerary planning.

### Target Behavior

After event selection:

1. Ticket provider is shown as an external handoff.
2. AI asks only missing essentials:
   - "Where are you flying from?"
   - "How many nights?"
   - "Budget or comfort preference?"
3. Flight options are ranked and explained.
4. Hotel options are venue/city-aware and explained.
5. CTAs redirect externally.
6. User can continue without selecting every option.

### Files Likely Involved

- `event-hub.js`
- `serp-flights-helpers.js`
- `serp-hotels-helpers.js`
- `flight-search.js`
- `hotel-search.js`
- `server.js`
- `profile.html`
- `auth-client.js`

### Implementation Tasks

- Use event city/date/venue as defaults.
- Use saved home airport from profile where available.
- Ask for origin only if missing.
- Add AI labels and reasons to flight options.
- Add AI labels and reasons to hotel options.
- Make redirect language explicit:
  - "Open Google Flights."
  - "Open hotel provider."
  - "External provider."
- Ensure user can proceed to itinerary without selecting flight/hotel.

### Non-Goals

- Do not book tickets, hotels, or flights.
- Do not store payment data.
- Do not scrape protected/private booking data.
- Do not require flight/hotel selection before itinerary.

### Acceptance Criteria

- User is guided from event to ticket link to travel options.
- Missing origin triggers one clear question.
- Flight results include AI reason labels.
- Hotel results include AI reason labels.
- External redirects are clear.
- User can proceed to itinerary with or without selected options.

### Risks

- SerpAPI limits or missing key may block live results.
- Profile airport data may be incomplete.
- Flight timing logic may need event time, which many events may not have.

### Test Checklist

- Select event with city/date.
- Test with profile home airport.
- Test without profile home airport.
- Search flights.
- Search hotels.
- Confirm external links open provider pages.
- Confirm itinerary button remains available.

### Future Execution Prompt

```text
Execute Phase 6 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect event-hub.js, flight/hotel helpers, flight-search.js, hotel-search.js, server flight/hotel routes, and profile data usage first. Implement AI-guided ticket, flight, and hotel flow without direct booking. Preserve existing provider redirects. Make a short implementation plan before editing. After completion, list modified files and test results for event -> ticket -> flight -> hotel.
```

## PHASE 7 — AI Itinerary Planner and Alternatives

### Phase Goal

Generate beautiful itinerary plans and alternatives such as budget, comfort, luxury, cultural, family, and food-focused plans.

### Current Problem

The itinerary engine is powerful, but the UI can feel static and complex. Alternatives exist conceptually, but the product should make them feel like curated travel styles.

### Target Behavior

The itinerary planner should:

- Draft an itinerary around the event first.
- Support alternatives:
  - Budget.
  - Comfort.
  - Luxury.
  - Cultural.
  - Family.
  - Food-focused.
- Explain why the schedule works.
- Include event attendance in the timeline.
- Include food, culture, nightlife, transport buffers, and local tips.
- Let users regenerate a day.
- Let users save the selected version.

### Files Likely Involved

- `itinerary-modal.js`
- `itinerary-routes.js`
- `viewer.html`
- `event-hub.js`
- `server.js`
- `sql/itineraries_generated.sql`

### Implementation Tasks

- Redesign generated itinerary display into a beautiful timeline.
- Make variant selection clear.
- Surface AI notes and warnings in plain travel language.
- Keep event day visually anchored.
- Add "regenerate this day" as a contextual action.
- Improve empty/loading states:
  - "Building your Malaysia travel arc..."
  - "Checking event timing and local travel buffers..."
- Ensure external ticket/flight/hotel links remain visible but not dominant.

### Non-Goals

- Do not require booking.
- Do not implement real-time weather/traffic unless already available.
- Do not create a separate itinerary product outside Eventra flow.

### Acceptance Criteria

- Itinerary generation works after selecting only an event and dates.
- Variants are visible and understandable.
- Timeline is readable on desktop and mobile.
- AI warnings are useful.
- Save action works.

### Risks

- Qwen response structure may vary.
- Long itineraries may overflow mobile.
- Saved trip schema may need normalization.

### Test Checklist

- Generate itinerary with event only.
- Generate itinerary with event + selected flight.
- Generate itinerary with event + selected hotel.
- Switch itinerary variants.
- Regenerate one day.
- Save itinerary.
- Reopen saved itinerary.

### Future Execution Prompt

```text
Execute Phase 7 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect itinerary-modal.js, itinerary-routes.js, event-hub.js, and saved itinerary endpoints first. Transform the itinerary planner into a premium AI travel timeline with clear alternatives. Preserve existing Qwen generation and save/history logic. Make a short implementation plan before editing. After completion, list modified files and itinerary test results.
```

## PHASE 8 — Saved Trips and Continue Later

### Phase Goal

Allow users to save trip plans with event, ticket link, flight link, hotel link, itinerary, and AI notes.

### Current Problem

Saved itinerary/history exists, but it needs to become a clear product feature: saved trips, not just saved generated payloads.

### Target Behavior

Saved trips should include:

- Event details.
- External ticket link.
- Selected or suggested flight/search link.
- Selected or suggested hotel/search link.
- Itinerary variant.
- AI notes/warnings.
- User preferences used.
- Continue planning action.

### Files Likely Involved

- `itinerary-routes.js`
- `itinerary-modal.js`
- `profile.html`
- `auth-client.js`
- `server.js`
- `sql/itineraries_generated.sql`
- Potential new SQL migration if schema expansion is required

### Implementation Tasks

- Audit current saved itinerary schema.
- Define saved trip object structure.
- Ensure save action is explicit and user-confirmed.
- Add "Saved Trips" or improve existing history UI.
- Allow reopening saved trips into the planner.
- Store external links as links, not bookings.
- Add empty state for no saved trips.

### Non-Goals

- Do not store payment or booking confirmations.
- Do not integrate booking accounts.
- Do not build calendar sync unless separately requested.

### Acceptance Criteria

- User can save a complete trip plan.
- User can view saved trips.
- User can reopen a saved trip.
- Saved trip clearly shows external links.
- Saved trips persist per authenticated user where backend supports it.

### Risks

- Existing Supabase table may not contain all fields.
- Authentication state may be incomplete.
- Local fallback may be needed if Supabase is unavailable.

### Test Checklist

- Save trip while logged in.
- Save trip while logged out if fallback exists.
- Reopen saved trip.
- Confirm event/ticket/flight/hotel/itinerary data is retained.
- Confirm no direct booking language appears.

### Future Execution Prompt

```text
Execute Phase 8 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect saved itinerary endpoints, SQL schema, auth-client.js, profile/history UI, and itinerary-modal.js first. Implement saved trips and continue-later behavior while preserving external redirect model. Make a short implementation plan before editing. After completion, list modified files, schema changes if any, and saved-trip test results.
```

## PHASE 9 — Mobile, Polish, and MVP Demo Readiness

### Phase Goal

Make the full experience stable, responsive, polished, and ready for a Tourism Malaysia stakeholder demo.

### Current Problem

The app has valuable functionality but needs final polish:

- Mobile responsiveness.
- Loading states.
- Empty states.
- Error states.
- Stakeholder-friendly demo flow.
- Fewer rough edges.

### Target Behavior

The demo should feel stable and impressive:

- Homepage is clean.
- Ask Eventra produces visual recommendations.
- Event detail starts a guided planning flow.
- Flight/hotel redirects are clearly external.
- Itinerary generation looks premium.
- Saved trips work.
- Mobile is usable.

### Files Likely Involved

- `viewer.html`
- `eventra-ticket-theme.css`
- `event-hub.js`
- `itinerary-modal.js`
- `flight-search.js`
- `hotel-search.js`
- `auth.html`
- `onboarding.html`
- `profile.html`
- `server.js`

### Implementation Tasks

- Run full UX QA on desktop and mobile.
- Fix spacing, overflow, and long-title issues.
- Add polished loading states.
- Add polished error states.
- Add demo-friendly fallback states when APIs are unavailable.
- Confirm all external redirects open safely.
- Confirm no accidental internal booking language.
- Prepare a demo script.

### Non-Goals

- Do not add major new features.
- Do not change scraping architecture.
- Do not add payment/booking flows.

### Acceptance Criteria

- Desktop flow is demo-ready.
- Mobile flow is usable.
- No major console errors.
- Core event -> detail -> travel -> itinerary -> save journey works.
- External provider handoffs are clear.
- UI feels premium and coherent.

### Risks

- External API failures can disrupt demo.
- Long scraped titles can break cards.
- Missing images can reduce premium feel.
- Authentication/Supabase setup may vary by environment.

### Test Checklist

- Desktop Chrome/in-app browser.
- Mobile viewport.
- Logged-in flow.
- Logged-out flow.
- Ask Eventra prompt tests.
- Event detail tests.
- Flight/hotel provider redirect tests.
- Itinerary generation test.
- Saved trip test.
- API unavailable fallback test.

### Future Execution Prompt

```text
Execute Phase 9 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect the full app flow first, then focus only on mobile, polish, loading/empty/error states, and demo readiness. Do not add major new product features. Make a short implementation plan before editing. After completion, list modified files, QA coverage, and remaining demo risks.
```

## 5. AI Workflow Specification

### Ask Eventra Behavior

Ask Eventra is an AI event discovery engine, not a generic chatbot.

It should:

- Accept natural language travel/event requests.
- Extract intent:
  - City.
  - Date range.
  - Event category.
  - Mood.
  - Budget.
  - Travel style.
  - Group type.
- Return visual recommendations first.
- Include concise AI reasons.
- Offer follow-up chips.
- Open event detail when a recommendation is selected.

It should not:

- Lead with a blank chat history.
- Ask many questions before showing value.
- Return only paragraphs.
- Show raw API fields.

### Event Assistant Behavior

The event assistant should activate after event selection.

It should know:

- Selected event.
- Event city.
- Event venue.
- Event date.
- Event category.
- External ticket URL.
- User profile/preferences when available.

It should guide:

1. "Here is why this event is worth planning around."
2. "Tickets are handled externally here."
3. "Do you want me to draft a trip around this?"

### Trip Planning Assistant Behavior

The trip planning assistant should know:

- Selected event.
- Travel dates.
- Origin airport/city if known.
- Budget.
- Travel style.
- Selected/suggested flight.
- Selected/suggested hotel/stay area.
- Generated itinerary.

It should:

- Ask only for missing critical information.
- Infer reasonable defaults.
- Recommend next step.
- Explain tradeoffs.
- Warn when timing is risky.
- Keep external booking handoffs clear.

### Memory and Context Usage

Use available context in this priority:

1. Current selected event.
2. Current prompt.
3. Saved user profile/preferences.
4. Current trip dates.
5. Selected flight/hotel if any.
6. Prior conversation refinements.

Profile context can include:

- Home airport.
- Preferred event types.
- Budget style.
- Travel energy.
- Food interests.
- Group type.
- Accessibility or family needs if collected.

### When to Ask Follow-Up Questions

Ask follow-up questions only when needed to produce useful next-step recommendations.

Good follow-up examples:

- "Where are you flying from?"
- "Is this trip budget, comfort, or luxury?"
- "Are you traveling solo, as a couple, or with family?"

Avoid asking:

- Long questionnaire chains.
- Questions already answered by profile.
- Questions that can be inferred from selected event/date/city.

### External Redirect Behavior

All ticket, flight, and hotel actions must be external redirects.

Use clear language:

- "Open ticket provider."
- "Open Google Flights."
- "Open hotel provider."
- "Continue on provider site."

Avoid language:

- "Book now" if it implies Eventra handles booking.
- "Reserve with Eventra."
- "Checkout."
- "Payment."

### Alibaba Qwen Usage

Use Alibaba Qwen/DashScope for:

- Natural language intent extraction.
- AI event recommendation reasoning.
- Follow-up suggestion generation.
- Event trip insight generation.
- Flight/hotel tradeoff explanations.
- Itinerary generation.
- Itinerary variant generation.
- Day regeneration.
- Saved trip summaries.

Do not use Qwen for:

- Inventing event data not present in the catalog.
- Inventing booking confirmations.
- Claiming real-time flight/hotel availability without provider/API data.
- Making unsafe guarantees about weather, traffic, or prices.

## 6. UI/UX Design Principles

Strict rules for all future implementation:

- Do not repeat event data across multiple visible sections.
- Do not show raw API data.
- Do not show unnecessary fields.
- Do not create generic chatbot UI.
- Do not force manual forms when AI can infer context.
- Show fewer things, but make them useful.
- Keep one primary CTA per step.
- Make external redirects obvious.
- Make the UI premium, clean, and calm.
- Use clear hierarchy: inspire -> guide -> browse -> plan -> save.
- Avoid dashboard-like layouts.
- Avoid crowded card grids.
- Avoid repeated headings.
- Avoid repeated CTAs.
- Avoid source/provider stats as primary content.
- Prefer visual recommendations over long text.
- Prefer guided chips over blank text entry when refining.
- Make loading states feel intelligent.
- Make empty states actionable.
- Make mobile a guided experience, not a compressed desktop page.

## 7. Future Execution Prompts

Use these prompts exactly when executing phases later.

### Phase 1 Prompt

```text
Execute Phase 1 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect the current homepage structure before editing. Preserve existing backend logic and event data loading. Remove duplicated event sections and repeated visual content. Make a short implementation plan before editing. After completion, list modified files, removed duplicated sections, and test results.
```

### Phase 2 Prompt

```text
Execute Phase 2 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect existing CSS and inline styles before editing. Create a consistent premium visual system while preserving current functionality. Avoid adding new product features. Make a short implementation plan before editing. After completion, list modified files, design system changes, and visual test results.
```

### Phase 3 Prompt

```text
Execute Phase 3 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect the existing homepage, event card rendering, and event filtering first. Rebuild only the homepage/event discovery structure around Hero -> Ask Eventra -> AI Picks -> Trending Cities -> All Events. Preserve existing APIs and event hub logic. Make a short implementation plan before editing. After completion, list modified files and browser verification results.
```

### Phase 4 Prompt

```text
Execute Phase 4 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect Ask Eventra UI, /api/chat, chatbot-utils.js, and current event result rendering first. Transform Ask Eventra into a result-first AI event discovery engine with visual recommendations and follow-up chips. Preserve existing AI/backend logic where possible. Make a short implementation plan before editing. After completion, list modified files and test prompts used.
```

### Phase 5 Prompt

```text
Execute Phase 5 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect event-hub.js and event detail markup/styles first. Redesign event detail into a premium event experience page/modal while preserving ticket, flight, hotel, and itinerary logic. Make a short implementation plan before editing. After completion, list modified files and event-detail test results.
```

### Phase 6 Prompt

```text
Execute Phase 6 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect event-hub.js, flight/hotel helpers, flight-search.js, hotel-search.js, server flight/hotel routes, and profile data usage first. Implement AI-guided ticket, flight, and hotel flow without direct booking. Preserve existing provider redirects. Make a short implementation plan before editing. After completion, list modified files and test results for event -> ticket -> flight -> hotel.
```

### Phase 7 Prompt

```text
Execute Phase 7 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect itinerary-modal.js, itinerary-routes.js, event-hub.js, and saved itinerary endpoints first. Transform the itinerary planner into a premium AI travel timeline with clear alternatives. Preserve existing Qwen generation and save/history logic. Make a short implementation plan before editing. After completion, list modified files and itinerary test results.
```

### Phase 8 Prompt

```text
Execute Phase 8 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect saved itinerary endpoints, SQL schema, auth-client.js, profile/history UI, and itinerary-modal.js first. Implement saved trips and continue-later behavior while preserving external redirect model. Make a short implementation plan before editing. After completion, list modified files, schema changes if any, and saved-trip test results.
```

### Phase 9 Prompt

```text
Execute Phase 9 only. Read README_EVENTRA_UI_AI_TRANSFORMATION_PLAN.md first. Do not execute other phases. Inspect the full app flow first, then focus only on mobile, polish, loading/empty/error states, and demo readiness. Do not add major new product features. Make a short implementation plan before editing. After completion, list modified files, QA coverage, and remaining demo risks.
```

## 8. Final Acceptance Criteria

Eventra is MVP-ready when:

- The UI feels premium, cinematic, and coherent.
- The homepage has no repeated event sections.
- Ask Eventra returns visual recommendations, not a generic chat-first UI.
- Users can discover live Malaysia events through natural language.
- Event detail starts an AI-guided planning flow.
- External ticket links are clear.
- Flight recommendations are guided, explained, and redirect externally.
- Hotel/stay recommendations are guided, explained, and redirect externally.
- Itinerary generation works around selected events.
- Itinerary alternatives are useful and visually clear.
- Users can save trips and continue later.
- Mobile is usable and polished.
- Loading, empty, and error states are demo-ready.
- No part of the app implies Eventra directly books tickets, flights, or hotels.
- The complete event -> planning -> itinerary -> save journey is ready for a Tourism Malaysia stakeholder demo.

## Recommended Execution Order

Execute phases in order:

1. Phase 1: Product structure and UI cleanup.
2. Phase 2: Global visual design system.
3. Phase 3: Homepage and event discovery rebuild.
4. Phase 4: Ask Eventra AI search experience.
5. Phase 5: Event detail experience.
6. Phase 6: AI-guided ticket, flight, and hotel flow.
7. Phase 7: AI itinerary planner and alternatives.
8. Phase 8: Saved trips and continue later.
9. Phase 9: Mobile, polish, and MVP demo readiness.

If time is limited before a demo, prioritize:

1. Phase 1.
2. Phase 3.
3. Phase 4.
4. Phase 5.
5. Phase 7.
