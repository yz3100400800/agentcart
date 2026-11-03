"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import TraceTimeline from "@/components/trace-timeline";
import { addRefund, findOrder, upsertOrder } from "@/lib/browser-store";
import { dollarsToCents, formatUsd } from "@/lib/money";
import type { SavedOrder } from "@/lib/types";

type LiveOrder = {
  id: string;
  status: string;
  amountCents: number | null;
  payerEmail?: string;
  items: { name: string; sku?: string; quantity: number; lineTotalCents: number }[];
  captures: { id: string; status: string; amountCents: number }[];
  refunds: { id: string; status: string; amountCents: number | null }[];
};
type WebhookStatus = { status: string; updatedAt: string; eventType: string } | null;

export default function OrderDetail() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const [saved, setSaved] = useState<SavedOrder | null>(null);
  const [live, setLive] = useState<LiveOrder | null>(null);
  const [webhook, setWebhook] = useState<WebhookStatus>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("Requested from the order page");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  async function refresh(quiet = false) {
    if (!quiet) setLoading(true);
    setSaved(findOrder(orderId));
    try {
      const response = await fetch(`/api/paypal/orders/${encodeURIComponent(orderId)}`);
      const body = (await response.json()) as { error?: string; order?: LiveOrder; webhook?: WebhookStatus };
      if (!response.ok) {
        setError(body.error || "PayPal could not return this order.");
        setLive(null);
      } else {
        setError(null);
        setLive(body.order ?? null);
        setWebhook(body.webhook ?? null);
      }
    } catch {
      setError("Could not reach the order API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // The order id comes from the route. Refresh when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  const capture = live?.captures.find((entry) => entry.status === "COMPLETED" || entry.status === "PARTIALLY_REFUNDED");

  const headerStatus = live ? displayStatus(live) : null;
  const canCapture = live?.status === "APPROVED" && live.captures.length === 0;

  async function capturePayment() {
    setCapturing(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/paypal/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const body = (await response.json()) as { error?: string; order?: LiveOrder; captureId?: string | null; captureStatus?: string | null };
      if (!response.ok) {
        setError(body.error || "Capture failed.");
        return;
      }
      if (body.order) setLive(body.order);
      if (saved && body.captureId) {
        upsertOrder({ ...saved, captureId: body.captureId, status: body.order?.status ?? "COMPLETED" });
        setSaved(findOrder(orderId));
      }
      setSuccess(`Payment captured${body.captureId ? ` (${body.captureId}, ${body.captureStatus ?? "done"})` : ""}.`);
      await refresh(true);
    } catch {
      setError("Capture did not finish.");
    } finally {
      setCapturing(false);
    }
  }

  async function refund(amountCents?: number, noteOverride?: string) {
    if (!capture) return;
    const payerNote = noteOverride ?? note;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/paypal/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captureId: capture.id,
          orderId,
          amountCents,
          note: payerNote,
        }),
      });
      const body = (await response.json()) as { error?: string; refund?: { id: string; status: string; amountCents: number | null } };
      if (!response.ok || !body.refund) {
        setError(body.error || "Refund failed.");
        return;
      }
      addRefund(orderId, {
        refundId: body.refund.id,
        amountCents: body.refund.amountCents,
        note: payerNote,
        at: new Date().toISOString(),
      });
      setSaved(findOrder(orderId));
      setSuccess(
        `Refund ${body.refund.id} is ${body.refund.status}${body.refund.amountCents === null ? "" : ` for ${formatUsd(body.refund.amountCents)}`}.`,
      );
      await refresh(true);
    } catch {
      setError("Refund did not finish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-grid">
      <section className="panel card">
        <p className="kicker"><Link href="/orders">Orders</Link></p>
        <h1>Order</h1>
        <p className="capture-id">{orderId}</p>
        {loading ? <p className="muted">Asking PayPal…</p> : null}
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        {success ? <p className="ok-banner" role="status">{success}</p> : null}
        {canCapture ? (
          <div className="actions">
            <button type="button" disabled={capturing} onClick={() => void capturePayment()}>
              {capturing ? "Capturing…" : "Capture payment"}
            </button>
          </div>
        ) : null}
        {live ? (
          <>
            <p className={headerStatus === "COMPLETED" ? "ok-banner" : "info-banner"}>
              PayPal status: {headerStatus}
              {headerStatus !== live.status ? <small className="muted"> (order {live.status})</small> : null}
            </p>
            <p>Amount {live.amountCents === null ? "unknown" : formatUsd(live.amountCents)}</p>
            {live.payerEmail ? <p className="muted">Payer {live.payerEmail}</p> : null}
            <ul className="lines">
              {live.items.map((item) => (
                <li key={`${item.sku}-${item.name}`} className="line">
                  <span className="mark">{item.quantity}</span>
                  <span>{item.name}<br /><small className="muted">{item.sku}</small></span>
                  <span>{formatUsd(item.lineTotalCents)}</span>
                </li>
              ))}
            </ul>
            <h3>Captures</h3>
            {live.captures.length === 0 ? <p className="muted">{canCapture ? "The buyer approved. Capture the payment above." : "No capture yet. Approve the order from the desk."}</p> : null}
            <ul className="notes">
              {live.captures.map((entry) => (
                <li key={entry.id}>{entry.id} · {entry.status} · {formatUsd(entry.amountCents)}</li>
              ))}
            </ul>
            <h3>Refunds</h3>
            {live.refunds.length === 0 ? <p className="muted">None recorded on the order.</p> : null}
            <ul className="notes">
              {live.refunds.map((entry) => (
                <li key={entry.id}>{entry.id} · {entry.status} · {entry.amountCents === null ? "amount unknown" : formatUsd(entry.amountCents)}</li>
              ))}
            </ul>
          </>
        ) : null}
        {webhook ? (
          <p className="info-banner">Last webhook: {webhook.status} via {webhook.eventType} at {new Date(webhook.updatedAt).toLocaleString()}.</p>
        ) : (
          <p className="muted">Webhook: not configured (demo)</p>
        )}
      </section>
      <div className="side">
        <section className="panel card">
          <h2>Refund</h2>
          <p className="lede">The chat agent can refund too. This form calls the same Payments API for a capture you already have.</p>
          {!capture ? <p className="muted">Capture the payment before refunding.</p> : null}
          {capture ? (
            <>
              <div className="field">
                <label htmlFor="refund-note">Note to payer</label>
                <textarea id="refund-note" value={note} onChange={(event) => setNote(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="refund-amount">Custom amount (USD, optional)</label>
                <input id="refund-amount" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="9.00" />
              </div>
              <div className="actions">
                <button type="button" className="danger" disabled={busy} onClick={() => refund()}>
                  {busy ? "Refunding…" : "Refund full capture"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || !amount.trim()}
                  onClick={() => {
                    const cents = dollarsToCents(Number(amount));
                    if (!Number.isInteger(cents) || cents <= 0) {
                      setError("Enter a positive dollar amount.");
                      return;
                    }
                    void refund(cents);
                  }}
                >
                  {busy ? "Refunding…" : "Refund custom amount"}
                </button>
              </div>
              {saved?.cart.lines.map((line) => (
                <button
                  key={line.sku}
                  type="button"
                  className="ghost"
                  style={{ marginTop: 8 }}
                  disabled={busy}
                  onClick={() => {
                    const lineNote = `Refund for ${line.name}`;
                    setNote(lineNote);
                    void refund(line.lineTotalCents, lineNote);
                  }}
                >
                  Refund {line.name} ({formatUsd(line.lineTotalCents)})
                </button>
              ))}
            </>
          ) : null}
        </section>
        {saved ? (
          <section className="panel card">
            <h2>Saved trace</h2>
            <p className="muted">{saved.requestText}</p>
            <TraceTimeline steps={saved.trace} />
          </section>
        ) : (
          <section className="panel card">
            <h2>Local record</h2>
            <p className="muted">This order id is not in this browser’s history. Status still comes from PayPal.</p>
          </section>
        )}
      </div>
    </div>
  );
}

export function displayStatus(order: { status: string; captures: { status: string }[] }): string {
  const statuses = order.captures.map((entry) => entry.status);
  if (statuses.length > 0 && statuses.every((status) => status === "REFUNDED")) return "REFUNDED";
  if (statuses.some((status) => status === "PARTIALLY_REFUNDED" || status === "REFUNDED")) return "PARTIALLY_REFUNDED";
  return order.status;
}
