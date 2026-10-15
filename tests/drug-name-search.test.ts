import { describe, expect, it } from "vitest";

import { rankDrugNames, type DailyMedRow } from "@/lib/drug-name-search";
import {
  DrugUpstreamError,
  fetchDailyMedNames,
  fetchRxNormCode,
  upstreamFailureResponse,
} from "@/server/medications/drug-names";

/**
 * The drug-name picker's two halves, neither of which touches the network here.
 *
 * WHY THIS FILE IS MOSTLY ABOUT ORDERING. DailyMed's `drugnames` service matches
 * on substring and returns rows ALPHABETICALLY — it has no relevance signal at
 * all. The fixtures below are shaped after what the live service actually
 * returns, and they are the whole reason `rankDrugNames` exists: `omeprazol`
 * genuinely reaches `OMEPRAZOLE` at index 68 of 100, behind two dozen `24 HOUR`
 * and combination products. If the ranking regresses, the picker does not merely
 * get worse — it becomes a list a pharmacist has to scroll, which is slower than
 * the text box it replaced, and the failure is invisible in every unit test that
 * only checks the fetch.
 *
 * No live call is made anywhere in this file. Both upstream clients take an
 * injectable `fetchImpl` (the precedent is `messaging/providers/whatsapp-cloud.ts`),
 * which is what lets the page size, the timeout and the error taxonomy be
 * asserted rather than hoped for.
 */

/** One row per name, `G` for a generic and `B` for a brand. */
function rows(...entries: [string, "G" | "B"][]): DailyMedRow[] {
  return entries.map(([drug_name, name_type]) => ({ drug_name, name_type }));
}

function names(suggestions: { name: string }[]): string[] {
  return suggestions.map((suggestion) => suggestion.name);
}

