# Premium UI tokens

Visual layer for `/events` (`viewer.html` + `premium-ui.css`). **No behavior changes** — chat → events, history sync, and accessibility hooks are unchanged.

## Fonts (Google Fonts)

| Role | Stack |
|------|--------|
| Headings | Playfair Display → Cormorant Garamond → Georgia |
| Body | Inter → Jost → system-ui |

Loaded in `viewer.html`; overridden in `premium-ui.css` via `--premium-font-display` and `--premium-font-body`.

## Colors

| Token | Value | Usage |
|-------|--------|--------|
| `--premium-bg` | `#FBFAF8` | Page background |
| `--premium-bg-2` | `#F3F0EA` | Stats strip |
| `--premium-surface` | `#FFFFFF` | Cards, controls |
| `--premium-text` | `#0F1724` | Primary text |
| `--premium-muted` | `#6B6F76` | Secondary text |
| `--premium-accent` | `#CDA34E` | Gold CTA, accents |
| `--premium-accent-deep` | `#B8862B` | Gradient end |
| `--premium-accent-soft` | `rgba(205,163,78,0.18)` | Highlights, focus ring |

Legacy `--pg-*` variables in `viewer.html` remain for inline components not yet mapped.

## Elevation & radius

| Token | Value |
|-------|--------|
| `--premium-radius-sm` | `8px` |
| `--premium-radius-md` | `12px` |
| `--premium-radius-lg` | `16px` |
| `--premium-card-elevation` | `0 8px 24px rgba(16,24,40,0.08)` |
| `--premium-ease` | `cubic-bezier(0.2, 0.9, 0.3, 1)` |

## Files

| File | Role |
|------|------|
| `viewer.html` | Base layout, component structure, `:root` palette |
| `eventra-ticket-theme.css` | Original Eventra scoped theme |
| `premium-ui.css` | **Premium polish** (load last) |

## Manual test

1. Open `/events` — serif headlines, gold accents, light grid.
2. Hero chat — glass card, pill input, gold **Ask Eventra**.
3. Submit a query — grid scroll/highlight/announcer still work.
4. **◷ History** — panel slides in; clear history still confirms.
5. Card hover — lift + shadow (`prefers-reduced-motion`: no lift).
6. Mobile — history full width; readable type.
