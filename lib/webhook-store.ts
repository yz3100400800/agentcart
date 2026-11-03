import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type WebhookVerification = "success" | "failed" | "skipped";

export type StoredWebhookEvent = {
  id: string;
  eventType: string;
  receivedAt: string;
  verified: boolean;
  verification: WebhookVerification;
  orderId?: string;
  captureId?: string;
  refundId?: string;
  status?: string;
  summary: string;
};

export type OrderStatusUpdate = {
  status: string;
  updatedAt: string;
  eventType: string;
  captureId?: string;
  refundId?: string;
};

export type WebhookStore = {
  addEvent(event: StoredWebhookEvent): void;
  setOrderStatus(orderId: string, update: OrderStatusUpdate): void;
  listEvents(): StoredWebhookEvent[];
  getOrderStatus(orderId: string): OrderStatusUpdate | null;
};

export type InterpretedWebhook = {
  eventId: string;
  eventType: string;
  orderId?: string;
  captureId?: string;
  refundId?: string;
  status?: string;
  summary: string;
};

const MAX_EVENTS = 40;

export function interpretWebhook(body: unknown): InterpretedWebhook | { error: string } {
  const event = asRecord(body);
  const eventType = typeof event.event_type === "string" ? event.event_type : "";
  if (!eventType) return { error: "Webhook event is missing event_type." };
  const eventId = typeof event.id === "string" ? event.id : crypto.randomUUID();
  const resource = asRecord(event.resource);
  const related = asRecord(asRecord(resource.supplementary_data).related_ids);
  const resourceType = typeof event.resource_type === "string" ? event.resource_type : "";
  const resourceId = typeof resource.id === "string" ? resource.id : undefined;
  const resourceStatus = typeof resource.status === "string" ? resource.status : undefined;

  let orderId = stringOrUndefined(related.order_id);
  let captureId = stringOrUndefined(related.capture_id);
  let refundId: string | undefined;

  if (eventType.startsWith("CHECKOUT.ORDER") || resourceType === "checkout-order") {
    orderId = orderId ?? resourceId;
  } else if (eventType.startsWith("PAYMENT.CAPTURE.REFUND") || resourceType === "refund") {
    refundId = resourceId;
    captureId = captureId ?? captureIdFromLinks(resource.links);
  } else if (eventType.startsWith("PAYMENT.CAPTURE") || resourceType === "capture") {
    captureId = captureId ?? resourceId;
  }

  const status = orderStatusFromEvent(eventType, resourceStatus);
  const parts = [eventType];
  if (orderId) parts.push(`order ${orderId}`);
  if (captureId) parts.push(`capture ${captureId}`);
  if (refundId) parts.push(`refund ${refundId}`);
  if (status) parts.push(`status ${status}`);

  return {
    eventId,
    eventType,
    orderId,
    captureId,
    refundId,
    status,
    summary: parts.join(" · "),
  };
}

export function orderStatusFromEvent(eventType: string, resourceStatus?: string): string | undefined {
  switch (eventType) {
    case "CHECKOUT.ORDER.APPROVED":
      return "APPROVED";
    case "CHECKOUT.ORDER.COMPLETED":
      return "COMPLETED";
    case "PAYMENT.CAPTURE.COMPLETED":
      return "COMPLETED";
    case "PAYMENT.CAPTURE.DENIED":
      return "DENIED";
    case "PAYMENT.CAPTURE.PENDING":
      return "PENDING";
    case "PAYMENT.CAPTURE.REFUNDED":
      if (resourceStatus === "PARTIALLY_REFUNDED") return "PARTIALLY_REFUNDED";
      return "REFUNDED";
    default:
      return resourceStatus;
  }
}

export function createMemoryWebhookStore(): WebhookStore & {
  events: StoredWebhookEvent[];
  statuses: Map<string, OrderStatusUpdate>;
} {
  const events: StoredWebhookEvent[] = [];
  const statuses = new Map<string, OrderStatusUpdate>();
  return {
    events,
    statuses,
    addEvent(event) {
      events.unshift(event);
      if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    },
    setOrderStatus(orderId, update) {
      statuses.set(orderId, update);
    },
    listEvents() {
      return [...events];
    },
    getOrderStatus(orderId) {
      return statuses.get(orderId) ?? null;
    },
  };
}

export function createFileWebhookStore(file = process.env.AGENTCART_WEBHOOK_LOG || "/tmp/agentcart-webhook-log.json"): WebhookStore {
  const memory = createMemoryWebhookStore();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      events?: StoredWebhookEvent[];
      statuses?: [string, OrderStatusUpdate][];
    };
    if (Array.isArray(parsed.events)) {
      for (const event of parsed.events.slice(0, MAX_EVENTS).reverse()) memory.addEvent(event);
    }
    if (Array.isArray(parsed.statuses)) {
      for (const [orderId, update] of parsed.statuses) {
        if (orderId && update) memory.setOrderStatus(orderId, update);
      }
    }
  } catch {
    // A missing log is the normal case on a cold start.
  }

  const persist = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ events: memory.listEvents(), statuses: [...memory.statuses] }),
      );
    } catch (error) {
      console.error("AgentCart webhook log was not persisted.", error instanceof Error ? error.message : "unknown");
    }
  };

  return {
    addEvent(event) {
      memory.addEvent(event);
      persist();
    },
    setOrderStatus(orderId, update) {
      memory.setOrderStatus(orderId, update);
      persist();
    },
    listEvents: () => memory.listEvents(),
    getOrderStatus: (orderId) => memory.getOrderStatus(orderId),
  };
}

let defaultStore: WebhookStore | null = null;

export function getWebhookStore(): WebhookStore {
  if (!defaultStore) defaultStore = createFileWebhookStore();
  return defaultStore;
}

export function resetWebhookStoreForTests(): void {
  defaultStore = null;
}

function captureIdFromLinks(links: unknown): string | undefined {
  if (!Array.isArray(links)) return undefined;
  for (const link of links) {
    const record = asRecord(link);
    if (record.rel !== "up" || typeof record.href !== "string") continue;
    const match = /\/captures\/([A-Za-z0-9-]+)/.exec(record.href);
    if (match) return match[1];
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
