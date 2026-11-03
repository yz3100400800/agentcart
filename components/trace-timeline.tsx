import type { TraceStep } from "@/lib/types";

export default function TraceTimeline({ steps }: { steps: TraceStep[] }) {
  if (steps.length === 0) {
    return <p className="muted">Tool calls, policy decisions, and PayPal requests show up here.</p>;
  }
  return (
    <ol className="trace-list" data-testid="trace">
      {steps.map((step) => (
        <li key={step.id} className="trace-item">
          <span className={`dot ${step.kind}`} aria-hidden="true" />
          <div>
            <header>
              <strong>{step.title}</strong>
              <time dateTime={step.at}>{formatTime(step.at)}</time>
            </header>
            <p className={step.ok === false ? "bad" : undefined}>
              {step.toolName ? <span className="meta">{step.toolName} · </span> : null}
              {step.detail}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
