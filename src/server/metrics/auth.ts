import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Bearer-token check for the metrics endpoint.
 *
 * Two details here are load-bearing.
 *
 * ## 1. Hash before comparing
 *
 * `timingSafeEqual` THROWS when its two buffers differ in length, and it throws
 * before comparing anything. A naive implementation therefore answers in two
 * distinguishable ways — a 500 for a guess of the wrong length, a 401 for one of
 * the right length — which hands an attacker the token's length for free, and
 * turns the endpoint into an oracle they can drive. Hashing both sides first
 * makes every comparison one between two 32-byte digests, so there is no length
 * to leak and no length-dependent branch.
 *
 * SHA-256 rather than a password KDF, for the same reason `hashSessionToken`
 * uses it: the input is a high-entropy random token with no guessable structure,
 * so there is nothing a deliberately slow hash would protect.
 *
 * ## 2. Unconfigured is not open
 *
 * An empty `expected` returns false. The endpoint answers 404 in that case (see
 * the route), so a deployment that never set `METRICS_TOKEN` has no metrics
 * endpoint rather than a public one. It must also be impossible to satisfy the
 * check by presenting an empty token, which is why the empty-string case is
 * rejected explicitly rather than falling out of the comparison.
 */

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time equality for two secrets of any length. */
function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * True only for `Authorization: Bearer <expected>`, with `expected` non-empty.
 *
 * Pure and synchronous, so it is testable without a request, a registry or a
 * database.
 */
export function checkBearerToken(
  header: string | null | undefined,
  expected: string,
): boolean {
  if (!expected) return false;
  if (!header) return false;

  // Case-sensitive on the scheme, and requiring the space. Both are what RFC
  // 6750 specifies, and both reject the near-misses (`Basic …`, a bare
  // `Bearer` with no token) that would otherwise reach the comparison.
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const presented = header.slice(prefix.length).trim();
  if (presented === "") return false;

  return secretsMatch(presented, expected);
}
