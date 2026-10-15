import { cacheLife, cacheTag } from "next/cache";
import type { NextRequest } from "next/server";
import { rankDrugNames, type DailyMedRow } from "@/lib/drug-name-search";
import { requireApiSession } from "@/server/auth/current-user";
import {
  DRUG_NAME_LIMIT,
  fetchDailyMedNames,
  upstreamFailureResponse,
} from "@/server/medications/drug-names";

/**
 * Drug-name suggestions for the medication form.
 *
 * `src/proxy.ts` excludes `/api` from its matcher, so this route is NOT behind
 * the app's session gate and must do its own — see `requireApiSession`.
 *
 * Note what is deliberately absent. `dynamic`, `revalidate`, `fetchCache` and
 * `dynamicParams` are build errors under `cacheComponents`, and `runtime` is
 * not exported either. No `limit` or `page` is read from the query string: the
 * page size and the result count are ours to choose, and a caller who could set
 * the page size could ask us to fetch an arbitrary number of upstream rows.
 *
 * Nothing here is prose. Every failure is a stable code, because the caller is
 * a `fetch` in a dropdown, not a person reading a page.
 */

/** Below this, DailyMed matches so much that the ranking has nothing to rank. */
const MIN_QUERY = 3;

/** Longer than any drug name, so anything past it is not a search. */
const MAX_QUERY = 60;

/**
 * Control characters and the bidi overrides, refused before they are forwarded.
 * A right-to-left override in a search term is a way to make a dropdown render
 * something other than the text it was given.
 */
const UNSAFE_QUERY = /[\u0000-\u001F\u007F‎‏‪-‮]/;

export async function GET(req: NextRequest) {
  const access = await requireApiSession("medication:write");
  if (access.response) return access.response;

  const query = (req.nextUrl.searchParams.get("q") ?? "").trim();

  if (query.length < MIN_QUERY || query.length > MAX_QUERY || UNSAFE_QUERY.test(query)) {
    return Response.json({ ok: false, error: "INVALID_QUERY" }, { status: 400 });
  }

  try {
    const ranked = rankDrugNames(await cachedDrugNames(query), query, DRUG_NAME_LIMIT);

    // An empty list is a 200. "No drug is called that" is an answer, not a
    // fault, and the client renders it as a hint rather than an error.
    return Response.json({ ok: true, query, suggestions: ranked });
  } catch (err) {
    return upstreamFailureResponse(err);
  }
}

/**
 * `use cache` cannot decorate the `GET` export — it has to be its own function —
 * and the documented rule is an explicit `cacheLife` in every `use cache` scope,
 * because an omitted one silently takes the 15-minute `default` profile.
 *
 * The cache key is this function's serialized argument, so one entry per
 * distinct query, and `cacheLife("days")` matches an upstream index that
 * DailyMed rebuilds daily. `cacheTag` is a handle for invalidating the pair of
 * drug endpoints together later; nothing revalidates it yet.
 *
 * Two things must stay true here. It reads no request state — the handler
 * parses `searchParams` outside and passes a plain string in — and it makes no
 * authorization decision: the session check is above, so a cached answer is
 * never a cached permission.
 */
async function cachedDrugNames(query: string): Promise<DailyMedRow[]> {
  "use cache";
  cacheLife("days");
  cacheTag("drug-catalog");

  return fetchDailyMedNames(query);
}
