# Screen conventions

Everything a new screen in this app must follow. Read this before writing one.

The existing screens are the reference implementation — read
`src/app/[locale]/(app)/patients/page.tsx` (list) and
`src/app/[locale]/(app)/patients/[id]/page.tsx` (detail) first. They were built
to be copied.

---

## 1. Next.js 16 with Cache Components

`next.config.ts` sets `cacheComponents: true` and `partialPrefetching: true`.
This changes the rules, and the failures are **build errors, not warnings**.

**`params` and `searchParams` are Promises — but they are not equally safe to
await.** The verified rule:

| Value | Awaiting it at the top of the page |
|---|---|
| `searchParams` | **Never.** Binds the whole route; `next build` fails with `blocking-prerender-dynamic`. |
| `params` containing a non-root segment (`[id]`) | **Never.** Same failure — see the git history of `patients/[id]/page.tsx`. |
| `params.locale` | Fine. It is a *root parameter*, statically known from `generateStaticParams` — `patients/page.tsx` does this today. |

**Prefer `next/root-params` over `params.locale` anywhere you need the locale.**
It is a plain function call available during prerendering from any server
component, so it survives any reshaping of the `params` prop and cannot bind a
route by accident. `src/i18n/request.ts` already uses it:

```tsx
import { locale as localeParam } from "next/root-params";

async function SomeResults({ searchParams }: { searchParams: Promise<…> }) {
  const locale = await localeParam();   // root param — safe anywhere
  const raw = await searchParams;        // inside Suspense — safe here
  // …
}
```

So the shape for a **list screen** is: hand the `searchParams` promise to a
`<Suspense>` child and await it there.

```tsx
export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title="…" />              {/* static, prerenders */}
      <Suspense fallback={<SkeletonRows />}>
        <Results searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
```

For a **detail screen** (`[id]`), hand the `params` promise to the `<Suspense>`
child and await it there, then call `notFound()`:

```tsx
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<Skeleton />}>
      <Record params={params} />
    </Suspense>
  );
}
```

> **Known tradeoff, deliberate.** Under partial prerendering the shell and the
> HTTP status commit before the dynamic hole resolves, so `notFound()` in a
> streamed child returns **HTTP 200** with the genuine 404 UI. The alternative,
> `export const instant = false` on the route, gives a real 404 at the cost of a
> blocking render on every valid load. `patients/[id]/page.tsx` documents this;
> the security property is unaffected either way (a cross-tenant id and a
> nonexistent id produce byte-identical responses).


**Also removed under `cacheComponents`:** `export const dynamic`,
`export const revalidate`, `export const fetchCache`, `export const dynamicParams`.
Declaring any of them is a build error. `export const instant = false` is the
supported escape hatch to make a route deliberately blocking — use it only when
you have a reason and say what it is.

**Cache Components uses React `<Activity>`:** routes stay *mounted but hidden*
when you navigate away. Component state persists. A dialog or dropdown that
relies on unmounting to reset itself will not reset.

**`searchParams` values are untrusted.** A query string can be repeated
(`?q=a&q=b`) so the type is `string | string[] | undefined`. Narrow it explicitly
— see `parseStatus`/`parseQuery` in the patients list.

**Filters must be plain `GET` forms with no `action` attribute.** That re-submits
to the current path and preserves the locale prefix. Adding `action="/patients"`
silently drops `/ar` and breaks the other language.

Other Next 16 details:
- `middleware.ts` is `proxy.ts` here (export named `proxy`).
- `updateTag(tag)` in Server Actions for read-your-own-writes;
  `revalidateTag(tag, "max")` now takes two arguments.

---

## 2. Imports

| Need | Import from |
|---|---|
| Links, `usePathname`, `useRouter`, `redirect` | `@/i18n/navigation` — **never** `next/link` |
| Layout primitives | `@/components/ui` |
| Status pills, tone maps, `enumKey` | `@/components/status` |
| Tenant-scoped reads | `@/server/queries/*` |
| Session, RBAC | `@/server/auth/current-user`, `@/server/auth/rbac` |
| Prisma | `@/server/db` (`prisma` = tenant-guarded, `systemPrisma` = unguarded) |

