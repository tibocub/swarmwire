# Quickstart: validating Piece Selection and Swarm Scaling

Run from the repository root once the tasks are done.

1. **Baseline first.** Before any code change: `npm test` and `npm run bench`; keep both outputs.
2. **Selection**: `npm run test:unit` passes, including the window, tie-break, first-group and
   availability tests with a fixed random source.
3. **The crowd** (SC-001): `npm run test:swarm` passes, including `spread.test.js`: one seeder, a
   hundred fresh downloaders, and at least 90% of groups uploaded after three files' worth.
4. **Single transfer** (SC-002): `npm run bench`. Requests, wasted requests and proof overhead
   equal the baseline; completion time is within 2% (measure completion, not network idle).
5. **The simulation**: `npm run bench:sim` prints the comparison table. Run it twice: the output is
   byte-identical (SC-003). Run `npm run bench:sim -- --peers 1000` and time it: under ten
   minutes.
6. **Model against reality**: the real-node test and the model's `random-ties` row agree in
   direction on the share of distinct groups uploaded after three files' worth.
7. **Verdicts**: `docs/scaling.md` has a section for super-seeding (both variants) and endgame, each
   with settings, table and verdict (SC-006).
8. **Everything**: `npm run test:all` (Node and Bare) and `npm run check:pack`.

Not validated here: behaviour on the public DHT, and the CLI.
