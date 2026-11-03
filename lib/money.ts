export function centsToAmount(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new Error("Cents must be an integer.");
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = (abs % 100).toString().padStart(2, "0");
  return `${sign}${dollars}.${remainder}`;
}

export function amountToCents(value: string): number {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid amount ${value}`);
  }
  const sign = match[1] ? -1 : 1;
  const dollars = Number(match[2]);
  const fraction = Number((match[3] ?? "").padEnd(2, "0"));
  return sign * (dollars * 100 + fraction);
}

export function dollarsToCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Invalid dollar amount.");
  }
  return Math.round(value * 100);
}

export function formatUsd(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const remainder = (abs % 100).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${remainder}`;
}
