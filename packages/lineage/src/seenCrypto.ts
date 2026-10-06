import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { Finding } from "@loom-ui/core";

// ── Per-viewer data keys for the record of what a viewer saw (U12) ─────────────────────────────
// WHY THIS IS HERE AND NOT `@loom/plugin-crypto`'s `shredSubject`: loom's shredder refuses the
// reserved `__loom_*` streams (a logged loom follow-up), and a seen log has to live in one. What IS
// reused is the SHAPE of loom's `KeyStore` (getOrCreate / get / destroy, destroy = the erasure
// primitive, never resurrected): a host's existing KMS-backed `KeyStore` satisfies `SeenKeyStore`
// structurally and can be passed as is. What is NOT reused is `encryptValue`: it has no associated
// data, and this design needs the ciphertext bound to (experience, viewer, record, entry) so a ref
// cannot be transplanted. So the primitive (AES-256-GCM, node:crypto, as loom's) is local.

/**
 * Key material for one (experience, viewer) subject. Destroying a key is the erasure primitive, so a
 * production store must really delete it (KMS/HSM), and `durable: false` stores lose every viewer's
 * record on restart (indistinguishable from erasure).
 */
export interface SeenKeyStore {
  /** The subject's 32-byte key, created on first use. MUST reject for a destroyed subject (never resurrect). */
  getOrCreate(subjectId: string): Promise<Uint8Array>;
  /** The key, or `null` if it never existed OR was destroyed. */
  get(subjectId: string): Promise<Uint8Array | null>;
  /** Irreversibly destroy the key. Idempotent; a no-op for an absent subject (which stays destroyed). */
  destroy(subjectId: string): Promise<void>;
  readonly durable?: boolean;
}

/** Reference in-memory key store (tests / ephemeral apps): NOT durable. */
export class InMemorySeenKeyStore implements SeenKeyStore {
  readonly durable = false;
  private readonly keys = new Map<string, Uint8Array>();
  private readonly destroyed = new Set<string>();

  async getOrCreate(subjectId: string): Promise<Uint8Array> {
    if (this.destroyed.has(subjectId))
      throw new Error(`the key for "${subjectId}" was destroyed; it cannot be recreated`);
    let key = this.keys.get(subjectId);
    if (key === undefined) {
      key = new Uint8Array(randomBytes(32));
      this.keys.set(subjectId, key);
    }
    return key;
  }
  async get(subjectId: string): Promise<Uint8Array | null> {
    return this.keys.get(subjectId) ?? null;
  }
  async destroy(subjectId: string): Promise<void> {
    this.keys.delete(subjectId);
    this.destroyed.add(subjectId);
  }
}

/** The subject (unit of erasure) of a stream key. */
export const seenKeySubject = (streamKey: string): string => `loom-ui/seen/${streamKey}`;

export interface DerivedSeenKeys {
  readonly enc: Buffer;
  readonly mac: Buffer;
}

/** Separate encryption and MAC keys from the stored data key (HKDF-SHA256). Throws on a malformed key. */
export function deriveSeenKeys(master: Uint8Array): DerivedSeenKeys {
  if (!(master instanceof Uint8Array) || master.length !== 32)
    throw new Error("a seen data key must be 32 bytes");
  const d = (info: string) =>
    Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `loom-ui/seen/${info}/v1`, 32));
  return { enc: d("enc"), mac: d("mac") };
}

/** The associated data a sealed ref is bound to. */
export const refAad = (
  experienceId: string,
  viewerId: string,
  sequence: number,
  entryIndex: number
): Buffer =>
  Buffer.from(
    JSON.stringify(["loom-ui/seen/ref/v1", experienceId, viewerId, sequence, entryIndex])
  );

/** AES-256-GCM: `base64url(0x01 | iv | ciphertext | tag)`. A fresh random IV per call. */
export function sealText(enc: Buffer, aad: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", enc, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf-8")), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, ct, c.getAuthTag()]).toString("base64url");
}

/** The plaintext, or `undefined` for ANY failure (wrong key, wrong AAD, tampering, malformed): fail closed. */
export function openText(enc: Buffer, aad: Buffer, sealed: unknown): string | undefined {
  try {
    if (typeof sealed !== "string") return undefined;
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 1 + 12 + 16 || raw[0] !== 1) return undefined;
    const d = createDecipheriv("aes-256-gcm", enc, raw.subarray(1, 13));
    d.setAAD(aad);
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(13, raw.length - 16)), d.final()]).toString(
      "utf-8"
    );
  } catch {
    return undefined;
  }
}

/** Keyed digest: an unkeyed hash of a manifest would let anyone confirm a guessed value. */
export const keyedDigest = (mac: Buffer, text: string): string =>
  `hmac:${createHmac("sha256", mac).update(text).digest("hex")}`;

/** The `SeenKeyStore` conformance kit: findings (a test asserts none), never throws. */
export async function checkSeenKeyStoreConformance(
  make: () => SeenKeyStore | Promise<SeenKeyStore>
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fail = (code: string, message: string) =>
    findings.push({ code, severity: "error", message });
  const store = await make();
  const same = (a: Uint8Array | null, b: Uint8Array | null) =>
    a !== null && b !== null && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
  const cases: Array<[string, () => Promise<void>]> = [
    [
      "an unknown subject has no key",
      async () => {
        if ((await store.get("k-none")) !== null)
          fail("get-unknown", "get of an unknown subject was not null");
      },
    ],
    [
      "getOrCreate yields a stable 32-byte key",
      async () => {
        const a = await store.getOrCreate("k-a");
        if (a.length !== 32) fail("key-length", `a key is ${a.length} bytes, not 32`);
        if (!same(a, await store.getOrCreate("k-a")) || !same(a, await store.get("k-a")))
          fail("key-stable", "getOrCreate/get did not return one key for one subject");
      },
    ],
    [
      "subjects get independent keys",
      async () => {
        if (same(await store.getOrCreate("k-1"), await store.getOrCreate("k-2")))
          fail("key-distinct", "two subjects share a key");
      },
    ],
    [
      "destroy erases and never resurrects",
      async () => {
        await store.getOrCreate("k-d");
        await store.destroy("k-d");
        if ((await store.get("k-d")) !== null)
          fail("destroy-get", "get after destroy was not null");
        let recreated = false;
        try {
          await store.getOrCreate("k-d");
          recreated = true;
        } catch {
          /* required */
        }
        if (recreated) fail("destroy-resurrect", "getOrCreate after destroy created a new key");
      },
    ],
    [
      "destroy is idempotent and works on an absent subject",
      async () => {
        await store.destroy("k-d");
        await store.destroy("k-never");
        if ((await store.get("k-never")) !== null)
          fail("destroy-absent", "an absent subject has a key");
      },
    ],
  ];
  for (const [name, run] of cases) {
    try {
      await run();
    } catch (err) {
      fail("store-threw", `${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return findings;
}
