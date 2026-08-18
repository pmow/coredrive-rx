// regionsview.js — pure transform: stored region-discovery answers (accumulated in
// app.js's onRegionsFrame, from applyRegionsReply results — see src/regionreq.js)
// into the rows the Home "declared scopes" panel displays.
//
// Two answer shapes are both real, distinct facts and neither is ever rendered
// blank: a repeater that declared regions lists them; one that declared an EMPTY
// list means it flood-allows nothing — that is an answer, not an absence of one.
export const REGIONS_ROWS_MAX = 5;

// regionsRows takes the stored answers (oldest first, in arrival order) and returns
// the most recent REGIONS_ROWS_MAX, most-recent-first. `name` (if already resolved
// and attached to a stored answer) passes through unresolved here — name resolution
// is a network lookup via names.js and stays in app.js, not in this pure function.
export function regionsRows(answers) {
  if (!answers || !answers.length) return [];
  return answers.slice(-REGIONS_ROWS_MAX).reverse().map((a) => ({
    target: a.target,
    name: a.name || '',
    regions: a.regions,
    declaresNothing: a.regions.length === 0,
    truncated: !!a.truncated,
  }));
}
