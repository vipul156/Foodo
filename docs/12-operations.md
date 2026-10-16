# 12 — Operations

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | ≥ 20 | `engines.node` |
| pnpm | 10.28.0 | `packageManager` pinned — corepack will fetch it |
| AWS credentials | valid, with CFN + Lambda + DynamoDB + SNS + SQS + API Gateway permissions | every stack deploys with CloudFormation |

```bash
corepack enable
pnpm install
```

`pnpm-workspace.yaml` declares `onlyBuiltDependencies: [bcrypt, esbuild, sharp]` —
pnpm 10 blocks lifecycle scripts by default, so these three need explicit permission to
build their native bindings.

---

## 2. Monorepo tooling

**Turborepo** drives builds and deploys; **pnpm workspaces** resolve `@foodo/*` links;
**pnpm catalog** pins every dependency version in one place.

```
apps/*  backend/*  packages/*  infra  core
```

### Catalog — the single source of version truth

Every workspace package declares `"express": "catalog:"` rather than a version. Bumping
`express` once in `pnpm-workspace.yaml` changes it everywhere. **Never pin a version
directly in a package.json.**

Two `overrides` exist for a specific type conflict:

```yaml
overrides:
  "@types/multer>@types/express": ^5.0.6
  "@types/multer>@types/express-serve-static-core": ^5.1.3
  "@types/cookie-session>@types/express": ^5.0.6
  "@types/cookie-session>@types/express-serve-static-core": ^5.1.3
```

`@types/multer` transitively depends on the Express 4 types, which drags a **second Express
type universe** into every consumer and breaks interface identity
(`RequestHandler` not assignable across universes) — which is exactly why
admin-service has `isAuth as unknown as RequestHandler` casts in its router. The overrides
keep everything on Express 5 types.

---

## 3. Root scripts

```bash
pnpm run build           # turbo run build
pnpm run lint            # turbo run lint
pnpm run format          # prettier --write
pnpm run format:check    # prettier --check

pnpm run deploy:infra    # 1
pnpm run deploy:core     # 2
pnpm run deploy:services # 3
pnpm run deploy:frontend # 4
pnpm run deploy:all      # all four, in order

pnpm run remove:frontend # reverse teardown order
pnpm run remove:services
pnpm run remove:core
pnpm run remove:infra
pnpm run remove:all

pnpm run logs:payment    # restaurant paymentConsumer
pnpm run logs:reconcile  # utils reconcile (hourly cron)
pnpm run logs:realtime   # realtime eventConsumer
```

### Deploy order is mandatory

Service stacks resolve `${cf:foodo-infra-<stage>.*}` and
`${cf:foodo-core-api-<stage>.*}`. If the export does not exist, the deploy fails at
CloudFormation time. `deploy:all` encodes the order; running the individual scripts out of
order will not work.

Teardown is the exact reverse, because service stacks own routes on the shared HTTP API.

### Per-service commands

```bash
cd backend/rider-service
npx serverless deploy --stage dev
npx serverless info
npx serverless logs --function orderReadyConsumer --tail
npx serverless remove

cd apps/web && pnpm dev     # Next dev server
cd apps/web && pnpm deploy  # sst deploy
```

---

## 4. Environment variables

Everything resolves through `${env:VAR, 'fallback'}` in the `serverless.yml` files, so a
missing variable does not fail the deploy — it fails at the first real call. Provide these
in the environment (or a `.env`, since `useDotenv: true`):

### Secrets — set these, do not rely on defaults

| Variable | Services | Notes |
|---|---|---|
| `JWT_SECRET` | core (authorizer), auth, restaurant, rider, admin, utils, realtime | **The most important one.** All stacks default to `dev-only-change-me`. Verify and authorizer must match. |
| `COOKIE_SECRET` | auth, restaurant, rider, admin, utils | `cookie-session` signing key. Must match across services or sessions break. |
| `CLOUDINARY_API_SECRET` | restaurant, rider, utils | **Never** leaves the server |
| `CLOUDINARY_API_KEY`, `CLOUDINARY_CLOUD_NAME` | same | safe to expose to clients |
| `INTERNAL_SERVICE_KEY` | restaurant only | legacy claim endpoint header |
| `RAZORPAY_KEY_ID` / `_KEY_SECRET` / `_WEBHOOK_SECRET` | utils | |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | utils | |
| `IAM_PERMISSIONS_BOUNDARY_ARN` | all | optional org-policy boundary |

