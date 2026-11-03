import type { Metadata } from "next";
import OrderDetail from "@/components/order-detail";
import Shell from "@/components/shell";

export const metadata: Metadata = { title: "Order · AgentCart" };

export default function OrderPage() {
  return (
    <Shell>
      <OrderDetail />
    </Shell>
  );
}
