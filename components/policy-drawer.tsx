"use client";

import { useEffect, useState } from "react";
import { dollarsToCents, formatUsd } from "@/lib/money";
import { DEFAULT_POLICY, POLICY_MAX_CENTS, POLICY_MIN_CENTS } from "@/lib/policy";
import type { Policy } from "@/lib/types";

export default function PolicyDrawer({
  open,
  categories,
  policy,
  onClose,
  onSave,
}: {
  open: boolean;
  categories: string[];
  policy: Policy;
  onClose: () => void;
  onSave: (policy: Policy) => void;
}) {
  const [budget, setBudget] = useState(dollars(policy.budgetCapCents));
  const [perItem, setPerItem] = useState(dollars(policy.perItemMaxCents));
  const [blocked, setBlocked] = useState<string[]>(policy.blockedCategories);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBudget(dollars(policy.budgetCapCents));
    setPerItem(dollars(policy.perItemMaxCents));
    setBlocked(policy.blockedCategories);
    setError(null);
  }, [open, policy]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function save() {
    const budgetCapCents = dollarsToCents(Number(budget));
    const perItemMaxCents = dollarsToCents(Number(perItem));
    if (
      !Number.isInteger(budgetCapCents) ||
      budgetCapCents < POLICY_MIN_CENTS ||
      budgetCapCents > POLICY_MAX_CENTS ||
      !Number.isInteger(perItemMaxCents) ||
      perItemMaxCents < POLICY_MIN_CENTS ||
      perItemMaxCents > POLICY_MAX_CENTS
    ) {
      setError(`Use amounts from ${formatUsd(POLICY_MIN_CENTS)} to ${formatUsd(POLICY_MAX_CENTS)}.`);
      return;
    }
    onSave({ budgetCapCents, perItemMaxCents, blockedCategories: blocked });
    onClose();
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-title"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="kicker">Rules</p>
        <h2 id="policy-title">Purchasing policy</h2>
        <p className="lede">The agent can spend only inside these rules. A tighter budget in the request also applies. Breaking a rule pauses for approval.</p>
        <div className="field">
          <label htmlFor="budget-cap">Budget cap (USD)</label>
          <input id="budget-cap" inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="per-item">Per-item max (USD)</label>
          <input id="per-item" inputMode="decimal" value={perItem} onChange={(event) => setPerItem(event.target.value)} />
        </div>
        <p className="kicker">Blocked categories</p>
        <div className="checks">
          {categories.map((category) => (
            <label key={category}>
              <input
                type="checkbox"
                checked={blocked.includes(category)}
                onChange={(event) => {
                  setBlocked((current) =>
                    event.target.checked ? [...current, category] : current.filter((entry) => entry !== category),
                  );
                }}
              />
              {category}
            </label>
          ))}
        </div>
        {error ? <p className="error-banner">{error}</p> : null}
        <div className="actions">
          <button type="button" className="solid" onClick={save}>Save policy</button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              onSave(DEFAULT_POLICY);
              onClose();
            }}
          >
            Reset defaults
          </button>
          <button type="button" className="ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
