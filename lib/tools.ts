import { buildSuggestedCart, priceExplicitCart, searchCatalog } from "@/lib/cart";
import { cartSummary, createOrderForCart } from "@/lib/checkout";
import { formatUsd, dollarsToCents } from "@/lib/money";
import { PayPalApiError, type NormalizedOrder, type PayPalClient } from "@/lib/paypal";
import { evaluatePolicy } from "@/lib/policy";
import { refundAmountForQuery, type RefundableLine } from "@/lib/refund-match";
import { traceStep } from "@/lib/trace";
import type { ToolDefinition } from "@/lib/llm";
import { resolveRequestBudget } from "@/lib/intent";
import type {
  CartRequestLine,
  HumanApproval,
  KnownOrder,
  Policy,
  PolicyEvaluation,
  PricedCart,
  Product,
  RequestHints,
  TraceStep,
} from "@/lib/types";

export type RefundOutcome = {
  id: string;
  status: string;
  amountCents: number | null;
  captureId: string;
  orderId?: string;
  note?: string;
};

export type AgentState = {
  cart: PricedCart | null;
  evaluation: PolicyEvaluation | null;
  needsApproval: boolean;
  approvalReason?: string;
  paypalOrder: { id: string; status: string; approveUrl?: string } | null;
  refund: RefundOutcome | null;
  purchaseIntent: boolean;
  refundRequested: boolean;
  seenOrder: NormalizedOrder | null;
  refundLines: RefundableLine[];
  requestBudgetCents?: number;
  trace: TraceStep[];
};

export type ToolContext = {
  catalog: Product[];
  policy: Policy;
  hints: RequestHints;
  humanApproval?: HumanApproval;
  knownOrders: KnownOrder[];
  paypal: PayPalClient;
  state: AgentState;
};

