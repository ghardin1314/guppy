import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 hex digest. */
export function signData(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Constant-time HMAC verification. */
export function verifySignature(
  secret: string,
  data: string,
  sig: string,
): boolean {
  const expected = signData(secret, data);
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/** Returns a Settings.inspectUrl callback that produces HMAC-signed URLs. */
export function createInspectUrl(
  baseUrl: string,
  secret: string,
): (threadId: string) => string {
  return (threadId: string) => {
    const sig = signData(secret, threadId);
    const encoded = encodeURIComponent(threadId);
    return `${baseUrl}/inspect/${encoded}?sig=${sig}`;
  };
}
