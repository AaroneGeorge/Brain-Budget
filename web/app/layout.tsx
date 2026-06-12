import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BrainBudget — a research agent that pays for its own brain",
  description:
    "Delegate a scoped USDC budget to an AI agent via ERC-7710. It pays per-request for Venice AI inference through x402 — non-custodial, caveat-enforced, gasless.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
