import { listCategories } from "@/lib/catalog";
import { DEFAULT_POLICY, sanitizePolicy } from "@/lib/policy";
import type {
  CartRequestLine,
  HumanApproval,
  KnownOrder,
  Policy,
} from "@/lib/types";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentRequest = {
  messages: ChatTurn[];
  policy: Policy;
  currentCart: CartRequestLine[];
  knownOrders: KnownOrder[];
};

const MAX_MESSAGES = 16;
const MAX_CONTENT = 4000;

export function parseAgentRequest(body: unknown): AgentRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const raw = body as Record<string, unknown>;
  const messages = parseMessages(raw.messages);
  if ("error" in messages) return messages;
  const policy =
    raw.policy === undefined || raw.policy === null ? DEFAULT_POLICY : sanitizePolicy(raw.policy, listCategories());
  if ("error" in policy) return policy;
  const currentCart = parseLines(raw.currentCart, "currentCart");
  if ("error" in currentCart) return currentCart;
  const knownOrders = parseKnownOrders(raw.knownOrders);
  if ("error" in knownOrders) return knownOrders;
  return { messages, policy, currentCart, knownOrders };
}

export function parseCheckoutRequest(body: unknown): {
  lines: CartRequestLine[];
  policy: Policy;
  requestBudgetCents?: number;
  humanApproval?: HumanApproval;
} | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const raw = body as Record<string, unknown>;
  const policy = sanitizePolicy(raw.policy, listCategories());
  if ("error" in policy) return policy;
  const lines = parseLines(raw.lines, "lines");
  if ("error" in lines) return lines;
  if (lines.length === 0) return { error: "Choose at least one catalog item." };
  const requestBudgetCents = optionalCents(raw.requestBudgetCents, "Request budget");
  if (typeof requestBudgetCents !== "number" && requestBudgetCents !== undefined) return requestBudgetCents;
  const humanApproval = parseApproval(raw.humanApproval);
  if (humanApproval && "error" in humanApproval) return humanApproval;
  return {
    lines,
    policy,
    requestBudgetCents,
    humanApproval: humanApproval && !("error" in humanApproval) ? humanApproval : undefined,
  };
}

export function parseRefundRequest(body: unknown): {
  captureId: string;
  orderId?: string;
  amountCents?: number;
  note?: string;
} | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const raw = body as Record<string, unknown>;
  if (typeof raw.captureId !== "string" || !/^[A-Za-z0-9-]{8,36}$/.test(raw.captureId)) {
    return { error: "A valid capture id is required." };
  }
  const amountCents = optionalCents(raw.amountCents, "Refund amount");
  if (typeof amountCents !== "number" && amountCents !== undefined) return amountCents;
  if (amountCents !== undefined && amountCents <= 0) return { error: "Refund amount must be positive." };
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 255) : undefined;
  const orderId =
    typeof raw.orderId === "string" && /^[A-Za-z0-9-]{8,36}$/.test(raw.orderId) ? raw.orderId : undefined;
  return { captureId: raw.captureId, orderId, amountCents, note };
}

function parseMessages(value: unknown): ChatTurn[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: "Include at least one message." };
  if (value.length > MAX_MESSAGES) return { error: `Send at most ${MAX_MESSAGES} messages.` };
  const messages: ChatTurn[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { error: "Each message must be an object." };
    const record = entry as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") {
      return { error: "Messages must be from the user or the assistant." };
    }
    if (typeof record.content !== "string") return { error: "Message content must be text." };
    const content = record.content.trim();
    if (!content) return { error: "Message content cannot be empty." };
    if (content.length > MAX_CONTENT) return { error: "A message is too long." };
    messages.push({ role: record.role, content });
  }
  if (messages[messages.length - 1]?.role !== "user") {
    return { error: "The latest message must be from the user." };
  }
  return messages;
}

function parseLines(value: unknown, label: string): CartRequestLine[] | { error: string } {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return { error: `${label} must be a list.` };
  if (value.length > 12) return { error: `${label} has too many lines.` };
  const lines: CartRequestLine[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { error: `${label} lines must be objects.` };
    const record = entry as Record<string, unknown>;
    if (typeof record.sku !== "string" || !/^[A-Z0-9-]{2,32}$/.test(record.sku)) {
      return { error: `${label} has an invalid SKU.` };
    }
    if (typeof record.quantity !== "number" || !Number.isInteger(record.quantity)) {
      return { error: `${label} quantities must be integers.` };
    }
    lines.push({ sku: record.sku, quantity: record.quantity });
  }
  return lines;
}

function parseKnownOrders(value: unknown): KnownOrder[] | { error: string } {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return { error: "knownOrders must be a list." };
  const orders: KnownOrder[] = [];
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.orderId !== "string" || !/^[A-Za-z0-9-]{8,36}$/.test(record.orderId)) continue;
    const lines = parseLines(record.lines, "order lines");
    if ("error" in lines) continue;
    const totalCents = typeof record.totalCents === "number" && Number.isInteger(record.totalCents) ? record.totalCents : 0;
    orders.push({
      orderId: record.orderId,
      captureId:
        typeof record.captureId === "string" && /^[A-Za-z0-9-]{8,36}$/.test(record.captureId)
          ? record.captureId
          : undefined,
      createdAt: typeof record.createdAt === "string" ? record.createdAt.slice(0, 40) : "",
      summary: typeof record.summary === "string" ? record.summary.slice(0, 240) : "",
      totalCents,
      status: typeof record.status === "string" ? record.status.slice(0, 40) : undefined,
      lines: lines.map((line) => ({
        sku: line.sku,
        name: line.sku,
        quantity: line.quantity,
        lineTotalCents: 0,
      })),
    });
    const sourceLines = Array.isArray(record.lines) ? record.lines : [];
    orders[orders.length - 1]!.lines = sourceLines.slice(0, 12).map((line, index) => {
      const parsed = lines[index];
      const recordLine = line && typeof line === "object" ? (line as Record<string, unknown>) : {};
      return {
        sku: parsed?.sku ?? "",
        name: typeof recordLine.name === "string" ? recordLine.name.slice(0, 80) : parsed?.sku ?? "Item",
        quantity: parsed?.quantity ?? 0,
        lineTotalCents:
          typeof recordLine.lineTotalCents === "number" && Number.isInteger(recordLine.lineTotalCents)
            ? recordLine.lineTotalCents
            : 0,
        category: typeof recordLine.category === "string" ? recordLine.category.slice(0, 40) : undefined,
      };
    }).filter((line) => line.sku);
  }
  return orders;
}

function parseApproval(value: unknown): HumanApproval | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") return { error: "Approval must be an object." };
  const raw = value as Record<string, unknown>;
  if (raw.approved !== true) return undefined;
  const lines = parseLines(raw.lines, "approval");
  if ("error" in lines) return lines;
  if (lines.length === 0) return { error: "Approval must name the cart lines." };
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 240) : undefined;
  return { approved: true, lines, note };
}

function optionalCents(value: unknown, label: string): number | undefined | { error: string } {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { error: `${label} must be an integer number of cents.` };
  }
  if (value > 500_000) return { error: `${label} is too large.` };
  return value;
}
