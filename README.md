# Gestu Managed Cloud Proxy (Cloudflare Worker)

The standalone, auditable Cloudflare Worker gateway for Gestu's managed cloud tiers on
`https://api.gestu.ca/v1`. This directory is intentionally self-contained so privacy-conscious
users and reviewers can publish and audit it as a read-only public repository in under 5 minutes.

## Privacy & Verification Guide (5-Minute Audit)

1. **Zero prompt or response logging (metadata-only):**
   - Every `console.*` call in `src/` emits only operational metadata (status codes, truncated
     hashed key/meter IDs, and integer token counts).
   - The single per-completion telemetry line is `reportUsageTelemetry()` in `src/proxy.ts`, which
     logs strictly `{evt, at, meter, tier, product, prompt, completion, cacheHit, cacheMiss, total}`.
   - Request bodies (`messages`), assistant outputs, raw virtual keys, and raw client IPs are never
     logged.
2. **Zero prompt or response storage:**
   - **Cloudflare KV (`PRO_KV`)** stores only `sha256` hashes of virtual keys and purchase tokens,
     device bindings, rate-limit counters, trial start timestamps, and monthly integer token totals.
   - **Durable Objects (`LICENCE_METER`, `ACCESS_METER`)** store only per-month spend (`µUSD`),
     token integers, device seats, and short-lived concurrency leases.
   - **Cloudflare D1 (`FUNNEL_DB`)** stores only 4 daily UTC aggregate integers
     (`trial_started`, `trial_cap_hit`, `pro_activated`, `day7_active`) — zero user IDs, zero
     device IDs, zero IPs, and zero prompt content (see `migrations/0001_funnel_metrics.sql`).
3. **Upstream Zero Data Retention (ZDR) posture:**
   - This Worker is a streaming TLS pass-through (`streamedCompletion()` in `src/proxy.ts`). Prompts
     are forwarded directly to the configured OpenAI-compatible upstream LLM API over HTTPS and
     responses are streamed back immediately via `ReadableStream.tee()` without buffering content
     to KV, D1, R2, or logs.
   - The proxy is provider-agnostic: upstream endpoints are configured via `wrangler.toml` `[vars]`
     and credentials via `wrangler secret put` (never committed). Gestu's production deployment
     routes managed traffic only to upstream providers configured under Zero Data Retention (ZDR)
     API terms so prompts are not stored or used for model training.
4. **Per-user Free trial limits (no low `$25/day` global kill switch):**
   - Free trial users are governed by **per-user trial limits** — a **7-day trial window**
     (`GESTU_FREE_TRIAL_DAYS`, default `7`, persisted per device hash so reinstalls do not reset
     the clock) **or** a **$0.50 USD per-user cost cap** (`DEFAULT_FREE_MONTHLY_CAP_MICRO_USD = 500_000`
     µUSD in `src/cost.ts`), whichever comes first.
   - A separate, high **emergency abuse guardrail** (`GESTU_FREE_EMERGENCY_DAILY_CAP_USD`, default
     `$500/day`, configurable or set to `"0"`/`"off"` to disable) exists solely to stop distributed
     bot-farm attacks — normal launch cohorts of 200–350 daily testers will never trip
     `503 free_capacity_reached`.
   - Pro subscribers ($14.99/mo) are never affected by Free limits and are metered independently
     ($10.00/mo soft cap → efficiency mode, $15.00/mo hard stop).

---

## What this Worker does

1. **Verifies Google Play purchases** server-side (service-account OAuth2 → Play Developer API
   `purchases.subscriptionsv2`), and acknowledges them so Google does not refund them after 3 days;
2. **Mints and stores virtual keys** (`gsk_…`, legacy `msk_…` accepted), so the client never holds a
   provider credential — for Play subscribers, for organisational licences, and for the Free
   managed trial (device-bound, no purchase);
3. **Meters** each key in Durable Object SQLite spend-PPM against its tier budget
   (**Free trial: 7-day window or $0.50 USD per-user cap; Pro: $10.00 USD soft / $15.00 USD hard**);
4. **Proxies** `POST /v1/chat/completions` to the configured ZDR upstream — streaming the answer
   straight through while counting tokens/cost, and **sanitizing every upstream error** so no
   provider name, host, key or provider error body ever reaches a client;
5. **Rate-limits the Free route** per IP+device (Cloudflare `ratelimit` binding + `AccessMeter` DO),
   and emits **4 PII-free daily funnel counters** to D1 (`trial_started`, `trial_cap_hit`,
   `pro_activated`, `day7_active`).

The client contract it implements is the Kotlin source in the app, not a document:
`composeApp/src/commonMain/kotlin/com/gestu/app/pro/{ProCatalog,ProKeyProvisioner,ProEntitlement,QuotaGate}.kt`.
Field names, header names, product ids, the token allowances and the denial vocabulary are copied
from there and must stay identical.

> **Naming rule:** the managed route is **"Managed by Gestu"**. The upstream provider is an internal
> routing detail and must never appear in a customer-facing response, error body, header the client
> reads, app string, website or Play copy. DeepSeek may appear in *this* repo as one of the 30+
> optional BYOK providers, and in operator-only configuration.

---

## How a request flows

### Buying and provisioning (Pro, Play)

