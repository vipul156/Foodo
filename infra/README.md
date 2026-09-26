# infra/ — Serverless Framework deployment

Two stacks, deployed in order. **Serverless resolves all paths against
the config's directory**, so each stack is self-contained here.

```
core      serverless.core.yml      data + event tier (no functions)
services  serverless.services.yml  the 5 Lambda services
```

## Deploy

```bash
pnpm run deploy:core        # DynamoDB tables, SNS topic, SQS queues + DLQs
pnpm run deploy:services    # Lambda functions, HTTP API, SQS triggers, schedule
```

Secrets at deploy time (never committed): `JWT_SECRET`, `COOKIE_SECRET`,
`INTERNAL_SERVICE_KEY`, `RAZORPAY_*`, `STRIPE_*`, `CLOUDINARY_URL`,
`FRONTEND_URL`. Pass via environment or `--stage`-specific `.env` files
(Serverless reads `infra/.env.<stage>`).

```bash
STAGE=prod pnpm run deploy:core && STAGE=prod pnpm run deploy:services
```

## Handler layout

`serverless.services.yml` declares handlers as `src/handlers.<name>` —
esbuild bundles each entry from the repo root, resolving the workspace
`@foodo/*` packages. Every service's `src/index.ts` exports the handlers
its functions use (e.g. restaurant-service exports `handler`,
`paymentConsumer`, `riderEvents`).

## What runs where

| Service | Entrypoints | Triggers |
|---|---|---|
| auth | `handler` | HTTP `/api/auth/*` |
| restaurant | `handler`, `paymentConsumer`, `riderEvents` | HTTP `/api/{restaurant,menu-item,cart,order,address}/*` + 2 SQS queues |
| rider | `handler`, `orderReady`, `riderEvents` | HTTP `/api/rider/*` + 2 SQS queues |
| admin | `handler` | HTTP `/api/admin/*` |
| utils | `handler`, `reconcile` | HTTP `/api/utils/*` + EventBridge `rate(1 hour)` |
| realtime | long-running (not in these stacks) | SQS poll of the SNS fan-out queue |

## Teardown

```bash
pnpm run remove:services && pnpm run remove:core
```
