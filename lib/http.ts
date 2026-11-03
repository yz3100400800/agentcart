import { NextResponse } from "next/server";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export function tooMany(request: Request, bucket: string, limit: number): NextResponse | null {
  const result = rateLimit(clientKey(request, bucket), limit);
  if (result.ok) return null;
  return NextResponse.json(
    { error: "Too many requests. Wait a moment and try again." },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
  );
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function readJson(request: Request): Promise<unknown | { error: string }> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return { error: "Request body must be JSON." };
  }
}
