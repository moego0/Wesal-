import "dotenv/config";

import { describe, expect, it } from "vitest";
import { classifyFreeText } from "@/server/responses/attribute";

/**
 * Free-text classification.
 *
 * The classifier is a keyword matcher, and the ordering of its branches is
 * load-bearing. The first version tested the affirmative keyword before the
 * negated forms that contain it — "مخدتش" and "مش خدت" both contain "خدت" — so
 * a patient reporting a missed dose was classified as having taken it. That is
 * the worst direction for this to be wrong in: it writes a false "taken" into
 * the adherence record and suppresses the follow-up a pharmacist would
 * otherwise make.
 *
 * The normalisation cases matter for the same reason. Free text is the noisiest
 * input in the system, so the free-text path must not be stricter than the
 * button-label path about what counts as the same sentence.
 */
describe("classifyFreeText", () => {
  it.each([
    // Negation must beat the affirmative keyword it contains.
    ["مش خدت الدوا", "MISSED"],
    ["مش اخدت الدوا", "MISSED"],
    ["ما خدت الدوا", "MISSED"],
    ["مخدتش الدوا", "MISSED"],
    ["لسه مخدتش", "MISSED"],
    ["I didn't take it", "MISSED"],
    ["not taken yet", "MISSED"],

    // Plain affirmatives are unaffected.
    ["خدت الدوا", "TAKEN"],
    ["أخدت الدواء", "TAKEN"],
    ["تناولت الدواء", "TAKEN"],
    ["took it", "TAKEN"],

    // Diacritics and tatweel no longer fall through to OTHER.
    ["خَدت الدوا", "TAKEN"],
    ["خــدت الدوا", "TAKEN"],

    // The other intents keep priority over both branches.
    ["مش عايز الدوا", "STOP"],
    ["اوقف الرسائل", "STOP"],
    ["عندي دوخة", "PROBLEM"],
    ["مش موجود في الصيدلية", "REFILL"],
    ["فكرني بعد شوية", "REMIND_LATER"],

    // Genuinely unclassified, and the empty case.
    ["", "OTHER"],
    ["شكرا", "OTHER"],
  ])("%s → %s", (text, expected) => {
    expect(classifyFreeText(text)).toBe(expected);
  });

  it("does not score a negated reply as taken", () => {
    // Asserted separately so that a future reordering of the keyword branches
    // fails loudly here rather than silently in production.
    for (const text of ["مش خدت", "مخدتش", "لسه مخدتش", "ما خدت", "not taken"]) {
      expect(classifyFreeText(text)).toBe("MISSED");
    }
  });
});
