/**
 * The strategies the simulation compares, as plain settings.
 *
 * `legacy` and `from: 'start'` are the first release's selection: the first 256 missing groups
 * counted from the start of the file, ties in file order. The rest build on `random-ties`, so a
 * row differs from it by one idea.
 */

const base = { legacy: false, from: 'random', ties: 'random', seeder: 'serve', endgame: null, hotswap: null }

export const STRATEGIES = {
  'file-order': { ...base, legacy: true, from: 'start', ties: 'file' },
  'random-ties': { ...base },
  'superseed-reveal': { ...base, seeder: 'reveal' },
  'superseed-reject': { ...base, seeder: 'reject' },
  endgame: { ...base, endgame: { last: 16 } },
  hotswap: { ...base, hotswap: { copies: 3 } } // Hypercore's: when everything missing is asked for, ask for the least-asked again, up to 3 copies
}
