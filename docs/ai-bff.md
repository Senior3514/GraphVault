# GraphVault AI BFF — Server-Side AI Proxy (Backend-for-Frontend)

> **Status:** design (architecture + contracts). The config CRUD, encrypted
> at-rest key storage, OpenRouter gateway, SSRF-guarded egress, and a
> non-streaming chat proxy already ship in
> `apps/server/src/{routes,services}/ai.ts` and `packages/shared/src/ai.ts`.
> This document is the **canonical contract** for that feature and specifies the
> two remaining additions: **SSE streaming** and **per-key spend caps**. The doc
> and the shared zod schemas are one source of truth — change them together.
>
> Roadmap: M21 — "Server-side AI proxy (BFF)". See `docs/ROADMAP.md`.

## 1. Why a BFF exists

The privacy spectrum (CLAUDE.md, M21) is a **dial the user controls**:

```
 off  ──►  local  ──►  BYO-key (browser)  ──►  server-BFF  ──►  (never hosted-by-us)
(default)  (Ollama)    (key in sessionStorage)  (key on YOUR server)
```

The BFF is an **additional rung**, not a replacement for the others:

| Rung               | Where the key lives                  | Where the request originates | Network when OFF |
| ------------------ | ------------------------------------ | ---------------------------- | ---------------- |
| `off`              | nowhere                              | nowhere                      | **zero**         |
| `local`            | nowhere (no key needed)              | browser → `localhost` Ollama | zero outbound    |
| `byo` (browser)    | browser `sessionStorage`             | browser → provider directly  | only on use      |
| **`server` (BFF)** | **your server, AES-256-GCM at rest** | **server → gateway**         | only on use      |

**The research-backed rationale for the BFF rung:** a key stored in the browser
(`byo`) is _extractable_ — by XSS, by a malicious extension, by anyone with
devtools on a shared machine, and it travels to every device that signs in. The
BFF moves the secret to the one machine the user already trusts with their notes
(their self-hosted server), encrypts it at rest, and **never returns it to any
client**. The browser only ever learns `{ keySet: true }`.

**Non-negotiable invariants (carried from the rest of the app):**

1. **AI is OFF by default.** When the privacy mode is `off`, the web client makes
   **zero** AI network calls and the assistant button is hidden. The server
   never calls a gateway unless a request arrives on `/v1/ai/chat`.
2. **The key never reaches the browser.** It is write-only over the wire: set via
   `POST /v1/ai/config`, never echoed by any `GET`, never logged, redacted from
   every error.
3. **Note content never leaves the device unless the user explicitly enables a
   provider** and confirms the send (the existing assistant panel keeps its
   confirm-before-send + DOMPurify-sanitised output behaviour).
4. **No telemetry.** The only outbound call the server makes for this feature is
   the user-initiated proxy to the configured gateway.

## 2. API contract

All routes live under `/v1/ai`, require a valid bearer token (`requireAuth`),
and operate on the **authenticated user's own** config (`user.id` from the auth
context — there is no cross-user surface; see §7).

### 2.1 `POST /v1/ai/config` — set provider + key

Write-only. Stores (and encrypts) the key; returns no secret.

Request body — `aiConfigRequestSchema`:

```ts
// packages/shared/src/ai.ts  (SHIPPED — with spend-cap additions sketched in §4)
export const aiConfigRequestSchema = z.object({
  apiKey: z.string().min(1).max(1024), // sent once over TLS, then encrypted
  gateway: z.enum(['openrouter', 'custom']).default('openrouter'),
  baseUrl: z
    .string()
    .url()
    .max(2048) // required iff gateway === 'custom'
    .refine((u) => /^https?:\/\//i.test(u), 'baseUrl must use http or https')
    .optional(),
  model: z.string().min(1).max(256).optional(), // default model when chat omits one
  // --- NEW (spend caps, §4) ---
  spendCapUsd: z.number().min(0).max(100_000).optional(), // 0 / undefined = no $ cap
  dailyRequestCap: z.number().int().min(0).max(1_000_000).optional(),
});
```

Responses:

- `201 { ok: true }` on success.
- `400 BAD_REQUEST` on schema failure, or `gateway === 'custom'` with no
  `baseUrl` (validated in the route).
- `401 UNAUTHENTICATED` with no/invalid token.

### 2.2 `GET /v1/ai/config` — non-secret status only

