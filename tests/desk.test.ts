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
