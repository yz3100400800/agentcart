import { describe, expect, it } from "vitest";
import { runAgent } from "@/lib/agent";
import { products } from "@/lib/catalog";
import type { LlmClient, LlmTurn } from "@/lib/llm";
import type { PayPalClient } from "@/lib/paypal";
import { DEFAULT_POLICY } from "@/lib/policy";

function scripted(turns: LlmTurn[]): LlmClient {
  const queue = [...turns];
  return {
    async complete() {
      return queue.shift() ?? { content: "Done.", toolCalls: [] };
    },
  };
}

function paypal() {
  const calls = { create: 0, refund: 0 };
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
      calls.refund += 1;
      return { id: "REFUND123456", status: "COMPLETED", amountCents: input.amountCents ?? null };
    },
    async verifyWebhook() {
      return { verification_status: "SUCCESS" };
    },
  };
  return { client, calls };
}

const planCall: LlmTurn = {
  content: null,
  toolCalls: [
    {
      id: "call-plan",
      name: "plan_cart",
      arguments: JSON.stringify({ goals: ["coffee beans", "cups"], teamSize: 5, days: 5, budgetDollars: 80 }),
    },
  ],
};

describe("runAgent", () => {
  it("creates one PayPal order after the model plans a valid cart", async () => {
    const pay = paypal();
    const result = await runAgent(
      {
        messages: [{ role: "user", content: "Order coffee beans and cups for a 5-person team next week, budget $80" }],
        policy: DEFAULT_POLICY,
        hints: { budgetCents: 8000, teamSize: 5, days: 5 },
      },
      {
        catalog: products,
        paypal: pay.client,
        llm: scripted([
          planCall,
          {
            content: null,
            toolCalls: [{ id: "call-pay", name: "create_paypal_order", arguments: "{}" }],
          },
          { content: "The PayPal order is ready for approval.", toolCalls: [] },
        ]),
      },
    );
    expect(pay.calls.create).toBe(1);
    expect(result.paypalOrder?.id).toBe("ORDER12345678");
    expect(result.needsApproval).toBe(false);
    expect(result.cart?.totalCents).toBe(7400);
    expect(result.message).toContain("ready for approval");
    expect(result.trace.some((step) => step.toolName === "create_paypal_order")).toBe(true);
  });

  it("still creates the order if the model stops after planning", async () => {
    const pay = paypal();
    const result = await runAgent(
      {
        messages: [{ role: "user", content: "Order coffee beans and cups for a 5-person team next week, budget $80" }],
        policy: DEFAULT_POLICY,
        hints: { budgetCents: 8000, teamSize: 5, days: 5 },
      },
      { catalog: products, paypal: pay.client, llm: scripted([planCall, { content: "Here is the cart.", toolCalls: [] }]) },
    );
    expect(pay.calls.create).toBe(1);
    expect(result.paypalOrder?.id).toBe("ORDER12345678");
  });

  it("pauses for a person when the cart breaks policy", async () => {
    const pay = paypal();
    const result = await runAgent(
      {
        messages: [{ role: "user", content: "Order cups for a 5-person team, budget $80" }],
        policy: { ...DEFAULT_POLICY, perItemMaxCents: 2000 },
        hints: { budgetCents: 8000, teamSize: 5, days: 1 },
      },
      {
        catalog: products,
        paypal: pay.client,
        llm: scripted([
          {
            content: null,
            toolCalls: [
              {
                id: "call-plan",
                name: "plan_cart",
                arguments: JSON.stringify({ goals: ["cups"], teamSize: 5, days: 1, budgetDollars: 80 }),
              },
            ],
          },
          { content: null, toolCalls: [] },
        ]),
      },
    );
    expect(pay.calls.create).toBe(0);
    expect(result.needsApproval).toBe(true);
    expect(result.paypalOrder).toBeNull();
    expect(result.policy?.ok).toBe(false);
  });

  it("refunds from a scripted tool sequence and does not open a new order", async () => {
    const pay = paypal();
    const result = await runAgent(
      {
        messages: [{ role: "user", content: "Refund the cups, they arrived broken" }],
        policy: DEFAULT_POLICY,
        knownOrders: [
          {
            orderId: "ORDER12345678",
            captureId: "CAPTURE123456",
            createdAt: "2026-11-03T00:00:00.000Z",
            summary: "5× Day Cup",
            totalCents: 7400,
            lines: [
              { sku: "BM-CUP-12", name: "Day Cup", quantity: 5, lineTotalCents: 4500, category: "Drinkware" },
            ],
          },
        ],
        hints: {},
      },
      {
        catalog: products,
        paypal: pay.client,
        llm: scripted([
          {
            content: null,
            toolCalls: [{ id: "call-get", name: "get_paypal_order", arguments: JSON.stringify({ orderId: "ORDER12345678" }) }],
          },
          {
            content: null,
            toolCalls: [
              {
                id: "call-refund",
                name: "refund_capture",
                arguments: JSON.stringify({ captureId: "CAPTURE123456", itemQuery: "cups", note: "Cups arrived broken" }),
              },
            ],
          },
          { content: "I refunded the cups.", toolCalls: [] },
        ]),
      },
    );
    expect(pay.calls.create).toBe(0);
    expect(pay.calls.refund).toBe(1);
    expect(result.refund?.amountCents).toBe(4500);
    expect(result.message).toContain("refunded the cups");
  });
});
