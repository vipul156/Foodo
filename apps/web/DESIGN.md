# Foodo — Design Record

Durable record of the visual world this product lives in, and the rules that keep new
surfaces inside it. Product truth lives in [PRODUCT.md](./PRODUCT.md); per-surface briefs
live in `.impeccable/surfaces/`.

## The world

Foodo looks like a well-set menu card, not a food-market billboard. Ink on paper:
near-black type on white, one neutral ramp, hairline borders, generous quiet space.
The interface is the counter, not the branding — it gets out of the way of the price
and the dish name.

What the world refuses: gradient text, glassmorphism panels, neon accents, emoji as
iconography, AI sparkle theatre, decorative illustrations that carry no information,
any shadow that reads as a glow.

## Tokens

Defined once in `src/app/globals.css`; never hardcode a colour, radius, or shadow in a
component.

- Palette: achromatic `oklch` ramp. `--foreground` `oklch(0.145 0 0)` on `--background`
  `oklch(1 0 0)` in light; inverted in `.dark`. `--primary` is the ink itself
  (`0.205` light / `0.922` dark), so primary buttons are black-on-white, never tinted.
- Semantic colour is reserved for meaning: `--destructive` for failure, amber for
  budget/attention, emerald for success. Nothing decorative may borrow them.
- Radius: `--radius: 0.625rem`, scaled by `@theme inline` (`xl` ≈ 14px, `2xl` ≈ 18px).
  Cards sit at `rounded-2xl`, controls at `rounded-xl`, chips at `rounded-md`.
- Elevation: two tokens only — `--shadow-card` and `--shadow-card-hover`, soft and
  offset. A surface gets a border **or** a shadow, never both.
- Type: one sans family for everything (`--font-sans`), `--font-mono` for amounts and
  IDs where alignment matters.

## Modes by surface

| Surface | Mode | Why |
|---|---|---|
| `/` home | Persuade | The visitor is deciding whether Foodo is worth an order |
| `/restaurants`, `/restaurants/[id]` | Operate | Browsing to a decision; density and price legibility win |
| `/checkout`, `/payment/*` | Operate | Money and address; zero ambiguity allowed |
| `/assistant` | Operate | A drafting tool with a receipt; see its brief |
| `/orders`, `/orders/[id]` | Operate | Status is the content |
| `/seller/*`, `/rider/*`, `/admin/*` | Operate | Repetitive daily work; scanability over expression |
| `/login`, `/register` | Operate | One job, one screen |

## Type and hierarchy

- Page title: `text-3xl` → `sm:text-4xl`, `font-semibold`, `tracking-tight`.
- Section title: `text-base`/`text-lg` semibold. Card title: `text-base` semibold.
- Body: `text-sm` (14px) for dense data, `text-[15px]` for reading prose, `leading-relaxed`.
- Metadata: `text-xs text-muted-foreground`. Amounts always `tabular-nums`.
- No kicker/eyebrow labels above headings. A heading stands on its own or gets a plain
  subtitle; never a small tracked-out uppercase word introducing it.

## Components

- Card: `rounded-2xl border border-border/60 bg-card` (hairline, no shadow) or
  `rounded-2xl bg-card shadow-[var(--shadow-card)]` (no border). Never both.
- Controls: 36–44px tall, `rounded-xl`, 200ms colour transition, `active:scale-[0.98]`
  at most. Primary = solid `--primary`; secondary = `bg-primary/10 text-primary`;
  tertiary = borderless text that gains `bg-accent` on hover.
- State is never colour-only: failures pair the tint with an icon and a sentence.
- Icons: `lucide-react`, 14–20px, `aria-hidden` whenever an adjacent label exists.

## Money

- Display: `₹` + `toLocaleString("en-IN", { maximumFractionDigits: 2 })`, tabular.
- Fees are server facts (`deliveryFee`, `platformFee`, `total`). A surface may show
  line arithmetic; it may never compute a fee or invent a total. If the server has not
  priced something yet, say so in words instead of estimating.
- "Free" beats `₹0` for delivery. Paid confirmation only ever arrives from the payment
  webhook — never from a client redirect.

## Motion

One authored moment per surface. Anything that loops must carry state (a rider moving,
an assistant thinking). Durations 150–320ms, ease-out. `prefers-reduced-motion` turns
loops off globally (see `.foodo-composing-dot`, `.foodo-marker__pulse`).

## Accessibility

- Focus is always visible: global `:focus-visible` ring token; icon-only controls carry
  `aria-label`.
- Hit targets ≥ 40px on touch surfaces; the composer, sheet, and dialog are keyboard
  and Escape operable.
- Contrast: body and metadata text hold AA against `--background`/`--card` in both
  themes; muted foreground is for supporting text only, never the only path to a fact.
- Live regions: conversation threads use `role="log"`; toasts use `role="status"` /
  `role="alert"`.

## Voice

Second person, plain, specific. Name the outcome in the button ("Move to checkout",
"Log in", "Review draft"). Disclose consequences immediately under the action they
qualify. No exclamation marks, no "Oops!", no hype. Errors state what happened, what
was not affected, and the next action.

## Surface index

- `/assistant` — `.impeccable/surfaces/src-app-customer-assistant-page-tsx.md`

## Changelog

- Added the conversational ordering surface (`/assistant`): thread + priced draft
  ticket, explicit hand-off into the existing cart, tool-trace provenance, guest and
  turn-limit states. Reasoning: the commerce API existed with no customer UI.
