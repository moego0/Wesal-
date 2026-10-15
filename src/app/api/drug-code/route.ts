import { cacheLife, cacheTag } from "next/cache";
import type { NextRequest } from "next/server";
import { requireApiSession } from "@/server/auth/current-user";
import { fetchRxNormCode, upstreamFailureResponse } from "@/server/medications/drug-names";

/**
 * The RxCUI for a name the pharmacist just picked from the suggestion list.
 *
 * A second endpoint rather than a field on the first, because the two calls
 * happen at different moments: suggestions are per keystroke, a code is once
 * per selection. Folding this into `/api/drug-names` would mean one RxNorm
 * request per suggestion per keystroke.
 *
 * Nothing here is required for a save. The code is optional metadata, so every
 * failure below resolves to "no code" and the medication is still stored with
 * the name the pharmacist chose.
 */

/** A name shorter than this is not something DailyMed would have offered. */
const MIN_NAME = 3;

/** Matches `NAME_MAX` in `src/server/medications/actions.ts`. */
const MAX_NAME = 160;

/** Same refusal as `/api/drug-names`; see the comment there. */
const UNSAFE_NAME = /[\u0000-\u001F\u007F‎‏‪-‮]/;

export async function GET(req: NextRequest) {
  const access = await requireApiSession("medication:write");
  if (access.response) return access.response;

  const name = (req.nextUrl.searchParams.get("name") ?? "").trim();

  if (name.length < MIN_NAME || name.length > MAX_NAME || UNSAFE_NAME.test(name)) {
    return Response.json({ ok: false, error: "INVALID_NAME" }, { status: 400 });
  }

  try {
    // `code: null` is a 200. RxNorm not holding a name is ordinary — it answers
    // null for `AMOXICILLIN AND CLAVULANATE POTASSIUM`, which DailyMed lists —
    // and storing no code is the correct outcome, not an error to show anyone.
    return Response.json({ ok: true, name, code: await cachedDrugCode(name) });
  } catch (err) {
    return upstreamFailureResponse(err);
  }
}

/**
 * Keyed on the exact name, so one entry per drug actually picked. See the
 * longer note in `/api/drug-names` for why the `use cache` directive is on this
 * helper rather than on the export, and why the session check stays outside.
 */
async function cachedDrugCode(name: string): Promise<string | null> {
  "use cache";
  cacheLife("days");
  cacheTag("drug-catalog");

  return fetchRxNormCode(name);
}
