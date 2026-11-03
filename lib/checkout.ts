import { priceExplicitCart } from "@/lib/cart";
import { formatUsd } from "@/lib/money";
import { PayPalApiError, type PayPalClient } from "@/lib/paypal";
import { decideCheckout } from "@/lib/policy";
import { traceStep } from "@/lib/trace";
import type {
  CartRequestLine,
  HumanApproval,
  Policy,
  PolicyEvaluation,
  PricedCart,
  TraceStep,
} from "@/lib/types";

export type CreatedPayPalOrder = {
  id: string;
  status: string;
  approveUrl?: string;
};

export type CreateOrderResult =
  | {
      ok: true;
      cart: PricedCart;
      evaluation: PolicyEvaluation;
      via: "policy" | "human";
      order: CreatedPayPalOrder;
      trace: TraceStep[];
    }
  | {
      ok: false;
      code: "INVALID_CART" | "POLICY" | "PAYPAL";
      message: string;
      cart?: PricedCart;
      evaluation?: PolicyEvaluation;
      trace: TraceStep[];
    };

export async function createOrderForCart(args: {
  catalog: Parameters<typeof priceExplicitCart>[0];
  lines: CartRequestLine[];
  policy: Policy;
  requestBudgetCents?: number;
  humanApproval?: HumanApproval;
  paypal: PayPalClient;
}): Promise<CreateOrderResult> {
  const priced = priceExplicitCart(args.catalog, args.lines);
  if (!priced.cart) {
    const message = priced.errors.map((error) => error.message).join(" ") || "The cart could not be priced.";
    return {
      ok: false,
      code: "INVALID_CART",
      message,
      trace: [traceStep({ kind: "error", title: "Cart rejected", detail: message, ok: false })],
    };
  }

  const decision = decideCheckout(
    priced.cart,
    args.policy,
    args.requestBudgetCents,
    args.humanApproval,
  );
  const summary = cartSummary(priced.cart);
  if (!decision.allowed) {
    const message = decision.evaluation.violations.map((violation) => violation.message).join(" ");
    return {
      ok: false,
      code: "POLICY",
      message,
      cart: priced.cart,
      evaluation: decision.evaluation,
      trace: [
        traceStep({
          kind: "policy",
          title: "PayPal order blocked by policy",
          detail: `${summary} ${message}`,
          ok: false,
        }),
      ],
    };
  }

  const via = decision.via === "human" ? "human" : "policy";
  const viaDetail =
    via === "human"
      ? "A person approved this cart, so the policy exception is allowed."
      : "The cart is inside policy.";

  try {
    const invoiceId = `AC-${crypto.randomUUID()}`;
    const order = await args.paypal.createOrder({
      lines: priced.cart.lines,
      customId: invoiceId,
      invoiceId,
    });
    if (!order.id) {
      throw new PayPalApiError("PayPal did not return an order id.", 502);
    }
    return {
      ok: true,
      cart: priced.cart,
      evaluation: decision.evaluation,
      via,
      order: { id: order.id, status: order.status, approveUrl: order.approveUrl },
      trace: [
        traceStep({
          kind: "policy",
          title: via === "human" ? "Human approval accepted" : "Policy passed",
          detail: viaDetail,
          ok: true,
        }),
        traceStep({
          kind: "paypal",
          title: "Created PayPal order",
          detail: `${order.id} is ${order.status}. Total ${formatUsd(priced.cart.totalCents)}. The buyer still has to approve before capture.`,
          toolName: "create_paypal_order",
          ok: true,
        }),
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "PayPal order creation failed.";
    return {
      ok: false,
      code: "PAYPAL",
      message,
      cart: priced.cart,
      evaluation: decision.evaluation,
      trace: [
        traceStep({
          kind: "error",
          title: "PayPal order failed",
          detail: message,
          toolName: "create_paypal_order",
          ok: false,
        }),
      ],
    };
  }
}

export function cartSummary(cart: PricedCart): string {
  const lines = cart.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ");
  return `${lines} · ${formatUsd(cart.totalCents)}.`;
}