```
Play Billing (device)                    Worker (api.gestu.ca)                   Google
─────────────────────                    ─────────────────────                  ──────
purchase gestu_pro_monthly
   │
   ├─ POST /api/provision-key ─────────▶ validate package + product id
   │  {productId, packageName,           for each purchaseToken:
   │   purchaseTokens[], deviceId,        └─ OAuth2 assertion (RS256 JWT) ──────▶ oauth2.googleapis.com/token
   │   obfuscatedAccountId, appVersion}   └─ GET subscriptionsv2/tokens/{token} ▶ androidpublisher…
   │                                         ◀── subscriptionState, expiryTime, acknowledgementState
   │                                      map state → active/grace/on_hold/canceled/expired/…
   │                                      mint gsk_… (32 random bytes), store sha256(key) ──▶ KV
   │                                      index purchaseToken → key   (a reinstall resolves back
   │                                                                   to the same subscription)
   │                                      bind device (cap GESTU_DEVICE_LIMIT, same device free)
   │                                      if acknowledgementState is PENDING:
   │                                        └─ POST …/tokens/{token}:acknowledge ─▶ androidpublisher…
   │  ◀── {ok, virtualKey, proxyBaseUrl, expiresAt}
   │
   └─ app stores the key and routes managed traffic to https://api.gestu.ca/v1
```

### Free managed provisioning (no store)

```
app ── POST /api/provision-free-token ──▶ {deviceId, packageName, appVersion}
                                          rate limit: 12/hour per IP+device (429 + Retry-After)
                                          mint gsk_…, record productId=gestu_free,
                                          meterId = hash(deviceId)  ← stable across reinstalls
        ◀── {ok, virtualKey, plan:"free", quotaLimit:200000, quotaPeriod, quotaRenewsAt, …}
```

A Free key expires only at the month (the allowance is the bound, not a date). A reinstall rotates
the secret but keeps the device's month; a new device on the same IP is a new allowance and is
rate-limited separately.

### A metered turn

```
app ── POST /v1/chat/completions ──▶ Worker
        Authorization: Bearer gsk_…          1. hash the key → KV lookup (401 if unknown)
        (X-Gestu-Subscription also accepted) 2. status active/grace/canceled-but-paid (403 if not)
                                             3. Free only: IP+device rate limits         (429 if not)
                                             4. used < locked caps for this UTC month   (429 if not)
                                             5. clamp outbound max_tokens to the tier ceiling
                                             6. force stream_options.include_usage = true,
                                                swap the public model id → tier upstream id,
                                                replace the credential with the tier secret
                                      ────▶ DeepSeek Direct (both tiers)
        ◀── SSE bytes, usage metered ────────┤  7. tee(): client gets bytes immediately,
            + X-Gestu-Quota-Used/Limit/       │     the other branch is parsed for `usage`
              Period/Renews-At/Unit/Mode      │  8. last chunk carries usage → counter += prompt+completion
                                               │     (the headers describe the state *before* this request)
```

### Reasoning depth

High reasoning is enabled on **both** managed tiers in normal mode (`thinking: {type: "enabled"}`
plus `reasoning_effort: "high"` when the caller names no depth). The app's explicit choice wins: a
request carrying `thinking: {type: "disabled"}` is honoured, and the Low/High/Max levels are passed
through. The one state that forces reasoning off is **reduced mode**, entered at the monthly cost
soft cap ($10.00, 150% hard stop $15.00): there the Worker sets `thinking: {type: "disabled"}`,
strips `reasoning_effort` and clamps `max_tokens` to 4,096. That is what protects the margin, and it
applies to Free and Pro alike.

### State changes without the app

```
Play ──▶ Pub/Sub topic ──▶ POST /api/rtdn ──▶ decode base64 envelope, dedupe by messageId
                                              EXPIRED → revoke the key immediately
                                              everything else → re-verify with Play, then apply
                                              refund/voided: act on Play's own state even when the
                                              line item is gone (never leave a refunded key live)
```

---

## Endpoints

| Method | Path                    | Auth                                   | Purpose |
| ------ | ----------------------- | -------------------------------------- | ------- |
| `GET`  | `/health`               | none                                   | Liveness + configuration self-check (names missing secrets/vars, never values) |
| `POST` | `/api/provision-key`    | none (the Play receipt is the credential) | Verify the purchase, mint or return the virtual key |
| `POST` | `/api/provision-free-token` | none (device id; IP+device rate-limited) | Mint/rotate the device-bound Free managed key |
| `POST` | `/api/provision-licence` | none (the signed licence is the credential) | Verify an organisational licence, mint or return the virtual key |
| `POST` | `/api/revoke-key`       | `X-Gestu-Subscription` or bearer       | Retire the presented key (always answers `{ok:true}`) |
| `POST` | `/api/subscription-status` | `virtualKey` in the body, or the header | Plan, status, and this month's token counter |
| `POST` | `/api/rtdn`             | Pub/Sub OIDC bearer when `RTDN_AUDIENCE` is set | Apply Play subscription state changes |
| `GET`  | `/v1/models`            | none                                   | Both managed model ids, in OpenAI's list shape |
| `POST` | `/v1/chat/completions`  | bearer or `X-Gestu-Subscription`       | Metered proxy, SSE passthrough |
| `GET`  | `/admin/usage`          | `ADMIN_USAGE_SECRET` bearer (no CORS)  | Operator per-meter monthly usage report (`json`/`csv`) |
| `GET`  | `/admin/funnel`         | `ADMIN_USAGE_SECRET` bearer (no CORS)  | Operator PII-free daily funnel counters (`json`/`csv`) |
| `OPTIONS` | any                  | allow-listed origins only              | CORS preflight |

Anything else is a JSON `404` (including the retired `/api/apple-asn` and `/api/webhook/payment`
paths); a known path with the wrong method is a JSON `405` with an `Allow` header.

### Status codes the proxy returns, and why those ones

The app maps status codes to user-facing meaning in
`composeApp/src/commonMain/kotlin/com/gestu/app/network/Requests.kt` (`handleOpenAICompatibleError`)
and its out-of-credit flow keys off `429` plus the `X-Gestu-Quota-*` headers. The choice of code is
therefore part of the contract:

