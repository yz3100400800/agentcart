import { jsonError } from "@/lib/http";
import { PayPalApiError, createPayPalClient, httpStatusForPayPal } from "@/lib/paypal";
import { getWebhookStore } from "@/lib/webhook-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9-]{8,36}$/.test(id)) return jsonError("Invalid PayPal order id.", 400);
  try {
    const order = await createPayPalClient().getOrder(id);
    return Response.json({ order, webhook: getWebhookStore().getOrderStatus(id) });
  } catch (error) {
    const message = error instanceof PayPalApiError ? error.message : "Could not read the PayPal order.";
    const status = error instanceof PayPalApiError ? httpStatusForPayPal(error) : 502;
    return jsonError(message, status);
  }
}
