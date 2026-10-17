import { describe, expect, it } from "vitest";
import { renderDescriptionHtml } from "./description";

const OPTIONS = { handlingDays: 3 };

describe("renderDescriptionHtml", () => {
  it("lays out the title, text, a specifications table and the detail pictures", () => {
    const html = renderDescriptionHtml(
      "A foldable lamp.\n\n- Material: ABS\n- Size: 14 x 4 cm\n- USB cable included\nShips in a box.",
      "LED Lamp",
      ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"],
      OPTIONS,
    );
    expect(html).toMatch(/<h2 [^>]*>LED Lamp<\/h2><p [^>]*>A foldable lamp\.<\/p><p [^>]*>Ships in a box\.<\/p><h3 [^>]*>Specifications<\/h3><table/);
    // "Label: value" facts become two cells; a fact without a label spans the row.
    expect(html).toMatch(/<td [^>]*>Material<\/td><td [^>]*>ABS<\/td>/);
    expect(html).toMatch(/<td colspan="2" [^>]*>USB cable included<\/td>/);
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('<img src="https://cdn.example/a.jpg" alt="LED Lamp"');
  });

  it("states the handling time and points to eBay's own shipping and returns details", () => {
    const html = renderDescriptionHtml("A lamp.", "LED Lamp", [], OPTIONS);
    expect(html).toContain("Orders are handed to the carrier within 3 business days of payment.");
    expect(renderDescriptionHtml("A lamp.", "LED Lamp", [], { handlingDays: 1 })).toContain("within 1 business day of payment");
    expect(html).toContain("shown in the Returns section of this listing");
    // No delivery promise, no links away from eBay, and nothing eBay would strip.
    expect(html).not.toMatch(/<a |<script|<style|href=/);
    expect(html).not.toMatch(/arrives|delivered (in|by|within)/i);
  });

  it("leaves out empty sections", () => {
    const html = renderDescriptionHtml("A lamp.", "LED Lamp", [], OPTIONS);
    expect(html).not.toContain("Specifications");
    expect(html).not.toContain("Product details");
    expect(html).not.toContain("<img");
  });

  it("escapes markup in the text and leaves out pictures that are not served over https", () => {
    const html = renderDescriptionHtml('Size < 5" & light <script>alert(1)</script>', 'A "B"', ["http://cdn.example/a.jpg", "javascript:alert(1)"], OPTIONS);
    expect(html).toContain("Size &lt; 5&quot; &amp; light &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
});
