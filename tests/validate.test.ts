import { describe, expect, it } from "vitest";
import { withApprovalLink } from "@/lib/agent";
import { DEFAULT_POLICY } from "@/lib/policy";
import { parseAgentRequest } from "@/lib/validate";

const messages = [{ role: "user", content: "Order coffee beans and cups for a 5-person team, budget $80" }];

describe("parseAgentRequest", () => {
  it("falls back to the default policy when policy is missing", () => {
    const parsed = parseAgentRequest({ messages });
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.policy).toEqual(DEFAULT_POLICY);
      expect(parsed.currentCart).toEqual([]);
    }
  });
  it("still rejects a malformed policy", () => {
    expect(parseAgentRequest({ messages, policy: "nope" })).toEqual({ error: "Policy must be an object." });
  });
});

describe("withApprovalLink", () => {
  const order = { id: "O1", status: "CREATED", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=O1" };
  it("appends the approval link", () => {
    expect(withApprovalLink("Order created.", { paypalOrder: order, refund: null })).toContain(order.approveUrl);
  });
  it("does not duplicate the link or add it without an order", () => {
    const text = `Pay here ${order.approveUrl}`;
    expect(withApprovalLink(text, { paypalOrder: order, refund: null })).toBe(text);
    expect(withApprovalLink("Hi", { paypalOrder: null, refund: null })).toBe("Hi");
  });
});
