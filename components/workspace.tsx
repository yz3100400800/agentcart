"use client";

import { useEffect, useRef, useState } from "react";
import PayPalCheckout from "@/components/paypal-checkout";
import PolicyDrawer from "@/components/policy-drawer";
import TraceTimeline from "@/components/trace-timeline";
import { knownOrdersForAgent, savePolicy, upsertOrder, addRefund, loadPersisted, loadDesk, saveDesk, clearDesk } from "@/lib/browser-store";
import { formatUsd } from "@/lib/money";
import { DEFAULT_POLICY } from "@/lib/policy";
import type {
  CatalogSummary,
  Policy,
  PolicyEvaluation,
  PricedCart,
  SavedOrder,
  TraceStep,
} from "@/lib/types";

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };
type PayPalOrder = { id: string; status: string; approveUrl?: string };
type PublicConfig = {
  paypalEnv: "sandbox" | "live";
  paypalClientId: string;
  paypalConfigured: boolean;
  llmConfigured: boolean;
  llmModel: string;
  webhookVerification: "enabled" | "skipped";
};
type AgentPayload = {
  message?: string;
  error?: string;
  trace?: TraceStep[];
  cart?: PricedCart | null;
  policy?: PolicyEvaluation | null;
  needsApproval?: boolean;
  paypalOrder?: PayPalOrder | null;
  refund?: {
    id: string;
    status: string;
    amountCents: number | null;
    captureId: string;
    orderId?: string;
    note?: string;
  } | null;
  hints?: { budgetCents?: number };
};

const EXAMPLES = [
  "Order coffee beans and cups for a 5-person team next week, budget $80",
  "Notebooks and gel pens for 5 people, budget $40",
  "Refund the cups, they arrived broken",
];