`@/i18n/navigation`'s `Link` writes hrefs **without** the locale:
`<Link href="/patients">`. Hand-building `/${locale}/patients` puts the same
concatenation everywhere and fails silently — the link renders fine in one
locale and 404s in the other.

`notFound()` comes from `next/navigation` (it is not locale-aware and does not
need to be).

---

## 3. Layout and RTL

The app is Arabic-first RTL with an English mode, and both must work.

**Use logical spacing utilities only:** `ms-*`, `me-*`, `ps-*`, `pe-*`,
`text-start`, `text-end`. A single `ml-2` lands on the wrong side under
`dir="rtl"` and **no lint rule catches it**.

**Latin/numeric runs need their own direction.** Phone numbers, times and
`HH:MM` strings inherit the paragraph direction and the `+` or leading digit gets
reordered to the wrong end. Wrap them:

```tsx
<span dir="ltr" className="tabular-nums">{patient.phoneE164}</span>
```

**Numbers stay Latin in Arabic.** Use `ar-EG-u-nu-latn` so counts and
percentages render as `128` / `92%`, not `١٢٨` / `٩٢٪`. Staff scan them faster,
and this is already the convention in the dashboard and patients list.

---

## 4. Load order and the tenant guard

Inside every `<Suspense>` child, in this order:

```tsx
const user = await requireSessionUser(locale);   // redirects if no session
const t = await getTranslations({ locale, namespace: "…" });
// then queries, always scoped by user.pharmacyId
```

`prisma` (from `@/server/db`) **rejects any query without a `pharmacyId`
predicate.** Always pass `user.pharmacyId`. Never use `systemPrisma` in a screen
— it is for auth and webhooks, which have no session to scope by.

Use `findFirst({ where: { id, pharmacyId } })`, never `findUnique({ where: { id } })`
for anything a user supplies. A record from another pharmacy must be
indistinguishable from one that does not exist.

---

## 5. Permission checks

```tsx
import { hasPermission, requirePermission } from "@/server/auth/rbac";

// Pages: require it. Throws PermissionDeniedError.
requirePermission(user, "followup:write");

// Nav/buttons: don't render a control the user cannot use.
{hasPermission(user, "user:manage") ? <Link …/> : null}
```

`Permission` values: `patient:read|write|consent`, `medication:read|write`,
`schedule:read|write`, `followup:read|write`, `report:read`, `audit:read`,
`user:manage`, `settings:manage`.

A link to a page that will refuse you is a dead end dressed up as navigation.
Hide it.

---

## 6. Status rendering — read this twice

`@/components/status` encodes two domain rules in pixels. Do not bypass it.

**Delivery and response are different KINDS of thing.**

- Delivery (`SCHEDULED`, `SENT`, `DELIVERED`, `READ`, `FAILED`, `EXPIRED`…) is
  **infrastructure**. Render with `OutlinePill` (no fill, muted).
- Response (`TAKEN`, `TAKEN_LATE`, `MISSED`, `PROBLEM`…) is **clinical**. Render
  with `Pill` (filled, semantic).

They are separate database fields. A pharmacist glancing at a row must never be
able to read "delivered" as a kind of "taken". Use `DoseOutcome` to render the
pair together.

**Silence is not failure.** `ResponseState.NONE` renders as a muted dash, not as
a miss. `DeliveryState.EXPIRED` is `warn`, not `bad` — it is *our* downtime, not
the patient's fault.

**`null` adherence is not `0`.** Use `AdherenceValue`, which handles this. A
patient enrolled this morning has not missed anything.

Enums map to translation keys via `enumKey`:

```tsx
const tEnums = await getTranslations({ locale, namespace: "enums" });
<Pill tone={CASE_STATUS_TONE[kase.status]}>
  {tEnums(enumKey.caseStatus(kase.status))}
</Pill>
```

