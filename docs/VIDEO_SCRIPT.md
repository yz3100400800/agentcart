# AgentCart demo script

Target length: under 3 minutes. Record the desk at a desktop width. Use a PayPal **sandbox personal** account. Do not show secrets, the `.env` file, or a live PayPal password on camera.

Sandbox buyer login: to be filled later

## Before you hit record

- `.env.local` has the LLM key, sandbox client id, sandbox secret, and `NEXT_PUBLIC_PAYPAL_CLIENT_ID`.
- `PAYPAL_ENV` is `sandbox`.
- Policy is the default: budget cap $150, per-item max $60, nothing blocked. Reset it in the panel if a previous take changed it.
- Browser local storage for the site is empty so the orders list starts clean.
- You are signed out of PayPal, or you know you can switch to the sandbox personal account in the popup.

## Shot list

### 0:00–0:12 — The desk

Show the AgentCart header, the PayPal sandbox pill, and the empty cart.

Say: “AgentCart is a purchasing agent. It shops a demo catalog, checks a spending policy, and pays with PayPal sandbox.”

### 0:12–0:28 — The request

Click the sample prompt, or paste it:

`Order coffee beans and cups for a 5-person team next week, budget $80`

Say: “Five people, next week, eighty dollars. The model does not get to invent prices.”

### 0:28–0:55 — Trace and cart

Wait until the trace finishes. Scroll it slowly: catalog plan, policy pass, PayPal order created.

Point at the cart: 5 Day Cups and 2 House Blend bags, $74.00. Mention the note that coffee was reduced to fit the budget if it is on screen.

Say: “The server priced the catalog, kept the cart under eighty dollars and under the policy cap, then created a PayPal order. It is not captured yet.”

If the model’s quantities differ, say what is actually on screen. Do not claim $74 if the cart is different. The default planner produces $74; the model may also propose an explicit cart that still passes policy.

### 0:55–1:25 — Pay

Click the PayPal button. Sign in with the sandbox personal account. Approve the payment.

Show the capture id on the desk.

Say: “The button only approves the order the server created. Our server captures it through the Orders API.”

### 1:25–1:40 — Orders

Open Orders, then the order. Show PayPal’s status and the saved trace.

Say: “This browser remembers the cart and the trace. PayPal is the source of truth for the payment.”

### 1:40–2:15 — Human approval

Back on the desk, open Policy and set the per-item max to `20`. Save.

Send the coffee request again. Show the violation: five cups are $45, over the $20 line max. Do not click the PayPal button yet, because there should not be one.

Click **Approve exception and create PayPal order**. Show the new order id in the trace.

Say: “The agent has to stop. A person approves this cart, and the server checks that the approved lines match before it calls PayPal.”

You can leave this second order unpaid if time is short. Say that it is created, not captured.

### 2:15–2:40 — Refund

Return to the first, captured order in your head, and on the desk send:

`Refund the cups, they arrived broken`

Show the trace calling the order lookup and then the refund tool for the cup amount.

Open the order again and show the refund on the PayPal status, or the refund id the page returns after a refresh.

Say: “That is a partial refund of the cups through PayPal’s Payments API. The coffee charge stays.”

If the refund is still in flight, show the order-page control only if you also use it, and call it the manual refund form.

### 2:40–3:00 — Close

Briefly show the webhook note on the orders page.

Say: “Webhooks verify with PayPal when a webhook id is configured, and update the status log. The catalog is fictional, the checkout is sandbox, and the trace is there so you can see every tool call.”

Stop. Do not add features that were not on screen.

## If something fails on camera

- No PayPal button: `NEXT_PUBLIC_PAYPAL_CLIENT_ID` is missing or the order was not created. Read the banner or the trace error. Do not pretend the button loaded.
- Policy unexpectedly blocks the first order: reset policy to the defaults and use a fresh request.
- The model asks a follow-up instead of ordering: send the sample sentence again, including the budget and the team size.
- Refund cannot find the order: the capture has to exist, and the order has to be in this browser. Use the order page refund for the Day Cup line and say you are using that form.
