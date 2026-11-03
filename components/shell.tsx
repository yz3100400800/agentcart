import Link from "next/link";
import type { ReactNode } from "react";
import { EnvPill, Nav } from "@/components/nav";

export default function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <a className="skip" href="#content">Skip to content</a>
      <header className="topbar">
        <Link href="/" className="brand">
          <strong>AgentCart</strong>
          <small>Purchasing agent</small>
        </Link>
        <Nav />
        <EnvPill />
      </header>
      <main id="content" className="page">{children}</main>
      <footer className="footer">
        <span>Sandbox demo. The catalog uses fictional brands, and PayPal is the source of truth for payment status.</span>
        <span>MIT License</span>
      </footer>
    </div>
  );
}