| Situation | Code | Why not something else |
| --------- | ---- | ---------------------- |
| Month's tokens spent | `429` + quota headers + `{"error":{"code":"quota_exceeded"}}` | The one code the app reads as "buy more or switch to BYOK" |
| Free anti-abuse throttle | `429` + `Retry-After` + quota headers + `{"error":{"code":"rate_limited"}}` | Transient; the quota numbers are unchanged so the app does not offer a purchase for a throttle |
| Unknown / revoked key | `401` | The app's "invalid key" path, which re-provisions |
| Subscription lapsed | `403` + `{"error":{"code":"subscription_inactive","reason":…}}` | `401` would read as "your key is wrong" and loop on re-provisioning; `402` would read as "out of tokens" and offer a purchase to someone whose subscription ended. `403` is the app's content-moderation branch today, which is why the body carries an explicit `code` and says plainly what happened |
| Upstream rejected the request | `400`, sanitized body | The request itself is wrong; retrying unchanged will not help. The provider's wording is never forwarded |
| Upstream auth / balance / route / rate limit | `503` `upstream_unavailable`, sanitized body | An operator problem, and transient from the client's perspective. A provider `429` is **not** mapped to our quota `429` |
| Upstream unreachable / 5xx | `502` `upstream_unreachable` | Non-2xx, so the app treats it as retryable rather than final |

**Error sanitization is a hard contract.** `sanitizedUpstreamFailure()` in `src/proxy.ts` never
forwards an upstream body or headers. Provider names, hosts (`api.deepseek.com`,
`generativelanguage.googleapis.com`), request ids, key fragments and doc URLs are dropped; the
operator reads the Worker log, the customer reads a fixed Gestu message. `test/error-sanitization.test.ts`
pins this with a forbidden-substring assertion.

### Quota headers

Set on every proxied answer (streamed or not), on the month-end `429`, and on the Free anti-abuse
`429`:

```
X-Gestu-Quota-Used: 1234567
X-Gestu-Quota-Limit: 1500000
X-Gestu-Quota-Period: 2026-11
X-Gestu-Quota-Renews-At: 1798761600000
X-Gestu-Quota-Unit: tokens
X-Gestu-Quota-Mode: normal
```

