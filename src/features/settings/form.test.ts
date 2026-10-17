import { describe, expect, it } from "vitest";
import { defaultSettings } from "@/server/settings/schema";
import { parseSettingsForm, toFormValues } from "./form";

const defaults = defaultSettings({ MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 });

describe("settings form", () => {
  it("shows rates as percent and cents as dollars", () => {
    const values = toFormValues(defaults);
    expect(values["fees.ebay.feeRate"]).toBe("13.25");
    expect(values["fees.ebay.fixedFeeCents"]).toBe("0.30");
    expect(values["pricing.minProfitCents"]).toBe("3.00");
    expect(values["listing.manualApprove"]).toBe("on");
    expect(values["demand.marketplaceInsightsEnabled"]).toBe("");
    expect(values["repricer.defaultStrategy"]).toBe("SLIGHTLY_BELOW");
  });

  it("round-trips every setting, so no field is missing from the form", () => {
    expect(parseSettingsForm(toFormValues(defaults))).toEqual({ success: true, settings: defaults });
  });

  it("converts edited values back to rates and cents", () => {
    const result = parseSettingsForm({
      ...toFormValues(defaults),
      "fees.amazon.feeRate": "17",
      "pricing.minProfitCents": "4.5",
      "listing.manualApprove": undefined,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.settings.fees.amazon.feeRate).toBe(0.17);
    expect(result.settings.pricing.minProfitCents).toBe(450);
    expect(result.settings.listing.manualApprove).toBe(false);
  });

  it("reports errors by field path", () => {
    const result = parseSettingsForm({
      ...toFormValues(defaults),
      "fees.ebay.feeRate": "130",
      "pricing.minProfitCents": "",
      "repricer.checkIntervalMinutes": "abc",
      "repricer.defaultStrategy": "RANDOM",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors).toEqual({
      "fees.ebay.feeRate": "Enter a percentage between 0 and 100.",
      "pricing.minProfitCents": "Enter an amount of $0 or more.",
      "repricer.checkIntervalMinutes": "Enter a whole number.",
      "repricer.defaultStrategy": "Choose one of the options.",
    });
  });

  it("keeps the wording of cross-field rules", () => {
    const result = parseSettingsForm({ ...toFormValues(defaults), "matching.reviewThreshold": "90" });
    expect(result).toEqual({
      success: false,
      errors: { "matching.reviewThreshold": "Must not exceed the confirm threshold." },
    });
  });
});
