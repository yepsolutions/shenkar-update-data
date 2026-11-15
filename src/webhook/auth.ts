import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verifies an HS256 JWT (monday integration-app webhooks) against the app signing secret. */
export function verifyMondayJwt(header: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const token = header.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  try {
    const head = JSON.parse(Buffer.from(h, "base64url").toString());
    if (head.alg !== "HS256") return false;
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    if (!safeEqual(expected, s)) return false;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    if (typeof claims.exp === "number" && claims.exp < nowSec) return false;
    return true;
  } catch {
    return false;
  }
}
