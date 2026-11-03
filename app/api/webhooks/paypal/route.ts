import { getPayPalConfig } from "@/lib/config";
import { createPayPalClient } from "@/lib/paypal";
import { processWebhook } from "@/lib/webhook-process";
import { getWebhookStore } from "@/lib/webhook-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 256_000) {
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }
  const config = getPayPalConfig();
  const paypal = createPayPalClient();
  const result = await processWebhook({
    rawBody,
    headers: {
      authAlgo: request.headers.get("paypal-auth-algo"),
      certUrl: request.headers.get("paypal-cert-url"),
      transmissionId: request.headers.get("paypal-transmission-id"),
      transmissionSig: request.headers.get("paypal-transmission-sig"),
      transmissionTime: request.headers.get("paypal-transmission-time"),
    },
    webhookId: config.webhookId,
    verify: (payload) => paypal.verifyWebhook(payload),
    store: getWebhookStore(),
  });
  return Response.json(result.body, { status: result.httpStatus });
}

export function GET() {
  const store = getWebhookStore();
  return Response.json({ events: store.listEvents() });
}
