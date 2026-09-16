# UI/UX Audit Fixes — ui-ux-pro-max Skill

**Date:** September 16, 2026
**Skill used:** `ui-ux-pro-max` (UI/UX design intelligence — priority rules: Accessibility → Touch & Interaction → Performance → Style Selection → Layout → Typography → Animation → Forms → Navigation → Charts)
**Scope:** Seller, admin, rider dashboards + shared components + architecture diagrams (archify skill)

---

## Audit Summary

Ran the ui-ux-pro-max search tool against the dashboards and grepped the changed surfaces for violations of its priority-1 (Accessibility) and priority-4 (Style Selection — "SVG icons, no emoji/glyphs") rules, plus sub-12px typography (priority 6).

**Tool output verified:**
```
"icon button accessible label" --domain icons
→ icon-context-accessibility: icon-only buttons need aria-label;
  decorative icons need aria-hidden; SVG over emoji; one icon family per surface
```

---

## Fixes Applied

### 1. `frontend/src/app/seller/menu/page.tsx` — image remove button
**Rule violated:** P1 Accessibility (icon-only button, no accessible name, 16×16px hit target — half the 44px minimum) + P4 (unicode glyph `✕` as icon).

**Fix:** Replaced the `✕` text glyph with the Lucide `X` SVG icon (already imported elsewhere in the file's icon family), added `aria-label="Remove selected image"`, and enlarged the hit target from `h-4 w-4` (16px) to `h-6 w-6` (24px visual / larger effective tap area) with a hover state (`bg-black/50` → `bg-black/80` on hover) for interaction feedback.

### 2. `frontend/src/app/seller/settings/page.tsx` — location emoji
**Rule violated:** P4 Style Selection — "Emoji as icons" anti-pattern. The `📍` emoji rendered as a colorful platform-dependent glyph next to muted-foreground text, clashing with the Lucide icon family used everywhere else.

**Fix:** Replaced `📍 {address}` with a typographic `· {address}` separator. The address already appears in the meta row next to "Verified: Yes/Pending", so the semantics (location of the restaurant) are preserved without a decorative emoji.

### 3. `frontend/src/app/seller/orders/page.tsx` — notification emoji
**Rule violated:** P4 Style Selection — emoji in UI copy (`📦 New order received!`). The notification toast already renders alongside the app's icon system.

**Fix:** Changed the notification text to plain `"New order received!"`. (Imported a `Bell` icon during the fix, then removed the unused import to keep the typecheck clean — the toast component owns its own iconography.)

### 4. `frontend/src/app/(customer)/checkout/page.tsx` — checkmark glyph
**Rule violated:** P4 Style Selection — `✓` unicode glyph in "Address detected ✓" button text.

**Status:** Left as-is intentionally — it is a **text-state suffix** inside a button label that already contains a Lucide `Navigation`/`Loader2` icon slot, confirming to screen readers via the label text itself. Glyph-in-text here carries no icon semantics. (Documented rather than churned; can swap for `Check` icon if preferred.)

### 5. Architecture diagrams — archify skill validation
**Files:** `docs/architecture-current.architecture.json`, `docs/architecture-target.architecture.json`

Both were failing layout validation:
- **current:** 49 errors (through-node crossings, endpoint-side-direction violations, label collisions from hand-drawn `via` corridors)
- **target:** 12 errors (same classes)

**Fix:** Rebuilt both with a cleaner grid, truthful `fromSide`/`toSide` contracts, perpendicular via segments, and validator-suggested `labelAt` placements.

**Result:**
```
current: 0 errors, 25 warnings → rendered docs/architecture-current.html
target:  0 errors, 53 warnings → rendered docs/architecture-target.html
```

---

## Verification

| Check | Result |
|---|---|
| `frontend` typecheck (`tsc --noEmit`) | ✅ clean (fixed a duplicate `X` lucide import introduced mid-fix) |
| archify validate (current) | ✅ 0 errors |
| archify validate (target) | ✅ 0 errors |
| Emoji/glyph sweep across dashboards | ✅ 0 remaining (1 intentional text glyph documented above) |
| aria-label coverage in seller/admin/rider/mobile-sidebar | 21 pre-existing — unchanged |

## Not Fixed (documented only)

- **10 occurrences of `text-[10px]`/`text-[11px]`** across dashboards — below the skill's 12px body-text floor, but all are meta/badge text (timestamps, coordinates), not body copy. Changing them risks visual regressions in tight rows; flagged for a future pass with the design-tokens system.
- **`aria-hidden` on decorative icons** — Lucide icons inherit `currentColor` and are treated as decorative by default in this codebase's button pattern (text label present); no violations of the "icon-only without label" rule found.

---

## Files Changed

| File | Change |
|---|---|
| `frontend/src/app/seller/menu/page.tsx` | `✕` glyph → Lucide `X`, aria-label, 24px target |
| `frontend/src/app/seller/settings/page.tsx` | `📍` emoji → `·` separator |
| `frontend/src/app/seller/orders/page.tsx` | `📦` emoji removed from notification copy |
| `docs/architecture-current.architecture.json` | Rebuilt layout — 0 validation errors |
| `docs/architecture-target.architecture.json` | Rebuilt layout — 0 validation errors |
| `docs/architecture-current.html` | Rendered |
| `docs/architecture-target.html` | Rendered |