export const agentTools: ToolDefinition[] = [
  {
    name: "search_catalog",
    description: "Search the fictional office catalog. Prices are fixed. Do not invent products.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product words such as coffee, cups, or notebooks." },
        category: { type: "string", description: "Optional category from the system prompt." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_cart",
    description:
      "Build a priced cart for a team from catalog goals. Quantities follow team size and days, then shrink consumables to the budget. Per-person items stay at one per person.",
    parameters: {
      type: "object",
      properties: {
        goals: {
          type: "array",
          items: { type: "string" },
          description: "Short product goals, one per need. Example: [\"coffee beans\", \"cups\"].",
        },
        teamSize: { type: "integer" },
        days: { type: "integer", description: "Office days to cover. Use 5 for next week." },
        budgetDollars: { type: "number", description: "Budget in dollars from the user, or the policy cap if they gave none." },
      },
      required: ["goals", "teamSize", "days", "budgetDollars"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_cart",
    description: "Replace the cart with explicit catalog SKUs and quantities. The server sets prices.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              quantity: { type: "integer" },
            },
            required: ["sku", "quantity"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "request_human_approval",
    description: "Pause for a person when policy fails. Call this instead of retrying order creation.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "create_paypal_order",
    description:
      "Create a PayPal sandbox order for the current cart. Refuses when policy fails unless the person already approved that exact cart. Capture happens later in the browser.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_paypal_order",
    description: "Read a PayPal order, including capture ids and line items. Call this before a refund.",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_known_orders",
    description: "List orders saved in this browser, with capture ids and line totals.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "refund_capture",
    description:
      "Refund a captured PayPal payment in full, by item query (such as cups), or by an explicit dollar amount. Requires get_paypal_order earlier in this turn.",
    parameters: {
      type: "object",
      properties: {
        captureId: { type: "string" },
        itemQuery: { type: "string", description: "Match cart lines, for example cups." },
        amountDollars: { type: "number" },
        note: { type: "string" },
      },
      required: ["captureId"],
      additionalProperties: false,
    },
  },
];

export async function handleTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<{ content: string }> {
  const parsed = readArgs(rawArguments);
  if (!parsed.ok) {
    return finish(ctx, name, false, "Tool arguments rejected", parsed.error, { error: parsed.error });
  }
  const args = parsed.value;
  try {
    switch (name) {
      case "search_catalog":
        return search(ctx, args);
      case "plan_cart":
        return plan(ctx, args);
      case "propose_cart":
        return propose(ctx, args);
      case "request_human_approval":
        return requestApproval(ctx, args);
      case "create_paypal_order":
        return createOrder(ctx);
      case "get_paypal_order":
        return getOrder(ctx, args);
      case "list_known_orders":
        return listOrders(ctx);
      case "refund_capture":
        return refund(ctx, args);
      default:
        return finish(ctx, name, false, "Unknown tool", name, { error: `Unknown tool ${name}.` });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool failed.";
    return finish(ctx, name, false, "Tool failed", message, { error: message });
  }
}

function search(ctx: ToolContext, args: Record<string, unknown>): { content: string } {
  const query = stringArg(args.query);
  if (!query) return finish(ctx, "search_catalog", false, "Search needs a query", "Missing query.", { error: "Missing query." });
  const category = stringArg(args.category);
  const matches = searchCatalog(ctx.catalog, query, category || undefined, 8);
  const products = matches.map(summarizeProduct);
  const detail = products.length
    ? products.map((product) => `${product.sku} ${product.name} ${formatUsd(product.priceCents)}`).join("; ")
    : "No matches.";
  return finish(ctx, "search_catalog", true, `Searched catalog for “${query}”`, detail, { products });
}

function plan(ctx: ToolContext, args: Record<string, unknown>): { content: string } {
  const goals = stringList(args.goals).slice(0, 6);
  if (goals.length === 0) {
    return finish(ctx, "plan_cart", false, "Cart plan needs goals", "Provide at least one goal.", { error: "Provide at least one goal." });
  }
  const teamSize = intArg(args.teamSize, 1, 100);
  const days = intArg(args.days, 1, 30);
  const budgetDollars = numberArg(args.budgetDollars);
  if (!teamSize || !days || budgetDollars === undefined || budgetDollars <= 0) {
    return finish(ctx, "plan_cart", false, "Cart plan rejected", "teamSize, days, and budgetDollars are required.", {
      error: "teamSize, days, and budgetDollars are required.",
    });
  }
  const toolBudget = dollarsToCents(budgetDollars);
  ctx.state.requestBudgetCents = resolveRequestBudget(ctx.hints.budgetCents, toolBudget);
  const built = buildSuggestedCart(ctx.catalog, {
    goals,
    teamSize,
    days,
    budgetCents: ctx.state.requestBudgetCents ?? toolBudget,
    policy: ctx.policy,
  });
  return rememberCart(ctx, "plan_cart", built.cart, built.notes);
}

function propose(ctx: ToolContext, args: Record<string, unknown>): { content: string } {
  const items = lineArgs(args.items);
  if ("error" in items) return finish(ctx, "propose_cart", false, "Cart proposal rejected", items.error, { error: items.error });
  const priced = priceExplicitCart(ctx.catalog, items);
  if (!priced.cart) {
    const message = priced.errors.map((error) => error.message).join(" ");
    return finish(ctx, "propose_cart", false, "Cart proposal rejected", message, { error: message });
  }
  if (ctx.hints.budgetCents !== undefined) {
    ctx.state.requestBudgetCents = resolveRequestBudget(ctx.hints.budgetCents, ctx.state.requestBudgetCents);
  }
  return rememberCart(ctx, "propose_cart", priced.cart, []);
}

function requestApproval(ctx: ToolContext, args: Record<string, unknown>): { content: string } {
  if (!ctx.state.cart || ctx.state.cart.lines.length === 0) {
    return finish(ctx, "request_human_approval", false, "Nothing to approve", "Propose a cart first.", {
      error: "Propose a cart first.",
    });
  }
  const evaluation = evaluatePolicy(ctx.state.cart, ctx.policy, ctx.state.requestBudgetCents);
  ctx.state.evaluation = evaluation;
  if (evaluation.ok) {
    return finish(ctx, "request_human_approval", true, "Approval is unnecessary", "Policy already passes. Create the PayPal order.", {
      policyOk: true,
      message: "Policy already passes. Call create_paypal_order.",
    });
  }
  ctx.state.needsApproval = true;
  ctx.state.approvalReason = stringArg(args.reason) || evaluation.violations.map((violation) => violation.message).join(" ");
  return finish(ctx, "request_human_approval", true, "Asked a person to approve", ctx.state.approvalReason, {
    needsApproval: true,
    violations: evaluation.violations,
    cart: publicCart(ctx.state.cart),
  });
}

async function createOrder(ctx: ToolContext): Promise<{ content: string }> {
  if (!ctx.state.cart) {
    return finish(ctx, "create_paypal_order", false, "No cart to pay for", "Plan or propose a cart first.", {
      error: "Plan or propose a cart first.",
    });
  }
  const result = await createOrderForCart({
    catalog: ctx.catalog,
    lines: ctx.state.cart.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    policy: ctx.policy,
    requestBudgetCents: ctx.state.requestBudgetCents,
    humanApproval: ctx.humanApproval,
    paypal: ctx.paypal,
  });
  ctx.state.trace.push(...result.trace);
  if (!result.ok) {
    if (result.evaluation) ctx.state.evaluation = result.evaluation;
    if (result.code === "POLICY") ctx.state.needsApproval = true;
    return {
      content: payload({
        error: result.message,
        code: result.code,
        violations: result.evaluation?.violations ?? [],
      }),
    };
  }
  ctx.state.cart = result.cart;
  ctx.state.evaluation = result.evaluation;
  ctx.state.paypalOrder = result.order;
  ctx.state.needsApproval = false;
  return {
    content: payload({
      orderId: result.order.id,
      status: result.order.status,
      approveUrl: result.order.approveUrl ?? null,
      total: formatUsd(result.cart.totalCents),
      via: result.via,
      message: "Order created. Tell the buyer to approve it with the PayPal button. Do not say it has been paid.",
    }),
  };
}

async function getOrder(ctx: ToolContext, args: Record<string, unknown>): Promise<{ content: string }> {
  const orderId = stringArg(args.orderId);
  if (!orderId) return finish(ctx, "get_paypal_order", false, "Missing order id", "orderId is required.", { error: "orderId is required." });
  try {
    const order = await ctx.paypal.getOrder(orderId);
    ctx.state.seenOrder = order;
    ctx.state.refundLines = refundLines(order, ctx.knownOrders);
    const detail = `${order.id} is ${order.status}. Captures: ${
      order.captures.map((capture) => `${capture.id} ${capture.status} ${formatUsd(capture.amountCents)}`).join(", ") || "none"
    }.`;
    return finish(ctx, "get_paypal_order", true, "Fetched PayPal order", detail, {
      id: order.id,
      status: order.status,
      amountCents: order.amountCents,
      items: ctx.state.refundLines,
      captures: order.captures,
      refunds: order.refunds,
    });
  } catch (error) {
    const message = error instanceof PayPalApiError ? error.message : "Could not read the PayPal order.";
    return finish(ctx, "get_paypal_order", false, "PayPal order lookup failed", message, { error: message });
  }
}

function listOrders(ctx: ToolContext): { content: string } {
  const orders = ctx.knownOrders.map((order) => ({
    orderId: order.orderId,
    captureId: order.captureId ?? null,
    status: order.status ?? null,
    total: formatUsd(order.totalCents),
    summary: order.summary,
    lines: order.lines,
  }));
  const detail = orders.length ? orders.map((order) => `${order.orderId} ${order.summary}`).join("; ") : "No saved orders.";
  return finish(ctx, "list_known_orders", true, "Listed saved orders", detail, { orders });
}

async function refund(ctx: ToolContext, args: Record<string, unknown>): Promise<{ content: string }> {
  ctx.state.refundRequested = true;
  const captureId = stringArg(args.captureId);
  if (!captureId) {
    return finish(ctx, "refund_capture", false, "Missing capture id", "captureId is required.", { error: "captureId is required." });
  }
  if (!ctx.state.seenOrder) {
    return finish(ctx, "refund_capture", false, "Refund needs a fresh order lookup", "Call get_paypal_order before refunding.", {
      error: "Call get_paypal_order before refunding.",
    });
  }
  const capture = ctx.state.seenOrder.captures.find((entry) => entry.id === captureId);
  if (!capture) {
    return finish(ctx, "refund_capture", false, "Capture not on the fetched order", `${captureId} was not on ${ctx.state.seenOrder.id}.`, {
      error: "That capture id was not on the order fetched this turn.",
    });
  }
  if (capture.status !== "COMPLETED" && capture.status !== "PARTIALLY_REFUNDED") {
    return finish(ctx, "refund_capture", false, "Capture cannot be refunded", `Capture status is ${capture.status}.`, {
      error: `Capture status is ${capture.status}. Only completed captures can be refunded.`,
    });
  }

  const itemQuery = stringArg(args.itemQuery);
  const amountDollars = numberArg(args.amountDollars);
  let amountCents: number | undefined;
  if (itemQuery) {
    const quoted = refundAmountForQuery(ctx.state.refundLines, itemQuery);
    if ("error" in quoted) {
      return finish(ctx, "refund_capture", false, "Refund items not found", quoted.error, { error: quoted.error });
    }
    amountCents = quoted.amountCents;
  } else if (amountDollars !== undefined) {
    amountCents = dollarsToCents(amountDollars);
  }
  if (amountCents !== undefined && amountCents > capture.amountCents) {
    return finish(
      ctx,
      "refund_capture",
      false,
      "Refund is larger than the capture",
      `${formatUsd(amountCents)} is above the captured ${formatUsd(capture.amountCents)}.`,
      { error: "Refund amount is larger than the captured amount." },
    );
  }

  const note = stringArg(args.note) || (itemQuery ? `Refund for ${itemQuery}` : "AgentCart refund");
  try {
    const result = await ctx.paypal.refundCapture({
      captureId,
      amountCents,
      note,
      requestId: `refund-${crypto.randomUUID()}`,
    });
    ctx.state.refund = {
      id: result.id,
      status: result.status,
      amountCents: result.amountCents,
      captureId,
      orderId: ctx.state.seenOrder.id,
      note,
    };
    const detail = `${result.id} ${result.status} for ${formatUsd(result.amountCents ?? amountCents ?? capture.amountCents)} on capture ${captureId}.`;
    return finish(ctx, "refund_capture", true, "Submitted PayPal refund", detail, {
      refundId: result.id,
      status: result.status,
      amountCents: result.amountCents,
      captureId,
      orderId: ctx.state.seenOrder.id,
      note,
    });
  } catch (error) {
    const message = error instanceof PayPalApiError ? error.message : "PayPal refund failed.";
    return finish(ctx, "refund_capture", false, "PayPal refund failed", message, { error: message });
  }
}

function rememberCart(ctx: ToolContext, toolName: string, cart: PricedCart, notes: string[]): { content: string } {
  const evaluation = evaluatePolicy(cart, ctx.policy, ctx.state.requestBudgetCents);
  ctx.state.cart = { ...cart, notes };
  ctx.state.evaluation = evaluation;
  ctx.state.purchaseIntent = cart.lines.length > 0;
  ctx.state.paypalOrder = null;
  if (!evaluation.ok && cart.lines.length > 0) ctx.state.needsApproval = false;
  const detail = [cartSummary(cart), ...notes, evaluation.ok ? "Policy passed." : evaluation.violations.map((violation) => violation.message).join(" ")]
    .filter(Boolean)
    .join(" ");
  return finish(ctx, toolName, true, evaluation.ok ? "Built a cart inside policy" : "Built a cart that needs approval", detail, {
    cart: publicCart(cart),
    notes,
    policy: evaluation,
  });
}

function finish(
  ctx: ToolContext,
  toolName: string,
  ok: boolean,
  title: string,
  detail: string,
  body: Record<string, unknown>,
): { content: string } {
  ctx.state.trace.push(
    traceStep({
      kind: toolName.includes("paypal") || toolName.includes("refund") ? "paypal" : toolName.includes("approval") ? "approval" : "tool",
      title,
      detail,
      toolName,
      ok,
    }),
  );
  return { content: payload(body) };
}

function refundLines(order: NormalizedOrder, known: KnownOrder[]): RefundableLine[] {
  const saved = known.find((entry) => entry.orderId === order.id);
  return order.items.map((item) => {
    const match = saved?.lines.find((line) => line.sku === item.sku);
    return {
      sku: item.sku ?? match?.sku ?? "",
      name: item.name || match?.name || "Item",
      quantity: item.quantity,
      lineTotalCents: item.lineTotalCents || match?.lineTotalCents || 0,
      category: match?.category,
    };
  });
}

function publicCart(cart: PricedCart) {
  return {
    totalCents: cart.totalCents,
    total: formatUsd(cart.totalCents),
    teamSize: cart.teamSize ?? null,
    days: cart.days ?? null,
    lines: cart.lines.map((line) => ({
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
      category: line.category,
    })),
  };
}

function summarizeProduct(product: Product) {
  return {
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    category: product.category,
    priceCents: product.priceCents,
    price: formatUsd(product.priceCents),
    kind: product.kind,
  };
}

function payload(body: Record<string, unknown>): string {
  const json = JSON.stringify(body);
  return json.length > 6000 ? `${json.slice(0, 6000)}…` : json;
}

function readArgs(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Tool arguments must be an object." };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON." };
  }
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
}

function intArg(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function numberArg(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function lineArgs(value: unknown): CartRequestLine[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: "Provide at least one item." };
  const lines: CartRequestLine[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { error: "Each item needs a sku and quantity." };
    const record = entry as Record<string, unknown>;
    const sku = stringArg(record.sku);
    const quantity = intArg(record.quantity, 1, 100);
    if (!sku || !quantity) return { error: "Each item needs a sku and a positive quantity." };
    lines.push({ sku, quantity });
  }
  return lines;
}
