# 03 — Infrastructure

Two foundation stacks: `infra` (network + data + events + identity) and `core`
(shared compute). Both are Serverless Framework, deployed with the root turbo scripts.

---

## 1. `infra` — the foundation stack

`infra/serverless.yml` → CloudFormation stack `foodo-infra-${stage}`

```
service: foodo-infra
provider: aws / nodejs20.x / ap-south-1
```

### 1.1 VPC — `10.0.0.0/16`

Two AZs × two subnet tiers:

| Subnet | CIDR | AZ | Public IP |
|---|---|---|---|
| `PublicSubnetA` | `10.0.0.0/20` | 0 | yes |
| `PublicSubnetB` | `10.0.16.0/20` | 1 | yes |
| `PrivateSubnetA` | `10.0.32.0/20` | 0 | no |
| `PrivateSubnetB` | `10.0.48.0/20` | 1 | no |

- Internet Gateway attached to a public route table (`0.0.0.0/0` → IGW); both public
  subnets associate with it.
- Private subnets have their own route tables with **no** default route unless NAT exists.

**Nothing runs in the VPC today.** Every Lambda runs outside it. The VPC exists so that
if a workload later needs private networking (payment gateway calls, a database), the
network is already there.

### 1.2 NAT gateways — stage-tunable, off by default

NAT costs roughly **$32/month per gateway**, so it is a parameter, not a default:

```yaml
params:
  default: { natGateways: 0 }
  prod:    { natGateways: 2 }
```

Three CloudFormation conditions resolve the combinations:

| Condition | Meaning |
|---|---|
| `NatEnabled` | `natGateways != 0` — create NAT + private default route |
| `DualNat` | `natGateways == 2` — one NAT per AZ, one private route per AZ |
| `SingleNat` | enabled but not dual — one NAT; AZ-B private subnets **hairpin** through AZ-A's NAT (cross-AZ, cheaper) |

### 1.3 Gateway endpoints (free)

Two interface-free **Gateway** endpoints on all three route tables:

- `com.amazonaws.${AWS::Region}.s3`
- `com.amazonaws.${AWS::Region}.dynamodb`

Traffic to these services never touches NAT or the internet. This is why the NAT count
can stay at zero in non-prod.

### 1.4 S3 uploads bucket

```
foodo-infra-<stage>-uploads
DeletionPolicy: Retain
```

Hardened: `BlockPublicAcls`, `BlockPublicPolicy`, `IgnorePublicAcls`,
`RestrictPublicBuckets` all true; `SSE-S3` (`AES256`); `BucketOwnerEnforced` ownership
(ACLs disabled); lifecycle rule aborting incomplete multipart uploads after 7 days.

**Nothing writes to it yet** — image uploads go to Cloudinary. The bucket and its exports
(`UploadsBucketName`, `UploadsBucketArn`) are provisioned for a future migration.

### 1.5 Cognito — provisioned, not yet used

```
foodo-infra-<stage>-users   (UserPool)
foodo-infra-<stage>-web     (UserPoolClient)
```

- Email as username, auto-verified; password policy min 8, upper + lower + number.
- Account recovery via verified email.
- Client: `GenerateSecret: false` (public SPA client), SRP + refresh flows,
  `PreventUserExistenceErrors: ENABLED`, token validity 60 min / 60 min / 30 days.

Exports: `CognitoUserPoolId`, `CognitoUserPoolClientId`, `CognitoIssuerUrl`.