`Used`/`Limit` are cost-based **PPM (`0..1,000,000`)** on Durable Object-metered keys (100% = $0.50 USD Free hard stop,
or $10.00 USD Pro soft cap with 150% hard stop), or output-token counts on legacy KV-only fallbacks —
because that is the normalized fraction the app renders as its usage meter. The month's token telemetry is carried separately in `X-Gestu-Input-Tokens-*` / `X-Gestu-Output-Tokens-*`. They describe the counter **before** the request
that carries them, because a streaming response head is written before the last chunk — and the last
chunk is where usage is reported. The request's own tokens are added to KV as its final chunk goes
past, so the next response (or the app's own local count) reflects them.

---

## Deploy

### 0. Prerequisites

* A Cloudflare account with Workers + KV enabled.
* Node 20+ and this directory's dependencies: `npm install`.
* A Google Cloud project, a Play Console developer account, and the `gestu_pro_monthly`
  subscription created (step 3).
* Upstream credential: one DeepSeek Direct API key, injected as `DEEPSEEK_API_KEY` (or `UPSTREAM_API_KEY`). The Free route reuses it unless `DEEPSEEK_FREE_API_KEY` is set.

### 1. KV namespace

```bash
npx wrangler kv namespace create PRO_KV
npx wrangler kv namespace create PRO_KV --preview
```

Wrangler prints the two ids. Put them in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "PRO_KV"
id = "<production id>"
preview_id = "<preview id>"
```

Everything the Worker stores lives in that one namespace, under these prefixes:

| Key | Value | Notes |
| --- | ----- | ----- |
| `key:<sha256(virtualKey)>` | `KeyRecord` | The key itself is **never** stored — only its hash |
| `purchase:<sha256(purchaseToken)>` | `PurchaseRecord` | purchase token → key, so a reinstall resolves back to the same subscription |
| `quota:<meterId>:<yyyy-MM>` | `QuotaRecord` | One counter per key (or Free device) per month; the month is in the key, so rollover needs no cron |
| `quota:tier:<meterId>:<yyyy-MM>` | `{inputTokens, outputTokens}` | The split counters the tier caps read |
| `free:device:<sha256(deviceId)>` | keyId | Free device index, so a reinstall rotates one key and keeps the month |
| `rl:free-*:<bucket>:<hash>` | counter | Free anti-abuse windows (hour/minute/day) |
| `index:active-keys` | `{keyIds, periods}` | Maintenance index for the scheduled prune |
| `google:access-token` | service-account access token | Cached until ~60 s before expiry |
| `rtdn:seen:<messageId>` | `"1"` | 24 h RTDN replay marker |

A virtual key is a *bearer* secret, so the Worker never stores it and can never show it twice. What
a reinstall or a re-provision gets back is therefore a **new secret for the same subscription** (the
same purchase binding, the same device set, the same monthly counter) — and the superseded record is
revoked in the same operation, so a key that was backed up or leaked does not stay valid.

### 2. Secrets

```bash
npx wrangler secret put DEEPSEEK_API_KEY            # Pro upstream (legacy alias: UPSTREAM_API_KEY)
npx wrangler secret put GEMINI_FREE_API_KEY         # Free upstream (Google AI Studio key)
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
# Only if you sell organisational licences — see section 8.
npx wrangler secret put GESTU_LICENCE_PUBLIC_KEY < gestu-licence-public.pem
```

| Secret | Where it comes from | Notes |
| ------ | ------------------- | ----- |
| `DEEPSEEK_API_KEY` | DeepSeek platform → API keys | The Pro credential subscribers never see. Only this Worker presents it, and only upstream |
| `GEMINI_FREE_API_KEY` | Google AI Studio / Generative Language API | The Free-route credential. Never in the app, never in a response |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | the `client_email` field of the service-account JSON key | Looks like `name@project.iam.gserviceaccount.com` |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | the `private_key` field of the same JSON key | Paste the PEM **with real newlines** (including the `-----BEGIN PRIVATE KEY-----` line). Pasting the JSON-escaped `\n` form is the commonest mistake and is rejected at import |
| `GESTU_LICENCE_PUBLIC_KEY` | `keygen` in section 8 | **Optional.** The ES256 public half of the B2B licence key pair. The private half never goes near a Worker |

**Rotate anything that was ever pasted into a chat or committed** (see RUNBOOK §0). A leaked key is
not made safe by not mentioning it.

**If a service account or upstream secret is missing, the Worker fails closed.** `/api/provision-key`
answers `200 {ok:false, reason:"not_verified"}` for every request; managed inference answers `503
server_misconfigured`; `/health` is `503` and lists the missing name in `degraded` (never a value).

### 3. Play Console: the product

In **Play Console → Monetise → Subscriptions → Create subscription**:

| Field | Value |
| ----- | ----- |
| Product ID | `gestu_pro_monthly` |
| Base plan 1 | `gestu-pro-monthly` — auto-renewing, monthly, `$14.99` |
| Base plan 2 | `gestu-pro-yearly` — auto-renewing, yearly, `$149.99` |

Prices are list prices; every other currency is Play's conversion, and the app shows the store's own
localised string — it never hardcodes a price.

**Two base plans inside one product, not two products.** Play treats base plans as the same
entitlement at different cadences, so a user can move between them and have the difference prorated.
The Worker accepts exactly the two-tier product surface: `gestu_pro_monthly` plus whatever
`GESTU_PRODUCT_ID` names. A **Lite** product (`gestu_lite_monthly`) is a retired three-tier remnant
and is refused with `not_verified`; a Free key never comes from Play at all.

These strings are duplicated in exactly two places and must agree:

* `composeApp/src/commonMain/kotlin/com/gestu/app/pro/ProEntitlement.kt`
  (`PRO_MONTHLY_PRODUCT_ID`, `PRO_MONTHLY_BASE_PLAN_ID`, `PRO_YEARLY_BASE_PLAN_ID`,
  `PRO_MONTHLY_LIST_PRICE`, `PRO_YEARLY_LIST_PRICE`);
* `wrangler.toml` `[vars]` `GESTU_PRODUCT_ID` / `GESTU_BASE_PLAN_ID`.

A provision request whose `productId` is not in that set is refused (`not_verified`) with an
error log naming both values — that is the drift alarm. The Worker never sees a *base plan* id:
Play owns that, and the line-item check is on the product.

### 4. Play Console: the service account

1. In **Google Cloud Console → APIs & Services → Library**, enable **Google Play Android Developer
   API** for the project.
2. **IAM & Admin → Service accounts → Create service account** (e.g. `gestu-pro-verifier`). No
   project roles are needed.
3. Create a **JSON key** for it and download it. From that file take `client_email` and
   `private_key` into the two secrets above. Delete the downloaded file afterwards.
4. In **Play Console → Users and permissions → Invite new users**, invite the service-account
   email, then under **App permissions** grant it access to the Gestu app, and under **Account
   permissions** enable at least *View financial data* and *Manage orders and subscriptions*. This
   is what the `purchases.subscriptionsv2` call and the acknowledge call require.
5. Permission changes can take a while (Google documents up to 24 h) to propagate; until then the
   Worker logs `service account lacks Play Console API access (403)` and refuses to mint.
   Reference: <https://developers.google.com/android-publisher/getting_started>

### 5. Pub/Sub + Real-time Developer Notifications

1. **Play Console → Monetise → Monetisation setup → Real-time developer notifications**: set the
   topic to a Pub/Sub topic (create one, e.g. `projects/<project>/topics/gestu-play-rtdn`). Play
   needs publish rights on it, which the console offers to grant when you save.
2. Create the push subscription with an OIDC identity so the Worker can authenticate it:

   ```bash
   gcloud pubsub subscriptions create gestu-play-rtdn-push \
     --topic=gestu-play-rtdn \
     --push-endpoint=https://api.gestu.ca/api/rtdn \
     --push-auth-service-account=gestu-pro-verifier@<project>.iam.gserviceaccount.com \
     --push-auth-token-audience=https://api.gestu.ca/api/rtdn \
     --ack-deadline=30
   ```

3. Set the audience the Worker should require, from `[vars]`:

   ```toml
   RTDN_AUDIENCE = "https://api.gestu.ca/api/rtdn"
   ```

   With `RTDN_AUDIENCE` empty the endpoint fails closed with `503 server_misconfigured`. **Set the
   audience before launch.**
4. Play sends a test notification from the same console page; `wrangler tail` shows
   `rtdn: test notification received`.

### 6. Route the domain

The app is compiled against `https://api.gestu.ca` (`ProCatalog.ACCOUNT_BASE_URL` and
`MANAGED_PROXY_BASE_URL = https://api.gestu.ca/v1`). Point that hostname at this Worker (Cloudflare
dashboard → Workers → the Worker → **Settings → Domains & Routes → Add custom domain**), or change
`GESTU_PUBLIC_BASE_URL` and the app's constants together.

### 7. Deploy and smoke-test

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest: pure logic, no live Google/DeepSeek/Gemini account needed
npx wrangler deploy --dry-run   # validates wrangler.toml + the FREE_RATE_LIMITER binding
npx wrangler deploy
npx wrangler tail     # watch the first requests
```

```bash
# health: names every missing var/secret without printing a value
curl -s https://api.gestu.ca/health | jq '{ok, checks, degraded}'

# free key + one free turn
curl -s -X POST https://api.gestu.ca/api/provision-free-token \
  -H 'content-type: application/json' \
  -d '{"deviceId":"smoke-free-device","packageName":"app.gestu.assistant","appVersion":"smoke"}' | jq
