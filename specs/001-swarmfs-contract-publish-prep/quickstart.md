# Quickstart: validating SwarmFS Contract and Publish Prep

Run from the repository root once the tasks are done.

1. **Suites still pass** (Principle IV): `npm run test:all`. Includes the new contract-export test
   on Node and Bare and the example test against the private DHT.
2. **Contract is honest**: `npm run test:unit` fails if `docs/contract.md` lists an export that
   `index.js` does not provide (SC-002). Rename an export locally and confirm it fails, then undo.
3. **Package contents** (SC-005): `npm run check:pack` passes. Add a file under `test/` to the
   whitelist temporarily and confirm it fails.
4. **Install from the tarball** (SC-003, SC-004):
   ```bash
   npm pack
   mkdir /tmp/consumer && cd /tmp/consumer && npm init -y && npm i /path/to/swarmwire-lib-0.1.0.tgz
   ```
   Follow the README example from that directory on Node. The received file is byte-identical to
   the sent one. Bare is covered by `npm run test:bare:net`, which runs the example inside the
   repository. Delete `/tmp/consumer` afterwards.
5. **Questions test** (SC-001): give `docs/contract.md` and the prepared ten questions to someone
   who has not read the source; every answer must match the library's behaviour.

   The ten questions, with the answer the contract gives. Answers come from `docs/contract.md`
   alone, and each must also be true of the library (planned items are answered "not yet").

   1. If every peer hint I give is wrong, does the download still finish? *Yes. Hints add options,
      never correctness, and cannot stall a transfer.*
   2. Does a peer hint make swarmwire connect to that peer? *No. It only changes which
      already-connected peers are asked first; the application dials.*
   3. How do I stop a peer outside my space from downloading something? *With an admission
      decision (planned, feature 002), made per peer and per content root.*
   4. What does a refused peer learn? *Nothing: it gets the same answer as for content swarmwire
      does not hold.*
   5. What if my admission decision throws or never answers? *It counts as a deny.*
   6. A folder has 1,000 files. How many admission decisions are made? *One per file, each told
      which folder it was requested through.*
   7. How do I download only some files of a folder? *Read the folder's file list (public reader
      planned, feature 002), then download the chosen files individually. Choosing is the
      application's job.*
   8. What does "3 peers connected" mean? *Direct connections only: a snapshot that may lag, not a
      count of the swarm.*
   9. Who owns the network connection and the keys? *The application. swarmwire attaches to the
      connection event and leaves the connection alone.*
   10. Can swarmwire tell me which peers hold which chunks across the whole network, or what a
       file is called? *No. Global counts and rarity are a tracker's job; names belong to
       SwarmFS.*
6. **README**: the example matches `examples/send-get.js` exactly, and the CLI paragraph points at
   `swarmwire-cli`.

Not validated here, by design: the planned capabilities in the contract. They are validated by the
feature that builds them.
