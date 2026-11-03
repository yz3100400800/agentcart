"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Primary">
      <Link href="/" className={path === "/" ? "active" : undefined}>Desk</Link>
      <Link href="/orders" className={path.startsWith("/orders") ? "active" : undefined}>Orders</Link>
    </nav>
  );
}

export function EnvPill() {
  const [env, setEnv] = useState<"sandbox" | "live">("sandbox");
  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((body: { paypalEnv?: "sandbox" | "live" }) => {
        if (body.paypalEnv === "live" || body.paypalEnv === "sandbox") setEnv(body.paypalEnv);
      })
      .catch(() => undefined);
  }, []);
  return <span className={env === "live" ? "env-pill live" : "env-pill"}>{env === "live" ? "PayPal live" : "PayPal sandbox"}</span>;
}