export default function Workspace({
  categories,
  catalog,
}: {
  categories: string[];
  catalog: CatalogSummary[];
}) {
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [cart, setCart] = useState<PricedCart | null>(null);
  const [policyEval, setPolicyEval] = useState<PolicyEvaluation | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [order, setOrder] = useState<PayPalOrder | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [requestBudgetCents, setRequestBudgetCents] = useState<number | undefined>();
  const [requestText, setRequestText] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = loadPersisted();
    setPolicy(saved.policy);
    const desk = loadDesk();
    setMessages(desk.messages);
    setTrace(desk.trace);
    setCart(desk.cart);
    setPolicyEval(desk.policyEval);
    setNeedsApproval(desk.needsApproval);
    setOrder(desk.order);
    setCaptureId(desk.captureId);
    setRequestBudgetCents(desk.requestBudgetCents);
    setRequestText(desk.requestText);
    setHydrated(true);
    fetch("/api/config")
      .then((response) => response.json())
      .then((body: PublicConfig) => setConfig(body))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveDesk({ messages, trace, cart, policyEval, needsApproval, order, captureId, requestBudgetCents, requestText });
  }, [hydrated, messages, trace, cart, policyEval, needsApproval, order, captureId, requestBudgetCents, requestText]);

  function resetDesk() {
    clearDesk();
    setMessages([]);
    setTrace([]);
    setCart(null);
    setPolicyEval(null);
    setNeedsApproval(false);
    setOrder(null);
    setCaptureId(null);
    setRequestBudgetCents(undefined);
    setRequestText("");
    setError(null);
  }

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const history = [...messages, { id: crypto.randomUUID(), role: "user" as const, content }];
    setMessages(history);
    setDraft("");
    setBusy(true);
    setError(null);
    setRequestText(content);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map(({ role, content: message }) => ({ role, content: message })),
          policy,
          currentCart: cart?.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })) ?? [],
          knownOrders: knownOrdersForAgent(),
        }),
      });
      const data = (await response.json()) as AgentPayload;
      if (!response.ok) {
        setError(data.error || "The agent could not answer.");
        return;
      }
      applyAgentResult(data, content, false);
    } catch {
      setError("The agent request did not finish. Check the server and try again.");
    } finally {
      setBusy(false);
    }
  }

  function applyAgentResult(data: AgentPayload, content: string, approved: boolean) {
    if (data.message) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: data.message! }]);
    }
    if (data.trace?.length) {
      setTrace((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          kind: "llm",
          title: "New request",
          detail: content,
          ok: true,
        },
        ...data.trace!,
      ]);
    }
    if (data.cart) setCart(data.cart);
    if (data.policy) setPolicyEval(data.policy);
    setNeedsApproval(Boolean(data.needsApproval));
    setRequestBudgetCents(data.hints?.budgetCents);
    if (data.paypalOrder) {
      setOrder(data.paypalOrder);
      setCaptureId(null);
      if (data.cart) {
        saveOrder({
          orderId: data.paypalOrder.id,
          createdAt: new Date().toISOString(),
          cart: data.cart,
          requestText: content,
          trace: data.trace ?? [],
          policyEvaluation: data.policy ?? null,
          approvedByHuman: approved,
          refunds: [],
          status: data.paypalOrder.status,
        });
      }
    } else if (data.cart && !data.refund) {
      setOrder(null);
      setCaptureId(null);
    }
    if (data.refund?.orderId) {
      addRefund(data.refund.orderId, {
        refundId: data.refund.id,
        amountCents: data.refund.amountCents,
        note: data.refund.note,
        at: new Date().toISOString(),
      });
    }
  }

  async function checkout(approved: boolean) {
    if (!cart || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: cart.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
          policy,
          requestBudgetCents,
          humanApproval: approved
            ? {
                approved: true,
                lines: cart.lines.map((line) => ({ sku: line.sku, quantity: line.quantity })),
                note: "Approved from the cart",
              }
            : undefined,
        }),
      });
      const data = (await response.json()) as AgentPayload & {
        ok?: boolean;
        message?: string;
        order?: PayPalOrder;
        evaluation?: PolicyEvaluation;
        via?: string;
      };
      if (!response.ok || data.ok === false) {
        setError(data.message || data.error || "Checkout was refused.");
        if (data.evaluation) setPolicyEval(data.evaluation);
        if (data.trace?.length) setTrace((current) => [...current, ...data.trace!]);
        if (data.evaluation && !data.evaluation.ok) setNeedsApproval(true);
        return;
      }
      const paypalOrder = data.order;
      if (!paypalOrder || !data.cart) return;
      setOrder(paypalOrder);
      setCart(data.cart);
      setPolicyEval(data.evaluation ?? null);
      setNeedsApproval(false);
      setCaptureId(null);
      if (data.trace?.length) setTrace((current) => [...current, ...data.trace!]);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `PayPal order ${paypalOrder.id} is ready. Approve it with the PayPal button. The payment is not captured yet.`,
        },
      ]);
      saveOrder({
        orderId: paypalOrder.id,
        createdAt: new Date().toISOString(),
        cart: data.cart,
        requestText,
        trace: data.trace ?? trace,
        policyEvaluation: data.evaluation ?? null,
        approvedByHuman: approved,
        refunds: [],
        status: paypalOrder.status,
      });
    } catch {
      setError("Checkout did not finish.");
    } finally {
      setBusy(false);
    }
  }

  function saveOrder(next: SavedOrder) {
    upsertOrder(next);
  }

  const visibleCatalog = catalog.filter((product) => {
    const hay = `${product.name} ${product.brand} ${product.category} ${product.sku}`.toLowerCase();
    return hay.includes(catalogQuery.trim().toLowerCase());
  });
  const policyOk = Boolean(policyEval?.ok && cart && cart.lines.length > 0);

  return (
    <div className="workspace">
      <section className="panel chat" aria-label="Agent conversation">
        <div className="chat-head">
          <div>
            <p className="kicker">Desk</p>
            <h1>What should we buy?</h1>
            <p className="lede">
              Ask in plain language. The agent shops the demo catalog, checks policy, and opens a real PayPal sandbox order.
            </p>
          </div>
          <button type="button" className="ghost" onClick={() => setPolicyOpen(true)} data-testid="open-policy">
            Policy
          </button>
        </div>
        {config && (!config.llmConfigured || !config.paypalConfigured) ? (
          <div className="info-banner" style={{ margin: "12px 20px 0" }}>
            {!config.llmConfigured ? "LLM_API_KEY is not set, so the agent cannot run. " : ""}
            {!config.paypalConfigured ? "PayPal credentials are not set, so orders cannot be created. " : ""}
            Model: {config.llmModel}. Webhook verification is {config.webhookVerification}.
          </div>
        ) : null}
        {config?.paypalEnv === "live" ? (
          <div className="warn-banner" style={{ margin: "12px 20px 0" }}>
            PAYPAL_ENV is live. This demo is meant for sandbox.
          </div>
        ) : null}
        <div className="prompts">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="prompt" onClick={() => send(example)} disabled={busy}>
              {example}
            </button>
          ))}
          {messages.length > 0 ? (
            <button type="button" className="prompt" onClick={resetDesk} disabled={busy}>
              New request (clear desk)
            </button>
          ) : null}
        </div>
        <div className="transcript" ref={transcriptRef} aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty">
              Try the coffee order. With the default policy it should land near $74 and wait for the sandbox buyer to approve.
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`bubble ${message.role}`}>
                {message.content}
              </div>
            ))
          )}
          {busy ? <div className="bubble assistant">Working through tools…</div> : null}
        </div>
        {error ? <p className="error-banner" style={{ margin: "0 20px 12px" }}>{error}</p> : null}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <label className="sr-only" htmlFor="request">Request</label>
          <textarea
            id="request"
            data-testid="composer"
            value={draft}
            placeholder="Order coffee beans and cups for a 5-person team next week, budget $80"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <button className="send" type="submit" disabled={busy || !draft.trim()} data-testid="send">
            {busy ? "Working" : "Send"}
          </button>
        </form>
        <div className="trace">
          <div className="split">
            <h2>Agent trace</h2>
            {trace.length > 0 ? (
              <button type="button" className="ghost" onClick={() => { setTrace([]); setMessages([]); setCart(null); setOrder(null); setCaptureId(null); setPolicyEval(null); setNeedsApproval(false); }}>
                Clear desk
              </button>
            ) : null}
          </div>
          <TraceTimeline steps={trace} />
        </div>
      </section>

      <aside className="side">
        <section className="panel receipt" aria-label="Cart">
          <p className="kicker">Cart</p>
          <h2>{cart?.lines.length ? "Ready to review" : "Nothing picked yet"}</h2>
          {cart?.teamSize ? <p className="muted">{cart.teamSize} people · {cart.days} office days</p> : null}
          {cart?.lines.length ? (
            <ul className="lines" data-testid="cart">
              {cart.lines.map((line) => (
                <li key={line.sku} className="line">
                  <span className="mark">{monogram(line.brand)}</span>
                  <span>
                    <strong>{line.quantity}× {line.name}</strong>
                    <br />
                    <small>{line.brand} · {line.category} · {formatUsd(line.unitPriceCents)}</small>
                  </span>
                  <strong>{formatUsd(line.lineTotalCents)}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">The agent fills this from the catalog. Prices are not chosen by the model.</p>
          )}
          <div className="totals">
            <span>Total</span>
            <span>{formatUsd(cart?.totalCents ?? 0)}</span>
          </div>
          {cart?.notes?.length ? (
            <ul className="notes">
              {cart.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          ) : null}
          {policyEval && !policyEval.ok ? (
            <ul className="violations">
              {policyEval.violations.map((violation) => (
                <li key={`${violation.code}-${violation.sku ?? violation.message}`}>{violation.message}</li>
              ))}
            </ul>
          ) : null}
          {policyOk ? <p className="ok-banner">Inside policy. Effective budget {formatUsd(policyEval!.effectiveBudgetCents)}.</p> : null}
          {needsApproval ? <p className="warn-banner">A person has to approve this cart before PayPal will accept it.</p> : null}
          <div className="actions">
            {needsApproval && cart ? (
              <button type="button" className="danger" disabled={busy} onClick={() => checkout(true)} data-testid="approve-cart">
                Approve exception and create PayPal order
              </button>
            ) : null}
            {policyOk && !order ? (
              <button type="button" className="solid" disabled={busy} onClick={() => checkout(false)} data-testid="create-order">
                Create PayPal order
              </button>
            ) : null}
          </div>
          {order ? (
            <div>
              <p className="ok-banner">
                PayPal order <span className="capture-id">{order.id}</span> is {order.status}.
                {captureId ? ` Captured as ${captureId}.` : " Waiting for the sandbox buyer."}
              </p>
              {!captureId ? (
                <PayPalCheckout
                  clientId={config?.paypalClientId || ""}
                  orderId={order.id}
                  onCaptured={(result) => {
                    setCaptureId(result.captureId);
                    setOrder((current) => current ? { ...current, status: result.orderStatus } : current);
                    const saved = loadPersisted().orders.find((entry) => entry.orderId === order.id);
                    if (saved) {
                      upsertOrder({
                        ...saved,
                        captureId: result.captureId ?? undefined,
                        status: result.orderStatus,
                      });
                    }
                  }}
                  onError={setError}
                />
              ) : null}
              {order.approveUrl && !captureId ? (
                <p className="muted"><a href={order.approveUrl}>Open the PayPal approval page</a> if the button does not load.</p>
              ) : null}
              <p className="muted"><a href={`/orders/${order.id}`}>Order status</a></p>
            </div>
          ) : null}
          <p className="muted">Policy cap {formatUsd(policy.budgetCapCents)} · per item {formatUsd(policy.perItemMaxCents)}
            {policy.blockedCategories.length ? ` · blocked ${policy.blockedCategories.join(", ")}` : ""}
          </p>
        </section>
        <section className="panel catalog">
          <details>
            <summary>Demo catalog ({catalog.length})</summary>
            <label className="sr-only" htmlFor="catalog-search">Filter catalog</label>
            <input
              id="catalog-search"
              className="catalog-search"
              placeholder="Filter by name or category"
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
            />
            <ul>
              {visibleCatalog.map((product) => (
                <li key={product.sku}>
                  <span>{product.name}<br /><small className="muted">{product.brand} · {product.category}</small></span>
                  <span>{formatUsd(product.priceCents)}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      </aside>
      <PolicyDrawer
        open={policyOpen}
        categories={categories}
        policy={policy}
        onClose={() => setPolicyOpen(false)}
        onSave={(next) => {
          setPolicy(next);
          savePolicy(next);
        }}
      />
    </div>
  );
}

function monogram(brand: string): string {
  return brand.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}
