import { describe, expect, it } from "vitest";
import {
  AlertStatus,
  CaseOrigin,
  CaseStatus,
  ConsentCaptureMethod,
  ConsentType,
  DeliveryState,
  PatientStatus,
  Priority,
  ResponseState,
  Severity,
  VerificationState,
} from "@/generated/prisma/enums";
import { enumKey } from "@/components/status";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";

/**
 * Translation coverage.
 *
 * A missing translation does not throw. next-intl renders the key path itself,
 * so a pharmacist sees `enums.delivery.EXPIRED` sitting in a status column — a
 * defect that survives review because nobody reads the Arabic column closely
 * enough to notice a Latin string, and that only ever appears for the enum
 * values that happen to be rare.
 *
 * `src/components/status.tsx` builds its keys through `enumKey`, so every value
 * of every enum it renders is derivable here and every one can be asserted.
 */

const catalogs = { ar, en } as const;
type Catalog = Record<string, unknown>;

/** Walk a dotted path, returning undefined rather than throwing. */
function resolve(catalog: Catalog, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      catalog,
    );
}

/** Every leaf path in a catalog, dotted. */
function leafPaths(catalog: Catalog, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object" && !Array.isArray(value)
      ? leafPaths(value as Catalog, path)
      : [path];
  });
}

const ENUM_CASES = [
  { name: "DeliveryState", values: Object.values(DeliveryState), key: enumKey.delivery },
  { name: "ResponseState", values: Object.values(ResponseState), key: enumKey.response },
  { name: "Severity", values: Object.values(Severity), key: enumKey.severity },
  { name: "CaseStatus", values: Object.values(CaseStatus), key: enumKey.caseStatus },
  { name: "AlertStatus", values: Object.values(AlertStatus), key: enumKey.alertStatus },
  { name: "PatientStatus", values: Object.values(PatientStatus), key: enumKey.patientStatus },
  {
    name: "VerificationState",
    values: Object.values(VerificationState),
    key: enumKey.verification,
  },
  {
    name: "CaseOrigin",
    values: Object.values(CaseOrigin),
    key: enumKey.caseOrigin,
  },
  {
    name: "ConsentType",
    values: Object.values(ConsentType),
    key: enumKey.consentType,
  },
  {
    name: "ConsentCaptureMethod",
    values: Object.values(ConsentCaptureMethod),
    key: enumKey.captureMethod,
  },
  // Points at the same catalog keys as Severity — see `enumKey.priority`. Listed
  // as its own case so a value added to Priority alone still fails here.
  {
    name: "Priority",
    values: Object.values(Priority),
    key: enumKey.priority,
  },
] as const;

describe("every enum value a screen can render is translated", () => {
  for (const { name, values, key } of ENUM_CASES) {
    it(`${name} resolves in both catalogs`, () => {
      expect(values.length).toBeGreaterThan(0);

      const missing: string[] = [];

      for (const value of values) {
        const path = `enums.${key(value as never)}`;

        for (const [locale, catalog] of Object.entries(catalogs)) {
          const text = resolve(catalog as Catalog, path);
          if (typeof text !== "string" || text.trim() === "") {
            missing.push(`${locale}: ${path}`);
          }
        }
      }

      expect(missing).toEqual([]);
    });
  }
});

describe("the catalogs do not drift apart", () => {
  it("every Arabic key exists in English", () => {
    const enPaths = new Set(leafPaths(en as Catalog));
    const missing = leafPaths(ar as Catalog).filter((p) => !enPaths.has(p));
    expect(missing).toEqual([]);
  });

  it("every English key exists in Arabic", () => {
    const arPaths = new Set(leafPaths(ar as Catalog));
    const missing = leafPaths(en as Catalog).filter((p) => !arPaths.has(p));
    expect(missing).toEqual([]);
  });

  /**
   * A hole this catches and the path check above does not: next-intl falls back
   * to the key path when a string is EMPTY, so an entry of "" renders exactly as
   * badly as a missing one while satisfying every structural check.
   */
  it("has no empty strings in either catalog", () => {
    const empty: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const path of leafPaths(catalog as Catalog)) {
        const text = resolve(catalog as Catalog, path);
        if (typeof text === "string" && text.trim() === "") empty.push(`${locale}: ${path}`);
      }
    }

    expect(empty).toEqual([]);
  });
});

describe("Arabic copy is actually Arabic", () => {
  /**
   * The failure this exists for: a new key added to `en.json`, copied to
   * `ar.json` to satisfy the structural check, and the English left in place. It
   * passes every test above and puts English text in the Arabic interface.
   *
   * Only applied to the `enums` and `common` namespaces — the locale switcher
   * legitimately holds the Latin string "English", and future proper nouns would
   * trip a repo-wide rule.
   */
  it("contains Arabic script in the namespaces a pharmacist reads", () => {
    const ARABIC = /[؀-ۿ]/;
    const offenders: string[] = [];

    for (const namespace of ["enums", "common", "nav", "roles"]) {
      const node = (ar as Catalog)[namespace];
      if (!node) continue;

      for (const path of leafPaths(node as Catalog)) {
        const text = resolve(node as Catalog, path);
        if (typeof text === "string" && !ARABIC.test(text)) {
          offenders.push(`${namespace}.${path} = ${JSON.stringify(text)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
