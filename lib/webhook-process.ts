import type { VerifyWebhookInput } from "@/lib/paypal";
import { traceStep } from "@/lib/trace";
import type { TraceStep } from "@/lib/types";
import {
  interpretWebhook,
  type StoredWebhookEvent,
  type WebhookStore,
  type WebhookVerification,
} from "@/lib/webhook-store";

export type WebhookHeaders = {
  authAlgo?: string | null;
  certUrl?: string | null;
  transmissionId?: string | null;
  transmissionSig?: string | null;
  transmissionTime?: string | null;
};

export async function processWebhook(input: {
  rawBody: string;
  headers: WebhookHeaders;
  webhookId: string;
  verify: (payload: VerifyWebhookInput) => Promise<{ verification_status: string }>;
  store: WebhookStore;
  now?: Date;
}): Promise<{ httpStatus: number; body: Record<string, unknown>; trace: TraceStep[] }> {
  const trace: TraceStep[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody) as unknown;
  } catch {
    return { httpStatus: 400, body: { error: "Webhook body must be JSON." }, trace };
  }

  const interpreted = interpretWebhook(parsed);
  if ("error" in interpreted) {
    return { httpStatus: 400, body: { error: interpreted.error }, trace };
  }

  let verification: WebhookVerification = "skipped";
  if (input.webhookId) {
    const missing = missingHeader(input.headers);
    if (missing) {
      return {
        httpStatus: 400,
        body: { error: `Missing PayPal header ${missing}.` },
        trace,
      };
    }
    try {
      const result = await input.verify({
        authAlgo: input.headers.authAlgo!,
        certUrl: input.headers.certUrl!,
        transmissionId: input.headers.transmissionId!,
        transmissionSig: input.headers.transmissionSig!,
        transmissionTime: input.headers.transmissionTime!,
        webhookId: input.webhookId,
        webhookEvent: parsed,
      });
      verification = result.verification_status === "SUCCESS" ? "success" : "failed";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook verification failed.";
      trace.push(traceStep({ kind: "error", title: "Webhook verification error", detail: message, ok: false }));
      return { httpStatus: 502, body: { error: "PayPal could not verify this webhook." }, trace };
    }
  }

  const receivedAt = (input.now ?? new Date()).toISOString();
  const event: StoredWebhookEvent = {
    id: interpreted.eventId,
    eventType: interpreted.eventType,
    receivedAt,
    verified: verification === "success",
    verification,
    orderId: interpreted.orderId,
    captureId: interpreted.captureId,
    refundId: interpreted.refundId,
    status: interpreted.status,
    summary: interpreted.summary,
  };

  if (verification === "failed") {
    trace.push(
      traceStep({
        kind: "paypal",
        title: "Webhook rejected",
        detail: interpreted.summary,
        ok: false,
      }),
    );
    return {
      httpStatus: 400,
      body: { error: "PayPal webhook signature verification failed.", verification },
      trace,
    };
  }

  input.store.addEvent(event);
  if (interpreted.orderId && interpreted.status) {
    input.store.setOrderStatus(interpreted.orderId, {
      status: interpreted.status,
      updatedAt: receivedAt,
      eventType: interpreted.eventType,
      captureId: interpreted.captureId,
      refundId: interpreted.refundId,
    });
  }

  trace.push(
    traceStep({
      kind: "paypal",
      title: verification === "success" ? "Webhook verified" : "Webhook accepted without verification",
      detail: interpreted.summary,
      ok: true,
    }),
  );

  return {
    httpStatus: 200,
    body: {
      ok: true,
      verification,
      orderId: interpreted.orderId ?? null,
      status: interpreted.status ?? null,
    },
    trace,
  };
}

function missingHeader(headers: WebhookHeaders): string | null {
  if (!headers.authAlgo) return "paypal-auth-algo";
  if (!headers.certUrl) return "paypal-cert-url";
  if (!headers.transmissionId) return "paypal-transmission-id";
  if (!headers.transmissionSig) return "paypal-transmission-sig";
  if (!headers.transmissionTime) return "paypal-transmission-time";
  return null;
}
