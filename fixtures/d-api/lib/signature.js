// Stripe webhook signature verification, as documented by Stripe:
//   Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_SECONDS = 300;

export function sign(secret, rawBody, timestamp) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Build a header value; handy for tests and for hand-testing the endpoint. */
export const header = (secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) => `t=${timestamp},v1=${sign(secret, rawBody, timestamp)}`;

/** Returns true when the header carries a valid, recent v1 signature for rawBody. */
export function verify(secret, rawBody, headerValue, now = Math.floor(Date.now() / 1000)) {
  if (!secret || !headerValue) return false;
  const parts = headerValue.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isInteger(t) || Math.abs(now - t) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(secret, rawBody, t), "hex");
  // Stripe may send several v1 values while a secret is being rolled; any match is enough.
  return parts
    .filter(([k]) => k === "v1")
    .some(([, v]) => {
      const got = Buffer.from(v ?? "", "hex");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}
