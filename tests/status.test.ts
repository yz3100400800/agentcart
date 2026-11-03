import { describe, expect, it } from "vitest";
import { displayStatus } from "@/components/order-detail";

describe("displayStatus", () => {
  it("derives refund states from captures", () => {
    expect(displayStatus({ status: "COMPLETED", captures: [{ status: "REFUNDED" }] })).toBe("REFUNDED");
    expect(displayStatus({ status: "COMPLETED", captures: [{ status: "PARTIALLY_REFUNDED" }] })).toBe("PARTIALLY_REFUNDED");
    expect(displayStatus({ status: "COMPLETED", captures: [{ status: "COMPLETED" }] })).toBe("COMPLETED");
    expect(displayStatus({ status: "APPROVED", captures: [] })).toBe("APPROVED");
  });
});