curl -sN -D - -X POST https://api.gestu.ca/v1/chat/completions \
  -H 'authorization: Bearer gsk_…' -H 'content-type: application/json' \
  -d '{"model":"gemini-3.5-flash-lite","stream":true,
       "messages":[{"role":"user","content":"say hi"}]}' | head -40

# provision with a token from a licence-test purchase
curl -s -X POST https://api.gestu.ca/api/provision-key \
  -H 'content-type: application/json' \
  -d '{"productId":"gestu_pro_monthly","packageName":"com.gestu.app",
       "purchaseTokens":["<purchase token>"],"deviceId":"smoke-test-device",
       "obfuscatedAccountId":"","appVersion":"smoke"}' | jq

# status
curl -s -X POST https://api.gestu.ca/api/subscription-status \
  -H 'content-type: application/json' \
  -d '{"virtualKey":"gsk_…","deviceId":"smoke-test-device"}' | jq

# models (no auth: it is a static id list)
curl -s https://api.gestu.ca/v1/models | jq

# a metered, streamed Pro turn — watch the X-Gestu-Quota-* headers
curl -sN -D - -X POST https://api.gestu.ca/v1/chat/completions \
  -H 'authorization: Bearer gsk_…' \
  -H 'content-type: application/json' \
  -d '{"model":"gestu-pro-flash","stream":true,
       "messages":[{"role":"user","content":"say hi"}]}' | head -40

# revoke
curl -s -X POST https://api.gestu.ca/api/revoke-key \
  -H 'X-Gestu-Subscription: gsk_…' | jq

# RTDN, with the shape Pub/Sub pushes. payload = base64({"packageName":…,"subscriptionNotification":{…}})
curl -s -X POST https://api.gestu.ca/api/rtdn \
  -H 'content-type: application/json' \
  -d '{"message":{"data":"<base64>","messageId":"smoke-1"}}' | jq
```

Expected `429` after the month's allowance is spent:

```bash
curl -s -D - -X POST https://api.gestu.ca/v1/chat/completions \
  -H 'authorization: Bearer gsk_…' -H 'content-type: application/json' \
  -d '{"model":"gestu-pro-flash","messages":[{"role":"user","content":"hi"}]}'
# HTTP/2 429
# x-gestu-quota-used: 1500000
# x-gestu-quota-limit: 1500000
# x-gestu-quota-period: 2026-11
# x-gestu-quota-renews-at: 1798761600000
```

To exercise the `429` without spending the full month, temporarily set
`GESTU_MONTHLY_TOKEN_LIMIT = "1"` in `[vars]`, deploy, make one request, then put it back.

---

### 8. Business licences (B2B)

A business buys by invoice, and instead of a Play subscription it is given a **signed licence
token** to paste into Settings. Nothing on this path touches Google Play: the Worker verifies an
ES256 signature against a public key it holds, so it needs no service account and keeps working
while Google is unreachable — and a leaked Worker cannot mint a licence, only refuse a real one.

A licence's key is metered against `GESTU_BUSINESS_MONTHLY_TOKEN_LIMIT` (10× the Pro split caps)
rather than the plan's `GESTU_MONTHLY_TOKEN_LIMIT`, because one key is shared by the whole company.

**Set up once:**

```bash
node tools/issue-licence.mjs keygen --out gestu-licence
npx wrangler secret put GESTU_LICENCE_PUBLIC_KEY < gestu-licence-public.pem
```

`keygen` writes a P-256 key pair. The **private** key never leaves the machine that issues
licences — do not put it in a Worker secret, because a compromised deploy could then mint licences
you would be billed for. Keep `gestu-licence-public.pem` wherever you keep operator material; it is
not itself a secret.

**Issue one:**

```bash
node tools/issue-licence.mjs issue \
    --key gestu-licence-private.pem \
    --id acme-2026 --org "Acme Corp" \
    --months 12 --seats 5 --ref INV-1042
