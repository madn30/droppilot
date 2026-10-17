function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Inline styles only: eBay removes scripts and other active content, and inline styles work everywhere eBay shows a description.
const PAGE = "background:#eeeeee;padding:16px 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#333333;";
const CARD = "background:#ffffff;max-width:1000px;margin:0 auto 16px;padding:20px 24px;border:1px solid #dddddd;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.15);";
const HEADING = "font-size:24px;line-height:1.25;margin:0 0 12px;color:#222222;";
const SECTION = "font-size:16px;margin:20px 0 8px;color:#1d3f72;";
const CELL = "padding:6px 10px;border:1px solid #dddddd;vertical-align:top;";
const PICTURE = "max-width:100%;height:auto;display:block;margin:0 auto 10px;";
const INFO_BOX = "flex:1 1 260px;border:1px solid #dddddd;border-radius:4px;padding:12px 14px;background:#f7f7f7;";

function section(title: string): string {
  return `<h3 style="${SECTION}">${escapeHtml(title)}</h3>`;
}

/** Facts as a two-column table; a fact without a "label: value" shape spans both columns. */
function factsTable(facts: string[]): string {
  const rows = facts.map((fact) => {
    const split = fact.indexOf(": ");
    if (split <= 0) return `<tr><td colspan="2" style="${CELL}">${escapeHtml(fact)}</td></tr>`;
    return `<tr><td style="${CELL}background:#f7f7f7;font-weight:bold;width:34%;">${escapeHtml(fact.slice(0, split))}</td><td style="${CELL}">${escapeHtml(fact.slice(split + 2))}</td></tr>`;
  });
  return `<table style="border-collapse:collapse;width:100%;margin:0 0 8px;">${rows.join("")}</table>`;
}

function infoBox(title: string, lines: string[]): string {
  return `<div style="${INFO_BOX}"><div style="font-weight:bold;color:#1d3f72;margin:0 0 6px;">${escapeHtml(title)}</div>${lines.map((line) => `<p style="margin:0 0 6px;">${escapeHtml(line)}</p>`).join("")}</div>`;
}

export interface DescriptionOptions {
  /** Business days before the order is handed to the carrier, as set on the listing. */
  handlingDays: number;
}

/**
 * The listing description as eBay shows it, laid out like a store page: the title, our text,
 * the facts (lines starting with "- ") as a specifications table, the supplier's detail pictures,
 * and an information block. The block points to eBay's own shipping, returns and payment details
 * instead of repeating terms that are set in the seller's policies and would go stale here.
 */
export function renderDescriptionHtml(text: string, title: string, detailImageUrls: string[], options: DescriptionOptions): string {
  const lines = text.split("\n").map((line) => line.trim());
  const paragraphs = lines.filter((line) => line && !line.startsWith("- "));
  const facts = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
  const pictures = detailImageUrls.filter((url) => url.startsWith("https://"));

  const product = [
    `<h2 style="${HEADING}">${escapeHtml(title)}</h2>`,
    ...paragraphs.map((paragraph) => `<p style="margin:0 0 10px;">${escapeHtml(paragraph)}</p>`),
    ...(facts.length > 0 ? [section("Specifications"), factsTable(facts)] : []),
    ...(pictures.length > 0 ? [section("Product details")] : []),
    ...pictures.map((url) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}" style="${PICTURE}">`),
  ];
  const days = options.handlingDays === 1 ? "1 business day" : `${options.handlingDays} business days`;
  const information = [
    section("Shipping, returns and payment"),
    `<div style="display:flex;flex-wrap:wrap;gap:12px;">`,
    infoBox("Shipping", [
      `Orders are handed to the carrier within ${days} of payment.`,
      "The shipping cost and the estimated delivery date for your address are shown in the Shipping section of this listing.",
      "A tracking number is added to your order as soon as the parcel ships.",
    ]),
    infoBox("Returns", [
      "The return period and conditions are shown in the Returns section of this listing.",
      "If anything is wrong with your order, message us first and we will put it right.",
    ]),
    infoBox("Payment and questions", [
      "Payment is completed securely through eBay checkout.",
      "Questions before or after you buy? Use Contact seller on this listing and we will be glad to help.",
    ]),
    "</div>",
  ];
  return `<div style="${PAGE}"><div style="${CARD}">${product.join("")}</div><div style="${CARD}">${information.join("")}</div></div>`;
}
