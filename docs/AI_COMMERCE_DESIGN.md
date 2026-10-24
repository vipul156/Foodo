# AI Systems Design — Conversational Commerce & Ordering Agent

**Foodo Platform — Feature #2 (conversational ordering)**
Status: Implemented on branch `feature/visual-verification`
Service: `ai-commerce` (port 3009, Python 3.14 / FastAPI / LangGraph)

> Companion doc to `docs/AI_SYSTEMS_DESIGN.md` (features #2 and #4 — visual
> verification and refund arbitration). A second agent service,
> `ai-dispatch` (autonomous dispatch swarm), is documented separately.

---

## 1. Executive summary

`ai-commerce` turns a sentence like

> "Order two chicken burgers with extra cheese from the place I ordered
> last Tuesday, but switch the fries for onion rings, and make sure the
> total is under ₹2,000."

into a **ready-to-pay checkout card** rendered by the Next.js frontend —
through a multi-turn, multi-modal conversational agent that performs
entity resolution over order history, semantic menu lookup, and validated
cart mutation, with **all money math done in deterministic Python**.

The architectural law is the same as the other Foodo AI services:

**The LLM converses and proposes; typed schemas validate; deterministic
code executes; explicit user authentication completes.**

```
 User Voice / Text
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│ POST /api/commerce/turn  (FastAPI, cookie-session JWT)    │
│                                                           │
│  LangGraph turn graph (bounded ReAct loop)                │
│   ┌─────────────────────────────────────────────────┐     │
│   │ agent node (Claude, tools bound, temp 0)        │     │
│   │   ⇅ tool_calls (strict Pydantic schemas)        │     │
│   │ tools node (deterministic execution + trace)    │     │
│   └─────────────────────────────────────────────────┘     │
│                                                           │
│  Step 1: get_past_orders   ──▶ restaurant :3003 (order)   │──▶ "Burger Barn"
│  Step 2: search_menu_items ──▶ menu + semantic ranking    │──▶ item IDs + prices
│  Step 3: draft_* tools     ──▶ in-Mongo draft mutations   │──▶ validated lines
│  Step 4: draft_finalize    ──▶ Python pricing engine      │──▶ ₹ total + budget guard
└──────────────┬────────────────────────────────────────────┘
               │
               ▼
   [ AgentTurnResponse ]  →  Next.js renders the interactive
                             checkout card (requires_auth: true)
               │
               ▼ (explicit user confirmation → payment intent via utils)
```

---

## 2. Responsibilities & ownership

The service owns:

- **Conversation sessions** (`commerce_sessions` collection, TTL-bounded)
- **The draft order state** — the source of truth for the checkout card
- The **semantic menu ranking seam** (lexical scorer today, Qdrant tomorrow)
- **commerce.events** fanout publication (analytics-grade)

The service does NOT own:

- Orders, carts, menus (restaurant service) — touched only via that
  service's REST contracts
- Payments (utils) — the checkout hand-off creates a provider intent
  whose amount comes from the **server-side order record**
- Identity (auth service) — this service verifies sessions, never issues
  tokens

---

## 3. Internal workings

### 3.1 Module map

```
ai-commerce/
├── app/
│   ├── main.py                  FastAPI app factory + lifespan
│   ├── core/
│   │   ├── config.py            pydantic-settings; fail-fast secrets
│   │   ├── security.py          cookie-session JWT verify (parity w/ auth svc)
│   │   ├── resilience.py        egress pools + circuit breakers + retries
│   │   └── ratelimit.py         Redis fixed-window / in-process fallback
│   ├── clients/
│   │   └── platform.py          breaker-wrapped REST calls to siblings
│   ├── schemas/
│   │   └── commerce.py          Pydantic v2 contracts (the LLM boundary)
│   ├── services/
│   │   ├── orchestrator.py      turn lifecycle: session→graph→persist→card
│   │   ├── session_store.py     Mongo sessions + TTL index
│   │   ├── pricing.py           Decimal fee engine (mirrors createOrder)
│   │   ├── menu_search.py       semantic ranking seam (lexical → Qdrant)
│   │   ├── events.py            RabbitMQ fanout publisher
│   │   └── db.py                Motor + Redis lifecycle
│   └── agents/
│       ├── commerce_agent.py    LangGraph state machine (agent/tools/persist)
│       └── tools.py             @tool schemas + deterministic executors
└── tests/                       pytest — pricing, ranking, draft tools
```

