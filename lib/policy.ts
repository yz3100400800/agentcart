import { formatUsd } from "@/lib/money";
import type {
  CartRequestLine,
  HumanApproval,
  Policy,
  PolicyEvaluation,
  PolicyViolation,
  PricedCart,
} from "@/lib/types";

export const DEFAULT_POLICY: Policy = {
  budgetCapCents: 15000,
  perItemMaxCents: 6000,
  blockedCategories: [],
};

export const POLICY_MIN_CENTS = 100;
export const POLICY_MAX_CENTS = 500_000;

export function sanitizePolicy(
  input: unknown,
  categories: readonly string[],
): Policy | { error: string } {
  if (!input || typeof input !== "object") {
    return { error: "Policy must be an object." };
  }
  const raw = input as Record<string, unknown>;
  const budgetCapCents = integerCents(raw.budgetCapCents, "Budget cap");
  if (typeof budgetCapCents !== "number") return { error: budgetCapCents.error };
  const perItemMaxCents = integerCents(raw.perItemMaxCents, "Per-item max");
  if (typeof perItemMaxCents !== "number") return { error: perItemMaxCents.error };

  const known = new Set(categories);
  const blocked: string[] = [];
  if (raw.blockedCategories !== undefined) {
    if (!Array.isArray(raw.blockedCategories)) {
      return { error: "Blocked categories must be a list." };
    }
    for (const entry of raw.blockedCategories) {
      if (typeof entry !== "string" || !known.has(entry)) {
        return { error: `Unknown category: ${String(entry)}` };
      }
      if (!blocked.includes(entry)) blocked.push(entry);
    }
  }

  return { budgetCapCents, perItemMaxCents, blockedCategories: blocked };
}

function integerCents(
  value: unknown,
  label: string,
): number | { error: string } {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { error: `${label} must be an integer number of cents.` };
  }
  if (value < POLICY_MIN_CENTS || value > POLICY_MAX_CENTS) {
    return {
      error: `${label} must be between ${formatUsd(POLICY_MIN_CENTS)} and ${formatUsd(POLICY_MAX_CENTS)}.`,
    };
  }
  return value;
}

export function evaluatePolicy(
  cart: PricedCart,
  policy: Policy,
  requestBudgetCents?: number,
): PolicyEvaluation {
  const effectiveBudgetCents =
    requestBudgetCents === undefined
      ? policy.budgetCapCents
      : Math.min(policy.budgetCapCents, requestBudgetCents);
  const violations: PolicyViolation[] = [];

  if (cart.lines.length === 0) {
    violations.push({
      code: "EMPTY_CART",
      message: "The cart is empty.",
    });
  }

  if (cart.totalCents > effectiveBudgetCents) {
    violations.push({
      code: "BUDGET_CAP",
      message: `Cart total ${formatUsd(cart.totalCents)} is over the ${formatUsd(effectiveBudgetCents)} budget.`,
    });
  }

  const blocked = new Set(policy.blockedCategories);
  for (const line of cart.lines) {
    if (line.lineTotalCents > policy.perItemMaxCents) {
      violations.push({
        code: "PER_ITEM_MAX",
        sku: line.sku,
        message: `${line.name} is ${formatUsd(line.lineTotalCents)}, over the ${formatUsd(policy.perItemMaxCents)} per-item max.`,
      });
    }
    if (blocked.has(line.category)) {
      violations.push({
        code: "BLOCKED_CATEGORY",
        sku: line.sku,
        category: line.category,
        message: `${line.name} is in ${line.category}, which is blocked.`,
      });
    }
  }

  return { ok: violations.length === 0, violations, effectiveBudgetCents };
}

export function approvalMatches(
  cart: PricedCart,
  approval: HumanApproval | undefined,
): boolean {
  if (!approval?.approved) return false;
  return lineKey(cart.lines) === lineKey(approval.lines);
}

function lineKey(lines: { sku: string; quantity: number }[]): string {
  return [...lines]
    .map((line) => `${line.sku}:${line.quantity}`)
    .sort()
    .join("|");
}

export type CheckoutDecision = {
  allowed: boolean;
  via: "policy" | "human" | "blocked";
  evaluation: PolicyEvaluation;
  reason?: string;
};

export function decideCheckout(
  cart: PricedCart,
  policy: Policy,
  requestBudgetCents: number | undefined,
  approval: HumanApproval | undefined,
): CheckoutDecision {
  const evaluation = evaluatePolicy(cart, policy, requestBudgetCents);
  if (evaluation.ok) {
    return { allowed: true, via: "policy", evaluation };
  }
  if (approvalMatches(cart, approval)) {
    return { allowed: true, via: "human", evaluation };
  }
  return {
    allowed: false,
    via: "blocked",
    evaluation,
    reason: "Policy failed and this exact cart has not been approved.",
  };
}

export function linesFromCart(cart: PricedCart): CartRequestLine[] {
  return cart.lines.map((line) => ({ sku: line.sku, quantity: line.quantity }));
}
