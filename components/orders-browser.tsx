"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loadPersisted } from "@/lib/browser-store";
import { formatUsd } from "@/lib/money";
import type { SavedOrder } from "@/lib/types";

type WebhookEvent = {
  id: string;
  eventType: string;
  receivedAt: string;
  verification: string;
  summary: string;
  orderId?: string;
};

export default function OrdersBrowser() {
  const router = useRouter();
  const [orders, setOrders] = useState<SavedOrder[]>([]);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [lookup, setLookup] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setOrders(loadPersisted().orders);
    setReady(true);
    fetch("/api/webhooks/paypal")
      .then((response) => response.json())
      .then((body: { events?: WebhookEvent[] }) => setEvents(body.events ?? []))
      .catch(() => undefined);
  }, []);

  return (
    <div className="orders">
      <section className="panel card">
        <p className="kicker">History</p>
        <h1>Orders</h1>
        <p className="lede">This browser remembers the cart and the trace. PayPal remains the source of truth for status, capture, and refunds.</p>
        <form
          className="lookup"
          onSubmit={(event) => {
            event.preventDefault();
            const id = lookup.trim();
            if (id) router.push(`/orders/${encodeURIComponent(id)}`);
          }}
        >
          <label className="sr-only" htmlFor="lookup">PayPal order id</label>
          <input id="lookup" value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="Look up a PayPal order id" />
          <button className="solid" type="submit">Look up</button>
        </form>
      </section>
      <section className="panel card">
        <h2>In this browser</h2>
        {!ready ? <p className="muted">Loading…</p> : null}
        {ready && orders.length === 0 ? <p className="muted">No orders yet. Start from the desk.</p> : null}
        {orders.map((order) => (
          <Link key={order.orderId} href={`/orders/${order.orderId}`} className="order-row">
            <span>
              <strong>{order.orderId}</strong>
              <br />
              <small className="muted">{new Date(order.createdAt).toLocaleString()} · {order.cart.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ")}</small>
            </span>
            <span>
              <span className={statusClass(order.status)}>{order.status || "CREATED"}</span>
              <br />
              <strong>{formatUsd(order.cart.totalCents)}</strong>
            </span>
          </Link>
        ))}
      </section>
      <section className="panel card">
        <h2>Webhook events</h2>
        <p className="muted">Events received by this server instance. With PAYPAL_WEBHOOK_ID set, only verified events are stored.</p>
        {events.length === 0 ? <p className="muted">None yet.</p> : null}
        {events.map((event) => (
          <div key={`${event.id}-${event.receivedAt}`} className="event-row">
            <span>
              <strong>{event.eventType}</strong>
              <br />
              <small className="muted">{event.summary}</small>
            </span>
            <span className={event.verification === "success" ? "status good" : "status"}>{event.verification}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function statusClass(status?: string): string {
  if (!status) return "status";
  if (status === "COMPLETED" || status === "APPROVED") return "status good";
  if (status.includes("REFUND") || status === "DENIED") return "status warn";
  return "status";
}