```

| Flag | Meaning |
| ---- | ------- |
| `--id` | Licence id, stable for the life of the agreement. The key index and revocation are keyed by it |
| `--org` | Organisation name, shown to the user in the app |
| `--months` / `--days` / `--perpetual` | Term. `--months 12` is the default when none is given |
| `--seats` | Devices allowed. `0`, the default, means "use `GESTU_DEVICE_LIMIT`"; omit it and pass `--unlimited` for no cap |
| `--unlimited` | No device cap — the business tier. Mutually exclusive with `--seats` |
| `--ref` | Free-text invoice reference. Put the invoice number here, so a licence can be reconciled with the payment that produced it |

The token is not a secret: it is signed, so it cannot be altered, and it is useless against any
other server. It is safe to paste into an email.

**What the Worker enforces.** The signature, so a licence signed with any other key is refused; the
format version; the expiry; the app's package name against `GESTU_ALLOWED_PACKAGE_NAMES`; and the
seat count through the same per-device binding a subscription uses. The licence is checked before
any claim is read, so a forged `seats` or `exp` cannot widen anything.

**One key per device.** A licence is indexed by licence *and* device. Each device that redeems it
gets its own key record and its own secret, so every device on a licence works at once and a
reinstall rotates only that device's credential.

**How a licence ends.** It expires, or the operator revokes it with `POST /api/revoke-key`.
Revoking *any* of a business licence's device keys ends the **whole** licence: the id is tombstoned
so no device can redeem again, and every key it issued is revoked so the devices already working
stop.

---

## Vars and secrets reference

`wrangler.toml` `[vars]` — public, reviewed in this repo:

| Var | Default in repo | Meaning |
| --- | --------------- | ------- |
| `GESTU_PRODUCT_ID` | `gestu_pro_monthly` | Must equal the app's `PRO_MONTHLY_PRODUCT_ID` |
| `GESTU_BASE_PLAN_ID` | `gestu-pro-monthly` | Base plan inside that product |
| `GESTU_MONTHLY_TOKEN_LIMIT` | `101500000` | Pro combined backstop = 1,500,000 output + 100,000,000 input. **Not** the old 300,000,000 three-tier number |
| `GESTU_BUSINESS_MONTHLY_TOKEN_LIMIT` | code default `1015000000` | Same ceiling for a key minted from a business licence (10× Pro) |
| `GESTU_MONTHLY_CAP_MICRO_USD` | `10000000` | Cost-based reduced/hard cap for licence-backed keys ($10.00 soft, $15.00 hard) |
| `GESTU_PRICE_TABLE` | DeepSeek `deepseek-flash` rates | µUSD/token price schedule; see RUNBOOK §3 |
| `GESTU_ALLOWED_PACKAGE_NAMES` | allow list | Comma-separated; empty means refuse everything |
| `UPSTREAM_BASE_URL` | `https://api.deepseek.com/v1` | Pro upstream root; the proxy calls `/chat/completions` |
| `UPSTREAM_MODEL_ID` | `deepseek-flash` | What the `gestu-pro-flash` alias is rewritten to |
| `UPSTREAM_FALLBACK_BASE_URL` / `_MODEL_ID` | *(empty)* | Optional secondary Pro host; never the default upstream |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_CHAT_MODEL` | same as above | Legacy aliases used only when `UPSTREAM_*` is unset |
| `FREE_UPSTREAM_BASE_URL` | `https://api.deepseek.com/v1` | Free upstream root (same DeepSeek Direct API) |
| `FREE_UPSTREAM_MODEL_ID` | `deepseek-flash` | What the public Free ids (`gemini-3.5-flash-lite` / `gestu-free-flash`) forward as |
| `GESTU_EXPOSED_MODELS` | `gestu-pro-flash` | Extra ids advertised by `GET /v1/models` |
| `GESTU_DEVICE_LIMIT` | `2` | Concurrent devices per Play subscription |
| `GESTU_PUBLIC_BASE_URL` | `https://api.gestu.ca` | Used to build `proxyBaseUrl` (`…/v1`) |
| `GESTU_ALLOWED_ORIGINS` | *(empty)* | Browser origins allowed by CORS; empty refuses all |
| `GOOGLE_OAUTH_TOKEN_URL` | `https://oauth2.googleapis.com/token` | Override only for testing |
| `GOOGLE_PLAY_API_BASE` | `https://androidpublisher.googleapis.com/androidpublisher/v3` | Override only for testing |
| `GESTU_FREE_TRIAL_DAYS` | `7` | Per-device Free trial window in days (paired with the `$0.50` per-user cost cap) |
| `GESTU_FREE_EMERGENCY_DAILY_CAP_USD` | `500` | High emergency-only daily Free abuse guardrail in USD (`"0"` or `"off"` disables it) |
| `RTDN_AUDIENCE` | *(empty)* | Required `aud` of the Pub/Sub OIDC token; empty = fail closed |
| `[[ratelimits]] FREE_RATE_LIMITER` | 100 / 60 s | Free-route per-IP+device minute window (`AccessMeter` DO handles day windows) |
| `[[d1_databases]] FUNNEL_DB` | *(optional)* | D1 database for the 4 PII-free daily funnel counters (`migrations/0001_funnel_metrics.sql`) |

Locked quota numbers live in **code** (`src/constants.ts`) rather than `[vars]` on purpose: they are
the product promise, and a deploy-time typo must not silently change what was sold. Tests pin them.

Secrets (`wrangler secret put`) — never logged, never returned:

| Secret | Required | Consequence if missing |
| ------ | -------- | ---------------------- |
| `DEEPSEEK_API_KEY` (or `UPSTREAM_API_KEY`) | yes | Pro inference answers `503 server_misconfigured`; `/health` is 503 |
| `GEMINI_FREE_API_KEY` | yes | Free inference answers `503 server_misconfigured`; `/health` is 503 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | yes for Play | Provisioning refuses everything with `not_verified` (fail closed) |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | yes for Play | Same as above |
| `GESTU_LICENCE_PUBLIC_KEY` | no | `/api/provision-licence` refuses everything with `not_verified`; Play/Free are unaffected |
| `UPSTREAM_FALLBACK_API_KEY` | no | Fallback host reuses the primary key |

---

## Security properties

* **The client is untrusted.** A Play key is minted only after a successful Play Developer API call
  for a purchase token, for an allow-listed package, for the configured product, in a state Play
  reports as live. A Free key is device-bound and rate-limited. There is no "trust the receipt" path
  anywhere in `src/`.
* **No credential is stored in the clear.** KV holds `sha256(virtualKey)`, `sha256(purchaseToken)`
  and hashed device/IP rate-limit identities; a KV dump, a dashboard view or a log line yields
  nothing presentable.
* **No secret is ever logged or returned.** Logs carry key *ids*, never keys, tokens, PEM material or
  provider identifiers. `/health` reports booleans.
* **The subscriber's key never reaches an upstream.** Upstreams see only `DEEPSEEK_API_KEY` /
  `GEMINI_FREE_API_KEY`.
* **Upstream errors are sanitized.** Every non-2xx upstream answer is mapped to a fixed Gestu body
  (`sanitizedUpstreamFailure`); provider bodies and headers are dropped, never reflected.
* **Fail closed on every configuration error:** no Play service account → `not_verified`;
  no upstream secret → `503`; empty package allow list → refuse all; missing `RTDN_AUDIENCE` → 503.
* **CORS off by default.** The app is a native client and needs none. An allowed origin must be
  listed in `GESTU_ALLOWED_ORIGINS`; `*` is not offered because any web page could then spend a
  virtual key it managed to read.