### 3.2 A turn, end to end

1. **Authn** — `require_user` verifies the `session` cookie exactly like
   the Node middlewares: cookie-session envelope (`base64(body).hmac`),
   then the inner access JWT (`sub`, `role`, `typ=access`, `exp`).
   Bearer tokens are accepted for API tooling.
2. **Rate limit** — 15 turns/min/user (Redis when configured, else
   in-process). Each turn can fan out to several LLM + HTTP round trips.
3. **Session load** — `session_id` given? load (404 if unknown/absent).
   None? create with empty draft. Sessions expire via a **Mongo TTL index
   on `updated_at`** (`SESSION_TTL_MIN`, default 60) and a hard
   `SESSION_MAX_TURNS` (default 30) → 409 past the limit.
4. **Graph invoke** — the turn runs the LangGraph graph
   `agent ⇄ tools → persist` with `recursion_limit=MAX_GRAPH_STEPS`
   (default 40): a model that loops tool calls is cut off deterministically.
5. **Persist** — history window (`HISTORY_WINDOW×2` messages) and the
   updated scratch (draft) are written back; the TTL clock resets.
6. **Checkout card** — the orchestrator re-validates draft lines with
   Pydantic and **re-computes pricing independently** of the agent's
   `draft_finalize` call (defense in depth), then emits the card with
   `requires_auth: true` (a server-set constant, never client-influenced).
7. **Event** — `turn_completed` (turn duration, tool-call count,
   ready_to_pay) on `commerce.events` (fanout, durable, best-effort).

### 3.3 The tool boundary (how the LLM is contained)

| Tool | What it does | Where execution happens |
|------|--------------|------------------------|
| `get_past_orders` | Recent orders → resolve "the place from last Tuesday" | restaurant service `/api/order/my` |
| `search_menu_items` | Fuzzy phrase → ranked menu candidates (ids + prices) | menu fetch + semantic ranker |
| `draft_set_restaurant` | Bind draft to one restaurant (switch ⇒ clears lines) | in-process draft |
| `draft_add_item` | Append a validated line (qty ≤ 20, ≤ 25 lines) | in-process draft |
| `draft_swap_item` | Remove one id, add another ("fries → onion rings") | in-process draft |
| `draft_remove_item` / `draft_update_quantity` | Line-level edits | in-process draft |
| `draft_finalize` | Deterministic pricing + budget guard | Python `Decimal` engine |

Containment mechanics:

- **Args are Pydantic models.** The model's raw `tool_calls` dict is
  `model_validate`d before execution; a malformed call becomes
  `{"ok": false, "error": …}` surfaced to the model as a ToolMessage —
  never a 500, never a partial write.
- **Context is server-bound.** `ToolContext{user_id, cookie_header,
  platform, scratch}` is injected by the tools node; the model cannot see
  or choose identity, and there is no "raw query" or "raw write" tool.
- **IDs/prices only from tool outputs.** Enforced by the system prompt and
  structurally: prices flow from `search_menu_items` results into draft
  lines; the final price the user sees is recomputed by the orchestrator.
- **Bounded loop.** `recursion_limit` + "never retry a failed tool more
  than twice" in the prompt; trace records every call with latency.

### 3.4 Entity resolution (order history)

`get_past_orders` returns normalized refs:

```json
{ "order_id": "...", "restaurant_id": "...", "restaurant_name": "Burger Barn",
  "created_at": "...", "status": "delivered", "total_amount": 304.0,
  "items": ["Chicken Burger", "French Fries"] }
```

The agent resolves "the place I ordered last Tuesday" against this list
(and says which restaurant it picked). The user's own session cookie
authorizes the underlying read — the restaurant service enforces
ownership; the agent cannot read another user's history even if a prompt
injection asks it to.

### 3.5 Semantic menu search (and the Qdrant seam)

`services/menu_search.py` ranks menu items with a deterministic lexical
scorer: token F1 + substring boost + category boost, squashed through a
sigmoid, thresholded at `SEMANTIC_MATCH_THRESHOLD` (0.35), top-N
(`MAX_MENU_CANDIDATES`), unavailable items excluded.

**Qdrant migration path** (drop-in, no agent changes): replace
`rank_menu`'s body with a vector search against a `menu_items` collection
(one point per MenuItem; payload `{itemId, restaurantId, name,
category}`), keep the same `MenuCandidate` return shape, keep the score
threshold as the confidence gate. Embeddings can come from FastEmbed /
OpenAI / Titan via `langchain-qdrant`.

