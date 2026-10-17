# Wisal (وِصال)

A pharmacist's medication follow-up platform. It registers consenting patients, sends
medication reminders over WhatsApp, records what the patient reports back, and shows the
pharmacist **which patient needs attention right now** — instead of relying on memory.

Arabic-first (RTL) and English, both from day one.

---

## What this is, in one paragraph

The care relationship normally ends at the point of sale. Wisal extends it: a pharmacist
records a patient's medications and their schedule, the system sends a WhatsApp reminder at
each dose time, the patient taps one of three buttons to say what happened, and the answer
lands on a dashboard with follow-up cases and adherence reporting behind it.

The patient's reply is stored as **patient-reported information**. It is never treated as
verified proof that a dose was taken. That distinction is structural in this codebase, not a
convention — see [Safety properties](#safety-properties-that-are-structural) below.

---

## Quick start

Prerequisites: **Node.js 20.9+** (Next 16's minimum), **Docker**, and npm.

```bash
# 1. Start Postgres (5433) and Redis (6380)
docker compose up -d

# 2. Configure
cp .env.example .env          # works as-is for local development

# 3. Install, migrate, seed
npm install
npm run db:migrate
npm run db:seed

# 4. Run the app and the worker, in two terminals
npm run dev                   # http://localhost:3000
npm run worker:dev            # the sweeps: dispatch, materialize, rules, outbox
```

The worker is **not optional**. Without it nothing is ever sent: reminders are materialized
and dispatched by background sweeps, not by the web process. A running app with no worker
looks completely healthy and sends nothing.

### Demo accounts

Seeded synthetic data only — no real patient data, ever (see [Data](#data)).

| Role | Email | Password |
|---|---|---|
| Pharmacy admin — د. هالة منصور | `pharmacist@wasal.demo` | `WasalDemo!2026` |
| Assistant — م. يوسف رمضان | `assistant@wasal.demo` | `WasalStaff!2026` |

The two roles differ meaningfully: an **assistant** can enroll patients and record consent
but holds neither `medication:write` nor `schedule:write`, so the medication controls do not
exist for them. That is the quickest way to see the permission model working.

### Reading the demo passwords

`prisma/seed.ts` hashes these with the same scrypt parameters the app uses. They are
deliberately in the open: this is a local demo dataset with no real data behind it. If you
point this at anything real, change them and take the values out of this file.

---

## Seeing a reminder end to end

The mock provider keeps an in-memory outbox and exposes it at a **development endpoint**.
There is no inbox UI — it is a JSON API, and you "tap" a button by POSTing an action:

1. Log in as the pharmacist and open **Patients → (a patient)**.
2. Under **Medications**, click **Add medication**. Pick dose times a few minutes out.
3. Watch `npm run worker:dev` — the dispatch sweep picks the dose up within ~30 seconds.
4. `curl localhost:3000/api/dev/outbox` — the sent message is listed there, with a
   `providerMessageId` and `canTap: true`.
5. POST an action to the same URL to simulate the patient's tap, and watch it link back to
   the correct dose on the patient screen.

```
# what's in the outbox, and what came back
curl localhost:3000/api/dev/outbox          # add ?full=1 for whole message bodies

# the patient "taps" the first button (0-based)
curl -X POST localhost:3000/api/dev/outbox -H 'content-type: application/json' \
  -d '{"action":"button_reply","providerMessageId":"<id>","buttonIndex":0}'

# move time forward instead of waiting for it
curl -X POST localhost:3000/api/dev/outbox -H 'content-type: application/json' \
  -d '{"action":"advance_clock","byMs":10800000}'
```

Other actions: `send`, `list_reply`, `template_reply`, `text_reply`, `media`, `status`,
`template_status`, `fail_next`, `clear`. They take indices rather than ids
(`buttonIndex`, `rowIndex`), because a real tap arrives as an index into the buttons that
were actually rendered. `template_reply` exercises the path a real template tap takes —
attribution through `context.id` rather than an explicit payload — which is the one the mock
must get right or the suite passes while production fails.

Every action that produces inbound goes through the same three steps the real webhook takes
(sign, verify, persist), so the development path cannot quietly diverge from Meta's. The
endpoint is absent in production, and absent whenever the live provider is not the mock.

`MESSAGING_PROVIDER=mock` is the default. The Meta Cloud API adapter sits behind the same
interface and is selected with `MESSAGING_PROVIDER=whatsapp_cloud`.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server (Turbopack) |
| `npm run worker:dev` | The sweep worker, restarting on change. **Required for anything to send.** |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Vitest — the full suite, against a real Postgres |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` | Apply migrations in development |
| `npm run db:deploy` | Apply migrations in production (no prompts, no reset) |
| `npm run db:reset` | Drop, re-migrate and re-seed |
| `npm run db:seed` | Synthetic pharmacy, users, patients and schedules |
| `npm run db:bootstrap` | **Production** first-run setup: pharmacy, admin, messaging channel. Idempotent, deletes nothing |
| `npm run db:studio` | Prisma Studio |
| `npm run i18n:merge` | Merge translation fragments into the catalogues (see below) |

> Do not run `npm run build` while someone else is working in the tree. It writes to the same
> `.next` directory the dev server is using, and one of you will get confusing errors. Run
> `typecheck` and `test` for a fast signal instead.

> `db:seed` and `db:bootstrap` are opposites. `db:seed` **deletes every row** and creates the
> demo logins above; it refuses to run when `NODE_ENV=production`. `db:bootstrap` is what a real
> deployment uses, and is safe to re-run.

---

## Deploying

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for the full runbook: one always-free Linux VM running
the whole stack, TLS without owning a domain, the production bootstrap, and — most importantly —
the verification steps.

Worth knowing before you start: the failure mode of this system is **silence**. With no worker
running, the web app still serves every screen, still accepts logins, and still returns 200 to
Meta's webhook, while no reminder is ever sent and no error is ever logged. Deploying is not
finished until `SweepHeartbeat` shows all eight sweeps running — DEPLOY.md has the query.

---

## How it is put together

One Docker Compose stack. Two processes share one codebase — the Next.js app (screens and
webhooks) and a standalone worker (the sweeps). Postgres and Redis are containers.

```
Next.js 16 (RSC + route handlers)  ─┐
                                    ├─► PostgreSQL (Prisma 7)
Worker (BullMQ sweeps, tsx)        ─┘         Redis (BullMQ)
        │
        └─► MessagingProvider ──► MockProvider (dev) | WhatsAppCloudProvider (prod)
```

The worker registers the sweeps on boot with BullMQ's `upsertJobScheduler` — idempotent on the
scheduler id, so a restart updates the schedule in place rather than accumulating a second
copy of every sweep:

| Sweep | Every | What it does |
|---|---|---|
| `dispatchSweep` | 30s | Claims due doses and enqueues the sends |
| `drainInbound` | 15s | Turns stored patient replies into responses |
| `reconcileSending` | 60s | Resolves sends stuck in `SENDING` |
| `expireStale` | 60s | Expires doses whose moment has passed |
| `heartbeat` | 60s | Watchdog — flags any sweep that has gone quiet |
| `settleNoResponse` | 5m | Settles silence into a disposition |
| `materialize` | 15m | Re-diffs the 72-hour horizon |
| `rulesSweep` | 15m | Evaluates the rule catalogue into alerts and cases |

Every sweep records a `SweepHeartbeat`. It is the only thing that catches the silent total
failure where the queue is emptied, the repeatable jobs vanish, and nobody is being messaged
while every log line still looks healthy.

### Three framing decisions everything else follows from

**1. `ReminderEvent` rows are a reconcilable projection, not a source of truth.**
They are materialized on a rolling 72-hour horizon and re-diffed every 15 minutes, and a
schedule edit can freely cancel or supersede them. If you find yourself treating a reminder
row as authoritative, something has gone wrong.

**2. Redis holds nothing that matters.**
Dispatch is a 30-second *sweep* that selects due rows from Postgres and transitions them with
a compare-and-swap — rather than one delayed job per reminder. This is why a pharmacist's
schedule edit only has to reconcile one system. Wiping Redis costs at most one sweep
interval.

**3. Delivery state and response state are two independent fields.**
"What happened to the message" and "what the patient said" are separate columns. This is what
stops a `read` receipt that arrives *after* an answer from clobbering the answer.

### Where things live

| Path | Responsibility |
|---|---|
| `prisma/schema.prisma` | All entities, enums and indexes |
| `prisma/seed.ts` | Synthetic demo data |
| `src/server/scheduling/` | Horizon materialization and dispatch |
| `src/server/responses/` | Attribution and response application |
| `src/server/rules/` | The rule catalogue and its evaluator |
| `src/server/messaging/` | The provider interface and both adapters |
| `src/server/metrics/` | Prometheus registry, scrape-time collectors, bearer auth |
| `src/app/[locale]/(app)/admin/` | Read-only ops console, behind `ENABLE_ADMIN` and `settings:manage` |
| `deploy/monitoring/` | Prometheus rules, scrape config, Grafana provisioning |
| `src/worker/index.ts` | Registers every sweep on boot |
| `src/messages/` | Translation catalogues (`ar.json`, `en.json`) |

---

## Safety properties that are structural

The client's brief is unusually careful about what a messaging system must **not** claim.
Each of these is enforced by the shape of the code, and several have tests that fail if the
guarantee is broken:

- **A response is patient-reported, never verified.** `PatientResponse.source` is
  single-valued `PATIENT_REPORTED` and `isVerified` defaults false; no inbound path writes
  it, and a database `CHECK` backs that up.
- **A successful API call is not proof of delivery.** Sending and delivery are separate
  states, driven by the provider's callbacks.
- **Silence is not non-adherence, and our downtime is not the patient's fault.**
  `EXPIRED` (we never sent it) and `NONE` (the patient said nothing) are never merged.
  `NO_RESPONSE` is a *derived disposition*, not a `ResponseState` value — so a late reply
  coexists with the settlement record instead of erasing it.
- **First response wins for adherence; the union wins for safety.** Tapping "taken" and then
  "problem" records `TAKEN` for adherence *and* opens a case anyway. A mis-tap cannot destroy
  an accurate record, and a symptom report can never be suppressed.
- **Phone numbers are not primary keys.** `Patient` is indexed on
  `[pharmacyId, phoneE164]`, deliberately not unique — shared family phones are common, and a
  unique constraint would silently block real enrollments.
- **No national IDs, no unrelated medical information, no AI training on patient data.**
- **No unofficial WhatsApp automation.** Only the official Cloud API, behind an adapter that
  translates Meta's error codes into `retryable: boolean` so business logic never has to know
  what `131047` means.

### Data

Everything in `prisma/seed.ts` is synthetic. **Do not put live patient data in this system**
until the Egyptian PDPL (Law 151/2020) position and the hosting/data-transfer terms have had
legal review. That is the reason the seed data is fake, not a temporary shortcut.

---

## Adding a screen or a string

Two conventions worth knowing before your first change.

**Translations are merged, not hand-edited.** Put new keys in
`src/messages/fragments/<namespace>.{ar,en}.json`, then run `npm run i18n:merge`. The script
validates Arabic/English leaf-path parity and rejects empty strings **before** it writes, and
it refuses to overwrite a namespace unless you pass `--force`. Do not run the merge while
someone else is mid-change in the catalogues.

**Every enum value must resolve in both languages.** `tests/i18n.coverage.test.ts` fails if a
value in the Prisma schema has no translation, if the two catalogues' key sets diverge in
either direction, or if a string is empty.

### Next.js 16 specifics

This project uses `cacheComponents` with partial prerendering, which changes some rules you
may know:

- `export const dynamic` / `revalidate` / `fetchCache` / `dynamicParams` are **build errors**,
  not warnings. `export const instant = false` is the escape hatch.
- Awaiting `searchParams` at the top of a page, or awaiting `params` that contains a non-root
  segment such as `[id]`, makes the route request-bound and `next build` rejects it. Pass the
  promise down to a `<Suspense>` child instead.
- `params.locale` **is** a root parameter and is safe to await at the top.
- Middleware is `proxy.ts` (exporting `proxy`), not `middleware.ts`.

`docs/SCREENS.md` is the standing reference for screen conventions, and reading it before
adding a page will save you a build failure.

---

## Ownership and continuity

This matters more than usual here, so it is stated plainly — and separated into what the code
already guarantees and what still has to be put in your name.

### What the code guarantees

- **No lock-in to a person or a vendor.** The source is a normal Next.js application with no
  proprietary components. No part of it requires a specific developer or company to build,
  run, or change.
- **No lock-in to a host.** The whole stack is one `docker-compose.yml` plus a plain Postgres
  database. Moving it means taking a database dump and starting the same compose file
  elsewhere. No managed service holds the application.
- **No secret build step.** `npm run build` is the entire deployment build, and
  `npm run db:deploy` the entire migration path.
- **Onboarding another developer is a documented, verifiable procedure:**
  `docker compose up` → `npm install` → `npm run db:migrate && npm run db:seed` → `npm test`.
  A green suite means their environment matches everyone else's. That is what the tests are
  for, and it is why they run against a real Postgres rather than mocks.

### What has to be arranged, not assumed

- **The WhatsApp Business account must be registered in the client's name, not a developer's.**
  The Meta app, the phone number, and the message templates are the assets with real switching
  cost — far more than the code. Whoever holds that account controls the channel. Register it
  to the pharmacy's business from the start, and give the developer access as a user rather
  than as the owner.
- **Templates can be submitted and edited through Meta's own dashboard**, without touching this
  codebase. That is deliberate: re-wording the questionnaire should not require a release.

### What is not finished

Being explicit about this is part of not locking anyone in:

- **The live Meta path has never been exercised against Meta.** The adapter exists and the
  mock provider reproduces its callback shapes — including the template-reply attribution path
  — but the first real template submission and the first real webhook will surface things no
  mock can. Budget for a shakedown period.
- **Pricing depends on the message classification** Meta assigns the reminder template. If it
  is accepted as a *utility* message the cost is roughly $0.65 per patient per month; if Meta
  classifies it as *marketing* it is roughly $11.50 — about 18×. **Submit the real Arabic
  template and confirm the classification before quoting a price to anyone.**
- **Alert thresholds ship with conservative defaults and need clinical validation.** They are
  configurable, and a rule dry-run on the settings screen reports how many alerts a given
  setting would have produced over the last 30 days, so they can be tuned without flooding the
  pharmacist.
- **No deployment configuration is included.** There is no production compose file, no TLS
  termination, and no backup schedule. Those depend on where this is hosted and are
  deliberately not guessed at here.
