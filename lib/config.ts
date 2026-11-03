export type PayPalEnv = "sandbox" | "live";

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type PayPalConfig = {
  clientId: string;
  clientSecret: string;
  env: PayPalEnv;
  baseUrl: string;
  webhookId: string;
  publicClientId: string;
};

export function getLlmConfig(): LlmConfig {
  return {
    baseUrl: (process.env.LLM_BASE_URL?.trim() || "https://opencode.ai/zen/v1").replace(/\/$/, ""),
    apiKey: process.env.LLM_API_KEY?.trim() || "",
    model: process.env.LLM_MODEL?.trim() || "claude-haiku-4-5",
  };
}

export function getPayPalConfig(): PayPalConfig {
  const env: PayPalEnv = process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim() || "";
  return {
    clientId,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET?.trim() || "",
    env,
    baseUrl: env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com",
    webhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || "",
    publicClientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim() || clientId,
  };
}

export function publicConfig() {
  const llm = getLlmConfig();
  const paypal = getPayPalConfig();
  return {
    paypalEnv: paypal.env,
    paypalClientId: paypal.publicClientId,
    paypalConfigured: Boolean(paypal.clientId && paypal.clientSecret),
    llmConfigured: Boolean(llm.apiKey),
    llmModel: llm.model,
    webhookVerification: paypal.webhookId ? "enabled" : "skipped",
  };
}
