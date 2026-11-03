import { describe, expect, it } from "vitest";
import { PayPalApiError, buildOrderBody, httpStatusForPayPal, normalizeOrder } from "@/lib/paypal";
import { resetRateLimitForTests, rateLimit } from "@/lib/rate-limit";
import { processWebhook } from "@/lib/webhook-process";
import { createMemoryWebhookStore, interpretWebhook } from "@/lib/webhook-store";
import type { CartLine } from "@/lib/types";

const lines: CartLine[] = [
  {
    sku: "BM-CUP-12",
    name: "Day Cup",
    brand: "Brightmug",
    category: "Drinkware",
    quantity: 5,
    unitPriceCents: 900,
    lineTotalCents: 4500,
  },
  {
    sku: "NB-HOUSE-12",
    name: "House Blend Beans",
    brand: "Northbean Co.",
    category: "Beverages",
    quantity: 2,
    unitPriceCents: 1450,
    lineTotalCents: 2900,
  },
];

describe("PayPal order payload", () => {
  it("keeps the item total equal to the sum of the lines", () => {
    const body = buildOrderBody({ lines, customId: "AC-1", invoiceId: "AC-1" });
    const unit = (body.purchase_units as Array<Record<string, unknown>>)[0]!;
    const amount = unit.amount as { value: string; breakdown: { item_total: { value: string } } };
    const items = unit.items as Array<{ quantity: string; unit_amount: { value: string } }>;
    expect(amount.value).toBe("74.00");
    expect(amount.breakdown.item_total.value).toBe("74.00");
    expect(items.map((item) => item.quantity)).toEqual(["5", "2"]);
    expect((body as { intent: string }).intent).toBe("CAPTURE");
  });

  it("reads captures and the approval link from an order", () => {
    const order = normalizeOrder({
      id: "ORDER12345678",
      status: "CREATED",
      links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345678" }],
      purchase_units: [
        {
          amount: { currency_code: "USD", value: "74.00" },
          items: [{ name: "Day Cup", sku: "BM-CUP-12", quantity: "5", unit_amount: { currency_code: "USD", value: "9.00" } }],
          payments: {
            captures: [{ id: "CAPTURE123456", status: "COMPLETED", amount: { currency_code: "USD", value: "74.00" } }],
          },
        },
      ],
    });
    expect(order.approveUrl).toContain("ORDER12345678");
    expect(order.captures[0]).toMatchObject({ id: "CAPTURE123456", amountCents: 7400 });
    expect(order.items[0]?.lineTotalCents).toBe(4500);
  });

  it("keeps a missing-credentials error as 503", () => {
    expect(httpStatusForPayPal(new PayPalApiError("missing", 503, "NOT_CONFIGURED"))).toBe(503);
    expect(httpStatusForPayPal(new PayPalApiError("bad", 422, "INVALID"))).toBe(422);
    expect(httpStatusForPayPal(new PayPalApiError("down", 500))).toBe(502);
  });
});

describe("webhooks", () => {
  it("maps capture and refund events onto an order", () => {
    const capture = interpretWebhook({
      id: "WH-2",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      resource: {
        id: "CAPTURE123456",
        status: "COMPLETED",
        supplementary_data: { related_ids: { order_id: "ORDER12345678" } },
      },
    });
    expect(capture).toMatchObject({ orderId: "ORDER12345678", captureId: "CAPTURE123456", status: "COMPLETED" });

    const refund = interpretWebhook({
      id: "WH-3",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource_type: "refund",
      resource: {
        id: "REFUND123456",
        status: "COMPLETED",
        supplementary_data: { related_ids: { order_id: "ORDER12345678" } },
        links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE123456" }],
      },
    });
    expect(refund).toMatchObject({
      orderId: "ORDER12345678",
      captureId: "CAPTURE123456",
      refundId: "REFUND123456",
      status: "REFUNDED",
    });
  });

  it("stores a verified event and ignores a failed signature", async () => {
    const approved = JSON.stringify({
      id: "WH-1",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource_type: "checkout-order",
      resource: { id: "ORDER12345678", status: "APPROVED" },
    });
    const headers = {
      authAlgo: "SHA256withRSA",
      certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
      transmissionId: "tx",
      transmissionSig: "sig",
      transmissionTime: "2026-11-03T00:00:00Z",
    };

    const skipped = createMemoryWebhookStore();
    const open = await processWebhook({
      rawBody: approved,
      headers,
      webhookId: "",
      verify: async () => ({ verification_status: "SUCCESS" }),
      store: skipped,
    });
    expect(open.httpStatus).toBe(200);
    expect(open.body.verification).toBe("skipped");
    expect(skipped.getOrderStatus("ORDER12345678")?.status).toBe("APPROVED");

    const rejected = createMemoryWebhookStore();
    const bad = await processWebhook({
      rawBody: approved,
      headers,
      webhookId: "WH-ID",
      verify: async () => ({ verification_status: "FAILURE" }),
      store: rejected,
    });
    expect(bad.httpStatus).toBe(400);
    expect(rejected.listEvents()).toHaveLength(0);
    expect(rejected.getOrderStatus("ORDER12345678")).toBeNull();

    const accepted = createMemoryWebhookStore();
    const good = await processWebhook({
      rawBody: approved,
      headers,
      webhookId: "WH-ID",
      verify: async () => ({ verification_status: "SUCCESS" }),
      store: accepted,
    });
    expect(good.httpStatus).toBe(200);
    expect(accepted.listEvents()[0]?.verified).toBe(true);
    expect(accepted.getOrderStatus("ORDER12345678")?.status).toBe("APPROVED");
  });
});

describe("rate limit", () => {
  it("blocks the next call inside the window", () => {
    resetRateLimitForTests();
    expect(rateLimit("agent:test", 2, 60_000, 1_000).ok).toBe(true);
    expect(rateLimit("agent:test", 2, 60_000, 1_100).ok).toBe(true);
    const blocked = rateLimit("agent:test", 2, 60_000, 1_200);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });
});