Returns the redacted status object — **never** the key, never the ciphertext.

Response — `aiConfigInfoSchema`:

```ts
export const aiConfigInfoSchema = z.object({
  keySet: z.boolean(), // true if a key is stored
  gateway: z.enum(['openrouter', 'custom']),
  baseUrl: z.string().optional(), // only when gateway === 'custom'
  model: z.string().optional(),
  updatedAt: z.string(), // ISO-8601
  // --- NEW (spend caps, §4) ---
  spendCapUsd: z.number().optional(), // the configured cap (not a secret)
  spendCapState: z.object({
    // current window status
    state: z.enum(['ok', 'warning', 'exceeded']), // <80% / >=80% / >=100%
    windowSpentUsd: z.number(), // accrued this window
    windowRequests: z.number().int(), // requests this window
    windowResetsAt: z.string(), // ISO-8601 (next UTC midnight)
  }),
});
```

- `200` with the info object when configured.
- `404 NOT_FOUND` (`{ error: { code, message } }`) when AI is not configured —
  this is how the web client decides whether to show the "Add a key" CTA.

> **Design note — why `spendCapState` here:** the client needs to render a
> budget meter and disable the send button when `state === 'exceeded'` _without_
> making a doomed chat call. Surfacing it on the config GET keeps the chat
> request path lean and lets the Settings UI show a live budget bar.

### 2.3 `DELETE /v1/ai/config` — remove config

- `204 No Content`. Idempotent (deleting an absent config still returns 204).
  Removing the config zeroes the stored ciphertext; the key is gone.

### 2.4 `POST /v1/ai/chat` — non-streaming proxy (SHIPPED)

Request — `aiChatRequestSchema`:

```ts
export const aiChatRequestSchema = z.object({
  messages: z.array(aiChatMessageSchema).min(1).max(100), // role + content, content<=64k
  model: z.string().min(1).max(256).optional(), // one-off override
  // --- NEW (opt into streaming, §3) ---
  stream: z.boolean().optional(), // default false
});
```

Response — `aiChatResponseSchema`:

```ts
export const aiChatResponseSchema = z.object({
  content: z.string(),
  model: z.string().optional(), // model the upstream reports
  // --- NEW (spend caps, §4) — echoed so the client can update its meter ---
  usage: z
    .object({
      promptTokens: z.number().int().optional(),
      completionTokens: z.number().int().optional(),
      costUsd: z.number().optional(),
    })
    .optional(),
});
```

