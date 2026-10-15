import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with Node's own scrypt.
 *
 * Deliberately not argon2 or bcrypt: both are native addons, and this project
 * keeps `npm install` free of a C++ toolchain on Windows dev machines. scrypt
 * is memory-hard and in the standard library, which is the right trade here.
 */

/** Recorded on `User.passwordAlgo`. The parameters live in the hash itself. */
export const PASSWORD_ALGO = "scrypt";

/**
 * N=2^17, r=8, p=1 — about 128 MiB and half a second per hash. Enough to make
 * an offline dictionary attack expensive, cheap enough that a pharmacist
 * logging in at 8am does not notice it.
 */
const PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * scrypt needs 128 * N * r bytes = 128 MiB here; Node's default cap is 32 MiB,
 * so this must be raised or every hash throws.
 */
const MAX_MEM = 256 * 1024 * 1024;

type ScryptParams = { N: number; r: number; p: number };

/**
 * `scrypt$N=131072,r=8,p=1$<salt-b64>$<hash-b64>`
 *
 * Self-describing so the cost can be raised later without locking anyone out:
 * verification reads the parameters from the stored string, and `needsRehash`
 * tells the login path when to transparently upgrade an old row.
 */
function encode(params: ScryptParams, salt: Buffer, key: Buffer): string {
  return [
    PASSWORD_ALGO,
    `N=${params.N},r=${params.r},p=${params.p}`,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

type Decoded = { params: ScryptParams; salt: Buffer; key: Buffer };

function decode(stored: string): Decoded | null {
  const parts = stored.split("$");
  if (parts.length !== 4) return null;

  const [algo, paramString, saltB64, keyB64] = parts;
  if (algo !== PASSWORD_ALGO) return null;

  const params: Record<string, number> = {};
  for (const pair of paramString.split(",")) {
    const [name, value] = pair.split("=");
    const parsed = Number(value);
    // A partial or non-numeric parameter set is a corrupt row, not something
    // to guess defaults for — guessing would silently weaken the hash.
    if (!name || !Number.isInteger(parsed) || parsed <= 0) return null;
    params[name] = parsed;
  }

  if (!params.N || !params.r || !params.p) return null;

  const salt = Buffer.from(saltB64, "base64");
  const key = Buffer.from(keyB64, "base64");
  if (salt.length === 0 || key.length === 0) return null;

  return { params: { N: params.N, r: params.r, p: params.p }, salt, key };
}

/**
 * Wrapped by hand rather than with `promisify`: scrypt is overloaded, and the
 * promisified type drops the options argument — which is where `N`, `r`, `p`
 * and the raised `maxmem` live.
 */
function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      // NFKC so a password typed on a different keyboard layout still matches;
      // without it, a full-width character or a combining mark changes the bytes.
      password.normalize("NFKC"),
      salt,
      KEY_BYTES,
      { ...params, maxmem: MAX_MEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  return encode(PARAMS, salt, await derive(password, salt, PARAMS));
}

/**
 * False for anything unparseable. A corrupt or truncated hash must read as
 * "this password does not match", never as an exception the login route would
 * have to handle — and never as a match.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const decoded = decode(stored);
  if (!decoded) return false;

  const candidate = await derive(password, decoded.salt, decoded.params);

  // Lengths are equal by construction (both KEY_BYTES), but timingSafeEqual
  // throws on a mismatch, so a corrupt row must not reach it.
  if (candidate.length !== decoded.key.length) return false;

  return timingSafeEqual(candidate, decoded.key);
}

/**
 * True when `stored` was produced with parameters weaker than the current
 * ones — the caller rehashes with the just-verified plaintext and updates the
 * row. Any hash we cannot parse is also rehashed, which is how a corrupt row
 * gets repaired.
 */
export function needsRehash(stored: string): boolean {
  const decoded = decode(stored);
  if (!decoded) return true;
  return (
    decoded.params.N !== PARAMS.N ||
    decoded.params.r !== PARAMS.r ||
    decoded.params.p !== PARAMS.p
  );
}
