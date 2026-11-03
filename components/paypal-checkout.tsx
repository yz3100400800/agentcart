"use client";

import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";

type CaptureResult = {
  captureId: string | null;
  captureStatus: string | null;
  orderStatus: string;
};

export default function PayPalCheckout({
  clientId,
  orderId,
  onCaptured,
  onError,
}: {
  clientId: string;
  orderId: string;
  onCaptured: (result: CaptureResult) => void;
  onError: (message: string) => void;
}) {
  if (!clientId) {
    return <p className="warn-banner">Set NEXT_PUBLIC_PAYPAL_CLIENT_ID to load the PayPal button.</p>;
  }

  return (
    <PayPalScriptProvider
      options={{
        clientId,
        currency: "USD",
        intent: "capture",
        disableFunding: "card,venmo,paylater,credit",
      }}
    >
      <PayPalButtons
        key={orderId}
        style={{ layout: "vertical", shape: "rect", color: "gold", label: "paypal", height: 45 }}
        createOrder={() => Promise.resolve(orderId)}
        onApprove={async (data) => {
          const response = await fetch("/api/paypal/capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId: data.orderID }),
          });
          const body = (await response.json()) as {
            error?: string;
            captureId?: string | null;
            captureStatus?: string | null;
            order?: { status?: string };
          };
          if (!response.ok) throw new Error(body.error || "Capture failed.");
          onCaptured({
            captureId: body.captureId ?? null,
            captureStatus: body.captureStatus ?? null,
            orderStatus: body.order?.status || "COMPLETED",
          });
        }}
        onCancel={() => onError("The PayPal window closed before approval. The order is still open.")}
        onError={(error) => onError(error instanceof Error ? error.message : "PayPal could not open the approval window.")}
      />
    </PayPalScriptProvider>
  );
}
