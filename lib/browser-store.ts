import { DEFAULT_POLICY } from "@/lib/policy";
import type { KnownOrder, Policy, PolicyEvaluation, PricedCart, SavedOrder, SavedRefund, TraceStep } from "@/lib/types";

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

const DESK_KEY = "agentcart.desk.v1";

export type DeskState = {
  messages: { id: string; role: "user" | "assistant"; content: string }[];
  trace: TraceStep[];
  cart: PricedCart | null;
  policyEval: PolicyEvaluation | null;
  needsApproval: boolean;
  order: { id: string; status: string; approveUrl?: string } | null;
  captureId: string | null;
  requestBudgetCents?: number;
  requestText: string;
};

export function emptyDesk(): DeskState {
  return { messages: [], trace: [], cart: null, policyEval: null, needsApproval: false, order: null, captureId: null, requestText: "" };
}

export function loadDesk(storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.localStorage): DeskState {
  if (!storage) return emptyDesk();
  try {
    const raw = storage.getItem(DESK_KEY);
    if (!raw) return emptyDesk();
    const parsed = JSON.parse(raw) as Partial<DeskState>;
    const base = emptyDesk();
    return {
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        : base.messages,
      trace: Array.isArray(parsed.trace) ? parsed.trace : base.trace,
      cart: parsed.cart && Array.isArray(parsed.cart.lines) ? parsed.cart : null,
      policyEval: parsed.policyEval ?? null,
      needsApproval: Boolean(parsed.needsApproval),
      order: parsed.order && typeof parsed.order.id === "string" ? parsed.order : null,
      captureId: typeof parsed.captureId === "string" ? parsed.captureId : null,
      requestBudgetCents: Number.isInteger(parsed.requestBudgetCents) ? parsed.requestBudgetCents : undefined,
      requestText: typeof parsed.requestText === "string" ? parsed.requestText : "",
    };
  } catch {
    return emptyDesk();
  }
}

export function saveDesk(desk: DeskState, storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.localStorage): void {
  if (!storage) return;
  const trimmed: DeskState = {
    ...desk,
    messages: desk.messages.slice(-40).map((m) => ({ ...m, content: m.content.slice(0, 4000) })),
    trace: desk.trace.slice(-80).map((step) => ({ ...step, detail: step.detail.slice(0, 1500) })),
  };
  try {
    storage.setItem(DESK_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full or blocked. The desk still works for this tab.
  }
}

export function clearDesk(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(DESK_KEY);
}
