import { jsPDF } from "jspdf";

/*
 * Renders the final research report as a polished, print-ready A4 PDF.
 * Pure client-side; jsPDF lays out crisp, selectable vector text (not a
 * rasterised screenshot), so the document stays sharp at any zoom and is
 * fully copy-pasteable. Loaded on demand from the page so jsPDF never
 * touches the initial bundle.
 */

export interface ReportPdfData {
  question: string;
  report: string;
  spentUsd: number;
  calls: number;
  budgetUsd: number;
  chain?: string;
  delegator?: string;
  agent?: string;
  generatedAt?: Date;
}

type RGB = [number, number, number];

const INK: RGB = [24, 24, 27]; // near-black body
const MUTED: RGB = [82, 82, 91];
const SUBTLE: RGB = [148, 148, 158]; // labels
const ACCENT: RGB = [4, 120, 87]; // emerald — the one semantic accent
const RULE: RGB = [228, 228, 231];

const short = (a?: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—");

export function downloadReportPdf(data: ReportPdfData): void {
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 54;
  const contentW = pageW - margin * 2;
  const bottom = pageH - 70; // keep clear of the footer
  const topContent = 64; // baseline of first line on continuation pages

  let y = 0;

  const setText = (c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
  const setFill = (c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
  const setDraw = (c: RGB) => doc.setDrawColor(c[0], c[1], c[2]);

  const newPage = () => {
    doc.addPage();
    y = topContent;
  };

  /* flowing paragraph text with inline **bold** runs, word-wrapped + page-aware */
  const flow = (
    text: string,
    opts: { size: number; gap: number; color: RGB; style?: "normal" | "italic"; indent?: number },
  ) => {
    const lineH = opts.size + opts.gap;
    const x0 = margin + (opts.indent ?? 0);
    const maxX = margin + contentW;
    const base: "normal" | "italic" = opts.style ?? "normal";
    doc.setFontSize(opts.size);
    setText(opts.color);
    if (y > bottom) newPage();
    let x = x0;
    const runs = text.split("**").map((t, i) => ({ t, bold: i % 2 === 1 }));
    for (const run of runs) {
      doc.setFont("helvetica", run.bold ? "bold" : base);
      for (const token of run.t.split(/(\s+)/)) {
        if (token === "") continue;
        if (/^\s+$/.test(token)) {
          if (x > x0) x += doc.getTextWidth(" ");
          continue;
        }
        const w = doc.getTextWidth(token);
        if (x + w > maxX && x > x0) {
          y += lineH;
          if (y > bottom) newPage();
          x = x0;
        }
        doc.text(token, x, y);
        x += w;
      }
    }
    y += lineH;
  };

  const heading = (text: string, size: number, color: RGB = INK) => {
    y += size * 0.5;
    if (y > bottom) newPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    setText(color);
    for (const ln of doc.splitTextToSize(text, contentW) as string[]) {
      if (y > bottom) newPage();
      doc.text(ln, margin, y);
      y += size + 4;
    }
    y += 4;
  };

  const label = (text: string) => {
    if (y > bottom) newPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    setText(SUBTLE);
    doc.text(text.toUpperCase(), margin, y, { charSpace: 0.7 });
    y += 14;
  };

  const bullet = (text: string) => {
    if (y > bottom) newPage();
    setFill(ACCENT);
    doc.circle(margin + 3, y - 3, 1.7, "F");
    flow(text, { size: 11, gap: 5.5, color: INK, indent: 16 });
    y += 3;
  };

  const numbered = (n: string, text: string) => {
    if (y > bottom) newPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    setText(ACCENT);
    doc.text(`${n}.`, margin, y);
    flow(text, { size: 11, gap: 5.5, color: INK, indent: 18 });
    y += 3;
  };

  const rule = (color: RGB = RULE, width = 0.8) => {
    if (y > bottom) newPage();
    setDraw(color);
    doc.setLineWidth(width);
    doc.line(margin, y, margin + contentW, y);
  };

  /* ---- masthead (page 1) ---- */
  y = 60;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(26);
  setText(INK);
  doc.text("Brain", margin, y);
  const brainW = doc.getTextWidth("Brain");
  setText(ACCENT);
  doc.text("Budget", margin + brainW, y);

  y += 18;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  setText(MUTED);
  doc.text("a research agent that pays for its own brain", margin, y);

  y += 14;
  rule(RULE, 1);
  setDraw(ACCENT);
  doc.setLineWidth(2.4);
  doc.line(margin, y, margin + 66, y);
  y += 28;

  /* ---- question ---- */
  label("Research question");
  flow(data.question, { size: 13.5, gap: 6, color: INK });
  y += 12;

  /* ---- metadata grid ---- */
  const colGap = 24;
  const colW = (contentW - colGap) / 2;
  const rowH = 40;
  const gridTop = y;
  const cell = (lab: string, val: string, col: 0 | 1, row: number, mono = false) => {
    const x = margin + col * (colW + colGap);
    const cy = gridTop + row * rowH;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    setText(SUBTLE);
    doc.text(lab.toUpperCase(), x, cy, { charSpace: 0.5 });
    doc.setFont(mono ? "courier" : "helvetica", "normal");
    doc.setFontSize(mono ? 9.5 : 11.5);
    setText(INK);
    doc.text(val, x, cy + 15);
  };
  const date = data.generatedAt ?? new Date();
  const dateStr = date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  cell("Generated", dateStr, 0, 0);
  cell("Network", data.chain ?? "—", 1, 0);
  cell("Spent", `$${data.spentUsd.toFixed(2)} USDC`, 0, 1);
  cell("Paid inferences", String(data.calls), 1, 1);
  cell("Delegated budget", `$${data.budgetUsd.toFixed(2)} USDC`, 0, 2);
  cell("Settlement", "x402 · ERC-7710 on-chain", 1, 2);
  cell("Delegator (user)", short(data.delegator), 0, 3, true);
  cell("Agent (delegate)", short(data.agent), 1, 3, true);
  y = gridTop + rowH * 4 + 6;

  rule();
  y += 24;

  /* ---- split the appended critic review off the main report ---- */
  let mainReport = data.report;
  let criticText = "";
  let criticCaption = "";
  const criticIdx = data.report.indexOf("— Critic review");
  if (criticIdx !== -1) {
    mainReport = data.report.slice(0, criticIdx).trim();
    const rest = data.report.slice(criticIdx);
    const nl = rest.indexOf("\n");
    criticCaption = (nl === -1 ? rest : rest.slice(0, nl)).replace(/—/g, "").trim();
    criticText = nl === -1 ? "" : rest.slice(nl + 1).trim();
  }

  /* ---- report body (light markdown: headings / bullets / numbered / bold) ---- */
  heading("Research report", 16);
  renderMarkdown(mainReport);

  if (criticText) {
    y += 10;
    heading("Critic review", 14, ACCENT);
    if (criticCaption) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      setText(MUTED);
      for (const ln of doc.splitTextToSize(criticCaption, contentW) as string[]) {
        if (y > bottom) newPage();
        doc.text(ln, margin, y);
        y += 12;
      }
      y += 6;
    }
    renderMarkdown(criticText, "italic");
  }

  /* ---- footer with page numbers, stamped after layout is known ---- */
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const fy = pageH - 42;
    setDraw(RULE);
    doc.setLineWidth(0.8);
    doc.line(margin, fy, margin + contentW, fy);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    setText(SUBTLE);
    doc.text("BrainBudget · a research agent that pays for its own brain", margin, fy + 14);
    const pn = `Page ${p} of ${pages}`;
    doc.text(pn, margin + contentW - doc.getTextWidth(pn), fy + 14);
  }

  doc.setProperties({
    title: "BrainBudget — Research Report",
    subject: data.question,
    author: "BrainBudget research agent",
    creator: "BrainBudget",
  });

  const stamp = date.toISOString().slice(0, 10);
  doc.save(`brainbudget-report-${stamp}.pdf`);

  /* render a block of light markdown into the running layout */
  function renderMarkdown(md: string, style: "normal" | "italic" = "normal") {
    const lines = md.replace(/\r/g, "").split("\n");
    let para: string[] = [];
    const flushPara = () => {
      if (para.length === 0) return;
      flow(para.join(" "), { size: 11, gap: 5.5, color: INK, style });
      y += 6;
      para = [];
    };
    for (const raw of lines) {
      const t = raw.trim();
      if (t === "") {
        flushPara();
        continue;
      }
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
        flushPara();
        const lvl = m[1].length;
        heading(m[2], lvl <= 1 ? 14 : lvl === 2 ? 12.5 : 11.5);
        continue;
      }
      if ((m = t.match(/^[-*•]\s+(.*)$/))) {
        flushPara();
        bullet(m[1]);
        continue;
      }
      if ((m = t.match(/^(\d+)[.)]\s+(.*)$/))) {
        flushPara();
        numbered(m[1], m[2]);
        continue;
      }
      para.push(t);
    }
    flushPara();
  }
}
