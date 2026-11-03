import { describe, expect, it } from "vitest";
import { buildSuggestedCart, priceExplicitCart, suggestQuantity } from "@/lib/cart";
import { products } from "@/lib/catalog";
import { parseRequestHints, resolveRequestBudget } from "@/lib/intent";
import { amountToCents, centsToAmount, dollarsToCents } from "@/lib/money";
import { DEFAULT_POLICY } from "@/lib/policy";
import type { Product } from "@/lib/types";

describe("catalog", () => {
  it("ships at least 30 fictional office products with unique skus", () => {
    expect(products.length).toBeGreaterThanOrEqual(30);
    expect(new Set(products.map((product) => product.sku)).size).toBe(products.length);
    expect(products.every((product) => product.priceCents > 0)).toBe(true);
    expect(products.some((product) => product.category === "Beverages")).toBe(true);
  });
});

describe("buildSuggestedCart", () => {
  it("orders coffee and cups for five people inside an $80 budget", () => {
    const result = buildSuggestedCart(products, {
      goals: ["coffee beans", "cups"],
      teamSize: 5,
      days: 5,
      budgetCents: 8000,
      policy: DEFAULT_POLICY,
    });
    expect(result.cart.lines).toHaveLength(2);
    expect(result.cart.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sku: "BM-CUP-12", quantity: 5, lineTotalCents: 4500 }),
        expect.objectContaining({ sku: "NB-HOUSE-12", quantity: 2, lineTotalCents: 2900 }),
      ]),
    );
    expect(result.cart.totalCents).toBe(7400);
    expect(result.notes.join(" ")).toContain("from 4 to 2");
  });

  it("does not shrink per-person quantities below the team size", () => {
    const result = buildSuggestedCart(products, {
      goals: ["cups"],
      teamSize: 5,
      days: 1,
      budgetCents: 1000,
      policy: DEFAULT_POLICY,
    });
    expect(result.cart.lines).toEqual([
      expect.objectContaining({ sku: "BM-CUP-12", quantity: 5, lineTotalCents: 4500 }),
    ]);
    expect(result.cart.totalCents).toBeGreaterThan(1000);
  });

  it("skips a blocked category and reports goals with no match", () => {
    const blocked = buildSuggestedCart(products, {
      goals: ["cups"],
      teamSize: 5,
      days: 1,
      budgetCents: 8000,
      policy: { ...DEFAULT_POLICY, blockedCategories: ["Drinkware"] },
    });
    expect(blocked.cart.lines).toEqual([]);
    expect(blocked.notes.join(" ")).toContain("blocked");

    const missing = buildSuggestedCart(products, {
      goals: ["helicopter"],
      teamSize: 2,
      days: 1,
      budgetCents: 8000,
      policy: DEFAULT_POLICY,
    });
    expect(missing.unmatchedGoals).toEqual(["helicopter"]);
    expect(missing.cart.lines).toEqual([]);
  });

  it("suggests weekly coffee from servings", () => {
    const coffee = products.find((product) => product.sku === "NB-HOUSE-12") as Product;
    expect(suggestQuantity(coffee, 5, 5)).toBe(4);
    const cup = products.find((product) => product.sku === "BM-CUP-12") as Product;
    expect(suggestQuantity(cup, 5, 5)).toBe(5);
  });
});

describe("priceExplicitCart", () => {
  it("prices from the catalog, merges duplicates, and rejects unknown skus", () => {
    const priced = priceExplicitCart(products, [
      { sku: "BM-CUP-12", quantity: 1 },
      { sku: "BM-CUP-12", quantity: 2 },
    ]);
    expect(priced.errors).toEqual([]);
    expect(priced.cart?.lines[0]).toMatchObject({ quantity: 3, unitPriceCents: 900, lineTotalCents: 2700 });

    const unknown = priceExplicitCart(products, [{ sku: "NO-SUCH-SKU", quantity: 1 }]);
    expect(unknown.cart).toBeUndefined();
    expect(unknown.errors[0]?.message).toContain("Unknown SKU");

    const zero = priceExplicitCart(products, [{ sku: "BM-CUP-12", quantity: 0 }]);
    expect(zero.cart).toBeUndefined();
  });
});

describe("request hints and money", () => {
  it("reads a team budget and an office week", () => {
    expect(parseRequestHints("Order coffee for a 5-person team next week, budget $80")).toEqual({
      budgetCents: 8000,
      teamSize: 5,
      days: 5,
    });
    expect(resolveRequestBudget(8000, 12000)).toBe(8000);
  });

  it("converts PayPal amounts without float drift", () => {
    expect(centsToAmount(7400)).toBe("74.00");
    expect(centsToAmount(5)).toBe("0.05");
    expect(amountToCents("19.99")).toBe(1999);
    expect(dollarsToCents(14.5)).toBe(1450);
  });
});
