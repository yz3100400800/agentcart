export type ProductKind = "per_person" | "consumable" | "shared";

export type Product = {
  sku: string;
  name: string;
  brand: string;
  description: string;
  category: string;
  priceCents: number;
  kind: ProductKind;
  servingsPerUnit?: number;
  servingsPerPersonPerDay?: number;
  maxQty: number;
  tags: string[];
};

export type Policy = {
  budgetCapCents: number;
  perItemMaxCents: number;
  blockedCategories: string[];
};

export type CartRequestLine = {
  sku: string;
  quantity: number;
};

export type CartLine = {
  sku: string;
  name: string;
  brand: string;
  category: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
};

export type PricedCart = {
  lines: CartLine[];
  totalCents: number;
  currency: "USD";
  teamSize?: number;
  days?: number;
  notes?: string[];
};

export type PolicyViolationCode =
  | "BUDGET_CAP"
  | "PER_ITEM_MAX"
  | "BLOCKED_CATEGORY"
  | "EMPTY_CART";

export type PolicyViolation = {
  code: PolicyViolationCode;
  message: string;
  sku?: string;
  category?: string;
};

export type PolicyEvaluation = {
  ok: boolean;
  violations: PolicyViolation[];
  effectiveBudgetCents: number;
};

export type HumanApproval = {
  approved: boolean;
  lines: CartRequestLine[];
  note?: string;
};

export type TraceKind = "llm" | "tool" | "policy" | "paypal" | "approval" | "error";

export type TraceStep = {
  id: string;
  at: string;
  kind: TraceKind;
  title: string;
  detail: string;
  toolName?: string;
  ok?: boolean;
};

export type KnownOrderLine = {
  sku: string;
  name: string;
  quantity: number;
  lineTotalCents: number;
  category?: string;
};

export type KnownOrder = {
  orderId: string;
  captureId?: string;
  createdAt: string;
  summary: string;
  totalCents: number;
  status?: string;
  lines: KnownOrderLine[];
};

export type RequestHints = {
  budgetCents?: number;
  teamSize?: number;
  days?: number;
};

export type CatalogSummary = {
  sku: string;
  name: string;
  brand: string;
  category: string;
  priceCents: number;
  kind: ProductKind;
};

export type SavedRefund = {
  refundId: string;
  amountCents: number | null;
  note?: string;
  at: string;
};

export type SavedOrder = {
  orderId: string;
  captureId?: string;
  createdAt: string;
  cart: PricedCart;
  requestText: string;
  trace: TraceStep[];
  policyEvaluation: PolicyEvaluation | null;
  approvedByHuman: boolean;
  refunds: SavedRefund[];
  status?: string;
};
