# API draft: piece selection

Becomes part of `docs/contract.md` when implemented.

## On `Swarmwire`

| Member | Contract |
|---|---|
| `random` (a plain field, not a constructor option) | `random()` returns a number in [0, 1). Default `Math.random`. Tests replace it with a seeded one. Not documented in the public contract. |

## Behaviour

- A download asks for groups in an order that is **not file order**. A file is complete when every
  group is held; nothing about reading it while it downloads is promised. (It never was; it used to
  happen roughly.)
- Selection never decides whether a transfer can finish: it changes order and who is asked, not
  correctness. Any peer, including one that does something different, can be on the other side.

## Internal (not exported)

`lib/select.js`: `Availability`, `candidates`, `rank`. (`rarestFirst` is removed.)

## Wire

No change. If super-seeding is built, it uses `have`, `holds`, `reject` as they are.
