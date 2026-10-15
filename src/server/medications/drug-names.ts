import type { DailyMedRow } from "@/lib/drug-name-search";

/**
 * The two external services behind the drug-name picker.
 *
 * Both are U.S. National Library of Medicine APIs, neither needs a key, and
 * neither is on the save path: a failure here means the pharmacist types the
 * name by hand, exactly as they did before the picker existed. That is why
 * nothing below retries, and why the errors are typed rather than swallowed —
 * the route turns them into a status the client can act on, and the client's
 * action is always "show nothing, keep the text box working".
 *
 * `fetchImpl` is injectable for the same reason the WhatsApp provider's is
 * (`messaging/providers/whatsapp-cloud.ts`): so the tests can assert the URL,
 * the page size and the timeout handling without a live call.
 */

/** DailyMed documents 100 as the maximum page size. */
export const DRUG_NAME_PAGESIZE = 100;

/** What the picker shows. The route does not accept a client-supplied limit. */
export const DRUG_NAME_LIMIT = 8;

const TIMEOUT_MS = 3000;

/**
 * Both services ask to be told who is calling. No contact URL is invented here
 * — an address that does not exist is worse than none.
 */
const USER_AGENT = "WASALH/1.0 (medication name lookup)";

/**
 * `kind` is the machine-readable cause the route maps to a status code, so the
 * classification happens once, next to the call that produced it.
 */
export class DrugUpstreamError extends Error {
  readonly kind: "UPSTREAM_ERROR" | "UPSTREAM_TIMEOUT";

  constructor(kind: DrugUpstreamError["kind"], message: string) {
    super(message);
    this.name = "DrugUpstreamError";
    this.kind = kind;
  }
}

/**
 * `AbortSignal.timeout` rejects with a DOMException named `TimeoutError`, but a
 * caller-supplied signal aborts as `AbortError` — both are timeouts as far as
 * this feature is concerned, and both must not read as an upstream fault.
 */
function classify(err: unknown): DrugUpstreamError {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new DrugUpstreamError("UPSTREAM_TIMEOUT", err.message);
  }

  return new DrugUpstreamError(
    "UPSTREAM_ERROR",
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * One GET, parsed as JSON, with the timeout and error taxonomy applied.
 *
 * No `cache` option is passed: the enclosing `use cache` in each route handler
 * owns the caching, and a second cache layer here would key on the URL instead
 * of on the normalized query and expire on its own schedule.
 */
async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw classify(err);
  }

  if (!response.ok) {
    throw new DrugUpstreamError(
      "UPSTREAM_ERROR",
      `Upstream responded ${response.status} ${response.statusText}`,
    );
  }

  try {
    return await response.json();
  } catch (err) {
    throw classify(err);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Every name DailyMed knows containing `query`, unranked.
 *
 * The full page is fetched rather than the handful we display, because the
 * ranking happens locally: the plain ingredient is often far down the alphabet,
 * so a smaller page would not contain it at all and no local sort could bring
 * back a row that was never fetched. `metformin` returns 60 rows in which the
 * single-ingredient name is not on the first page of any smaller size.
 */
export async function fetchDailyMedNames(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DailyMedRow[]> {
  const url = `https://dailymed.nlm.nih.gov/dailymed/services/v2/drugnames.json?${new URLSearchParams(
    { drug_name: query, pagesize: String(DRUG_NAME_PAGESIZE), page: "1" },
  ).toString()}`;

  const body = await getJson(url, fetchImpl);

  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new DrugUpstreamError(
      "UPSTREAM_ERROR",
      "DailyMed response did not contain a data array",
    );
  }

  // Rows are passed through as they arrive; `rankDrugNames` is the only place
  // that decides what a usable row looks like.
  return body.data as DailyMedRow[];
}

/**
 * The RxCUI for an exact RxNorm name, or null when RxNorm has no such name.
 *
 * This is `rxcui.json`, not `drugs.json`, and the difference matters. Measured
 * against the live services, `drugs.json?name=METFORMIN` returns 134 concepts
 * that are ALL product-level (SBD/SCD, plus packs with no `rxcui` at all) and
 * not one ingredient: the first hit is `24 HR metformin hydrochloride 1000 MG /
 * saxagliptin 2.5 MG … [Kombiglyze]`, and `METFORMIN`, `OMEPRAZOLE`,
 * `ATORVASTATIN` and `GLUCOPHAGE` have no exact match anywhere in their own
 * result sets. Storing a concept from that payload would attach a combination
 * product's code to the plain ingredient's name.
 *
 * `rxcui.json` matches RxNorm's own names exactly, which is the semantics we
 * want: it resolves `METFORMIN` to 6809, `METFORMIN HYDROCHLORIDE` to 235743
 * (the salt form, which is the name DailyMed lists) and `GLUCOPHAGE` to
 * 151827, and it answers null for a name it does not hold rather than guessing
 * at the nearest product.
 */
export async function fetchRxNormCode(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url = `https://rxnav.nlm.nih.gov/REST/rxcui.json?${new URLSearchParams({
    name,
  }).toString()}`;

  const body = await getJson(url, fetchImpl);

  const ids = isRecord(body) && isRecord(body.idGroup) ? body.idGroup.rxnormId : null;
  if (!Array.isArray(ids)) return null;

  // A list because RxNorm can hold duplicate names. The first is RxNav's own
  // preference order; anything else would be this app inventing a tie-break.
  const [first] = ids;
  if (typeof first !== "string") return null;

  // Validated here as well as in the action, because this value is about to be
  // written into a form field that the action must treat as user-controlled.
  return /^\d{1,8}$/.test(first) ? first : null;
}

/**
 * An upstream fault is the caller's problem to route around, not a crash: 504
 * when the service timed out, 502 when it answered with something we could not
 * use. The client treats both as "no suggestions", so the status exists for
 * logs and for anything watching this endpoint, not for the pharmacist.
 *
 * Anything that is NOT a `DrugUpstreamError` is rethrown, so a bug in this app
 * surfaces as a 500 with a stack instead of being disguised as someone else's
 * outage. It lives here rather than in the routes because a route file may only
 * export its HTTP methods.
 */
export function upstreamFailureResponse(err: unknown): Response {
  if (!(err instanceof DrugUpstreamError)) throw err;

  return Response.json(
    { ok: false, error: err.kind },
    { status: err.kind === "UPSTREAM_TIMEOUT" ? 504 : 502 },
  );
}