Today the platform's **own** `JWT_SECRET` HS256 tokens are authoritative; the authorizer
in `core` verifies those. When auth-service migrates to issuing Cognito tokens, the
authorizer flips to JWKS verification (or the HTTP API's built-in Cognito authorizer)
with **no other infrastructure change** — the pool already exists.

### 1.6 DynamoDB tables — 8 total

All `PAY_PER_REQUEST`. PITR enabled on users / restaurants / riders / orders. See
[04 Data Model](./04-data-model.md) for key schemas and GSI definitions.

| Table name | Purpose | PITR | TTL |
|---|---|---|---|
| `foodo-infra-<stage>-users` | User profiles + refresh-token session rows | ✅ | refresh rows |
| `foodo-infra-<stage>-restaurants` | Restaurant records | ✅ | — |
| `foodo-infra-<stage>-riders` | Rider KYC + availability | ✅ | — |
| `foodo-infra-<stage>-orders` | Orders (the busiest table) | ✅ | unpaid orders |
| `foodo-infra-<stage>-menu-items` | Menu items | ❌ | — |
| `foodo-infra-<stage>-carts` | Carts (one partition per user) | ❌ | — |
| `foodo-infra-<stage>-addresses` | Saved delivery addresses | ❌ | — |
| `foodo-infra-<stage>-webhook-dedupe` | Payment webhook idempotency markers | ❌ | 24 h |

### 1.7 SNS — the domain event bus

```
foodo-infra-<stage>-events          (Topic)
```

Exported as `EventsTopicArn`. Fan-out only: consumers subscribe from their own stacks
with `FilterPolicy` on the `event` message attribute. One publisher, many independent
queues — adding a consumer never touches a publisher.

### 1.8 SQS — cross-service work queues

| Queue | VisibilityTimeout | Retention | DLQ | maxReceiveCount |
|---|---|---|---|---|
| `foodo-infra-<stage>-payment` | 180 s | 4 days | `…-payment-dlq` (14 d) | 3 |
| `foodo-infra-<stage>-order` | 180 s | 4 days | `…-order-dlq` (14 d) | 3 |

`VisibilityTimeout: 180` is deliberately **6× the 30-second consumer Lambda timeout** —
if a consumer hangs, SQS redelivers to a healthy container rather than a busy one.

Exports: `PaymentQueueUrl`, `PaymentQueueArn`, `OrderQueueUrl`, `OrderQueueArn`.

### 1.9 Exports — the contract every other stack depends on

`EventsTopicArn`, `UsersTable`, `RestaurantsTable`, `RidersTable`, `OrdersTable`,
`MenuItemsTable`, `CartsTable`, `AddressesTable`, `WebhookDedupeTable`,
`PaymentQueueUrl`, `PaymentQueueArn`, `OrderQueueUrl`, `OrderQueueArn`,
`UploadsBucketName`, `UploadsBucketArn`, `VpcId`, `PublicSubnetIds`, `PrivateSubnetIds`,
`CognitoUserPoolId`, `CognitoUserPoolClientId`, `CognitoIssuerUrl`.

Each is named `foodo-infra-${stage}-<Name>`.

---

## 2. `core` — the shared compute stack

`core/serverless.yml` → CloudFormation stack `foodo-core-api-${stage}`

### 2.1 One HTTP API for the entire platform

```yaml
HttpApi:
  Type: AWS::ApiGatewayV2::Api
  Properties:
    Name: ${self:service}-${sls:stage}
    ProtocolType: HTTP
```

No `CorsConfiguration` — deliberately. All traffic is **same-origin** through CloudFront
(see §3), so CORS is unnecessary and its absence is an extra guard against cross-origin
abuse.

Stage `$default` with `AutoDeploy: true`. Access logs go to
`/aws/http-api/foodo-core-api-<stage>` (14-day retention) in the format:

```json
{"requestId":"$context.requestId","ip":"$context.identity.sourceIp",
 "requestTime":"$context.requestTime","httpMethod":"$context.httpMethod",
 "routeKey":"$context.routeKey","status":"$context.status","protocol":"$context.protocol",
 "responseLength":"$context.responseLength","authorizerError":"$context.authorizer.error"}
```

`authorizerError` is the field that tells you "the token was bad" as opposed to "the route
does not exist".

### 2.2 The JWT request authorizer

`core/src/authorizer.ts`, Lambda `jwtAuthorizer`, **128 MB**, 10 s timeout, arm64.

```yaml
FoodoJwtAuthorizer:
  Type: AWS::ApiGatewayV2::Authorizer
  Properties:
    AuthorizerType: REQUEST
    AuthorizerPayloadFormatVersion: "2.0"
    EnableSimpleResponses: true
    AuthorizerResultTtlInSeconds: 0
```

**Token extraction order:**

1. `Cookie` header (either casing), or HTTP API v2's `event.cookies` array.
2. Split on `;`, find the `session=` cookie.
3. `decodeURIComponent` → base64 decode → `JSON.parse` → read `.jwt`.
4. If that fails (missing, malformed, no `.jwt`), fall back to
   `Authorization: Bearer <jwt>`.

**Verification:** `jwt.verify(token, JWT_SECRET)`, then require `claims.sub`.

**Return:** `{ isAuthorized: true, context: { sub, role } }` — context values must be
scalars (string/number/boolean) for HTTP API v2 simple responses.

Note the reasoning in the source: *the inner JWT, not the cookie signature, is the
cryptographic boundary.* Verifying the JWT alone is sound; `cookie-session` still
validates its own signature inside each service.

The verified claims land on the Lambda event at
`event.requestContext.authorizer.lambda`, which `serverless-http` exposes to Express as
`req.apiGateway`. That is exactly how the shared `isAuth` avoids re-verifying.

**Deliberately absent: role checks.** The authorizer proves identity only. Role authority
stays in each service (`isSeller` / `isRider` / `isAdmin`) so it stays in sync with the
permissive `isAuth`.

### 2.3 Exported for every service stack

| Export | Value | Used as |
|---|---|---|
| `HttpApiId` | the API id | `provider.httpApi.id` — attaches routes |
| `HttpApiUrl` | `https://<id>.execute-api.<region>.amazonaws.com` | consumed by the frontend via `API_GATEWAY_URL` |
| `AuthorizerId` | the authorizer id | `authorizer: { type: request, id: … }` on protected routes |
| `AuthorizerFunctionArn` | function ARN | for extra `AWS::Lambda::Permission` if ever needed |

### 2.4 No Lambda layers — on purpose

Every service bundles its own code with `tsup` and turbo caches the build. A shared
`node_modules` layer would add cold-start time and version skew for no benefit.

---

## 3. The frontend stack — `foodo-web` (SST / OpenNext)

`apps/web/sst.config.ts`

```ts
app(input) {
  return {
    name: "foodo-web",
    removal: input?.stage === "production" ? "retain" : "remove",
    protect: ["production"].includes(input?.stage),
    home: "aws",
    providers: { aws: { region: "ap-south-1" } },
  };
}
```

`removal: retain` + `protect` on production means the stack cannot be accidentally
destroyed in prod. Both are no-ops on dev.

### 3.1 Zero-cost single origin

The critical design decision. Instead of a custom domain plus CORS plus cookie
third-party blocking, CloudFront is given an **extra origin**:

```ts
args.origins = [
  ...(args.origins || []),
  { originId: "ApiGatewayBackend",
    domainName: coreApiEndpoint.replace(/^https?:\/\//, ""),
    customOriginConfig: { httpPort: 80, httpsPort: 443,
      originProtocolPolicy: "https-only", originSslProtocols: ["TLSv1.2"] } },
];
```

and an ordered cache behaviour **before** all others:

```ts
args.orderedCacheBehaviors = [
  { pathPattern: "api/*",
    targetOriginId: "ApiGatewayBackend",
    viewerProtocolPolicy: "redirect-to-https",
    allowedMethods: ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
    cachedMethods: ["GET","HEAD"],
    defaultTtl: 0, minTtl: 0, maxTtl: 0,   // never cache at the behaviour level
    compress: true,
    forwardedValues: { queryString: true,
                       cookies: { forward: "all" },
                       headers: ["*"] } },
  ...(args.orderedCacheBehaviors || []),
];
```

Result: the browser calls **relative** `/api/auth/login`. It stays on the CloudFront
hostname. The cookie is first-party. No custom domain, no CORS, no `SameSite=None`.
`NEXT_PUBLIC_API_URL` is set to the empty string deliberately.

### 3.2 Automatic endpoint discovery

`getCloudFormationExport()` calls `ListExports` (paginated) looking for
`foodo-core-api-<stage>-HttpApiUrl` and `foodo-realtime-<stage>-WebSocketUrl`.
Precedence is always env var → discovered export → constructed fallback:

```ts
const coreApiEndpoint =
  process.env.API_GATEWAY_URL || deployedHttpApiUrl ||
  `https://foodo-core-api-${stage}.execute-api.ap-south-1.amazonaws.com`;
```

If credentials or stacks are unavailable it degrades gracefully to the constructed URL
rather than failing the deploy.

### 3.3 Compute sizing

| Component | Memory | Timeout | Arch |
|---|---|---|---|
| SSR Lambda | 1024 MB | 15 s | arm64 |
| Image optimiser | 1536 MB | — | arm64 |

`NEXT_PUBLIC_STAGE` is passed so client code can branch on stage.

---

## 4. Per-service stack conventions (shared by all six)

```yaml
service: foodo-<name>
frameworkVersion: "3"
useDotenv: true

plugins: [serverless-prune-plugin]

package:
  individually: true

custom:
  stage: ${opt:stage, 'dev'}
  region: ${opt:region, 'ap-south-1'}
  infra: foodo-infra-${self:custom.stage}
  coreApi: foodo-core-api-${self:custom.stage}
  prune: { automatic: true, number: 3 }

provider:
  runtime: nodejs20.x
  architecture: arm64
  memorySize: 512
  timeout: 15
  logRetentionInDays: 14
```

**IAM pattern.** Every table is granted explicitly by ARN, table **and** its indexes,
because a GSI access needs `table/index/*`. Nothing is wildcarded. Optional
`permissionsBoundary` via `IAM_PERMISSIONS_BOUNDARY_ARN` for org-policy compliance.

```
- Effect: Allow
  Action: [dynamodb:GetItem, dynamodb:PutItem, dynamodb:UpdateItem, dynamodb:Query]
  Resource:
    - Fn::Sub: arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${TableName}
      TableName: ${cf:...UsersTable}
    - Fn::Sub: arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${TableName}/index/*
      TableName: ${cf:...UsersTable}
```

Note `admin-service` also gets `dynamodb:Scan` (it scans the orders table for stats) and
`DeleteItem` is granted to restaurant-service (cart deletes) — nothing more.

**Packaging pattern.** Each function ships only its own bundle:

```yaml
package:
  patterns:
    - "!**"
    - dist/**
```

Consumers set `timeout: 30`; realtime's ws router uses 256 MB / 10 s; the reconcile cron
uses 256 MB / 120 s.

---

## 5. Deployment commands

```bash
pnpm run deploy:infra       # 1 — must be first
pnpm run deploy:core        # 2
pnpm run deploy:services    # 3
pnpm run deploy:frontend    # 4
pnpm run deploy:all         # all four, in order

# or a single service
cd backend/rider-service && npx serverless deploy --stage dev

# teardown, reverse order
pnpm run remove:all
```

Tail logs for the asynchronous consumers:

```bash
pnpm run logs:payment      # restaurant paymentConsumer
pnpm run logs:reconcile    # utils reconcile (hourly cron)
pnpm run logs:realtime     # realtime eventConsumer
```

---

## 6. Stage handling

Every stack derives its stage from `--stage` (default `dev`) and bakes it into resource
names: `foodo-infra-dev-users`, `foodo-core-api-dev`, etc. The frontend resolves its own
stage from `$app.stage` and looks up matching exports.

Consequence: **stages are fully isolated at the CloudFormation-export level**, so a
`dev` deploy can never read a `prod` table name. There is no cross-stage sharing and no
shared state to corrupt.