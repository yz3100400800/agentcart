# AgentCart — Devpost draft

Submission text for the PayPal AI Hackathon. Do not treat this as a claim that a judge has already completed a sandbox payment. The flows below are what the app implements.

## Inspiration

Buying for a team is a string of small decisions: what to get, how many, whether it fits the budget, and who is allowed to spend it. A chat box can draft the list. It should not be the thing that talks to a payment API with prices it invented. AgentCart is the desk where those two jobs meet. The model shops. The server prices the catalog, applies the rules, and only then creates a PayPal order a person can approve.

## What it does

You type a request with a budget. The agent searches a 33-product office catalog (fictional brands only), builds a cart, and checks three rules: a budget cap, a per-item maximum, and blocked categories. The rules are editable in a Policy panel.

If the cart fits, AgentCart creates a PayPal sandbox order with the Orders v2 API. You approve it with the PayPal JavaScript SDK using a sandbox personal account, and the server captures it. If a rule fails, the agent stops and the desk asks a person to approve that exact cart or change the request. Approval is checked again on the server. A mismatched cart is not charged.

You can ask for a refund in the same chat, for example “Refund the cups, they arrived broken.” The agent looks up the capture and refunds that line through the Payments API. The order page can issue the same full or partial refund without the model. An orders list shows browser history plus live PayPal status. A webhook endpoint verifies PayPal’s signature when `PAYPAL_WEBHOOK_ID` is set and records the resulting status. Every tool call, policy decision, and PayPal call is on an agent trace so a judge can see the sequence.

## How we built it

Next.js App Router and TypeScript, meant to deploy on Vercel Hobby without a database. The catalog is JSON. Policy and cart math are pure functions with Vitest tests. The model is any OpenAI-compatible chat-completions endpoint (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, defaulting to `https://opencode.ai/zen/v1` and `claude-haiku-4-5`). PayPal is called over REST: OAuth, Orders v2 create/capture/get, Payments v2 refunds, and `verify-webhook-signature`. The browser uses the PayPal JS SDK only to approve an order the server already created.

We looked at `@paypal/agent-toolkit`. Its order tool accepts prices from the model, which would skip the catalog and the policy gate, so the app calls the REST APIs directly and keeps those checks in one module.

The agent loop, cart builder, policy engine, and webhook handler are covered by unit tests that mock PayPal and the model. `npm test` and `npm run build` do not need secrets.

Order narrative (the request, cart, and trace) lives in `localStorage`. Payment status is read back from PayPal. Webhook events are kept in memory and, when possible, a temp file on that server instance.

Built with Cursor cloud agent in November 2026.

## Challenges

The model is helpful and also willing to name a price. The tool schema does not accept a price field, and the server ignores anything that is not a catalog SKU and a quantity.

Human approval had to be more than a sentence in the prompt. The create-order path re-prices the cart and compares it to the approved SKUs and quantities. A policy failure with no matching approval never reaches PayPal.

Partial refunds need a capture id, not an order id, and “cups” does not literally appear in the product name “Day Cup.” The refund tool looks the order up first, then matches a singular form of the query to the line items PayPal stored.

Serverless hosting has nowhere durable to put an order row without adding a paid database. The design treats PayPal as the record of payment and the browser as the record of why the agent bought it. The webhook log is honest about being instance-local.

A weak model can stop after planning a legal cart. The server then runs the same checkout function and writes that step into the trace, so the buyer still gets a PayPal button.

## Accomplishments

- A natural-language purchase that can end in a real sandbox capture, with the catalog and the policy engine in the path.
- A visible pause when budget, per-item, or category rules fail, and a server-side check on the approval.
- Full and partial refunds from the agent and from the order page.
- Webhook verification through PayPal’s verify-webhook-signature API, with a dev mode that is clearly marked unverified when the webhook id is absent.
- An agent trace a judge can read without opening the terminal.
- Unit tests for policy, cart building, tool handlers, the agent loop, PayPal payload shape, and webhook handling.

## What we learned

Tool calling is the easy half. The useful half is deciding which numbers the model is not allowed to invent, and showing that decision in the interface. PayPal’s sandbox is a better demo when the order is created on the server and the button only approves it. Shipping preference and extra funding sources get in the way of a three-minute recording, so the order asks for no shipping address and the button is the PayPal login.

We also learned that “the webhook updated the order” is a vague sentence if there is no database. Recording the verified event, and still reading the order from PayPal when the page loads, is a smaller claim and a true one.

## What's next

- A real catalog and merchant inventory, still priced by the server.
- Signed-in approvers when a cart breaks policy, instead of a same-browser confirmation.
- A durable event log so webhook status survives cold starts.
- Multi-currency carts and taxes, which this demo deliberately leaves out.
- Stronger rate limits in front of a shared store, instead of a per-instance memory window.
