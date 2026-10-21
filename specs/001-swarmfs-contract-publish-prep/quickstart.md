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
6. **README**: the example matches `examples/send-get.js` exactly, and the CLI paragraph points at
   `swarmwire-cli`.

Not validated here, by design: the planned capabilities in the contract. They are validated by the
feature that builds them.
