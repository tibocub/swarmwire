# Quickstart: validating Peer Events, Counts and Folder File List

Run from the repository root once the tasks are done.

1. **Baseline first.** Before the first code change: `npm test`, `npm run bench` and keep the output.
2. **Unit and swarm tests**: `npm test` passes, including `test/unit/holdings.test.js`,
   `test/swarm/peers.test.js` and `test/swarm/list.test.js`. These cover SC-001 to SC-004.
3. **Bare**: `npm run test:bare` passes with the same files (no new globals).
4. **Real swarm**: `npm run test:net` and `npm run test:bare:net` pass, including the events and
   counts check on a private DHT.
5. **Benchmarks** (SC-006): `npm run bench` again; requests per file, wasted requests and proof
   overhead equal the baseline.
6. **Look-only really is** (FR-011a): the test with three peers on a harness topic shows the reader
   is not among the providers a lookup returns.
7. **Contract and package**: `npm run test:unit` (the contract test), `npm run check:pack`.
8. **Hand-check, 5 minutes**: with two terminals, serve a folder with `node bin/swarmwire.js send`, in a
   script attach to the sender's `Swarmwire`, and watch `peer-connected`, `counts(link)` while a
   second process downloads, and `peer-disconnected` when it is killed. (The CLI itself does not use
   the new API yet; that is the CLI repository's job.)

Not validated here: CLI display of the counts (CLI repository), admission and hints (later features).
