import { DEFAULT_POLICY } from "@/lib/policy";
import type { KnownOrder, Policy, SavedOrder, SavedRefund } from "@/lib/types";

const KEY = "agentcart.v1";

export type PersistedState = {
  policy: Policy;
  orders: SavedOrder[];
};

export function loadPersisted(): PersistedState {
  if (typeof window === "undefined") return { policy: DEFAULT_POLICY, orders: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { policy: DEFAULT_POLICY, orders: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      policy: isPolicy(parsed.policy) ? parsed.policy : DEFAULT_POLICY,
      orders: Array.isArray(parsed.orders) ? parsed.orders.filter(isOrder) : [],
    };
  } catch {
    return { policy: DEFAULT_POLICY, orders: [] };
  }
}

export function savePolicy(policy: Policy): void {
  const current = loadPersisted();
  current.policy = policy;
  write(current);
}

export function upsertOrder(order: SavedOrder): SavedOrder[] {
  const current = loadPersisted();
  const trimmed: SavedOrder = {
    ...order,
    requestText: order.requestText.slice(0, 500),
    trace: order.trace.slice(-40).map((step) => ({ ...step, detail: step.detail.slice(0, 1500) })),
    refunds: order.refunds ?? [],
  };
  const index = current.orders.findIndex((entry) => entry.orderId === trimmed.orderId);
  if (index >= 0) {
    current.orders[index] = {
      ...current.orders[index],
      ...trimmed,
      refunds: trimmed.refunds.length ? trimmed.refunds : current.orders[index]!.refunds,
    };
  } else {
    current.orders.unshift(trimmed);
  }
  current.orders = current.orders.slice(0, 30);
  write(current);
  return current.orders;
}

export function addRefund(orderId: string, refund: SavedRefund): SavedOrder | null {
  const current = loadPersisted();
  const order = current.orders.find((entry) => entry.orderId === orderId);
  if (!order) return null;
  if (!order.refunds.some((entry) => entry.refundId === refund.refundId)) {
    order.refunds.unshift(refund);
  }
  write(current);
  return order;
}

export function findOrder(orderId: string): SavedOrder | null {
  return loadPersisted().orders.find((order) => order.orderId === orderId) ?? null;
}

export function knownOrdersForAgent(): KnownOrder[] {
  return loadPersisted().orders.slice(0, 5).map((order) => ({
    orderId: order.orderId,
    captureId: order.captureId,
    createdAt: order.createdAt,
    summary: order.cart.lines.map((line) => `${line.quantity}× ${line.name}`).join(", "),
    totalCents: order.cart.totalCents,
    status: order.status,
    lines: order.cart.lines.map((line) => ({
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      lineTotalCents: line.lineTotalCents,
      category: line.category,
    })),
  }));
}

function write(state: PersistedState): void {
  window.localStorage.setItem(KEY, JSON.stringify(state));
}

function isPolicy(value: unknown): value is Policy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Policy;
  return (
    Number.isInteger(policy.budgetCapCents) &&
    Number.isInteger(policy.perItemMaxCents) &&
    Array.isArray(policy.blockedCategories) &&
    policy.blockedCategories.every((category) => typeof category === "string")
  );
}

function isOrder(value: unknown): value is SavedOrder {
  if (!value || typeof value !== "object") return false;
  const order = value as SavedOrder;
  return typeof order.orderId === "string" && Boolean(order.cart) && Array.isArray(order.cart.lines);
}
