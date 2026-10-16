# Foodo — Documentation Index

Complete engineering documentation for the Foodo multi-role food-delivery platform.
Every statement here is derived from the source at repo revision `4e76e2c4`.

---

## Start here

| # | Document | What it answers |
|---|---|---|
| 00 | **This file** | Where to look |
| 01 | [Overview](./01-overview.md) | What is Foodo? Who are the users? What can each role do? |
| 02 | [Architecture](./02-architecture.md) | How do the pieces fit together? What talks to what, and why? |
| 03 | [Infrastructure](./03-infrastructure.md) | VPC, DynamoDB tables, SNS/SQS, API Gateway, the JWT authorizer |
| 04 | [Data Model](./04-data-model.md) | Exact DynamoDB key schemas, GSIs, TTLs, conditional writes, geo handling |
| 05 | [Authentication & Sessions](./05-authentication.md) | Cookies, access/refresh tokens, rotation, reuse detection, rate limits, guards |
| 06 | [Services Reference](./06-services.md) | Line-by-line responsibility of all six backend services |
| 07 | [API Reference](./07-api-reference.md) | Every endpoint: method, path, auth, request, response |
| 08 | [Event Bus & Sagas](./08-events.md) | Every event, envelope shape, subscriber, idempotency, compensation |
| 09 | [Realtime](./09-realtime.md) | WebSocket protocol, rooms, broadcasts, rider GPS streaming |
| 10 | [Payments](./10-payments.md) | Razorpay + Stripe, webhooks, dedupe, reconciliation, COD |
| 11 | [Frontend](./11-frontend.md) | Next.js routes, API client, state stores, hooks, direct image upload |
| 12 | [Operations](./12-operations.md) | Local dev, deploy order, env vars, teardown, logs, cost knobs |
| 13 | [FAQ / Interview Q&A](./13-faq.md) | "If someone asked about X" — ~70 answered questions |
| 14 | [Known Gaps & Risks](./14-known-gaps.md) | Honest list of what is incomplete, fragile, or dead |
| **A** | **[Architecture & Code Audit](./ARCHITECTURE_AND_CODE_AUDIT.md)** | **Independent deep audit — health scores, 36-flaw matrix, 15 deep-dives with remediation code, P0/P1/P2 roadmap** |

---

## Reading paths

**Just want to run it**
→ 12 Operations → 03 Infrastructure (deploy order) → 11 Frontend (dev rewrite)

**Reviewing someone's code / PR**
→ 02 Architecture → 04 Data Model → 08 Events → 06 Services

**Debugging an incident**
→ 08 Events (which queue/DLQ) → 12 Operations (tail logs) → 14 Known Gaps

**Learning the project for an interview**
→ 01 Overview → 02 Architecture → 13 FAQ

**Reviewing it as a reviewer / auditor**
→ ARCHITECTURE_AND_CODE_AUDIT.md — starts with the flaw matrix (Section 2)

**Understanding money**
→ 10 Payments → 05 Authentication (token model) → 04 Data Model (TTL)

---

## Visual reference

`docs/foodo-platform-architecture.html` — rendered platform diagram (open in a browser).
`docs/foodo-platform-architecture.json` — its source spec.

---

## One-paragraph summary

Foodo is a four-role (customer / seller / rider / admin) food-delivery platform
deployed entirely on AWS serverless primitives. A Next.js 16 app on CloudFront serves
the browser and reverse-proxies `/api/*` to a single shared API Gateway HTTP API.
Six Express apps run as Lambda functions — each owns one slice of the domain, all
mounted on that one API. State lives in eight DynamoDB tables keyed `pk`/`sk`.
Coordination happens over one SNS topic (domain + realtime events) and two shared
SQS work queues, each service declaring its own SQS queue + SNS filter subscription.
Real-time push rides API Gateway WebSockets with a DynamoDB-backed connection registry.
Authentication is cookie-based: a 15-minute minimal-claims access JWT in a signed
session cookie plus a 30-day opaque, revocable, rotating refresh token in its own
`httpOnly` cookie scoped to `/api/auth`.

---

## Document conventions

- Route paths are exact as declared in the service `serverless.yml` files.
- Environment variables are quoted exactly as the IaC injects them.
- Where the code and the existing `README.md` disagree, **the code wins** — the
  README still describes the pre-AWS MongoDB/RabbitMQ/Socket.IO era. See
  [14 Known Gaps](./14-known-gaps.md).
- Tables, GSIs and functions are listed with their CloudFormation logical/exports.