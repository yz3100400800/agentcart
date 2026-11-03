import { describe, expect, it } from "vitest";
import { explicitApproval } from "@/lib/intent";
import { formatUsd } from "@/lib/money";
import {
  DEFAULT_POLICY,
  approvalMatches,
  decideCheckout,
  evaluatePolicy,
  sanitizePolicy,
} from "@/lib/policy";
import type { PricedCart, Policy } from "@/lib/types";

const categories = ["Beverages", "Drinkware", "Electronics"];

function cart(lines: PricedCart["lines"], total?: number): PricedCart {
  return {
    lines,
    totalCents: total ?? lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
    currency: "USD",
  };
}

const cups = {
  sku: "BM-CUP-12",
  name: "Day Cup",
  brand: "Brightmug",
  category: "Drinkware",
  quantity: 5,
  unitPriceCents: 900,
  lineTotalCents: 4500,
};

const lamp = {
  sku: "LD-LAMP",
  name: "Task Lamp",
  brand: "Lumen Desk Co.",
  category: "Electronics",
  quantity: 1,
  unitPriceCents: 3200,
  lineTotalCents: 3200,
};

describe("evaluatePolicy", () => {
  it("passes a cart inside the cap and the per-item max", () => {
    const result = evaluatePolicy(cart([cups]), DEFAULT_POLICY, 8000);
    expect(result.ok).toBe(true);
    expect(result.effectiveBudgetCents).toBe(8000);
    expect(result.violations).toEqual([]);
  });

  it("uses the tighter of the policy cap and the request budget", () => {
    const result = evaluatePolicy(cart([cups]), { ...DEFAULT_POLICY, budgetCapCents: 4000 }, 8000);
    expect(result.ok).toBe(false);
    expect(result.effectiveBudgetCents).toBe(4000);
    expect(result.violations.map((violation) => violation.code)).toContain("BUDGET_CAP");
  });

  it("flags a line over the per-item max and a blocked category together", () => {
    const policy: Policy = { budgetCapCents: 20000, perItemMaxCents: 2000, blockedCategories: ["Electronics"] };
    const result = evaluatePolicy(cart([cups, lamp]), policy);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "PER_ITEM_MAX",
      "PER_ITEM_MAX",
      "BLOCKED_CATEGORY",
    ]);
  });

  it("rejects an empty cart", () => {
    const result = evaluatePolicy(cart([]), DEFAULT_POLICY);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("EMPTY_CART");
  });

  it("formats the budget message in dollars", () => {
    const result = evaluatePolicy(cart([cups]), DEFAULT_POLICY, 1000);
    expect(result.violations[0]?.message).toContain(formatUsd(4500));
    expect(result.violations[0]?.message).toContain(formatUsd(1000));
  });
});

describe("approval", () => {
  it("matches the same sku and quantity regardless of order", () => {
    const priced = cart([cups, lamp]);
    expect(approvalMatches(priced, { approved: true, lines: [{ sku: lamp.sku, quantity: 1 }, { sku: cups.sku, quantity: 5 }] })).toBe(true);
    expect(approvalMatches(priced, { approved: true, lines: [{ sku: cups.sku, quantity: 4 }] })).toBe(false);
    expect(approvalMatches(priced, { approved: false, lines: [{ sku: cups.sku, quantity: 5 }, { sku: lamp.sku, quantity: 1 }] })).toBe(false);
  });

  it("allows checkout through policy or a matching human approval", () => {
    const priced = cart([cups]);
    const tight: Policy = { ...DEFAULT_POLICY, perItemMaxCents: 2000 };
    expect(decideCheckout(priced, DEFAULT_POLICY, 8000, undefined).via).toBe("policy");
    const blocked = decideCheckout(priced, tight, 8000, undefined);
    expect(blocked.allowed).toBe(false);
    const approved = decideCheckout(priced, tight, 8000, {
      approved: true,
      lines: [{ sku: cups.sku, quantity: 5 }],
    });
    expect(approved.allowed).toBe(true);
    expect(approved.via).toBe("human");
  });

  it("recognizes a short approval and ignores a change request", () => {
    expect(explicitApproval("I approve this cart.")).toBe(true);
    expect(explicitApproval("approve")).toBe(true);
    expect(explicitApproval("go ahead")).toBe(true);
    expect(explicitApproval("approved orders please")).toBe(false);
    expect(explicitApproval("approve but remove the cups")).toBe(false);
  });
});

describe("sanitizePolicy", () => {
  it("keeps known categories and rejects bad amounts", () => {
    const saved = sanitizePolicy(
      { budgetCapCents: 8000, perItemMaxCents: 2000, blockedCategories: ["Electronics", "Electronics"] },
      categories,
    );
    expect(saved).toEqual({ budgetCapCents: 8000, perItemMaxCents: 2000, blockedCategories: ["Electronics"] });
    expect(sanitizePolicy({ budgetCapCents: 50, perItemMaxCents: 2000, blockedCategories: [] }, categories)).toHaveProperty("error");
    expect(sanitizePolicy({ budgetCapCents: 8000, perItemMaxCents: 2000, blockedCategories: ["Spaceships"] }, categories)).toHaveProperty("error");
  });
});
