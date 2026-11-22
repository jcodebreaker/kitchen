// Minimal Stripe client: just the two calls this service makes, using Stripe's real wire format.

export function stripeClient({ apiBase, secretKey }) {
  async function call(path, { body, idempotencyKey } = {}) {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
      },
      body: body ? new URLSearchParams(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${path}: ${res.status} ${data.error?.message ?? ""}`.trim());
    return data;
  }

  return {
    createPaymentIntent: ({ orderId, amount, email }) =>
      call("/v1/payment_intents", {
        idempotencyKey: `order-${orderId}`,
        body: { amount: String(amount), currency: "usd", "metadata[order_id]": String(orderId), receipt_email: email },
      }),
    cancelPaymentIntent: (id) => call(`/v1/payment_intents/${encodeURIComponent(id)}/cancel`),
  };
}