* **RTDN is authenticated** once `RTDN_AUDIENCE` is set: RS256 signature against Google's published
  JWKS, `iss` restricted to Google, `exp` checked, `aud` matched exactly.
* **Device cap.** One subscription provisions at most `GESTU_DEVICE_LIMIT` devices; re-provisioning
  an existing device consumes no slot. A Free key is one device by construction.

### Known limitations

* **KV counters are not atomic.** Two overlapping requests for the same key can both read the same
  counter and write back overlapping totals, so the month can under-count by the tokens of the
  requests that raced. The pre-request `429` gate, the split tier caps and the layered Free limits
  bound the exposure. A per-key Durable Object would remove the race; the licence path already uses
  one.
* **Cost-cap duplication.** The $10.00 soft cap and the 1,500,000-output cap both target the same
  bill; the token caps are the customer promise, the cost cap is the operator backstop. If the
  price table is wrong, the cost cap stops the bleeding but the customer sees `quota_exceeded`
  earlier than the token meter implies — check `GESTU_PRICE_TABLE` first.
* **Free upstream dialect drift.** Google's OpenAI-compatible endpoint is broader than it is deep;
  a provider-specific parameter can still be rejected with a sanitized `400`. The Worker retries once
  without `stream_options` when that is what was rejected.

---

## Google API details we verified

Recorded here because they were the parts worth being unsure about.