### Non-secret

| Variable | Default | Purpose |
|---|---|---|
| `FRONTEND_URL` | `http://localhost:3000` | Stripe redirect fallback |
| `REFRESH_COOKIE_NAME` | `refresh_token` | |
| `API_GATEWAY_URL` | — | enables dev rewrites |
| `NEXT_PUBLIC_REALTIME_WS_URL` | discovered export | set to override |
| `AWS_DYNAMO_ENDPOINT` | — | point the shared client at DynamoDB Local / moto |

⚠️ `CLOUDINARY_URL` appears in the restaurant/rider `environment:` blocks but the shared
signer reads `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`.
See [14 Known Gaps](./14-known-gaps.md).

---

## 5. Local development

There is no docker-compose. The intended model is **local frontend against deployed
backends**.

```bash
# Terminal 1 — backend (against a deployed stage)
cd backend/restaurant-service
npx serverless offline          # or deploy to dev and point at it

# Terminal 2 — frontend
cd apps/web
API_GATEWAY_URL=<deployed HttpApiUrl> pnpm dev
```

With `API_GATEWAY_URL` set and `NODE_ENV=development`, `next.config.ts` rewrites
`/api/:path*` to the gateway. Cookies stay first-party because the browser only ever sees
`localhost:3000`.

Per-service hot reload:

```bash
cd backend/auth-service && pnpm dev     # tsx --watch src/index.ts
cd backend/realtime-service && pnpm dev  # wsRouter entry only
```

Note these `dev` scripts start the Express app / handler directly — they are for local
inspection, not a full API-gateway-shaped runtime.

---

## 6. Architecture diagram

`docs/foodo-platform-architecture.json` is the archify spec;
`docs/foodo-platform-architecture.html` is the rendered artifact.

```bash
node .agents/skills/archify/bin/archify.mjs validate architecture docs/foodo-platform-architecture.json
node .agents/skills/archify/bin/archify.mjs deliver   docs/foodo-platform-architecture.json
```

The spec declares `source` evidence paths, so `validate` must run **from the repository
root** — it verifies every referenced file exists and the revision matches.

`docs/foodo-platform-architecture.visual-check.json` records the last visual-check result.
That run returned `viewer/chrome-unavailable` (no Chrome on the machine), so browser
containment/readability evidence was not collected.

---

## 7. Logging & debugging

### Where to look

| Question | Where |
|---|---|
| Did the request authenticate? | HTTP API access log → `authorizerError` field |
| Which route matched? | access log → `routeKey` |
| What did the service do? | the service Lambda's CloudWatch log group |
| Did the consumer run? | `pnpm run logs:payment` / `logs:realtime` |
| Did reconciliation notice an orphan? | `pnpm run logs:reconcile` — look for `[ALERT][RECONCILE]` |
| Is a saga stuck? | look for `[COMPENSATE]` in restaurant-service logs |

### Grep-able log markers

| Marker | Meaning |
|---|---|
| `[COMPENSATE] order … not assignable — rider … release requested` | the order was taken before this rider; the rider is being freed |
| `[ALERT][RECONCILE] Failed to attach razorpay/stripe order …` | intent created but not stamped — orphan, reconciliation will flag it |
| `[ALERT][RECONCILE] … MANUAL INSPECTION REQUIRED` | reconciliation found an unexpected provider state |
| `[WebhookDedupe] store unavailable:` | dedupe table unreachable — processing continues (fail-open) |
| `[Socket] No bootstrap token; skipping connect` | the browser has no session; the socket silently does not connect |
| `Event publish failed (<event>):` | a domain publish failed — the caller should have compensated |
| `Realtime publish failed (<event>):` | a fanout publish failed — logged, not retried |

