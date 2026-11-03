import type { Metadata } from "next";
import OrdersBrowser from "@/components/orders-browser";
import Shell from "@/components/shell";

export const metadata: Metadata = { title: "Orders · AgentCart" };

export default function OrdersPage() {
  return (
    <Shell>
      <OrdersBrowser />
    </Shell>
  );
}
