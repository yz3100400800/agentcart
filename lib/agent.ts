import { priceExplicitCart } from "@/lib/cart";
import { cartSummary, createOrderForCart } from "@/lib/checkout";
import { listCategories } from "@/lib/catalog";
import { formatUsd } from "@/lib/money";
import type { LlmClient, LlmMessage } from "@/lib/llm";
import { evaluatePolicy } from "@/lib/policy";
import { traceStep } from "@/lib/trace";
import { agentTools, handleTool, type AgentState, type RefundOutcome } from "@/lib/tools";
import type { PayPalClient } from "@/lib/paypal";
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

const MAX_ROUNDS = 6;

export type AgentInput = {
  messages: { role: "user" | "assistant"; content: string }[];
  policy: Policy;
  currentCart?: CartRequestLine[];
  knownOrders?: KnownOrder[];
  humanApproval?: HumanApproval;
  hints: RequestHints;
};

export type AgentResult = {
  message: string;
  trace: TraceStep[];
  cart: PricedCart | null;
  policy: PolicyEvaluation | null;
  needsApproval: boolean;
  paypalOrder: { id: string; status: string; approveUrl?: string } | null;
  refund: RefundOutcome | null;
  hints: RequestHints;
};

export async function runAgent(
  input: AgentInput,
  deps: { llm: LlmClient; paypal: PayPalClient; catalog: Product[] },
): Promise<AgentResult> {
  const state: AgentState = {
    cart: null,
    evaluation: null,
    needsApproval: false,
    paypalOrder: null,
    refund: null,
    purchaseIntent: Boolean(input.humanApproval?.approved && input.currentCart?.length),
    refundRequested: false,
    seenOrder: null,
    refundLines: [],
    requestBudgetCents: input.hints.budgetCents,
    trace: [],
  };

  if (input.currentCart?.length) {
    const priced = priceExplicitCart(deps.catalog, input.currentCart);
    if (priced.cart) {
      state.cart = priced.cart;
      state.evaluation = evaluatePolicy(priced.cart, input.policy, state.requestBudgetCents);
    }
  }

  const messages: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt(input, state) },
    ...input.messages.map((message) => ({ role: message.role, content: message.content }) as LlmMessage),
  ];

  let finalText: string | null = null;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let turn;
    try {
      turn = await deps.llm.complete(messages, agentTools);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The model request failed.";
      state.trace.push(traceStep({ kind: "error", title: "Model request failed", detail: message, ok: false }));
      throw error;
    }

    if (turn.toolCalls.length === 0) {
      finalText = turn.content;
      if (finalText?.trim()) {
        state.trace.push(
          traceStep({
            kind: "llm",
            title: "Model reply",
            detail: clip(finalText, 700),
            ok: true,
          }),
        );
      }
      break;
    }

    state.trace.push(
      traceStep({
        kind: "llm",
        title: "Model chose tools",
        detail: turn.toolCalls.map((call) => call.name).join(", "),
        ok: true,
      }),
    );
    messages.push({ role: "assistant", content: turn.content, tool_calls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const result = await handleTool(call.name, call.arguments, {
        catalog: deps.catalog,
        policy: input.policy,
        hints: input.hints,
        humanApproval: input.humanApproval,
        knownOrders: input.knownOrders ?? [],
        paypal: deps.paypal,
        state,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
    if (state.needsApproval && !input.humanApproval?.approved) {
      if (turn.content?.trim()) finalText = turn.content;
      break;
    }
  }

  await maybeCreateOrder(input, deps, state);

  if (state.cart && state.evaluation && !state.evaluation.ok && state.cart.lines.length > 0 && !state.paypalOrder) {
    state.needsApproval = true;
  }

  return {
    message: withApprovalLink(fallbackMessage(state, finalText), state),
    trace: state.trace,
    cart: state.cart,
    policy: state.evaluation,
    needsApproval: state.needsApproval && !state.paypalOrder,
    paypalOrder: state.paypalOrder,
    refund: state.refund,
    hints: input.hints,
  };
}

async function maybeCreateOrder(
  input: AgentInput,
  deps: { paypal: PayPalClient; catalog: Product[] },
  state: AgentState,
): Promise<void> {
  if (
    state.refundRequested ||
    !state.purchaseIntent ||
    !state.cart ||
    state.cart.lines.length === 0 ||
    state.paypalOrder ||
    state.refund
  ) {
    return;
  }
  if (state.needsApproval && !input.humanApproval?.approved) return;
  const result = await createOrderForCart({
    catalog: deps.catalog,
    lines: state.cart.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
    policy: input.policy,
    requestBudgetCents: state.requestBudgetCents,
    humanApproval: input.humanApproval,
    paypal: deps.paypal,
  });
  state.trace.push(
    traceStep({
      kind: "tool",
      title: "Server finished checkout",
      detail: "The model stopped before creating the PayPal order, so AgentCart ran the same checkout check.",
      ok: result.ok,
    }),
  );
  state.trace.push(...result.trace);
  if (result.ok) {
    state.cart = result.cart;
    state.evaluation = result.evaluation;
    state.paypalOrder = result.order;
    state.needsApproval = false;
    return;
  }
  if (result.evaluation) state.evaluation = result.evaluation;
  if (result.code === "POLICY") state.needsApproval = true;
}

export function withApprovalLink(message: string, state: Pick<AgentState, "paypalOrder" | "refund">): string {
  const url = state.paypalOrder?.approveUrl;
  if (!url || state.refund || message.includes(url)) return message;
  return `${message}\n\n[Approve with PayPal](${url})`;
}

function fallbackMessage(state: AgentState, modelText: string | null): string {
  const text = modelText?.trim();
  if (text) return text;
  if (state.refund) {
    const amount = state.refund.amountCents === null ? "the captured amount" : formatUsd(state.refund.amountCents);
    return `Refund ${state.refund.id} is ${state.refund.status} for ${amount}.`;
  }
  if (state.paypalOrder && state.cart) {
    return `PayPal order ${state.paypalOrder.id} is ${state.paypalOrder.status} for ${formatUsd(state.cart.totalCents)}. Approve it with the PayPal button. The payment is not captured until you do.`;
  }
  if (state.needsApproval && state.evaluation) {
    return `This cart needs approval before I create a PayPal order. ${state.evaluation.violations.map((violation) => violation.message).join(" ")}`;
  }
  if (state.cart?.lines.length) return `I put together ${cartSummary(state.cart)}`;
  return "I could not complete that request. Try naming the products and a budget.";
}

export function buildSystemPrompt(input: AgentInput, state: AgentState): string {
  const policy = input.policy;
  const hints = [
    input.hints.budgetCents !== undefined ? `budget ${formatUsd(input.hints.budgetCents)}` : null,
    input.hints.teamSize ? `team size ${input.hints.teamSize}` : null,
    input.hints.days ? `${input.hints.days} office days` : null,
  ].filter(Boolean);
  const cart = state.cart
    ? state.cart.lines.map((line) => `${line.quantity}× ${line.name} (${line.sku})`).join(", ") + ` = ${formatUsd(state.cart.totalCents)}`
    : "empty";
  const orders = (input.knownOrders ?? []).length
    ? input.knownOrders!
        .map((order) => `${order.orderId} capture ${order.captureId ?? "unknown"} ${formatUsd(order.totalCents)} — ${order.summary}`)
        .join("\n")
    : "None.";
  const approval = input.humanApproval?.approved
    ? "The person has approved the current cart. Create the PayPal order."
    : "There is no human approval yet.";

  return [
    "You are AgentCart, a purchasing agent for a fictional office catalog. You pay only through PayPal sandbox.",
    "Use tools. Never invent SKUs or prices. The server prices every cart from the catalog.",
    "Shopping: search_catalog if you need options, then plan_cart or propose_cart. If policy passes, create_paypal_order. If policy fails, request_human_approval and explain the violations. Do not claim the payment is captured.",
    "A week of office coffee means days=5. Keep the stated budget.",
    "Refunds: list_known_orders if needed, get_paypal_order, then refund_capture. Use itemQuery for a partial refund such as cups. Do not create a new order on a refund turn.",
    `Categories: ${listCategories().join(", ")}.`,
    `Policy: budget cap ${formatUsd(policy.budgetCapCents)}, per-item max ${formatUsd(policy.perItemMaxCents)}, blocked categories: ${policy.blockedCategories.join(", ") || "none"}.`,
    `Hints from the latest request: ${hints.join("; ") || "none"}.`,
    `Current cart: ${cart}.`,
    approval,
    `Saved orders:\n${orders}`,
  ].join("\n");
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