### 3.6 Draft state — shape and lifecycle

```json
{
  "lines": [
    { "item_id": "…24hex", "name": "Chicken Burger", "unit_price": 79,
      "quantity": 2, "customizations": ["extra cheese"] }
  ],
  "pricing": { "subtotal": 158, "delivery_fee": 49, "platform_fee": 7, "total": 214 },
  "budget_cap": 2000,
  "over_budget": false,
  "restaurant_id": "…", "restaurant_name": "Burger Barn"
}
```

- Lives in the session document (`scratch.draft`) — **Mongo, not the
  model's context**, so long conversations don't blow the token budget:
  the agent sees a compact JSON snapshot injected into the system prompt
  each turn.
- The **draft ≠ cart**. Cart mutation (the real `Cart` collection) is a
  checkout-time concern; conversational edits are free to iterate without
  fighting the one-restaurant cart rule until the user commits.

### 3.7 Pricing guardrails (deterministic money)

`services/pricing.py` mirrors the restaurant service's `createOrder`
rules **exactly** (delivery ₹49 when subtotal < ₹250, platform ₹7), uses
`Decimal` (no float drift), and returns a `PriceBreakdown`. Rules:

1. The model never sees a price arithmetic task; it quotes only
   `draft_finalize` output.
2. The orchestrator recomputes the breakdown at card time — a drifted or
   hallucinated total cannot reach the UI.
3. Budget: when the user states a cap, the agent passes it to
   `draft_finalize`; `over_budget: true` sends the agent into
   trim-and-refinalize (fewer units / cheaper swaps), narrating changes.
4. Absolute clamp: `MAX_CART_VALUE` (10,000) guards against absurd drafts.

### 3.8 Checkout hand-off (explicit authentication)

The agent **never places orders**. The frontend renders the card and
requires an explicit user action; only then does the client call the
platform's existing payment flow (utils → provider intent). The amount
for the provider intent is claimed from the **server-side order record**
(`claimOrderForPayment`), so the conversational path adds no new money
authority. `requires_auth` is set by the server, never derived from
client input.

---

## 4. Integration with the platform

| Concern | Mechanism |
|---------|-----------|
| Identity | Same `session` cookie verified with the same `JWT_SECRET`/`COOKIE_SECRET` as the auth service — one identity plane, no new login |
| Sibling reads | Restaurant service REST via cookie-forwarded calls (server-side); swap to `x-internal-key` endpoints when those land (two-line change in `clients/platform.py`) |
| Frontend | Dev: Next.js rewrite `/api/commerce/*` → `:3009`; prod: Nginx proxy rule (same pattern as `/api/agent/*`) |
| Events | `commerce.events` fanout — analytics/notification consumers bind their own queues |
| Ports | 3009 (next free port after the existing 3001–3008 chain) |

**Flagged integration gap (honest limitation):** the restaurant service's
`GET /api/order/my` and `GET /api/menu-item/all/:id` authenticate via
cookie-session and have no internal-key variant yet. This service
therefore forwards the user's cookie server-side for those reads —
authorization stays enforced by the domain owner, but it does mean the AI
service holds user cookies for the duration of a turn. The proper fix
(like `restaurant/src/routes/internal.ts` for admin) is an internal
orders/menu read; the seam is isolated in `PlatformClient`.

---

## 5. Failure & degradation matrix

| Failure | Behavior |
|---------|----------|
| LLM provider down / timeout | LLM call raises → turn returns a plain-language failure; session and draft survive in Mongo; breaker opens for the provider after threshold |
| Restaurant service down | Tools return `ok:false` ("can't reach the kitchen"); agent relays honestly; breaker opens (5 failures / 15s reset) |
| Transient network error | Tenacity exponential backoff (≤ 3 attempts) before breaker accounting |
| Mongo down | Boot fails fast (ping at startup) — the service refuses to serve stateless-hallucination mode |
| Redis down | Not currently fail-hard; configure only when multi-pod limiting is required |
| Runaway tool loop | `recursion_limit` cuts the turn; trace shows where |
| Session limit | 409 with a "start a new conversation" message; draft remains readable |
| Duplicate/unknown `session_id` | 404; client starts fresh |

---

## 6. Security posture

