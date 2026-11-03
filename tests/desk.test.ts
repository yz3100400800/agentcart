import { describe, expect, it } from "vitest";
import { APPROVE_HINT, withApprovalLink } from "@/lib/agent";
import { emptyDesk, loadDesk, saveDesk } from "@/lib/browser-store";

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe("desk persistence", () => {
  it("round-trips chat, cart and current order", () => {
    const store = memory();
    const desk = {
      ...emptyDesk(),
      messages: [{ id: "1", role: "user" as const, content: "coffee" }],
      cart: { lines: [], totalCents: 7400, currency: "USD" },
      order: { id: "O1", status: "CREATED", approveUrl: "https://x" },
      requestText: "coffee",
    };
    saveDesk(desk as never, store);
    const loaded = loadDesk(store);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.order?.id).toBe("O1");
    expect(loaded.cart?.totalCents).toBe(7400);
  });
  it("returns an empty desk for missing or corrupt data", () => {
    const store = memory();
    expect(loadDesk(store)).toEqual(emptyDesk());
    store.setItem("agentcart.desk.v1", "{not json");
    expect(loadDesk(store)).toEqual(emptyDesk());
  });
});

describe("approval wording", () => {
  it("uses the consistent PayPal button hint", () => {
    const text = withApprovalLink("Order created.", {
      paypalOrder: { id: "O1", status: "CREATED", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=O1" },
      refund: null,
    });
    expect(text).toContain(APPROVE_HINT);
    expect(APPROVE_HINT).toMatch(/click the PayPal button below \(or the link\) to approve/i);
  });
});

describe("cleanReply via withApprovalLink", () => {
  const url = "https://www.sandbox.paypal.com/checkoutnow?token=6RK382978H537990G";
  const raw = `✅ **Order Created!**\n\nYour order is ready for payment:\n- **Order ID:** 6RK382978H537990G\n- **Total:** $74.00\n\n**Next Step:** Please approve and complete the payment using the PayPal button at:\n${url}\n\nClick the PayPal button below (or the link) to approve.\n[Approve with PayPal](${url})`;
  it("strips markdown, model-written links and approval text, then adds one hint", () => {
    const out = withApprovalLink(raw, { paypalOrder: { id: "X", status: "CREATED", approveUrl: url }, refund: null });
    expect(out).not.toMatch(/\*\*|✅|\[Approve/);
    expect(out.split(url).length - 1).toBe(1);
    expect(out.split(APPROVE_HINT).length - 1).toBe(1);
    expect(out).toContain("Order ID: 6RK382978H537990G");
    expect(out.endsWith(`Approve with PayPal: ${url}`)).toBe(true);
  });
});

describe("sentence-level cleanup", () => {
  it("keeps the summary sentence and drops only the approval sentence", () => {
    const url = "https://www.sandbox.paypal.com/checkoutnow?token=T1";
    const out = withApprovalLink(
      "Your order is ready: 2 bags of House Blend Beans and 5 Day Cups for $74.00. The PayPal button has appeared so you can approve the payment.",
      { paypalOrder: { id: "T1", status: "CREATED", approveUrl: url }, refund: null },
    );
    expect(out.startsWith("Your order is ready: 2 bags of House Blend Beans and 5 Day Cups for $74.00.")).toBe(true);
    expect(out).not.toContain("has appeared");
  });
  it("falls back to an order summary if everything was approval talk", () => {
    const out = withApprovalLink("Click the PayPal button to approve.", {
      paypalOrder: { id: "T2", status: "CREATED", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=T2" },
      refund: null,
    });
    expect(out.startsWith("PayPal order T2 is CREATED.")).toBe(true);
  });
});
