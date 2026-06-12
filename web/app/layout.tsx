import type { Metadata } from "next";
import { Fraunces, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "600", "700", "900"],
  style: ["normal", "italic"],
});

const splineMono = Spline_Sans_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "BrainBudget — a research agent that pays for its own brain",
  description:
    "Delegate a scoped USDC budget to an AI agent via ERC-7710. It pays per-request for Venice AI inference through x402 — non-custodial, caveat-enforced, gasless.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${splineMono.variable}`}>{children}</body>
    </html>
  );
}