---

## 7. i18n — how to add strings

**Do NOT edit `src/messages/ar.json` or `src/messages/en.json` directly.** Other
work is landing in those files concurrently and a lost write is silent.

Instead write a fragment at:

```
src/messages/fragments/<yourNamespace>.ar.json
src/messages/fragments/<yourNamespace>.en.json
```

Each contains exactly one top-level key — your namespace — and nothing else:

```json
{ "caseDetail": { "title": "تفاصيل الحالة", "…": "…" } }
```

These get merged into the main catalogs by `npm run i18n:merge`. **Do not run it
yourself** if others are working in the repo at the same time — it rewrites both
catalogs wholesale. Whoever is coordinating the work runs it once, at the end.

The two fragments must be structurally identical: `tests/i18n.coverage.test.ts`
fails if a key exists in one language and not the other, or if either contains an
empty string. The merge script checks both of those *before* it writes, so a
structural mistake is reported against your fragment by name rather than as a
missing key in the merged catalog.

**Arabic must be real Arabic.** The coverage test asserts Arabic-script
characters in certain namespaces, and more to the point the client reads it.
Write Egyptian pharmacy register, not MSA filler — the existing catalog is the
tone reference (`خدها`, `فوّتها`, `مفيش رد`).

**Getting a string from another namespace:** next-intl resolves keys relative to
the translator's namespace and there is **no absolute-path escape**
(`t("/enums.x")` does not work). Call `getTranslations` again with the namespace
you need. Two or three translators in one component is normal here.

---

## 8. Mutations

Server Actions, in a `"use server"` file under `src/server/<area>/actions.ts`:

```ts
"use server";
export async function recordIntervention(prev: State, formData: FormData): Promise<State> { … }
```

Client components use `useActionState` + `useFormStatus`. `useFormStatus` must be
called from a component **rendered inside** the `<form>`, not the component that
renders it.

Every server action must:

1. `requireSessionUser()` and `requirePermission(...)` — an action is a public
   endpoint. Rendering rules do not protect it.
2. Validate input with Zod. `FormData` values are strings; coerce explicitly.
3. Scope every write by `user.pharmacyId`.
4. Write an `AuditEvent` **in the same transaction** as the change, for anything
   clinical. `AuditEvent` is append-only (a DB trigger rejects UPDATE/DELETE), so
   it cannot be fixed later — get it right the first time.
5. Return a state object; never throw raw Prisma errors at the user.

---

## 9. Verification — all three must pass before you report done

```bash
npx tsc --noEmit      # zero errors, repo-wide
npx vitest run        # all tests
```

**`npx next build` is the only thing that catches cacheComponents
violations** — `tsc` cannot see a `blocking-prerender-dynamic` error, and one bad
page fails the whole build. But it writes `.next/`, so **only one build may run
at a time**. If several people (or agents) are working in this repo concurrently,
do not run it: report done on the two commands above and let the build be run
centrally once everyone has stopped. Running it in parallel produces corrupt
build output that fails in ways that have nothing to do with anyone's code.

If you are working alone, run it. If you are unsure, ask.

If you add a query with logic worth trusting (a rate, a threshold, an ordering),
add a test in `tests/` that asserts the **behaviour** against the real database,
not the object's existence. `tests/queries.patients.test.ts` is the model —
hand-built fixtures with an exact expected number, and comments saying which
mistake each assertion exists to catch.

---

## 10. Available read models

`src/server/queries/patients.ts`: `listPatients`, `getPatientDetail`,
`getPatientAdherence`, `getPatientAlerts`, `getRecentDoses`, `listOpenCases`.

Every one takes `pharmacyId` first. **The adherence predicate lives in exactly
one place** (`scorableDoseCore` in that file) — do not re-derive it in a screen.
Two screens computing adherence slightly differently is how a pharmacist ends up
distrusting both numbers.

Add new queries to a module under `src/server/queries/`, not inline in a page, if
more than one screen needs them or if the logic is a clinical decision.
