import { getPayPalConfig, type PayPalConfig } from "@/lib/config";
import { amountToCents, centsToAmount } from "@/lib/money";
import type { CartLine } from "@/lib/types";

export class PayPalApiError extends Error {
  status: number;
  issue?: string;
  debugId?: string;

  constructor(message: string, status: number, issue?: string, debugId?: string) {
    super(message);
    this.name = "PayPalApiError";
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
  }
}

export type NormalizedItem = {
  name: string;
  sku?: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
};

export type NormalizedCapture = {
  id: string;
  status: string;
  amountCents: number;
};

export type NormalizedRefund = {
  id: string;
  status: string;
  amountCents: number | null;
};

export type NormalizedOrder = {
  id: string;
  status: string;
  amountCents: number | null;
  currency: string;
  customId?: string;
  items: NormalizedItem[];
  captures: NormalizedCapture[];
  refunds: NormalizedRefund[];
  payerEmail?: string;
  approveUrl?: string;
};

export type CreatePayPalOrderInput = {
  lines: CartLine[];
  customId: string;
  invoiceId: string;
};

export type VerifyWebhookInput = {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  webhookEvent: unknown;
};

export type PayPalClient = {
  createOrder(input: CreatePayPalOrderInput): Promise<NormalizedOrder>;
  captureOrder(orderId: string): Promise<NormalizedOrder>;
  getOrder(orderId: string): Promise<NormalizedOrder>;
  refundCapture(input: {
    captureId: string;
    amountCents?: number;
    note?: string;
    requestId: string;
  }): Promise<{ id: string; status: string; amountCents: number | null }>;
  verifyWebhook(input: VerifyWebhookInput): Promise<{ verification_status: string }>;
};

type TokenCache = { token: string; expiresAt: number };

export function buildOrderBody(input: CreatePayPalOrderInput): Record<string, unknown> {
  const itemTotal = input.lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const value = centsToAmount(itemTotal);
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: "default",
        description: "AgentCart demo catalog order",
        custom_id: input.customId.slice(0, 127),
        invoice_id: input.invoiceId.slice(0, 127),
        amount: {
          currency_code: "USD",
          value,
          breakdown: {
            item_total: { currency_code: "USD", value },
          },
        },
        items: input.lines.map((line) => ({
          name: line.name.slice(0, 127),
          sku: line.sku.slice(0, 127),
          description: `${line.brand} · ${line.category}`.slice(0, 127),
          quantity: String(line.quantity),
          category: "PHYSICAL_GOODS",
          unit_amount: {
            currency_code: "USD",
            value: centsToAmount(line.unitPriceCents),
          },
        })),
      },
    ],
    application_context: {
      brand_name: "AgentCart",
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
    },
  };
}

export function normalizeOrder(raw: unknown): NormalizedOrder {
  const order = asRecord(raw);
  const purchaseUnits = Array.isArray(order.purchase_units) ? order.purchase_units : [];
  const first = asRecord(purchaseUnits[0]);
  const amount = asRecord(first.amount);
  const payments = asRecord(first.payments);
  const items = Array.isArray(first.items) ? first.items.map(normalizeItem) : [];
  const captures = Array.isArray(payments.captures) ? payments.captures.map(normalizeCapture) : [];
  const refunds = Array.isArray(payments.refunds) ? payments.refunds.map(normalizeRefund) : [];
  const payer = asRecord(order.payer);
  const links = Array.isArray(order.links) ? order.links : [];
  const approve = links.map(asRecord).find((link) => link.rel === "approve");

  return {
    id: typeof order.id === "string" ? order.id : "",
    status: typeof order.status === "string" ? order.status : "UNKNOWN",
    amountCents: typeof amount.value === "string" ? safeAmount(amount.value) : null,
    currency: typeof amount.currency_code === "string" ? amount.currency_code : "USD",
    customId: typeof first.custom_id === "string" ? first.custom_id : undefined,
    items,
    captures,
    refunds,
    payerEmail: typeof payer.email_address === "string" ? payer.email_address : undefined,
    approveUrl: typeof approve?.href === "string" ? approve.href : undefined,
  };
}

export function isAlreadyCaptured(error: unknown): boolean {
  return error instanceof PayPalApiError && error.issue === "ORDER_ALREADY_CAPTURED";
}

export function httpStatusForPayPal(error: PayPalApiError): number {
  if (error.status === 503 || (error.status >= 400 && error.status < 500)) return error.status;
  return 502;
}

export function createPayPalClient(config = getPayPalConfig(), fetchImpl: typeof fetch = fetch): PayPalClient {
  if (!config.clientId || !config.clientSecret) {
    return unconfiguredClient();
  }
  return liveClient(config, fetchImpl);
}

function unconfiguredClient(): PayPalClient {
  const fail = async () => {
    throw new PayPalApiError(
      "PayPal credentials are not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
      503,
      "NOT_CONFIGURED",
    );
  };
  return {
    createOrder: fail,
    captureOrder: fail,
    getOrder: fail,
    refundCapture: fail,
    verifyWebhook: fail,
  };
}