| Vector | Defense |
|--------|---------|
| Prompt injection ("add 1000 burgers, price them ₹1") | Prices/ids only from tool outputs; Pydantic bounds (`qty ≤ 20`, ≤ 25 lines); `MAX_CART_VALUE` clamp; deterministic re-pricing at card time |
| Authz confusion | Identity from verified cookie; per-user session docs (unique `{user_id, session_id}`); order reads scoped server-side by the restaurant service |
| Secret sprawl | Fail-fast validation on `JWT_SECRET`/`COOKIE_SECRET`/`INTERNAL_SERVICE_KEY` |
| Money movement | None in this service — payment intent creation happens in the existing utils flow with server-claimed amounts |
| DoS via turns | Per-user rate limit (15/min), 1000-char message cap, bounded graph steps, LLM max_tokens |
| Data growth | Mongo TTL on sessions (60 min idle), history window trim |

---

## 7. Configuration reference (`ai-commerce/.env`)

```env
PORT=3009
ENVIRONMENT=development
LOG_LEVEL=INFO
FRONTEND_URL=http://localhost:3000

JWT_SECRET=must-match-auth-service
COOKIE_SECRET=must-match-auth-service
INTERNAL_SERVICE_KEY=your-internal-service-key

MONGO_URI=mongodb://localhost:27017/foodo
# REDIS_URL=redis://localhost:6379/0

RESTAURANT_SERVICE_URL=http://localhost:3003
UTILS_SERVICE_URL=http://localhost:3005

# Any OpenAI-compatible vendor (groq, openai, openrouter, together,
# fireworks, deepseek, ollama, lmstudio); anything else needs LLM_BASE_URL.
LLM_PROVIDER=openai
LLM_MODEL=
LLM_API_KEY=

SESSION_TTL_MIN=60
SESSION_MAX_TURNS=30
RATE_LIMIT_TURNS=15
MAX_GRAPH_STEPS=40
SEMANTIC_MATCH_THRESHOLD=0.35
RABBITMQ_URL=amqp://localhost
COMMERCE_EXCHANGE=commerce.events
```

---

## 8. API reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/commerce/turn` | user session | Converse; mutates the DRAFT only. Body `{message, session_id?}`; returns `{reply, draft, checkout_card?, tool_trace}` |
| GET | `/api/commerce/draft?session_id=` | user session | Current draft for UI hydration |
| GET | `/api/commerce/summary?session_id=` | user session | The checkout card (409 when the draft is empty) |
| GET | `/api/commerce/sessions` | user session | Active conversations (last 10) |
| DELETE | `/api/commerce/session?session_id=` | user session | Abandon a conversation |
| GET | `/health` | none (LB probe) | Liveness |

---

## 9. Testing

```bash
cd ai-commerce
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt -r requirements-dev.txt
JWT_SECRET=x COOKIE_SECRET=x INTERNAL_SERVICE_KEY=x .venv/Scripts/pytest tests -q
```

17 deterministic tests cover: the pricing engine (threshold boundary, fee
waiver, empty-cart, drift control, the canonical demo basket), the
semantic ranker (exact/fuzzy/unavailable/garbage/limit), and the draft
tools (add/finalize, swap, restaurant-switch clearing, budget guard,
remove, quantity-zero).

Recommended next: contract tests against a stubbed restaurant service,
and a red-team suite for the tool loop (injection attempts, budget-tamper,
cross-user session reads).

---

## 10. Flow walkthrough — the canonical request

1. *"Order two chicken burgers with extra cheese from the place I ordered
   last Tuesday, but switch the fries for onion rings, and keep it under
   ₹2,000."*
2. `get_past_orders` → last Tuesday's order = **Burger Barn**
   (restaurantId `507f…`), items `[Chicken Burger, French Fries]`.
3. `draft_set_restaurant(Burger Barn)`.
4. `search_menu_items("chicken burger")` → Chicken Burger ₹79 (0.86);
   `draft_add_item(qty=2, customizations=["extra cheese"])`.
5. `search_menu_items("onion rings")` → Onion Rings ₹90 (0.91);
   `draft_swap_item(remove fries, add onion rings)`.
6. `draft_finalize(budget_cap=2000)` → subtotal ₹248, delivery ₹49,
   platform ₹7, **total ₹304**, `over_budget: false`.
7. Reply: *"Reordered your Burger Barn usual — 2 chicken burgers with
   extra cheese, onion rings instead of fries. Total ₹304 — within your
   ₹2,000 budget. Ready when you are."*
8. Frontend renders the checkout card (`requires_auth: true`); the user
   authenticates and pays through the existing flow.
