import type { TraceStep } from "@/lib/types";

export function traceStep(
  partial: Omit<TraceStep, "id" | "at"> & { at?: string },
): TraceStep {
  return {
    id: crypto.randomUUID(),
    at: partial.at ?? new Date().toISOString(),
    kind: partial.kind,
    title: partial.title,
    detail: partial.detail,
    toolName: partial.toolName,
    ok: partial.ok,
  };
}
