import { describe, expect, it } from "vitest";
import { MAX_VARIATIONS, optionsOf, variationSet } from "./variations";

describe("optionsOf", () => {
  it("turns supplier attributes into option names and values", () => {
    expect(optionsOf({ "light color": " Grey ", power: "0.5  watts" })).toEqual({ "Light Color": "Grey", Power: "0.5 watts" });
  });

  it("drops empty attributes and tolerates missing or malformed ones", () => {
    expect(optionsOf({ color: "", size: "M" })).toEqual({ Size: "M" });
    expect(optionsOf(null)).toEqual({});
    expect(optionsOf({ color: 3 })).toEqual({});
  });

  it("cuts values eBay would reject as too long", () => {
    expect(optionsOf({ color: "x".repeat(80) }).Color).toHaveLength(50);
  });
});

describe("variationSet", () => {
  const variant = (id: string, attributes: unknown) => ({ id, attributes });

  it("groups variants that offer a different choice of the same options, the requested one first", () => {
    const set = variationSet(variant("white", { color: "White" }), [variant("black", { color: "Black" }), variant("red", { color: "Red" })]);
    expect(set.map((entry) => [entry.variant.id, entry.options])).toEqual([
      ["white", { Color: "White" }],
      ["black", { Color: "Black" }],
      ["red", { Color: "Red" }],
    ]);
  });

  it("leaves out a duplicate choice and a variant with other option names", () => {
    const set = variationSet(variant("white", { color: "White" }), [
      variant("white-again", { color: "white" }),
      variant("sized", { color: "Black", size: "M" }),
      variant("black", { color: "Black" }),
    ]);
    expect(set.map((entry) => entry.variant.id)).toEqual(["white", "black"]);
  });

  it("is empty when the variant has no options or nothing to choose between", () => {
    expect(variationSet(variant("plain", {}), [variant("other", { color: "Black" })])).toEqual([]);
    expect(variationSet(variant("white", { color: "White" }), [])).toEqual([]);
    expect(variationSet(variant("white", { color: "White" }), [variant("copy", { color: "White" })])).toEqual([]);
  });

  it("offers only the attributes that differ between the variants", () => {
    const set = variationSet(variant("grey", { "light color": "Grey", power: "0.5 watts" }), [
      variant("white", { "light color": "White", power: "0.5 watts" }),
    ]);
    expect(set.map((entry) => entry.options)).toEqual([{ "Light Color": "Grey" }, { "Light Color": "White" }]);
  });

  it("never offers more options than the limit", () => {
    const others = Array.from({ length: 100 }, (_, index) => variant(`v${index}`, { color: `Shade ${index}` }));
    expect(variationSet(variant("first", { color: "First" }), others)).toHaveLength(MAX_VARIATIONS);
  });
});