Errors (all use the app's standard `{ error: { code, message } }` envelope):

- `404 NOT_FOUND` — AI not configured.
- `429 RATE_LIMITED` — daily request cap **or** spend cap exceeded (§4).
- `400 BAD_REQUEST` — upstream non-2xx or malformed response (sanitised body,
  key redacted, truncated to 400 chars).
- `401 UNAUTHENTICATED` — no/invalid token.

### 2.5 `POST /v1/ai/chat` with `stream: true` — SSE streaming proxy (NEW)

The browser and the BFF speak **Server-Sent Events**; the BFF and the gateway
speak the OpenAI-compatible streaming format (`data: {…}\n\n` lines ending in
`data: [DONE]`). The BFF is a **translating relay**, not a passthrough.

**Wire format (server → browser):** `Content-Type: text/event-stream`, one of:

```
event: delta
data: {"content":"partial text chunk"}

event: usage
data: {"promptTokens":312,"completionTokens":88,"costUsd":0.0007}

event: done
data: {"model":"openai/gpt-4o-mini"}

event: error
data: {"code":"RATE_LIMITED","message":"…"}
```

**Flow through the proxy:**

```
browser                         BFF (/v1/ai/chat stream)              gateway (OpenRouter)
  │  POST {messages, stream:true}   │                                     │
  │ ───────────────────────────────►│  spend/cap precheck (§4)            │
  │                                  │  decrypt key (in-memory only)       │
  │                                  │  guardedFetch(..., stream body) ───►│  POST /chat/completions
  │                                  │                                     │  stream:true, usage:{include}
  │                                  │◄──── data: {choices:[{delta:…}]} ───│
  │◄── event:delta data:{content} ──│  (parse SSE line, re-emit clean)    │
  │◄── event:delta … ───────────────│  (accumulate tokens for metering)   │
  │◄── event:usage data:{costUsd} ──│  (read final usage chunk)           │
  │◄── event:done ──────────────────│  commit spend to counter (§4)       │
```

**Why translate rather than pipe the raw stream:**

1. **Never leak upstream shape.** The browser must not depend on OpenRouter's
   exact JSON (provider lock-in, and it can carry fields we don't want exposed).
   We emit a tiny stable `{content}` delta.
2. **Metering happens in the relay.** The BFF reads the terminal `usage` chunk
   (OpenRouter returns it when the request includes
   `"usage": { "include": true }` / `stream_options: { include_usage: true }`)
   and commits the actual cost to the spend counter (§4) — accurate, not
   estimated.
3. **Key redaction.** Any upstream error surfaced mid-stream is rewritten as a
   clean `event: error` with the key stripped.

**Implementation constraints (for the server slice):**

- Set `reply.hijack()` (Fastify) and write to `reply.raw` directly, OR return a
  Node `Readable`/web `ReadableStream` with
  `reply.header('Content-Type', 'text/event-stream')`,
  `'Cache-Control': 'no-cache, no-transform'`, `'Connection': 'keep-alive'`,
  `'X-Accel-Buffering': 'no'` (defeats nginx proxy buffering — required for the
  self-hosted reverse-proxy deployment; see `docs/hardening.md`).
- **`guardedFetch` must gain a streaming mode.** Today its transport buffers the
  whole response (`chunks` → `Buffer.concat`). Add a `stream: true` option that
  resolves with the `Response` whose `body` is the live `IncomingMessage`
  stream, keeping the DNS-pinned socket + per-hop SSRF revalidation intact. See
  §5 for the exact change.
- **Abort propagation:** if the browser disconnects (`reply.raw.on('close')`),
  abort the upstream request (`req.destroy()`) so a closed tab does not keep
  burning the user's budget.
- **Heartbeat:** emit a `:keepalive\n\n` comment every ~15s so intermediaries do
  not idle-timeout a slow generation.
- **Spend pre-check before opening the upstream socket; spend commit after the
  terminal usage chunk.** If the pre-check fails, emit a single
  `event: error data:{code:"RATE_LIMITED"}` and close — no upstream call.

## 3. Streaming summary

| Concern            | Decision                                                              |
| ------------------ | --------------------------------------------------------------------- |
| Opt-in             | `stream: true` on `POST /v1/ai/chat`; default stays non-streaming.    |
| Client transport   | SSE (`text/event-stream`) with named events `delta/usage/done/error`. |
| Upstream transport | OpenAI-compat SSE; BFF parses and **re-emits a clean shape**.         |
| Proxy buffering    | `X-Accel-Buffering: no` + `no-transform` for nginx/Caddy in front.    |
| Disconnect         | client close → abort upstream (stop spend).                           |
| Metering           | read terminal `usage` chunk; commit real cost.                        |

## 4. Per-key spend caps

The shipped cap is **request-count only**, in-process, per-user/day
(`GRAPHVAULT_AI_DAILY_CAP`, default 200, resets at UTC midnight, `<=0` =
unlimited). This design **keeps that** and adds a **monetary** cap on top.

### 4.1 Two independent caps, same window

| Cap               | Source                                                      | Default          | Cleared at   |
| ----------------- | ----------------------------------------------------------- | ---------------- | ------------ |
| Daily **request** | `dailyRequestCap` (config) or `GRAPHVAULT_AI_DAILY_CAP` env | 200              | UTC midnight |
| Daily **spend $** | `spendCapUsd` (config)                                      | unset (no $ cap) | UTC midnight |

Per-user config overrides the env default; `0` / unset means "no cap of that
kind". Both are checked; whichever trips first throws 429.

### 4.2 Where the counter lives

The shipped counter is a process-local `Map<userId, {date, count}>` — **fine for
a single-process self-hosted server, but it is wiped on restart and does not
survive the postgres durability work** (lessons: "Don't advertise _encrypted at
rest_ while storing config in process memory"). The spend cap must be
**durable**, so:

- **Persist the window counter alongside the AI config**, in the `Storage` layer
  (in-memory impl + Prisma model), as an `AiSpendWindow` record:

```ts
// apps/server/src/store/types.ts  (NEW — server slice)
export interface AiSpendWindowRecord {
  userId: string;
  windowDate: string; // "YYYY-MM-DD" UTC — the active window
  requests: number; // requests committed this window
  spentUsd: number; // cost accrued this window (provider-reported)
  updatedAt: string; // ISO-8601
}
// Storage gains: getAiSpendWindow / commitAiSpend(userId, addUsd, addRequests, today)
```

`commitAiSpend` is a single read-modify-write keyed on `userId`; when
`windowDate !== today` it resets to a fresh window before adding. Keep it cheap;
this is a self-hosted single-tenant-ish workload, not a billing system.

### 4.3 Enforcement order (per chat call)

```
1. pre-check  (before any upstream call, before decrypting the key):
      load AiSpendWindow for userId
      if windowDate != today → treat counters as 0 (lazy reset)
      if dailyRequestCap > 0 and requests >= dailyRequestCap   → 429 RATE_LIMITED
      if spendCapUsd     > 0 and spentUsd  >= spendCapUsd       → 429 RATE_LIMITED
2. perform the proxied call (buffered or streamed)
3. commit  (after the response, using the provider-reported cost):
      commitAiSpend(userId, costUsd, +1 request, today)
```

- **Pre-check uses the _previous_ window's accrued spend** — a single call can
  cross the cap (we cannot know the cost until after generation), but the _next_
  call is then refused. This is the standard, simple "soft cap" behaviour; it
  cannot be made a hard pre-spend cap without per-token pre-authorization, which
  no gateway offers. Documented as such.
- **Cost source:** OpenRouter returns `usage` (and, with
  `stream_options.include_usage`, a terminal usage chunk) containing token
  counts and, for many models, a computed cost. When the gateway does not return
  a dollar cost, fall back to **request-count capping only** for that call and
  record `costUsd: 0` (never guess — guessing risks both over- and
  under-charging the user's own budget; the request cap remains the backstop).

### 4.4 429 behaviour (reuse the existing envelope)

Reuse the shipped 429 exactly (lessons: "AI cap is rate-limiting → 429, not
400"):

```ts
throw new AppError(
  429,
  'RATE_LIMITED',
  `AI daily spend cap ($${cap}) reached. Resets at UTC midnight or raise it in Settings.`,
);
```

For streaming requests the 429 is delivered as a single
`event: error data: {"code":"RATE_LIMITED","message":"…"}` then the stream
closes (an SSE response has already committed `200` headers, so we cannot send an
HTTP 429 status mid-stream — the _pre-check_ therefore runs before any SSE
headers are written, allowing a real `429` status for the common case, and the
`event: error` path is the fallback for a cap tripped after headers).

## 5. SSRF / egress

**Every outbound AI call already goes through `guardedFetch`** (confirmed in
`apps/server/src/services/ai.ts` line ~262 and the SSRF audit:
"WebDAV/S3/Azure/GCS/AI custom endpoint/clip all route through `guardedFetch`").
This design preserves that and extends it:

- **OpenRouter host:** `https://openrouter.ai/api/v1`. This resolves to public
  IPs, so the default SSRF guard passes it with **no allowlist needed**. We do
  **not** add a host allowlist (it would break the legitimate `custom` gateway
  and every self-hoster's choice of provider); the private-IP guard is the
  correct boundary.
- **`custom` gateway:** user-supplied `baseUrl`. Because it is attacker-
  controllable in the threat model (an authed user is the "attacker" for SSRF
  purposes), it MUST keep flowing through `guardedFetch`. A self-hoster pointing
  the BFF at a **localhost** Ollama/LiteLLM must set
  `GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS=true` (the same opt-in every other
  proxy uses). Default OFF.
- **Streaming change to `guardedFetch` (the one new requirement):** add a
  `stream?: boolean` to `GuardedFetchInit`. When set, the default transport
  resolves the `Response` immediately with the live `IncomingMessage` as the
  body stream instead of buffering `chunks` → `Buffer.concat`. The DNS-pinned
  `lookup`, scheme check, private-IP rejection, and per-redirect-hop
  revalidation are **unchanged** — only the body-handling tail differs. Redirects
  on a streaming request are still followed via the buffered small-response path
  (3xx bodies are tiny); only the final 2xx is streamed.
- **Egress posture unchanged when AI is off:** no config → no chat route work →
  no `guardedFetch` call. Zero outbound.

## 6. Key handling (reuse, don't reinvent)

The exact helper to reuse already exists inside
`apps/server/src/services/ai.ts`:

- **AES-256-GCM** (`aes-256-gcm`, 12-byte nonce, 16-byte tag), key material =
  `HKDF-SHA256(ikm = GRAPHVAULT_ENCRYPTION_KEY, salt = userId, info =
"graphvault-ai-cred-v1", 32 bytes)` — the same per-user HKDF scheme as
  `webdav.ts` / `s3.ts` / `azure.ts` / `gcs.ts`, with the **distinct, versioned
  info string** `graphvault-ai-cred-v1` (lessons: "HKDF info strings must be
  unique per credential type"). When `GRAPHVAULT_ENCRYPTION_KEY` is unset a
  process-lifetime random fallback key is used (config does not survive restart
  in that mode — acceptable, and matches the other proxies).
- On disk the value is `base64(nonce ‖ tag ‖ ciphertext)` in
  `AiConfigRecord.encryptedApiKey`. The **plaintext key exists only in a local
  variable during one outbound call** and is never assigned to a field,
  returned, or logged.
- **Redaction is belt-and-suspenders:** the shipped service `.replace(apiKey,
'[REDACTED]')` on both the network-error message and the upstream error body
  (truncated to 400 chars). The streaming path must apply the same redaction to
  any `event: error` payload it relays.

**Do not** introduce a new crypto path. If a shared crypto helper is later
factored out of the four storage proxies, the AI service should adopt it with
its existing info string — but that refactor is out of scope here.

## 7. Security review

Reviewed against the threat list in the brief:

### Key extraction

- **Browser:** impossible by construction — the key is never sent to any client;
  `GET /config` returns `keySet` only; no endpoint echoes the ciphertext.
- **At rest:** AES-256-GCM, per-user HKDF sub-key. A DB/disk leak yields
  ciphertext bound to `GRAPHVAULT_ENCRYPTION_KEY` (operator secret, env-only).
- **In flight (set):** key travels once, over the operator's TLS, in a POST body
  (never a query string → never in access logs).
- **Residual:** the plaintext lives transiently in process memory during a call.
  That is inherent to any server-side proxy and is the trade we are explicitly
  making vs. browser storage. Acceptable.

### Log leakage

- Key never logged. Errors run through `.replace(apiKey, '[REDACTED]')`. Upstream
  error bodies truncated to 400 chars. **Action item for the streaming slice:**
  ensure the new SSE `event: error` and any debug logging of stream chunks apply
  the same redaction; never `console.log` a raw upstream chunk (it can echo the
  key on a 401). Recommend an assertion test: induce a 401 upstream whose body
  contains the key string and assert it appears nowhere in the response or logs.

### Cross-user access (`requireOwned`)

- Every route resolves `user.id` from the bearer token and scopes **all** storage
  reads/writes to that `userId` (`getAiConfig(user.id)`, `saveConfig(user.id,…)`,
  `commitAiSpend(user.id,…)`). There is **no vault-scoped object** here, so the
  `assertVaultOwner` check that storage proxies use does not apply — the config
  is keyed directly by the authenticated user. There is no path/param a caller
  can supply to reach another user's config. Confirmed: no IDOR surface.

### SSRF

- All egress through `guardedFetch` (DNS-pinned, per-hop revalidation,
  private-IP block). OpenRouter is public → passes with no allowlist. `custom`
  endpoints are guarded; localhost requires the explicit env opt-in. Streaming
  preserves the pin (§5). **No regression.**

### Zero-telemetry / off-by-default

- No config → no outbound calls. The only egress is the user-initiated proxy to
  the user-chosen gateway. No analytics, no phone-home. The web client hides the
  assistant entirely when the privacy mode is `off`. ✔

### Additional notes

- **Prompt content is user data.** The BFF necessarily sees note text in
  `messages` (it must, to forward it). This is the documented, consented trade of
  enabling the `server` rung — surface it in the Settings privacy notice. The BFF
  must **not** persist prompts or responses (no request/response logging of
  bodies; only counts + cost go into the spend window). Make this explicit in the
  privacy copy.
- **Spend cap as a safety control:** the durable spend counter also limits the
  blast radius of a stolen _bearer token_ (not the AI key) — an attacker who
  steals a session can still only burn up to the daily cap before being 429'd.

## 8. Implementation slices (ownership-disjoint)

Sequence matters: shared-types first (both other slices import the new schemas),
then server, then web. Each slice owns a disjoint path set per the playbook
ownership matrix.

### Slice A — shared-types (`gv-architect`) — **do first**

- **Paths:** `packages/shared/src/ai.ts`, this doc.
- **Work:** add `stream` to `aiChatRequestSchema`; add `usage` to
  `aiChatResponseSchema`; add `spendCapUsd` + `dailyRequestCap` to
  `aiConfigRequestSchema`; add `spendCapUsd` + `spendCapState` to
  `aiConfigInfoSchema`; add an `aiStreamEventSchema`
  (`delta`/`usage`/`done`/`error`) so the web client validates inbound SSE
  payloads. Keep the doc and schemas in lockstep.
- **DoD:** `pnpm --filter @graphvault/shared build typecheck test`. No consumer
  breakage (all additions optional).

### Slice B — server (`gv-server-engineer`, reviewed by `gv-security-engineer`)

- **Paths:** `apps/server/src/{routes,services}/ai.ts`,
  `apps/server/src/store/types.ts` + the in-memory & prisma store impls,
  `apps/server/test/ai.test.ts`.
- **Work:** (1) streaming branch on `POST /v1/ai/chat` (SSE relay, abort
  propagation, heartbeat); (2) `stream` option on `guardedFetch`/transport in
  `services/ssrf.ts` (coordinate — security-owned file) without touching the
  buffered/validate path; (3) durable `AiSpendWindowRecord` + `commitAiSpend` in
  Storage, replacing the in-process daily `Map`; (4) two-cap enforcement (request
  - spend) with the 429 envelope; (5) `spendCapState` in `getConfigInfo`.
- **Depends on:** Slice A (imports new schemas).
- **DoD:** new tests for streaming happy-path, mid-stream key-redaction, spend
  pre-check 429, durable counter survives a simulated restart (in-memory store
  re-read), disconnect aborts upstream. Full gauntlet green.

### Slice C — web settings + assistant (`gv-web-engineer`)

- **Paths:** `apps/web/**` AI settings panel + assistant panel + the AI client
  helper (e.g. `apps/web/lib/ai/*`). **No `packages/**` edits\*\* (lessons: use the
  shared schemas; if a field is route-local, validate server-side).
- **Work:** (1) add the `server`/BFF rung to the privacy-mode picker; (2) Settings
  form to POST the key + caps and render `spendCapState` as a budget meter; (3)
  consume the SSE stream (`EventSource`-style fetch reader) validated against
  `aiStreamEventSchema`, keeping the existing confirm-before-send + DOMPurify
  output sanitisation; (4) disable send when `spendCapState.state === 'exceeded'`;
  (5) update the in-UI privacy notice ("prompts go to your server → your chosen
  gateway; key stays on the server; nothing logged"). Keep the assistant button
  **hidden when mode is `off`**.
- **Depends on:** Slice A (types) + Slice B (live endpoints) for integration
  testing; can be built against the schemas in parallel with B and integrated
  last.

### Sequence

```
A (shared-types)  ──►  B (server)  ──►  C (web)         [strict order for integration]
                  └──►  C can start UI against A's types in parallel, integrate after B
```

### Integration / DoD reminders (orchestrator)

- Disjoint paths → cherry-pick each feature commit (not lessons commits).
- One central `pnpm install`; agents must not stage `pnpm-lock.yaml`.
- Full gauntlet (`pnpm -r build/typecheck/test`, `pnpm lint`, `pnpm format:check`)
  - a runtime smoke test: set config → stream a chat → observe deltas → hit the
    spend cap → 429.
- Security sign-off on the redaction assertion test and the SSRF streaming pin.

## 9. Open questions (for the owner / future slices)

- **Spend pre-auth is impossible** with current gateways → caps are "soft" (one
  call may cross, the next is refused). Acceptable for v1; revisit if a gateway
  exposes a hard budget API.
- **Cost when the gateway reports none:** we fall back to request-count capping
  and record `costUsd: 0` rather than estimate. Could add an optional
  per-model price table later (operator-supplied) for stricter budgeting.
- **Multi-process / clustered server:** the durable counter is correct under a
  single writer; if a self-hoster runs N replicas, the spend window needs the
  DB row to be the single source of truth (Prisma path already is). The
  in-memory store remains single-process by design.
- **Promote route-local wire types to `@graphvault/shared`** if the web slice
  needs config-CRUD types it currently re-declares (follow the storage-adapter
  precedent in lessons).

```

```
