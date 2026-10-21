# Data Model: Piece Selection and Swarm Scaling

Nothing is persisted. Everything is in memory, per download or per simulation run.

## Availability

`counts: Uint16Array(groupCount)`: for each group, how many *source* peers hold it. Uint16
bounds a count at 65,535 peers, far above the 64-neighbour design.

- `add(bitfield)`: increment every set bit. Used on `have`.
- `set(index)`: increment one. Used on `holds`, only if that peer's bit was clear.
- `unset(index)`: decrement one. Used when a set bit is cleared (`reject`).
- `remove(bitfield)`: decrement every set bit. Used when a peer leaves, sends `unavailable`, or is
  marked a liar.
- `at(index)`: the count, never below 0.
- Invariant: after any sequence of events, `counts[i]` equals the number of source peers whose
  bitfield has bit `i` (tested by recounting).

## Candidate window

The ordered list `candidates({count, has, peerHas, claimed, from, limit})` returns:

- (`legacy: true`, `file-order` only: take the first `limit` groups with `!has(g)` from 0 first, then filter by `peerHas`/`claimed`)
- groups `g` scanned from `from`, wrapping, such that `!has(g)`, `peerHas(g)` and `!claimed(g)`;
- at most `limit` of them (default `SCAN_LIMIT = 256`);
- in scan order (the random start makes the order random-looking; ranking comes after).

## Ranking

`rank(candidates, availability, random)` returns the candidates ordered by `availability.at`
ascending, ties in random order. A random key per candidate is drawn once per call.

## Strategy (simulation only)

```
{ name, tieBreak: 'file'|'random', window: number, legacy: boolean, first: 'none'|'random',
  seeder: 'serve'|'reveal'|'reject', endgame: false|{ last: number } }
```

## Simulated peer

| Field | Meaning |
|---|---|
| id | integer |
| role | `seed` or `down` |
| has | bitfield of groups held |
| neighbours | up to `neighbours` peer ids |
| uplink | groups it can upload per tick |
| queue | requests waiting for its uplink (FIFO) |
| inflight | per neighbour: requested groups not yet received |
| availability | an `Availability` over its neighbours |
| doneAt | tick it held every group, or null |

## Simulation result row

`{ strategy, median, last, repeatShare, wasted }`: ticks to the median and last downloader;
the share of seeder uploads of a group the seeder had already uploaded; requests whose group
arrived from someone else first or was rejected.
