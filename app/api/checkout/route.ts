import { products } from "@/lib/catalog";
import { createOrderForCart } from "@/lib/checkout";
import { jsonError, readJson, tooMany } from "@/lib/http";
import { createPayPalClient } from "@/lib/paypal";
import { parseCheckoutRequest } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const limited = tooMany(request, "checkout", 12);
  if (limited) return limited;
  const body = await readJson(request);
  if (isParseError(body)) return jsonError(body.error, 400);
  const parsed = parseCheckoutRequest(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);

  const result = await createOrderForCart({
    catalog: products,
    lines: parsed.lines,
    policy: parsed.policy,
    requestBudgetCents: parsed.requestBudgetCents,
    humanApproval: parsed.humanApproval,
    paypal: createPayPalClient(),
  });
  if (!result.ok) {
    const status = result.code === "PAYPAL" ? 502 : 422;
    return Response.json(result, { status });
  }
  return Response.json(result);
}

function isParseError(body: unknown): body is { error: string } {
  return Boolean(body && typeof body === "object" && "error" in body && Object.keys(body).length === 1);
}
