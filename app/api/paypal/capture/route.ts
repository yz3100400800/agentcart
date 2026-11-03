import { jsonError, readJson, tooMany } from "@/lib/http";
import { PayPalApiError, createPayPalClient, httpStatusForPayPal } from "@/lib/paypal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const limited = tooMany(request, "capture", 20);
  if (limited) return limited;
  const body = await readJson(request);
  if (!body || typeof body !== "object" || !("orderId" in body) || typeof body.orderId !== "string") {
    return jsonError("orderId is required.", 400);
  }
  try {
    const order = await createPayPalClient().captureOrder(body.orderId);
    const capture = order.captures[0];
    return Response.json({
      order,
      captureId: capture?.id ?? null,
      captureStatus: capture?.status ?? null,
    });
  } catch (error) {
    const message = error instanceof PayPalApiError ? error.message : "PayPal capture failed.";
    const status = error instanceof PayPalApiError ? httpStatusForPayPal(error) : 502;
    return jsonError(message, status);
  }
}