| Question | Answer | Source |
| -------- | ------ | ------ |
| Which Play endpoint reports subscription state? | `GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/purchases/subscriptionsv2/tokens/{token}`, returning a `SubscriptionPurchaseV2` | <https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get> |
| What are the `subscriptionState` values? | Nine, not eight: `SUBSCRIPTION_STATE_UNSPECIFIED`, `_PENDING`, `_ACTIVE`, `_PAUSED`, `_IN_GRACE_PERIOD`, `_ON_HOLD`, `_CANCELED`, `_EXPIRED`, and `_PENDING_PURCHASE_CANCELED` | Android Publisher v3 Discovery document, `schemas.SubscriptionPurchaseV2.properties.subscriptionState.enum` (<https://androidpublisher.googleapis.com/$discovery/rest?version=v3>) |
| Where is the end of the paid period? | `lineItems[].expiryTime` (RFC 3339). The Worker takes the **furthest-out** item so an add-on cannot shorten the period | same Discovery document, `schemas.SubscriptionPurchaseLineItem` |
| Where is the account binding? | `externalAccountIdentifiers.obfuscatedExternalAccountId` (falls back to `externalAccountId`) | same |
| How is an upgrade/re-signup linked? | `linkedPurchaseToken` — "the purchase token of the old subscription" | same |
| How is acknowledgement reported? | `acknowledgementState`: `ACKNOWLEDGEMENT_STATE_UNSPECIFIED` \| `_PENDING` \| `_ACKNOWLEDGED` | same |
| How do we acknowledge? | `POST …/applications/{packageName}/purchases/subscriptions/{subscriptionId}/tokens/{token}:acknowledge` with `subscriptionId` = the **product id**; body `{}`; empty response | <https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/acknowledge> |
| What does a 404 from subscriptionsv2 mean? | Play does not know that token for that package. Treated as `invalid_token` on provision and as a revocation on RTDN | The endpoint returns "not found" for an unknown token; there is no documented distinct "invalid" body |
| What is the OAuth2 scope? | `https://www.googleapis.com/auth/androidpublisher` | <https://developers.google.com/identity/protocols/oauth2/service-account#jwt-auth> |
| What are the RTDN notification type integers? | `SUBSCRIPTION_RECOVERED`=1, `_RENEWED`=2, `_CANCELED`=3, `_PURCHASED`=4, `_ON_HOLD`=5, `_IN_GRACE_PERIOD`=6, `_RESTARTED`=7, `_PRICE_CHANGE_CONFIRMED`=8 (deprecated), `_DEFERRED`=9, `_PAUSED`=10, `_PAUSE_SCHEDULE_CHANGED`=11, `_REVOKED`=12, `_EXPIRED`=13, `_ITEMS_CHANGED`=17, `_CANCELLATION_SCHEDULED`=18, `_PRICE_CHANGE_UPDATED`=19, `_PENDING_PURCHASE_CANCELED`=20, `_PRICE_STEP_UP_CONSENT_UPDATED`=22 | <https://developer.android.com/google/play/billing/rtdn-reference> |
| What is the RTDN push envelope? | `{"message":{"data":"<base64>","messageId":"…","publishTime":"…"}}`; the decoded body is `{"version","packageName","eventTimeMillis","subscriptionNotification":{"version","notificationType","purchaseToken"}}` | same |
| How does Pub/Sub authenticate a push? | An OIDC bearer token signed by Google; `--push-auth-service-account` enables it and `--push-auth-token-audience` sets `aud` (defaulting to the push endpoint). The Worker verifies against `https://www.googleapis.com/oauth2/v3/certs` | <https://docs.cloud.google.com/sdk/gcloud/reference/pubsub/subscriptions/create>, <https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions> |
| How does Wrangler create a KV namespace? | `npx wrangler kv namespace create PRO_KV [--preview] [--binding PRO_KV --update-config]` | <https://developers.cloudflare.com/kv/reference/kv-commands/> |
| Does the Free upstream need a service account? | No — Google's Generative Language OpenAI-compatible endpoint (`/v1beta/openai/chat/completions`) accepts a plain API key as `Authorization: Bearer …`, so the Worker needs no JWT assertion or GCP project id for the Free route | <https://ai.google.dev/gemini-api/docs/openai> |
| What are the Pro `deepseek-flash` rates? | Off-peak `/1M`: cache-hit `$0.003`, cache-miss `$0.15`, output `$0.60`; peak (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri) exactly double. Model id at `https://api.deepseek.com` is `deepseek-flash` | <https://api-docs.deepseek.com/quick_start/pricing> (checked 2026-10-18; summarised at <https://www.morphllm.com/deepseek-api>) |
| Where is the Cloudflare rate-limit binding documented? | `[[ratelimits]] name / namespace_id / simple = { limit, period }`; periods are 10 s or 60 s | <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/> |

---

## Local development

```bash
npm install
npx wrangler dev            # http://localhost:8787
npm run typecheck
npm test
```

For `wrangler dev`, put the non-secret test values in `.dev.vars` (git-ignored):

```
DEEPSEEK_API_KEY=sk-…
GEMINI_FREE_API_KEY=…
GOOGLE_SERVICE_ACCOUNT_EMAIL=…@….iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
```

`.dev.vars` supports `\n` escapes inside double quotes, which is the one place that form is accepted.
Point `GOOGLE_PLAY_API_BASE` and `GOOGLE_OAUTH_TOKEN_URL` at a stub if you want to exercise the
provisioning path without touching Google; point `UPSTREAM_BASE_URL` / `FREE_UPSTREAM_BASE_URL` at
local stubs to exercise the proxy without spending credits.

### Tests

`npm test` runs Vitest over the pure logic — no Workers runtime and no live provider account needed
(203 tests at the start of the launch-remediation work; the suite is the contract, run it before
every deploy):

| File | Covers |
| ---- | ------ |
| `test/base64.test.ts` | base64url without padding (RFC 4648 vectors), hashing, virtual-key shape |
| `test/quota.test.ts` | period ids in UTC, month rollover, renewal instants, accounting and clamping, **the locked 1M-window / 1.5M / 100M Pro caps**, entitlement gate |
| `test/play.test.ts` | all nine Play states → entitlement, expiry parsing, grant construction, RTDN classification, refund/voided handling |
| `test/streaming.test.ts` | usage extraction from the final SSE chunk, partial frames, alias rewriting |
| `test/store.test.ts` | device cap behaviour, same-device re-provisioning, hashing at rest |
| `test/proxy.test.ts` | request parsing, `include_usage` forcing, tier-aware model routing/rewriting, `max_tokens` clamp-before-estimate, the Free/Pro moat, Free rate limiting |
| `test/free.test.ts` | `/api/provision-free-token` contract, device-bound key rotation with a stable meter id, Free inference, fail-closed rate limits, `/health`, removed-route 404s |
| `test/error-sanitization.test.ts` | **no provider name, host, key or provider body may appear in any client-visible response** |
| `test/status.test.ts` | `/api/subscription-status` plan/status mapping (Free ≠ Pro, canceled-but-paid stays entitled, tombstones) |
| `test/licence-meter.test.ts` | the LicenceMeter DO, ppm accounting, reduced/hard caps, tier token caps for licence keys |
| `test/licence-provision.test.ts` | licence seats, rotation, revocation and every refusal |
| `test/google.test.ts` | PKCS#8 PEM import, RS256 JWT claims and signature, fail-closed on a missing service account |
| `test/config.test.ts` | the upstream/secret/URL seams: DeepSeek Direct defaults for both tiers, `UPSTREAM_*` vs legacy `DEEPSEEK_*`, shared-vs-dedicated Free keys, locked quota defaults |
| `test/apple.test.ts` | retired App Store path: pure helpers still unit-tested, the routes are 404 |
| `test/fair-use.test.ts` | the deploy-time `GESTU_MONTHLY_TOKEN_LIMIT` override seam |

`@cloudflare/vitest-pool-workers` is deliberately not a dependency: nothing here needs a live
`workerd`. Add it if you later want integration tests that exercise real KV bindings.

## Layout

```
cloudflare/pro-proxy/
├── package.json          npm scripts: dev, deploy, tail, typecheck, test
├── tsconfig.json         strict, noEmit, workers-types
├── wrangler.toml         main, compatibility_date, KV/DO/rate-limit bindings, [vars], cron, observability
├── src/
│   ├── index.ts          the router: one switch on method+path, plus /health and the cron handler
│   ├── constants.ts      the wire contract (headers, ids, model ids, locked quotas) as literals
│   ├── config.ts         Env → typed config; every parser fails closed
│   ├── responses.ts      JSON shapes, quota headers, the 429/403/401 answers
│   ├── base64.ts         base64url, hex, sha256, constant-time compare, key minting
│   ├── crypto.ts         PKCS#8/SPKI PEM import, RS256 signing and verification, JWK thumbprint
│   ├── google.ts         OAuth2 assertion + token cache, subscriptionsv2, acknowledge, Pub/Sub OIDC
│   ├── play.ts           Play purchase → grant; RTDN decoding. Pure, and the part with tests
│   ├── quota.ts          billing-period arithmetic, tier caps, entitlement gate. Pure
│   ├── store.ts          the KV data model: key records, purchase index, device binding, counters
│   ├── streaming.ts      SSE inspection, usage extraction, model-alias rewriting
│   ├── proxy.ts          the metered proxy: authorize, tier routing, sanitize, stream through, meter
│   ├── provision.ts      POST /api/provision-key
│   ├── free.ts           POST /api/provision-free-token + Free per-IP+device rate limiting
│   ├── free-global.ts    emergency-only global Free abuse guardrail ($500/day default)
│   ├── funnel.ts         4 PII-free D1 funnel counters + GET /admin/funnel
│   ├── api.ts            revoke, status, and POST /api/rtdn
│   └── maintenance.ts    the scheduled prune
├── migrations/
│   └── 0001_funnel_metrics.sql  D1 schema for `funnel_daily_counters` (zero PII)
└── test/                 Vitest unit tests for the pure parts
```
