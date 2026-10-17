/** A marketplace listing as the buyer sees it: one card, with its options when it has any. */
export interface ListingGroup<T> {
  key: string;
  /** The row that stands for the listing: its title, description, holiday and marketplace id. */
  lead: T;
  /** Every row of the listing, the lead included; more than one when the buyer picks an option. */
  options: T[];
}

/** Puts the options of one listing together, keeping the order of the first row of each. */
export function groupListings<T extends { id: string; marketplace: string; groupKey: string | null }>(listings: T[]): ListingGroup<T>[] {
  const groups = new Map<string, ListingGroup<T>>();
  for (const listing of listings) {
    const key = listing.groupKey ? `${listing.marketplace}|${listing.groupKey}` : listing.id;
    const group = groups.get(key);
    if (group) group.options.push(listing);
    else groups.set(key, { key, lead: listing, options: [listing] });
  }
  return [...groups.values()];
}
