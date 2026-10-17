# Deploying Wisal

The whole stack — web, worker, Postgres, Redis, TLS — on one always-on Linux VM.
No managed database, no paid tier, no domain.

Budget target: **Oracle Cloud Always Free** (ARM Ampere A1). The allowance was
4 OCPU / 24 GB and was reduced to roughly 2 OCPU / 12 GB — **check the current
figure before you plan around it**, because Oracle has changed it before. Either
way it comfortably exceeds what this stack needs; the sizing only matters
because the worker runs TypeScript through `tsx` rather than a compiled bundle,
so it needs materially more memory than `next start`, and a 1 GB instance would
need swap before it could even build the image.

> **Render was evaluated and rejected.** Its free tier cannot host this system,
> and not marginally so:
> - **No free background worker.** Render's docs are explicit that "other
>   service types don't support Free instances". Without a worker, nothing
>   drains the inbound queue and nothing dispatches — **zero reminders are ever
>   sent**, while the web app looks perfectly healthy.
> - **Free Postgres is deleted 30 days after creation.**
> - **Free web services spin down after 15 minutes idle**, so Meta's webhook
>   would time out on the first patient tap of the day.

---

## What is actually being deployed

```
        Internet
            │  80/443
            ▼
      ┌───────────┐
      │   caddy   │  TLS termination, certificate renewal
      └─────┬─────┘
            │ :3000 (compose network only)
            ▼
      ┌───────────┐        ┌──────────┐
      │    web    │        │  worker  │   ← the process that must never stop
      └─────┬─────┘        └────┬─────┘
            │                   │
            ├───────────────────┤
            ▼                   ▼
      ┌───────────┐        ┌──────────┐
      │ postgres  │        │  redis   │
      └───────────┘        └──────────┘
       (no host ports — compose network only)
```

Three things about this diagram are load-bearing:

1. **Postgres and Redis publish no host ports.** The dev compose file publishes
   5433 and 6380 to make local tooling easy. On a public VM that hands the
   patient database to the internet.