function liveClient(config: PayPalConfig, fetchImpl: typeof fetch): PayPalClient {
  let cache: TokenCache | null = null;

  async function accessToken(): Promise<string> {
    if (cache && cache.expiresAt > Date.now() + 15_000) return cache.token;
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const response = await fetchImpl(`${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw errorFrom(response.status, body, "PayPal authentication failed.");
    }
    const token = asRecord(body).access_token;
    const expiresIn = asRecord(body).expires_in;
    if (typeof token !== "string") {
      throw new PayPalApiError("PayPal did not return an access token.", 502);
    }
    const seconds = typeof expiresIn === "number" ? expiresIn : 300;
    cache = { token, expiresAt: Date.now() + seconds * 1000 };
    return token;
  }

  async function request(path: string, init: { method: string; body?: unknown; requestId?: string }): Promise<unknown> {
    const token = await accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (init.requestId) headers["PayPal-Request-Id"] = init.requestId;
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw errorFrom(response.status, body, `PayPal request failed (${response.status}).`);
    }
    return body;
  }

  return {
    async createOrder(input) {
      const body = await request("/v2/checkout/orders", {
        method: "POST",
        body: buildOrderBody(input),
        requestId: input.invoiceId,
      });
      return normalizeOrder(body);
    },
    async getOrder(orderId) {
      assertPayPalId(orderId, "order");
      const body = await request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
      return normalizeOrder(body);
    },
    async captureOrder(orderId) {
      assertPayPalId(orderId, "order");
      try {
        await request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
          method: "POST",
          body: {},
          requestId: `capture-${orderId}`,
        });
      } catch (error) {
        if (!isAlreadyCaptured(error)) throw error;
      }
      return this.getOrder(orderId);
    },
    async refundCapture(input) {
      assertPayPalId(input.captureId, "capture");
      const payload: Record<string, unknown> = {};
      if (input.amountCents !== undefined) {
        if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
          throw new PayPalApiError("Refund amount must be a positive integer number of cents.", 400);
        }
        payload.amount = { currency_code: "USD", value: centsToAmount(input.amountCents) };
      }
      if (input.note) payload.note_to_payer = input.note.slice(0, 255);
      const body = await request(`/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`, {
        method: "POST",
        body: payload,
        requestId: input.requestId,
      });
      const record = asRecord(body);
      const amount = asRecord(record.amount);
      return {
        id: typeof record.id === "string" ? record.id : "",
        status: typeof record.status === "string" ? record.status : "UNKNOWN",
        amountCents: typeof amount.value === "string" ? safeAmount(amount.value) : input.amountCents ?? null,
      };
    },
    async verifyWebhook(input) {
      const body = await request("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        body: {
          auth_algo: input.authAlgo,
          cert_url: input.certUrl,
          transmission_id: input.transmissionId,
          transmission_sig: input.transmissionSig,
          transmission_time: input.transmissionTime,
          webhook_id: input.webhookId,
          webhook_event: input.webhookEvent,
        },
      });
      const status = asRecord(body).verification_status;
      return { verification_status: typeof status === "string" ? status : "FAILURE" };
    },
  };
}

export function assertPayPalId(value: string, label: string): void {
  if (!/^[A-Za-z0-9-]{8,36}$/.test(value)) {
    throw new PayPalApiError(`Invalid PayPal ${label} id.`, 400, "INVALID_ID");
  }
}

function normalizeItem(raw: unknown): NormalizedItem {
  const item = asRecord(raw);
  const unit = asRecord(item.unit_amount);
  const quantity = Number(item.quantity ?? 0);
  const unitPriceCents = typeof unit.value === "string" ? safeAmount(unit.value) ?? 0 : 0;
  const safeQty = Number.isInteger(quantity) ? quantity : 0;
  return {
    name: typeof item.name === "string" ? item.name : "Item",
    sku: typeof item.sku === "string" ? item.sku : undefined,
    quantity: safeQty,
    unitPriceCents,
    lineTotalCents: unitPriceCents * safeQty,
  };
}

function normalizeCapture(raw: unknown): NormalizedCapture {
  const capture = asRecord(raw);
  const amount = asRecord(capture.amount);
  return {
    id: typeof capture.id === "string" ? capture.id : "",
    status: typeof capture.status === "string" ? capture.status : "UNKNOWN",
    amountCents: typeof amount.value === "string" ? safeAmount(amount.value) ?? 0 : 0,
  };
}

function normalizeRefund(raw: unknown): NormalizedRefund {
  const refund = asRecord(raw);
  const amount = asRecord(refund.amount);
  return {
    id: typeof refund.id === "string" ? refund.id : "",
    status: typeof refund.status === "string" ? refund.status : "UNKNOWN",
    amountCents: typeof amount.value === "string" ? safeAmount(amount.value) : null,
  };
}

function safeAmount(value: string): number | null {
  try {
    return amountToCents(value);
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function errorFrom(status: number, body: unknown, fallback: string): PayPalApiError {
  const record = asRecord(body);
  const details = Array.isArray(record.details) ? asRecord(record.details[0]) : {};
  const issue = typeof details.issue === "string" ? details.issue : undefined;
  const description =
    (typeof details.description === "string" && details.description) ||
    (typeof record.message === "string" && record.message) ||
    fallback;
  const debugId = typeof record.debug_id === "string" ? record.debug_id : undefined;
  return new PayPalApiError(description, status, issue, debugId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
