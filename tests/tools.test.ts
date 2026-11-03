import { describe, expect, it } from "vitest";
import { products } from "@/lib/catalog";
import type { PayPalClient } from "@/lib/paypal";
import { DEFAULT_POLICY } from "@/lib/policy";
import { handleTool, type AgentState, type ToolContext } from "@/lib/tools";

function state(): AgentState {
  return {
    cart: null,
    evaluation: null,
    needsApproval: false,
    paypalOrder: null,
    refund: null,
    purchaseIntent: false,
    refundRequested: false,
    seenOrder: null,
    refundLines: [],
    trace: [],
  };
}

function paypalMock() {
  const calls = { create: 0, refunds: [] as Array<number | undefined> };
  const client: PayPalClient = {
    async createOrder() {
      calls.create += 1;
      return {
        id: "ORDER12345678",
        status: "CREATED",
        amountCents: 7400,
        currency: "USD",
        items: [],
        captures: [],
        refunds: [],
        approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER12345678",
      };
    },
    async captureOrder(orderId) {
      return this.getOrder(orderId);
    },
    async getOrder(orderId) {
      return {
        id: orderId,
        status: "COMPLETED",
        amountCents: 7400,
        currency: "USD",
        items: [
          { name: "Day Cup", sku: "BM-CUP-12", quantity: 5, unitPriceCents: 900, lineTotalCents: 4500 },
          { name: "House Blend Beans", sku: "NB-HOUSE-12", quantity: 2, unitPriceCents: 1450, lineTotalCents: 2900 },
        ],
        captures: [{ id: "CAPTURE123456", status: "COMPLETED", amountCents: 7400 }],
        refunds: [],
      };
    },
    async refundCapture(input) {
      calls.refunds.push(input.amountCents);
      return { id: "REFUND123456", status: "COMPLETED", amountCents: input.amountCents ?? 7400 };
    },
    async verifyWebhook() {
      return { verification_status: "SUCCESS" };
    },
  };
  return { client, calls };
}

function context(overrides: Partial<ToolContext> = {}): { ctx: ToolContext; calls: ReturnType<typeof paypalMock>["calls"] } {
  const paypal = paypalMock();
  return {
    calls: paypal.calls,
    ctx: {
      catalog: products,
      policy: DEFAULT_POLICY,
      hints: { budgetCents: 8000, teamSize: 5, days: 5 },
      knownOrders: [],
      paypal: paypal.client,
      state: state(),
      ...overrides,
    },
  };
}

describe("tool handlers", () => {
  it("searches the catalog and plans a priced cart", async () => {
    const { ctx } = context();
    const search = await handleTool("search_catalog", JSON.stringify({ query: "cups" }), ctx);
    expect(search.content).toContain("BM-CUP-12");
    expect(ctx.state.trace.at(-1)?.toolName).toBe("search_catalog");

    await handleTool(
      "plan_cart",
      JSON.stringify({ goals: ["coffee beans", "cups"], teamSize: 5, days: 5, budgetDollars: 80 }),
      ctx,
    );
    expect(ctx.state.cart?.totalCents).toBe(7400);
    expect(ctx.state.evaluation?.ok).toBe(true);
    expect(ctx.state.purchaseIntent).toBe(true);
  });

  it("blocks PayPal order creation until a person approves the same cart", async () => {
    const { ctx, calls } = context({
      policy: { ...DEFAULT_POLICY, perItemMaxCents: 2000 },
    });
    await handleTool(
      "propose_cart",
      JSON.stringify({ items: [{ sku: "BM-CUP-12", quantity: 5 }] }),
      ctx,
    );
    const blocked = await handleTool("create_paypal_order", "{}", ctx);
    expect(blocked.content).toContain("POLICY");
    expect(calls.create).toBe(0);
    expect(ctx.state.needsApproval).toBe(true);

    ctx.humanApproval = { approved: true, lines: [{ sku: "BM-CUP-12", quantity: 4 }] };
    const mismatched = await handleTool("create_paypal_order", "{}", ctx);
    expect(mismatched.content).toContain("POLICY");
    expect(calls.create).toBe(0);

    ctx.humanApproval = { approved: true, lines: [{ sku: "BM-CUP-12", quantity: 5 }] };
    const allowed = await handleTool("create_paypal_order", "{}", ctx);
    expect(allowed.content).toContain("ORDER12345678");
    expect(calls.create).toBe(1);
    expect(ctx.state.paypalOrder?.status).toBe("CREATED");
  });

  it("creates an order when the cart is inside policy", async () => {
    const { ctx, calls } = context();
    await handleTool(
      "plan_cart",
      JSON.stringify({ goals: ["coffee beans", "cups"], teamSize: 5, days: 5, budgetDollars: 80 }),
      ctx,
    );
    const created = await handleTool("create_paypal_order", "{}", ctx);
    expect(created.content).toContain("ORDER12345678");
    expect(calls.create).toBe(1);
    expect(ctx.state.trace.some((step) => step.title === "Created PayPal order")).toBe(true);
  });

  it("refunds the cup line only after the order is fetched", async () => {
    const { ctx, calls } = context();
    const early = await handleTool("refund_capture", JSON.stringify({ captureId: "CAPTURE123456", itemQuery: "cups" }), ctx);
    expect(early.content).toContain("get_paypal_order");
    expect(calls.refunds).toEqual([]);

    await handleTool("get_paypal_order", JSON.stringify({ orderId: "ORDER12345678" }), ctx);
    const refunded = await handleTool(
      "refund_capture",
      JSON.stringify({ captureId: "CAPTURE123456", itemQuery: "cups", note: "Cups arrived broken" }),
      ctx,
    );
    expect(calls.refunds).toEqual([4500]);
    expect(refunded.content).toContain("REFUND123456");
    expect(ctx.state.refund?.orderId).toBe("ORDER12345678");
    expect(ctx.state.refundRequested).toBe(true);
  });
});
