import { runAgent } from "@/lib/agent";
import { products } from "@/lib/catalog";
import { getLlmConfig } from "@/lib/config";
import { explicitApproval, parseRequestHints } from "@/lib/intent";
import { createLlmClient } from "@/lib/llm";
import { createPayPalClient } from "@/lib/paypal";
import { jsonError, readJson, tooMany } from "@/lib/http";
import { parseAgentRequest } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const limited = tooMany(request, "agent", 12);
  if (limited) return limited;

  const body = await readJson(request);
  if (body && typeof body === "object" && "error" in body && Object.keys(body).length === 1) {
    return jsonError(String((body as { error: string }).error), 400);
  }
  const parsed = parseAgentRequest(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);
  if (!getLlmConfig().apiKey) {
    return jsonError("Set LLM_API_KEY to an OpenAI-compatible key before using the agent.", 503);
  }

  const latest = parsed.messages[parsed.messages.length - 1]?.content ?? "";
  const hints = parseRequestHints(latest);
  const humanApproval =
    explicitApproval(latest) && parsed.currentCart.length > 0
      ? { approved: true as const, lines: parsed.currentCart, note: "Approved in chat" }
      : undefined;

  try {
    const result = await runAgent(
      {
        messages: parsed.messages,
        policy: parsed.policy,
        currentCart: parsed.currentCart,
        knownOrders: parsed.knownOrders,
        humanApproval,
        hints,
      },
      { llm: createLlmClient(), paypal: createPayPalClient(), catalog: products },
    );
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent failed.";
    return jsonError(message, 502);
  }
}