function indexOf(suggestions: { name: string }[], name: string): number {
  return names(suggestions).indexOf(name);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("ranking drug names", () => {
  it("puts the plain ingredient above every combination product for metformin", () => {
    /*
     * The verified shape of the live response: DailyMed returns 60 rows for
     * `metformin`, and the alphabetical order leads with the combinations —
     * `ALOGLIPTIN AND METFORMIN HYDROCHLORIDE` before `METFORMIN` itself. Shown
     * as-is, the first thing a pharmacist sees is a drug they did not ask for.
     */
    const suggestions = rankDrugNames(
      rows(
        ["ALOGLIPTIN AND METFORMIN HYDROCHLORIDE", "B"],
        ["CANAGLIFLOZIN AND METFORMIN HYDROCHLORIDE", "B"],
        ["METFORMIN AND SITAGLIPTIN", "B"],
        ["METFORMIN HYDROCHLORIDE", "G"],
        ["METFORMIN", "G"],
        ["METFORMIN HYDROCHLORIDE AND PIOGLITAZONE", "B"],
      ),
      "metformin",
    );

    expect(names(suggestions)).toEqual([
      "METFORMIN",
      "METFORMIN HYDROCHLORIDE",
      "METFORMIN AND SITAGLIPTIN",
      "METFORMIN HYDROCHLORIDE AND PIOGLITAZONE",
      "ALOGLIPTIN AND METFORMIN HYDROCHLORIDE",
      "CANAGLIFLOZIN AND METFORMIN HYDROCHLORIDE",
    ]);

    // The property, not just this ordering: no combination may outrank either
    // single-ingredient name. `METFORMIN HYDROCHLORIDE AND PIOGLITAZONE` still
    // outranks the two `ALOGLIPTIN`-led rows below it, and that is the ranking
    // working — it begins with the word that was typed.
    const bestCombination = names(suggestions).findIndex((name) => name.includes(" AND "));
    expect(bestCombination).toBeGreaterThan(indexOf(suggestions, "METFORMIN"));
    expect(bestCombination).toBeGreaterThan(indexOf(suggestions, "METFORMIN HYDROCHLORIDE"));
  });

  it("puts OMEPRAZOLE above the 24-hour and esomeprazole rows that precede it alphabetically", () => {
    // `omeprazol` is the case that proves the ranking is load-bearing: the
    // ingredient is not merely low in DailyMed's order, it is off the first
    // screen entirely.
    const suggestions = rankDrugNames(
      rows(
        ["24 HOUR ESOMEPRAZOLE MAGNESIUM", "B"],
        ["24 HOUR OMEPRAZOLE", "B"],
        ["ESOMEPRAZOLE MAGNESIUM", "G"],
        ["OMEPRAZOLE MAGNESIUM", "G"],
        ["OMEPRAZOLE", "G"],
      ),
      "omeprazol",
    );

    expect(names(suggestions)[0]).toBe("OMEPRAZOLE");
    expect(indexOf(suggestions, "OMEPRAZOLE")).toBeLessThan(
      indexOf(suggestions, "OMEPRAZOLE MAGNESIUM"),
    );
    expect(indexOf(suggestions, "OMEPRAZOLE")).toBeLessThan(
      indexOf(suggestions, "24 HOUR OMEPRAZOLE"),
    );
  });

  it("prefers the name other products are variants of when two matches are equal", () => {
    /*
     * `atorva` is a tie the generic flag does NOT break, and this fixture is the
     * live shape, types included: DailyMed tags `ATORVALIQ` as a GENERIC, so both
     * candidates are `G`, both score 580, and the tie falls through to length —
     * which hands over `ATORVALIQ`, the shorter string, to a pharmacist who
     * typed the first six letters of `ATORVASTATIN`.
     *
     * An earlier version of this test declared `ATORVALIQ` a brand and passed,
     * while the live service put it first. The measurement is now in the fixture.
     *
     * The separator that does work: `ATORVASTATIN` is the stem of several other
     * names in the payload and `ATORVALIQ` is the stem of nothing.
     */
    const suggestions = rankDrugNames(
      rows(
        ["ATORVALIQ", "G"],
        ["ATORVASTATIN", "G"],
        ["ATORVASTATIN CALCIUM", "G"],
        ["ATORVASTATIN FILM COATED", "G"],
        ["ATORVASTATIN CALCIUM TABLETS", "G"],
      ),
      "atorva",
    );

    expect(names(suggestions)[0]).toBe("ATORVASTATIN");
    expect(indexOf(suggestions, "ATORVASTATIN")).toBeLessThan(indexOf(suggestions, "ATORVALIQ"));
  });

  it("treats a slashed name as the combination it is", () => {
    // DailyMed writes these with NO spaces around the slash — the live payload
    // returns `OMEPRAZOLE/BICARBONATE` and `AMOXICILLIN CLAV/POT`. A joiner list
    // that only knew `" / "` scored the combination exactly the same as the
    // plain ingredient, leaving their order to whatever the length tie-break
    // happened to do with them.
    const suggestions = rankDrugNames(
      rows(
        ["OMEPRAZOLE", "G"],
        ["OMEPRAZOLE/BICARBONATE", "B"],
        ["OMEPRAZOLE/SODIIUM BICARBONATE", "G"],
      ),
      "omeprazol",
    );

    expect(names(suggestions)[0]).toBe("OMEPRAZOLE");
    expect(indexOf(suggestions, "OMEPRAZOLE/BICARBONATE")).toBeGreaterThan(
      indexOf(suggestions, "OMEPRAZOLE"),
    );
  });

  it("returns one row for a name DailyMed lists as both a generic and a brand", () => {
    // The live service really does emit two consecutive rows with the same name
    // and different types. Without the dedupe, a third of the dropdown is the
    // same drug printed twice.
    const suggestions = rankDrugNames(
      rows(["ALOGLIPTIN AND METFORMIN HYDROCHLORIDE", "B"], ["ALOGLIPTIN AND METFORMIN HYDROCHLORIDE", "G"]),
      "alogliptin",
    );

    expect(suggestions).toHaveLength(1);
    // The merged label, so the generic survives the collapse.
    expect(suggestions[0]).toEqual({
      name: "ALOGLIPTIN AND METFORMIN HYDROCHLORIDE",
      nameType: "G",
    });
  });

  it("keeps a brand-only name as a brand", () => {
    // A naive `filter(name_type === "G")` would drop this drug from the list
    // entirely — and it is one a pharmacist might well be typing.
    const suggestions = rankDrugNames(rows(["GLUCOPHAGE", "B"]), "glucophage");

    expect(suggestions).toEqual([{ name: "GLUCOPHAGE", nameType: "B" }]);
  });

  it("does not treat an honest two-word ingredient as a combination", () => {
    // The combination penalty keys on DailyMed's joiners, not on word count: a
    // word count would sink `INSULIN LISPRO` and `INSULIN GLARGINE`, which are
    // single ingredients and among the most-prescribed drugs there are.
    const suggestions = rankDrugNames(
      rows(
        ["INSULIN LISPRO AND INSULIN GLARGINE", "B"],
        ["INSULIN LISPRO", "G"],
        ["INSULIN", "G"],
      ),
      "insulin",
    );

    expect(names(suggestions)).toEqual([
      "INSULIN",
      "INSULIN LISPRO",
      "INSULIN LISPRO AND INSULIN GLARGINE",
    ]);
  });

  it("ranks a leading-punctuation name as the substring match it is", () => {
    /*
     * DailyMed returns rows like `.INSULIN ASPART` and `1.85% HYDROCORTISONE
     * ACETATE …`. Stripping the leading punctuation as a tidy-up step would
     * promote them to prefix matches and put a malformed-looking entry at the
     * top of the list, above the drug whose exact name was typed.
     */
    const suggestions = rankDrugNames(
      rows([".INSULIN ASPART", "B"], ["INSULIN ASPART", "G"]),
      "insulin aspart",
    );

    expect(names(suggestions)).toEqual(["INSULIN ASPART", ".INSULIN ASPART"]);
  });

  it("normalizes the query and the rows before comparing", () => {
    // Raw literals rather than `rows()`: the ragged whitespace and the lowercase
    // type are exactly what the helper's types would refuse to carry.
    const suggestions = rankDrugNames(
      [{ drug_name: "  metformin   hydrochloride ", name_type: "g" }],
      "  METFORMIN ",
    );

    // Lowercase type, ragged whitespace, padded query: one normalized row, and
    // what comes back is the normalized name — the string the form stores.
    expect(suggestions).toEqual([{ name: "METFORMIN HYDROCHLORIDE", nameType: "G" }]);
  });

  it("skips rows it cannot use, rather than showing a blank option", () => {
    const suggestions = rankDrugNames(
      [
        { drug_name: null, name_type: "G" },
        { drug_name: "   ", name_type: "G" },
        { drug_name: "METFORMIN", name_type: "G" },
        { drug_name: "METFORMIN HYDROCHLORIDE", name_type: null },
        { drug_name: "METFORMIN HYDROCHLORIDE", name_type: "S" },
        {},
        { drug_name: "METFORMIN TABLET" },
      ],
      "metformin",
    );

    expect(names(suggestions)).toEqual(["METFORMIN"]);
  });

  it("honours the limit and returns nothing for a query that matches nothing", () => {
    const many = rows(
      ["METFORMIN", "G"],
      ["METFORMIN HYDROCHLORIDE", "G"],
      ["METFORMIN ER", "G"],
      ["METFORMIN TABLET", "G"],
    );

    expect(rankDrugNames(many, "metformin", 2)).toHaveLength(2);
    expect(rankDrugNames(many, "metformin")).toHaveLength(4);
    expect(rankDrugNames(many, "atorvastatin")).toEqual([]);
    expect(rankDrugNames(many, "")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake `fetch` that records what it was asked for and answers with a fixture. */
function recordingFetch(respond: (url: string) => Promise<Response>) {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    inits.push(init);
    return respond(url);
  }) as typeof fetch;

  return { fetchImpl, urls, inits };
}

describe("the DailyMed name lookup", () => {
  it("asks for the whole match set, which is what makes the ranking possible", async () => {
    const { fetchImpl, urls, inits } = recordingFetch(async () =>
      jsonResponse({ data: [{ drug_name: "METFORMIN", name_type: "G" }] }),
    );

    const result = await fetchDailyMedNames("metformin", fetchImpl);

    expect(result).toEqual([{ drug_name: "METFORMIN", name_type: "G" }]);

    const url = new URL(urls[0]);
    expect(url.origin + url.pathname).toBe(
      "https://dailymed.nlm.nih.gov/dailymed/services/v2/drugnames.json",
    );
    expect(url.searchParams.get("drug_name")).toBe("metformin");
    /*
     * 100 is DailyMed's documented maximum, and it is a CORRECTNESS constraint
     * rather than a performance choice: `omeprazol` reaches its best match at
     * index 68, so a smaller page would not contain `OMEPRAZOLE` at all and no
     * amount of local ranking could recover a row that was never fetched.
     */
    expect(url.searchParams.get("pagesize")).toBe("100");
    expect(url.searchParams.get("page")).toBe("1");

    // The request is bounded, and identifies who is calling.
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    expect((inits[0]?.headers as Record<string, string>)["user-agent"]).toContain("WASALH");
  });

  it("survives a response with no data array", async () => {
    const { fetchImpl } = recordingFetch(async () => jsonResponse({ error: "nope" }));

    await expect(fetchDailyMedNames("metformin", fetchImpl)).rejects.toMatchObject({
      kind: "UPSTREAM_ERROR",
    });
  });

  it("classifies a non-ok response as an upstream fault, not a timeout", async () => {
    const { fetchImpl } = recordingFetch(async () => jsonResponse({}, 503));

    await expect(fetchDailyMedNames("metformin", fetchImpl)).rejects.toBeInstanceOf(
      DrugUpstreamError,
    );
    await expect(fetchDailyMedNames("metformin", fetchImpl)).rejects.toMatchObject({
      kind: "UPSTREAM_ERROR",
    });
  });

  it("classifies an aborted request as a timeout", async () => {
    // What `AbortSignal.timeout` actually produces when the 3s bound elapses.
    const { fetchImpl } = recordingFetch(async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    });

    await expect(fetchDailyMedNames("metformin", fetchImpl)).rejects.toMatchObject({
      kind: "UPSTREAM_TIMEOUT",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the RxNorm code lookup", () => {
  it("returns the first RxCUI for an exact name", async () => {
    const { fetchImpl, urls } = recordingFetch(async () =>
      jsonResponse({ idGroup: { name: "METFORMIN", rxnormId: ["6809"] } }),
    );

    expect(await fetchRxNormCode("METFORMIN", fetchImpl)).toBe("6809");

    // `rxcui.json`, not `drugs.json`: the latter returns only product-level
    // concepts and answers a plain ingredient with a combination product's code.
    expect(new URL(urls[0]).pathname).toBe("/REST/rxcui.json");
    expect(new URL(urls[0]).searchParams.get("name")).toBe("METFORMIN");
  });

  it("answers null when RxNorm does not hold the name", async () => {
    // The ordinary case, not an error: RxNorm has no exact match for
    // `AMOXICILLIN AND CLAVULANATE POTASSIUM`, which DailyMed does list. Storing
    // no code is the correct outcome.
    const { fetchImpl } = recordingFetch(async () => jsonResponse({ idGroup: {} }));

    expect(await fetchRxNormCode("AMOXICILLIN AND CLAVULANATE POTASSIUM", fetchImpl)).toBeNull();
  });

  it("refuses anything that is not a numeric id", async () => {
    // This value is about to be written into a form field, so it is validated
    // here as well as in the action that reads it back.
    const { fetchImpl } = recordingFetch(async () =>
      jsonResponse({ idGroup: { rxnormId: ["<script>"] } }),
    );

    expect(await fetchRxNormCode("METFORMIN", fetchImpl)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("mapping an upstream fault to a status", () => {
  it("is 504 for a timeout and 502 for anything else", async () => {
    const timeout = upstreamFailureResponse(
      new DrugUpstreamError("UPSTREAM_TIMEOUT", "too slow"),
    );
    expect(timeout.status).toBe(504);

    const failed = upstreamFailureResponse(new DrugUpstreamError("UPSTREAM_ERROR", "bad body"));
    expect(failed.status).toBe(502);

    // Both are the same thing to the pharmacist — no suggestions, keep typing —
    // so the status is for logs and for anything watching the endpoint.
    expect(await failed.json()).toEqual({ ok: false, error: "UPSTREAM_ERROR" });
  });

  it("rethrows a bug in this app instead of disguising it as an outage", () => {
    // A TypeError from our own code must surface as a 500 with a stack, not as
    // someone else's 502.
    expect(() => upstreamFailureResponse(new TypeError("ours"))).toThrow("ours");
  });
});
