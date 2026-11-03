export type RefundableLine = {
  sku: string;
  name: string;
  quantity: number;
  lineTotalCents: number;
  category?: string;
};

const STOP = new Set(["the", "and", "for", "they", "them", "arrived", "broken", "refund"]);

export function matchRefundLines(lines: RefundableLine[], query: string): RefundableLine[] {
  const phrase = query.toLowerCase().trim();
  if (!phrase) return [];
  const words = phrase
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9-]/g, ""))
    .filter((word) => word.length > 2 && !STOP.has(word));

  return lines.filter((line) => {
    const hay = `${line.name} ${line.sku} ${line.category ?? ""}`.toLowerCase();
    if (hay.includes(phrase)) return true;
    if (words.length === 0) return false;
    return words.every((word) => variants(word).some((variant) => hay.includes(variant)));
  });
}

export function refundAmountForQuery(
  lines: RefundableLine[],
  query: string,
): { matches: RefundableLine[]; amountCents: number } | { error: string } {
  const matches = matchRefundLines(lines, query);
  if (matches.length === 0) {
    return { error: `No line items match “${query}”.` };
  }
  return {
    matches,
    amountCents: matches.reduce((sum, line) => sum + line.lineTotalCents, 0),
  };
}

function variants(word: string): string[] {
  const out = [word];
  if (word.endsWith("s") && word.length > 3) out.push(word.slice(0, -1));
  if (word.endsWith("es") && word.length > 4) out.push(word.slice(0, -2));
  return out;
}