2. **The worker is not optional.** It owns all eight sweeps. If it is not
   running, the web app still accepts logins, still renders every screen, and
   still returns 200 to Meta's webhook — and no reminder is ever sent. See
   [Verification](#verification).
3. **Redis must run with `noeviction`.** BullMQ keeps every repeatable sweep
   registration there. Under an LRU policy they are silently evicted under
   memory pressure and the schedules vanish with nothing logged. The cost of
   `noeviction` is that a full Redis rejects writes — a loud failure, which is
   the one you want.

---

## Prerequisites

| Thing | Why |
|---|---|
| A VM with a **reserved public IP** | The hostname is derived from the IP and the certificate is issued for the hostname. An IP that changes on reboot breaks both at once. |
| A free hostname | DuckDNS, or nothing at all via sslip.io — see [HTTPS without a domain](#https-without-a-domain). |
| Meta app credentials | App Secret, a **permanent** system-user access token, and the `phone_number_id`. |
| The approved WhatsApp template | Named exactly `wasal_dose_reminder_v1`, in **both `ar` and `en`**, with three body parameters. See [The template is hardcoded](#the-template-is-hardcoded). |

---

## Runbook

### 1. Provision the VM

Oracle Cloud → Compute → Instances → Create. Ubuntu, shape
`VM.Standard.A1.Flex` (ARM), as much of the Always Free allowance as it offers.

**Reserve the public IP** (Networking → Reserved public IPs, free) and attach it.
Write it down; everything below depends on it.

### 2. Open ports — twice

This is the most common reason an Oracle web server appears unreachable, and it
fails closed with a timeout that looks like Caddy is broken.

**a. In the cloud console.** VCN → Security Lists → default → Add Ingress Rules:
TCP 80 and 443 from `0.0.0.0/0`. Leave port 22 alone.

**b. On the instance itself.** Oracle's Ubuntu images ship an iptables ruleset
that blocks everything except SSH. The security list alone is not enough:

```bash
# Insert ABOVE the catch-all REJECT rule, so check where that rule sits first:
sudo iptables -L INPUT -n --line-numbers

sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT

# Persist. On Ubuntu this needs iptables-persistent installed:
#   sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

If the insert lands below the REJECT rule the traffic is still dropped, which is
why the first command is there. On Oracle Linux images the persistence step is
`sudo service iptables save` instead.

Re-check with `sudo iptables -L INPUT -n --line-numbers | head`.

### 3. HTTPS without a domain

Caddy obtains a certificate by itself over HTTP-01 on port 80. It only needs a
name that resolves to this host — which does not have to be a name anyone
bought. Pick one:

**DuckDNS** — sign in at duckdns.org, create a subdomain, point it at the
reserved IP. `duckdns.org` is on the Public Suffix List, so this name gets its
**own** Let's Encrypt quota.

**sslip.io** — no account at all. The hostname is a pure function of the IP:
`203.0.113.10` becomes `203-0-113-10.sslip.io` (dashes, not dots). Caveat:
sslip.io is *not* on the Public Suffix List, so every user of it shares one
Let's Encrypt quota. Issuance works, but a bad week for other people can fail
yours.

```bash
# Confirm it resolves to the VM before going further
nslookup 203-0-113-10.sslip.io
```

### 4. Install Docker and get the code

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out and back in for this to take effect

sudo mkdir -p /opt/wasal && sudo chown "$USER" /opt/wasal
git clone <your-repo-url> /opt/wasal
cd /opt/wasal
```

### 5. Create the environment file

`.env` is gitignored and must never be committed.

```bash
cp .env.production.example /opt/wasal/.env
chmod 600 /opt/wasal/.env

# Generate the secrets and paste them in
openssl rand -hex 24   # POSTGRES_PASSWORD — also inside DATABASE_URL
openssl rand -hex 32   # SESSION_SECRET
```

Fill in `WISAL_DOMAIN`, `APP_URL` (same host, `https://`), `ACME_EMAIL`, and the
four `WHATSAPP_*` values.

**Keep `POSTGRES_PASSWORD` hex.** It is interpolated into `DATABASE_URL`, and a
character needing percent-encoding there yields a URL that parses into the wrong
credentials — a genuinely confusing failure.

### 6. Build, then bring the stack up

```bash
cd /opt/wasal

docker compose -f docker-compose.prod.yml build          # required first:
                                                         # only `web` has a build key,
                                                         # the others reuse the image
docker compose -f docker-compose.prod.yml up -d
```

`web` and `worker` both wait on the one-shot `migrate` service exiting **zero**,
so neither can start against an un-migrated schema.

**Build on the VM**, as written above — do not build the image on your laptop and
ship it. `VM.Standard.A1.Flex` is **ARM64**, and an image built on an x86 machine
is x86. The result is `exec format error` on every container, which is at least a
loud failure. Building on the box also means Prisma downloads the matching
`linux-musl-arm64` query engine rather than a cross-arch one that cannot run.

### 7. Bootstrap the first pharmacy and admin

The demo seed is the wrong tool here: it deletes every row and creates the
public logins from the README. `scripts/bootstrap-prod.ts` is idempotent and
performs no deletes.

```bash
docker compose -f docker-compose.prod.yml run --rm web npm run db:bootstrap
```

**Capture the printed admin password.** If `ADMIN_PASSWORD` was unset, one is
generated and shown exactly once — only the scrypt hash is stored, so it cannot
be recovered afterwards.

This also writes the `MessagingChannel` row. That row is the inbound routing
key, and getting it wrong is silent: see [Verification](#verification).

### 8. Point Meta at the VM, then retire ngrok

Only after Verification passes.

1. Meta dashboard → WhatsApp → Configuration → Webhook:
   - Callback URL: `https://<WISAL_DOMAIN>/api/webhooks/whatsapp`
   - Verify token: the same value as `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save** (Meta performs the GET handshake)
2. **Manage** the subscription and tick **`messages`**. Without this, Meta
   verifies the webhook and then never sends anything to it.
3. Settings → Basic: App Secret matches `WHATSAPP_APP_SECRET`.
4. WhatsApp → API Setup: the Phone number ID matches
   `WHATSAPP_PHONE_NUMBER_ID`, and the token is a permanent system-user token.
5. Kill the ngrok tunnel. Meta posts to exactly one URL, so leaving it running
   is harmless but pointless — and an ngrok free URL rotates on restart, so
   re-pointing Meta back at it is not a viable rollback.

---

## Verification

Run these in order. Every failure mode here is silent — the system keeps
returning 200 and looking healthy while doing nothing — so "it's up" is not a
result.

**1. Containers healthy, and the worker actually reached `ready`**

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs worker | tail -30
```

Look for `[worker] ready`. **Not** just `[worker] starting`. If Redis is
unreachable the worker logs the start line, then retries forever
(`maxRetriesPerRequest: null`), never registers a sweep, and sits there looking
like a running container.

**2. Every sweep is running**

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Then paste this. Compute the age in SQL rather than eyeballing `lastRunAtUtc`:
that column is a `timestamp WITHOUT time zone` holding a UTC wall clock, and
comparing it by hand against your own local clock is how you conclude a healthy
worker is dead. (See the note in `scripts/worker-healthcheck.js` — that mistake
was made once already.)

```sql
select "sweepName",
       round(extract(epoch from ((now() at time zone 'utc') - "lastRunAtUtc")))::bigint as age_seconds,
       "lastError"
  from "SweepHeartbeat"
 order by "sweepName";
```

Expect **8 rows**, recent timestamps, `lastError` null. Interpretation:

| What you see | What it means |
|---|---|
| 8 fresh rows, no errors | working |
| `dispatchSweep` older than 120s | **reminders have stopped going out** |
| `drainInbound` older than 75s | patient replies, including a **STOP**, are being stored and ignored |
| rows present but `lastError` set | the sweep runs and fails — usually the database |
| **no rows at all** | the worker never reached registration — see step 1 |
| all rows frozen at one timestamp | the worker died; `docker compose ps` should show it restarting |

The same check is the `worker` container's healthcheck
(`scripts/worker-healthcheck.js`), so `docker compose ps` showing the worker
unhealthy means the same thing.

**3. Webhook reachable — before touching Meta**

```bash
curl -sS -w '\n%{http_code}\n' \
  "https://<WISAL_DOMAIN>/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=12345"
```

Must echo `12345` as `text/plain` with status 200. A **403** means the verify
token is wrong; a **400** means it was not recognised as a handshake at all.

**4. Inbound routing resolves to the pharmacy — the silent killer**

A `MessagingChannel` whose `providerPhoneNumberId` does not equal the
`phone_number_id` Meta sends means every patient reply is persisted as
`UNROUTED` with a null pharmacy, **and the webhook still returns 200**. The
patient taps, the pharmacy never sees it, nothing errors.

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  'select "processingStatus", "pharmacyId" from "InboundMessage" order by "receivedAtUtc" desc limit 5;'
```

`RECEIVED` with a non-null `pharmacyId` is correct. `UNROUTED` means the channel
row and `WHATSAPP_PHONE_NUMBER_ID` disagree.

**5. End to end**

Enroll a medication with a dose a few minutes out for your own phone. Watch the
dispatch sweep claim it within ~30 seconds (`ReminderDispatch` → `SENT`), then
tap a button in WhatsApp and confirm a `PatientResponse` appears. That last step
is the only proof `drainInbound` is working.

---

## The template is hardcoded

`DOSE_REMINDER_TEMPLATE` is a constant in `src/server/scheduling/dispatch.ts`,
sent as:

- name `wasal_dose_reminder_v1`
- language `ar` for an `AR_EG` patient, `en` otherwise
- exactly three body parameters, in order: patient name, medication name, dose text
- three quick-reply buttons

An approved Meta template must exist under **that exact name**, in **both**
languages, with those parameters. Otherwise every send fails with
`132001 template_not_found`, which the error map marks **non-retryable** — it
fails once and stops rather than retrying into the rate limit.

This is also where Meta decides *utility* versus *marketing* classification, and
that decision is roughly an 18× difference in per-patient cost. Confirm both the
approval and the category before sending to a real patient.

The `WhatsAppTemplate` row written by the bootstrap is **bookkeeping only** —
nothing reads that table at send time. It exists so the category is recorded
somewhere queryable.

---

## Operating it

**Logs**

```bash
docker compose -f docker-compose.prod.yml logs -f worker
docker compose -f docker-compose.prod.yml logs -f caddy
```

The worker's watchdog prints `[watchdog] N sweep(s) overdue: …`. **If you are
alerting on one thing, alert on that line.** It is the only signal that
reminders have stopped while everything else still looks healthy.

**Backups** — there is no managed backup on a free VM. `pg_dump` on a timer, and
**test a restore once** rather than discovering the dump was empty when you need
it:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > /backups/wasal-$(date +%F).sql.gz
```

Keep the dumps off the VM. It also matters for Oracle's idle-instance reclaim:
an instance judged idle over a 7-day window can be reclaimed, and a card-verified
Pay-As-You-Go tenancy is reportedly exempt. Do not treat the free VM as the only
copy of patient data.

**Updating**

```bash
cd /opt/wasal && git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

`migrate` runs automatically and `web`/`worker` restart behind it. Then re-run
step 2 of [Verification](#verification) — a deploy that comes up without live
sweeps is the failure this whole document is arranged around.

**Rotating the admin password.** Only the hash is stored, so it cannot be read
back. Create a second admin with the bootstrap, or update the hash directly.

---

## Monitoring

Prometheus and Grafana run as an **overlay** on the production stack, not as a
separate one:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.monitoring.yml up -d
```

Always pass both files. The monitoring file alone is a different compose
project: it would start Grafana with no app to graph and no network in common.

Neither port is published beyond loopback — Prometheus on `127.0.0.1:9090`,
Grafana on `127.0.0.1:3001`. Publishing them on `0.0.0.0` would put
unauthenticated HTTP (Prometheus) on the internet, and Docker's port
publishing bypasses the host's INPUT rules, so the Oracle firewall would not be
a second line of defence. Reach them over a tunnel:

```bash
ssh -N -L 9090:127.0.0.1:9090 -L 3001:127.0.0.1:3001 deploy-host
# locally:  http://localhost:9090   Prometheus, with alerts at /alerts
#           http://localhost:3001   Grafana, password = GRAFANA_ADMIN_PASSWORD
```

**The scrape token.** Prometheus authenticates to `/api/metrics` with a bearer
token read from `deploy/monitoring/metrics_token`. It is not in `.env` because
Prometheus wants `credentials_file`, and everything in `.env` is interpolated
into every container:

```bash
cd /opt/wasal
openssl rand -hex 32 | sudo tee deploy/monitoring/metrics_token >/dev/null
sudo chown 65534:65534 deploy/monitoring/metrics_token   # Prometheus runs as nobody
sudo chmod 600 deploy/monitoring/metrics_token
```

Put the **same** value in `.env` as `METRICS_TOKEN`, then bring the stack up.
The ownership line is not cosmetic: the official Prometheus image runs as uid
65534, so a root-owned `600` file is unreadable to it, and the only symptom is a
`wasal-web` target that never comes up.

Create the file **before** the first `up` — otherwise Docker creates a
directory at that path and the bind mount fails in a way that reads like a
missing config.

**Rotation** is the same commands again plus a restart of both sides: Prometheus
re-reads the file on each scrape, but the app reads `METRICS_TOKEN` once, at
boot.

```bash
# regenerate the file and update .env as above, then:
docker compose -f docker-compose.prod.yml -f docker-compose.monitoring.yml up -d web prometheus
```

**What is scraped** — `deploy/monitoring/prometheus.yml`:

| Job | Target | Why |
|---|---|---|
| `wasal-web` | `web:3000/api/metrics` | sweeps, queue depth, dispatch outcomes, `nodejs_*` |
| `caddy` | `caddy:2019/metrics` | HTTP latency and the true 5xx rate |
| `prometheus` | `localhost:9090` | separates "the app stopped" from "Prometheus stopped" |

The app cannot measure its own request latency: Next 16 has no hook that sees a
successful request finish (`onRequestError` fires only on errors, `register`
once at boot). Caddy terminates every request, so p95 latency and the 5xx rate
come from Caddy and include requests that never reached the app. That is a real
limitation, not a detail to paper over.

`/api/metrics` answers **404 at the edge** — the Caddyfile hides the path —
while Prometheus reaches `web:3000` over the compose network, where the rule
does not apply. The Caddy admin API (`admin :2019`) is unauthenticated; it is
safe only because no compose file publishes that port. Never add one.

**Alerts.** `deploy/monitoring/alerts.yml` ships no Alertmanager. Rules fire
into `http://localhost:9090/alerts`, the dashboard's "Alerts firing" panel, and
the `ALERTS` metric. That is deliberate: an alert nobody reads and an alert
delivery path that silently broke are the same thing, and one container fewer
is one failure fewer. Adding Alertmanager later changes only the consumer of
these rules.

| Alert | Means |
|---|---|
| `WasalSweepStale` | **reminders have stopped going out** — the failure nothing else reports |
| `WasalSweepNeverRan` | the worker never completed a first tick; usually a fresh deployment, otherwise check `docker compose ps` |
| `WasalRepliesNotDrained` | replies are stored and ignored, including **STOP** |
| `WasalUnroutedReplies` | replies match no pharmacy — compare the channel row with Meta. Absolute count: it does not clear by itself after the fix |
| `WasalDispatchFailures` | WhatsApp rejected sends; `/admin` shows the per-row error code that tells an expired token from a bad template |
| `WasalQueueBacklog`, `WasalStuckSends` | sends are not completing; Redis holds hints only, so nothing is lost |
| `WasalHttp5xx`, `WasalWebDown` | the edge or the process is failing |
| `WasalMetricsCollectorFailing` | one collector failed; its metrics are missing, the rest still publish |

**The dashboard** is provisioned from
`deploy/monitoring/grafana/dashboards/wasal-ops.json`, not imported by hand.
It shows sweep age and staleness, queue depth by state, failed sends, the
pharmacy-scoped unrouted and stuck-send counts, errors by route file, edge p95
latency and 5xx rate, event-loop lag and heap, and the firing alerts. Editing it
in the browser is disabled — `allowUiUpdates: false` — because a hand-edited
dashboard lives only in the Grafana volume and is lost on a rebuild. Change the
JSON in the repo and let the 30-second sync pick it up.

---

## Scaling

The target is one VM, and it should stay one VM until a threshold below is
actually crossed. None of them is close.

| Component | Becomes necessary when | On one box today |
|---|---|---|
| Load balancer | more than one VM, or blue/green deploys | Caddy already terminates TLS and proxies; a second LB is one more thing to patch |
| A second `web` replica | one process cannot serve the request rate | web is stateless (signed cookie + Postgres), so this is easy later; Caddy would need explicit upstreams, since `reverse_proxy web:3000` resolves one address |
| A second `worker` replica | **not as written** | every sweep would run concurrently — there is no leader election or per-sweep lock. A lock comes first, replicas second |
| Redis HA (Sentinel/Cluster) | Redis stops being disposable | it is disposable: BullMQ holds hints, Postgres holds truth, and losing Redis costs a re-materialization, not data. Redis Cluster also wants 3+ nodes, more than this whole app |
| Vault | several environments or teams, or an audit requirement on secret access | a handful of secrets in one `.env`. Vault needs unseal keys, an HA backend and its own backups — more operations than the application |
| Managed Postgres | the database outgrows the VM, or point-in-time recovery is required | `pg_dump` on a timer, tested at least once |

In practice the box runs out of **memory** before CPU: Next's build cache,
Postgres, Redis, Prometheus and Grafana all compete for the same RAM. The two
monitoring containers are capped at 512 MiB each for exactly that reason — a
scrape storm must OOM the scraper, never the worker, whose death stops reminders
without an error anywhere.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `https://` times out, HTTP works | port 443 not open in the security list, or not in the instance's own iptables (step 2b) |
| Permit certificate error, Caddy logs `challenge failed` | port 80 closed, or `WISAL_DOMAIN` does not resolve to this VM |
| Worker healthy, `[worker] ready` never appears | Redis unreachable — check `REDIS_URL` |
| All replies `UNROUTED` | `MessagingChannel.providerPhoneNumberId` ≠ `WHATSAPP_PHONE_NUMBER_ID` |
| Every send fails `132001` | template name/language/parameters do not match Meta exactly |
| Sends fail after ~24h of working | the access token was temporary and expired |
| Sweeps stop with no error | Redis was restarted outside compose and lost `noeviction` |
| `EACCES` on boot in the worker | npm/Prisma cache not writable by the non-root user |
| Container restarts in a loop | migration failing — intended, since `require_production_config=1` makes it fatal |

---

## What deploying does not solve

None of these are fixed by having a server, and all of them are still open from
the README:

- **The Arabic template must be submitted to Meta** and its utility-versus-marketing
  classification confirmed. An 18× cost difference rides on it.
- **The Egyptian PDPL (Law 151/2020) position needs legal review** before real
  patient data is stored here — including where the data is hosted and how it is
  transferred. Nothing in this document changes that.
- **The alert thresholds need clinical validation.**
- **Login has no rate limiting.** Each attempt costs the server 128 MiB of
  scrypt, which is a real denial-of-service vector once the endpoint is public.
  Worth scheduling before real patient use.
