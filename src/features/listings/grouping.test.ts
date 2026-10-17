import { describe, expect, it } from "vitest";
import { groupListings } from "./grouping";

const row = (id: string, groupKey: string | null, marketplace = "EBAY") => ({ id, groupKey, marketplace });

describe("groupListings", () => {
  it("puts the options of one listing on one card and leaves ordinary listings alone", () => {
    const groups = groupListings([row("a", "DP-1"), row("b", null), row("c", "DP-1"), row("d", "DP-2")]);
    expect(groups.map((group) => [group.lead.id, group.options.map((option) => option.id)])).toEqual([
      ["a", ["a", "c"]],
      ["b", ["b"]],
      ["d", ["d"]],
    ]);
  });

  it("keeps the same group key on two marketplaces apart", () => {
    expect(groupListings([row("a", "DP-1"), row("b", "DP-1", "AMAZON")])).toHaveLength(2);
  });
});
