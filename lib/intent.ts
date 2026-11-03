import type { RequestHints } from "@/lib/types";
import { dollarsToCents } from "@/lib/money";

export function parseRequestHints(text: string): RequestHints {
  const hints: RequestHints = {};
  const budgetMatch =
    /budget(?:\s+of)?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i.exec(text) ??
    /(?:under|below|max(?:imum)?|cap)\s*\$\s*(\d+(?:\.\d{1,2})?)/i.exec(text) ??
    /\$\s*(\d+(?:\.\d{1,2})?)/.exec(text);
  if (budgetMatch) {
    hints.budgetCents = dollarsToCents(Number(budgetMatch[1]));
  }

  const teamMatch =
    /(\d+)\s*[- ]?\s*person/i.exec(text) ??
    /team of\s*(\d+)/i.exec(text) ??
    /for\s+(\d+)\s+people/i.exec(text);
  if (teamMatch) {
    hints.teamSize = Number(teamMatch[1]);
  }

  const dayMatch = /(\d+)\s*days?/i.exec(text);
  if (dayMatch) {
    hints.days = Number(dayMatch[1]);
  } else if (/next week|this week|a week|per week/i.test(text)) {
    hints.days = 5;
  }

  return hints;
}

const CHANGE_WORDS = /\b(instead|change|remove|add|cheaper|without|don't|do not|except)\b/i;

export function explicitApproval(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || CHANGE_WORDS.test(trimmed)) return false;
  return /^(i approve( this( cart| order| exception)?)?|approve( this( cart| order| exception)?)?|yes[, ]+approve( this( cart| order| exception)?)?|go ahead)[.!]?$/i.test(
    trimmed,
  );
}

export function resolveRequestBudget(
  hintCents?: number,
  toolCents?: number,
): number | undefined {
  if (hintCents !== undefined && toolCents !== undefined) {
    return Math.min(hintCents, toolCents);
  }
  return hintCents ?? toolCents;
}
