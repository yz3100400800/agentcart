import { jsonError, readJson, tooMany } from "@/lib/http";
import { PayPalApiError, createPayPalClient, httpStatusForPayPal } from "@/lib/paypal";
import { parseRefundRequest } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const limited = tooMany(request, "refund", 10);
  if (limited) return limited;
  const body = await readJson(request);
  if (body && typeof body === "object" && "error" in body && Object.keys(body).length === 1) {
    return jsonError(String((body as { error: string }).error), 400);
  }
  const parsed = parseRefundRequest(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);
  try {
    const refund = await createPayPalClient().refundCapture({
      captureId: parsed.captureId,
      amountCents: parsed.amountCents,
      note: parsed.note,
      requestId: `refund-${crypto.randomUUID()}`,
    });
    return Response.json({ refund, orderId: parsed.orderId ?? null });
  } catch (error) {
    const message = error instanceof PayPalApiError ? error.message : "PayPal refund failed.";
    const status = error instanceof PayPalApiError ? httpStatusForPayPal(error) : 502;
    return jsonError(message, status);
  }
}
