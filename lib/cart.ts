import type {
  CartRequestLine,
  PricedCart,
  Policy,
  PolicyViolation,
  Product,
} from "@/lib/types";

export type CartBuildResult = {
  cart: PricedCart;
  notes: string[];
  unmatchedGoals: string[];
};

const STOP = new Set(["the", "and", "for", "with", "per", "pack"]);

export function suggestQuantity(product: Product, teamSize: number, days: number): number {
  const people = clampInt(teamSize, 1, 100);
  const span = clampInt(days, 1, 30);
  let quantity = 1;
  if (product.kind === "per_person") {
    quantity = people;
  } else if (product.kind === "consumable") {
    const perDay = product.servingsPerPersonPerDay ?? 1;
    const perUnit = Math.max(1, product.servingsPerUnit ?? 1);
    quantity = Math.ceil((people * perDay * span) / perUnit);
  }
  return clampInt(quantity, 1, product.maxQty);
}

export function scoreProduct(product: Product, goals: string[]): number {
  const hay = haystack(product);
  let score = 0;
  for (const goal of goals) {
    const phrase = goal.toLowerCase().trim();
    if (!phrase) continue;
    if (hay.includes(phrase)) score += 5;
    for (const word of phrase.split(/\s+/)) {
      if (word.length > 2 && !STOP.has(word) && hay.includes(word)) score += 1;
    }
  }
  return score;
}

export function selectProducts(catalog: Product[], goals: string[]): {
  chosen: { product: Product; goal: string }[];
  unmatchedGoals: string[];
} {
  const chosen: { product: Product; goal: string }[] = [];
  const unmatchedGoals: string[] = [];
  for (const goal of goals) {
    let best: Product | null = null;
    let bestScore = 0;
    for (const product of catalog) {
      const score = scoreProduct(product, [goal]);
      if (score <= 0) continue;
      if (
        !best ||
        score > bestScore ||
        (score === bestScore &&
          (product.priceCents < best.priceCents ||
            (product.priceCents === best.priceCents && product.sku < best.sku)))
      ) {
        best = product;
        bestScore = score;
      }
    }
    if (!best) {
      unmatchedGoals.push(goal);
      continue;
    }
    if (!chosen.some((entry) => entry.product.sku === best.sku)) {
      chosen.push({ product: best, goal });
    }
  }
  return { chosen: chosen.slice(0, 4), unmatchedGoals };
}

export function buildSuggestedCart(
  catalog: Product[],
  plan: {
    goals: string[];
    teamSize: number;
    days: number;
    budgetCents: number;
    policy: Policy;
  },
): CartBuildResult {
  const notes: string[] = [];
  const { chosen, unmatchedGoals } = selectProducts(catalog, plan.goals);
  const blocked = new Set(plan.policy.blockedCategories);
  const quantities = new Map<string, { product: Product; quantity: number; ideal: number }>();

  for (const entry of chosen) {
    if (blocked.has(entry.product.category)) {
      notes.push(
        `Skipped ${entry.product.name} because ${entry.product.category} is blocked.`,
      );
      continue;
    }
    const ideal = suggestQuantity(entry.product, plan.teamSize, plan.days);
    quantities.set(entry.product.sku, { product: entry.product, quantity: ideal, ideal });
  }

  const budget = plan.budgetCents;
  let guard = 0;
  while (totalOf(quantities) > budget && guard < 40) {
    guard += 1;
    const reducible = [...quantities.values()]
      .filter((entry) => entry.product.kind !== "per_person" && entry.quantity > 1)
      .sort((a, b) => b.product.priceCents - a.product.priceCents || a.product.sku.localeCompare(b.product.sku));
    const target = reducible[0];
    if (!target) break;
    target.quantity -= 1;
  }

  for (const entry of quantities.values()) {
    if (entry.quantity < entry.ideal) {
      notes.push(
        `Reduced ${entry.product.name} from ${entry.ideal} to ${entry.quantity} to stay within the budget.`,
      );
    }
  }

  if (unmatchedGoals.length > 0) {
    notes.push(`No catalog match for: ${unmatchedGoals.join(", ")}.`);
  }

  const lines = [...quantities.values()].map((entry) => toLine(entry.product, entry.quantity));
  const cart: PricedCart = {
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
    currency: "USD",
    teamSize: clampInt(plan.teamSize, 1, 100),
    days: clampInt(plan.days, 1, 30),
    notes,
  };
  return { cart, notes, unmatchedGoals };
}

export function priceExplicitCart(
  catalog: Product[],
  requests: CartRequestLine[],
): { cart?: PricedCart; errors: PolicyViolation[] } {
  const errors: PolicyViolation[] = [];
  const merged = new Map<string, number>();
  for (const request of requests) {
    const sku = request.sku?.trim();
    if (!sku) {
      errors.push({ code: "EMPTY_CART", message: "A cart line is missing a SKU." });
      continue;
    }
    if (!Number.isInteger(request.quantity) || request.quantity < 1) {
      errors.push({
        code: "PER_ITEM_MAX",
        sku,
        message: `Quantity for ${sku} must be a positive integer.`,
      });
      continue;
    }
    merged.set(sku, (merged.get(sku) ?? 0) + request.quantity);
  }

  const bySku = new Map(catalog.map((product) => [product.sku, product]));
  const lines = [];
  for (const [sku, quantity] of merged) {
    const product = bySku.get(sku);
    if (!product) {
      errors.push({
        code: "EMPTY_CART",
        sku,
        message: `Unknown SKU ${sku}. Prices only come from the demo catalog.`,
      });
      continue;
    }
    if (quantity > product.maxQty) {
      errors.push({
        code: "PER_ITEM_MAX",
        sku,
        message: `Quantity for ${product.name} cannot exceed ${product.maxQty}.`,
      });
      continue;
    }
    lines.push(toLine(product, quantity));
  }

  if (errors.length > 0 || lines.length === 0) {
    return { errors };
  }

  return {
    cart: {
      lines,
      totalCents: lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
      currency: "USD",
    },
    errors: [],
  };
}

export function searchCatalog(
  catalog: Product[],
  query: string,
  category?: string,
  limit = 8,
): Product[] {
  const pool = catalog.filter((product) => !category || product.category === category);
  const trimmed = query.trim();
  if (!trimmed) return pool.slice(0, limit);
  return pool
    .map((product) => ({ product, score: scoreProduct(product, [trimmed]) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.product.priceCents - b.product.priceCents ||
        a.product.sku.localeCompare(b.product.sku),
    )
    .slice(0, limit)
    .map((entry) => entry.product);
}

function toLine(product: Product, quantity: number) {
  return {
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    category: product.category,
    quantity,
    unitPriceCents: product.priceCents,
    lineTotalCents: product.priceCents * quantity,
  };
}

function totalOf(quantities: Map<string, { product: Product; quantity: number }>): number {
  let total = 0;
  for (const entry of quantities.values()) {
    total += entry.product.priceCents * entry.quantity;
  }
  return total;
}

function haystack(product: Product): string {
  return `${product.name} ${product.brand} ${product.category} ${product.description} ${product.tags.join(" ")}`.toLowerCase();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