### DLQ triage

```bash
aws sqs list-dead-letter-source-queues --queue-url-prefix https://sqs.ap-south-1.amazonaws.com/1234/foodo-infra-dev
aws sqs receive-message --queue-url <dlq-url> --max-number-of-messages 10 --visibility-timeout 30
```

After inspecting, either fix the cause and re-drive the message, or purge. A message in a
DLQ means a conditional write kept failing or the consumer threw consistently for 3
receives.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Service deploy fails on `${cf:...}` | infra or core not deployed | `pnpm run deploy:infra` then `deploy:core` |
| Every protected route 401s | `JWT_SECRET` differs between `core` and the service, or the session cookie is missing | both stacks must use the same `JWT_SECRET` and `COOKIE_SECRET` |
| 401 loops in the browser | `refresh` is failing — check for a `refresh_token` cookie | the cookie is `path=/api/auth`; a request to another path will not carry it |
| Socket never connects | `NEXT_PUBLIC_REALTIME_WS_URL` empty or a `$connect` 401 | check the export and the bootstrap token |
| Socket connects, no events | the room row is missing, or the event never reached `foodo-realtime-*-emit` | query `room-index`, tail `logs:realtime` |
| Upload signature 500 | `CLOUDINARY_*` env vars missing (they use the three separate names, not `CLOUDINARY_URL`) | set them on the restaurant/rider stacks |
| Webhook always 400 | the body was JSON-parsed before `express.raw` | verify `index.ts` ordering in utils |
| Orders visible to another user | always verify `order.userId === user.id` on read paths | see [14](./14-known-gaps.md) |
| Hot catalog slow | CloudFront cache TTL expired, or `Cache-Control` was stripped | check the response headers on the origin |

---

## 9. Cost knobs

| Lever | Where | Effect |
|---|---|---|
| `params.<stage>.natGateways` | `infra` | **~$32/month per NAT.** `0` in dev, `2` in prod. Currently unused since nothing runs in the VPC |
| `BillingMode: PAY_PER_REQUEST` | all tables | no idle cost; scales to zero |
| DynamoDB gateway endpoints | `infra` | free; keeps S3/DynamoDB traffic off NAT |
| CloudFront `/api/*` TTL 0 + `Cache-Control` | `apps/web/sst.config.ts` + services | edge caching of hot catalog GETs is the single biggest HTTP-cost lever |
| `authorizer` 128 MB, no result cache | `core` | cheap per-request verify; caching would be faster but incorrect with cookie identity |
| `serverless-prune-plugin` `number: 3` | all services | keeps 3 artifact versions; limits S3 growth |
| `logRetentionInDays: 14` | all | limits CloudWatch Logs cost |
| `reconcile` 256 MB / 120 s, hourly | utils | the cheapest function in the platform |
| `SST` `removal: retain` + `protect` on prod | `apps/web` | prevents accidental prod destruction |

---

## 10. Security checklist before any public launch

- [ ] `JWT_SECRET` and `COOKIE_SECRET` are strong, unique, and identical across `core`
      and every service (not `dev-only-change-me`).
- [ ] `CLOUDINARY_API_SECRET` set and never exposed to a client.
- [ ] `RAZORPAY_WEBHOOK_SECRET` / `STRIPE_WEBHOOK_SECRET` set and verified end to end.
- [ ] `NODE_ENV=production` everywhere (already hard-coded) so `secure` cookies are set.
- [ ] Cognito is provisioned but unused — decide whether to migrate or delete it.
- [ ] API Gateway throttling / usage plans added (currently the documented gap for
      serverless per-IP rate limiting).
- [ ] The VPC has no workloads in it — either remove it or plan the first private workload
      and re-enable NAT deliberately.
- [ ] Review [14 Known Gaps](./14-known-gaps.md) end to end.
- [ ] Replace the admin `/stats` full orders `ScanCommand` with DynamoDB Streams counters
      before order volume matters.