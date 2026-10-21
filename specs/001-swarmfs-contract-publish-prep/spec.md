# Feature Specification: SwarmFS Contract and Publish Prep

**Feature Branch**: `001-swarmfs-contract-publish-prep`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "SwarmFS contract and publish prep"

## Clarifications

### Session 2026-10-21

- Q: When an admission decision refuses a peer, can that peer tell the content exists? → A: No. A refused peer gets the same answer as for content swarmwire does not hold.
- Q: Is admission decided once per folder or per file inside it? → A: Per file. Each file is its own content root and is asked separately, and the call includes the folder it was requested through.
- Q: Should a peer hint make swarmwire connect to that peer, or only favor it when already connected? → A: Only favor it. The application dials peers itself through the connection it owns.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A written contract between swarmwire and the layers above it (Priority: P1)

The developer of SwarmFS (or any other application built on swarmwire) opens one document and learns
exactly what swarmwire guarantees, what it will accept from the application, and what it will never
do. They can design their side without reading swarmwire's source and without fearing that a later
swarmwire release silently changes the deal.

The contract covers five things the application can rely on or supply:

1. **Hints**: peers to prefer or connect to, file or range priorities. Hints only add options.
2. **Admission decisions**: a way for the application to say which peer may fetch which content.
3. **Peer activity**: join and leave notifications and live counts of connected peers and how many
   of them hold the whole content.
4. **A shared network connection**: the application owns the connection to the swarm and swarmwire
   attaches to it, so one peer connection can serve several protocols.
5. **Peer identity**: what swarmwire knows about a connected peer, so the application can tie it to
   its own users and devices.

**Why this priority**: This is the decision everything else depends on. Publishing a package fixes
its public surface; SwarmFS and the CLI are both blocked on knowing what that surface is. It is also
the cheapest piece: it is a document plus agreement, not code.

**Independent Test**: A reader who has never opened swarmwire's source can answer, from the
contract alone, each question in a fixed list (for example: "If my peer list is wrong, does the
download still finish?", "How do I refuse a peer that is not in my space?", "Where do I get the
number of connected peers?") and a maintainer confirms every answer matches the library's behaviour.

**Acceptance Scenarios**:

1. **Given** the contract, **When** an application author looks for how to restrict who may download
   something, **Then** they find the admission mechanism, what information it receives, and that a
   refused peer gets the same answer as for content swarmwire does not hold.
2. **Given** the contract, **When** an application supplies a peer hint that is wrong or stale,
   **Then** the contract states that the transfer still completes correctly and that no hint can
   stall it.
3. **Given** the contract, **When** an application author wants peer counts for a display, **Then**
   it states what is counted (direct connections only), what the count excludes, and how changes are
   reported.
4. **Given** a feature request for a name, directory, user or tracker, **When** the maintainer
   checks it against the contract, **Then** the contract tells them whether it belongs in swarmwire
   or one layer up.

---

### User Story 2 - Installing swarmwire from the public registry (Priority: P2)

A developer of another project, starting with `swarmwire-cli`, installs swarmwire from the public
package registry under its final name and uses it without cloning the repository. The installed
package contains what is needed to run on both Node and Bare and nothing that is only for
swarmwire's own development.

**Why this priority**: The CLI repository and any other consumer cannot be installed globally by
end users until this exists. It depends on Story 1 because publishing fixes the public surface.

**Independent Test**: In an empty directory with no access to the swarmwire repository, install the
published package, run the example from the README on Node, and transfer a file between two
processes. The example's behaviour on Bare is proved by the repository's own test suite.

**Acceptance Scenarios**:

1. **Given** an empty project, **When** the developer installs the package by its published name,
   **Then** every symbol the contract describes is importable from the package's main entry.
2. **Given** the installed package, **When** its contents are listed, **Then** test fixtures,
   benchmarks and specification files are absent and the license is present.
3. **Given** the repository's test suite, **When** it runs the example on Bare, **Then** it behaves
   the same as on Node.
4. **Given** a first release, **When** its version is read, **Then** it is a pre-1.0 version that
   tells consumers the surface may still change between minor releases.

---

### User Story 3 - A minimal example that doubles as a check (Priority: P3)

A newcomer reads the README, finds a short send-and-get example, runs it, and sees a file move
between two processes. The same example is run by the test suite, so it cannot rot.

**Why this priority**: It replaces the in-repo CLI as the "how do I use this" answer once the CLI
moves to its own repository, but nothing else is blocked on it.

**Independent Test**: Run the example exactly as the README states and compare the received file to
the original.

**Acceptance Scenarios**:

1. **Given** a fresh checkout, **When** a newcomer follows the README example, **Then** the received
   file is byte-identical to the sent one.
2. **Given** a change that breaks the example, **When** the test suite runs, **Then** it fails.
3. **Given** the README, **When** it describes the command-line tool, **Then** it links to the
   separate repository rather than documenting commands that no longer live here.

---

### Edge Cases

- A consumer relies on something the contract does not list. The contract states that only listed
  behaviour is stable.
- An admission decision takes a long time or fails. The contract states whether the peer waits, is
  refused, or the content is withheld, and that a failing decision never serves content by default.
- An admission decision permits some files of a folder and refuses others. The permitted files
  transfer and the refused ones look absent; the contract states how an application sees which
  files were unavailable rather than the folder download failing as a whole.
- A hint names a peer that is unreachable, malicious, or holds nothing. The contract states that it
  costs time at worst, never correctness.
- Counts are read while peers are joining and leaving. The contract states they are a snapshot of
  direct connections and may lag.
- The chosen package name is unavailable or revoked after the first release.
- A consumer on Bare imports something that only works on Node.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The repository MUST contain one contract document, referenced from the README and
  from `AGENTS.md`, describing everything an application may rely on or supply.
- **FR-002**: The contract MUST describe hints (preferred peers, priorities) and MUST state
  that a transfer completes correctly when every hint is wrong or stale, per Constitution Principle
  III. A peer hint only changes which already-connected peers are asked first; swarmwire
  never dials a peer because of a hint, and the application dials through the connection it owns.
- **FR-003**: The contract MUST describe an admission mechanism by which the application decides,
  per peer and per content, whether content is served, including what the application receives,
  and what happens if the decision fails or is slow. A refused peer MUST receive the same answer
  as for content swarmwire does not hold, so a refusal reveals nothing about what is held, its
  size or its name. The decision MUST be made per content root, so each file of a folder is
  decided separately, and the decision MUST be told which folder the file was requested through.
- **FR-003a**: The contract MUST state how an application downloads only some files of a folder:
  by reading the folder's file list without fetching any content, then downloading the chosen
  files individually. Which files to choose, and any interface for choosing, belong to the
  application (SwarmFS), not swarmwire. Whether swarmwire also offers a built-in filter on whole-folder
  download is an open design decision to settle in the plan; it MUST NOT be assumed.
- **FR-004**: The contract MUST describe peer activity reporting: when a peer connects or
  disconnects, and a count of connected peers and of connected peers holding the whole content,
  stated as direct connections only.
- **FR-005**: The contract MUST describe how an application shares its own network connection with
  swarmwire, and who owns its lifetime and keys.
- **FR-006**: The contract MUST state what swarmwire knows about a connected peer's identity and
  that binding it to an application user or device is the application's responsibility.
- **FR-007**: The contract MUST list what swarmwire will not do (names, directories, users,
  permissions, mutable references, trackers, global peer counts), pointing to the layer that owns
  each.
- **FR-008**: Each capability the contract names that does not exist yet MUST be marked as planned
  and linked to the feature that will deliver it, so the document never claims behaviour that is
  absent.
- **FR-009**: The package MUST be installable from the public registry under the
  unscoped name `swarmwire-lib`. (`swarmwire` itself is taken on the public registry by an
  unrelated project; the command-line tool will publish as `swarmwire-cli`.)
- **FR-010**: The first published version MUST be pre-1.0, and every export named in the contract
  MUST be importable from the package's main entry.
- **FR-011**: The published package MUST include the files needed to run on Node and Bare and the
  license, and MUST exclude tests, benchmarks, specifications and development tooling.
- **FR-012**: The package manifest MUST no longer be marked private and MUST carry accurate
  description, license, repository, engine and keyword fields.
- **FR-013**: The README MUST contain a short send-and-get example that the repository's network test
  job and `npm run test:all` execute on every run.
- **FR-014**: The README MUST state that swarmwire is a library and link to the command-line tool's
  separate repository once it exists.
- **FR-015**: The release procedure (checks that must pass, how the version is chosen, how a
  mistaken release is handled) MUST be written down.

### Key Entities

- **Contract**: The document and the set of behaviours it promises. Has a version that moves with
  the package version.
- **Hint**: Information from the application that may speed up a transfer but is never required.
- **Admission decision**: The application's answer to "may this peer fetch this content?"
- **Peer activity**: Connection events and counts for direct peers.
- **Package release**: A named, versioned, installable snapshot of the library.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reader unfamiliar with the code answers all of the questions in a prepared list of
  ten contract questions correctly using only the contract, in under 30 minutes.
- **SC-002**: Every behaviour the contract states as existing is covered by a passing test, and every
  behaviour not yet built is marked planned (zero unmarked claims).
- **SC-003**: From an empty directory, a developer goes from installing the package to a completed
  file transfer between two processes in under 10 minutes by following the README alone.
- **SC-004**: The example, run by the repository's test suite, produces a byte-identical file on both
  Node and Bare in 100% of runs.
- **SC-005**: A listing of the published package contains zero test, benchmark or specification
  files.
- **SC-006**: No hook, hint or admission feature is needed by SwarmFS or the CLI that the contract
  does not list, as confirmed when the later features are specified.

## Assumptions

- The publication target is the public npm registry, and `swarmwire-cli` will depend on this
  package by name.
- This feature produces the contract and the publishable package state. Building the capabilities
  the contract marks as planned (admission decisions, peer activity reporting, hint inputs) is
  separate library work with its own specifications.
- Peer identity today is the public key of the connection; the contract documents that as is.
- Because the application supplies the network connection, it already controls keys and lifetime.
- Pre-1.0 versioning means minor releases may change the surface, with changes recorded in the
  contract and a changelog.
- Bare and Node support are kept as the existing constraints require.
- The command-line tool is extracted in a later feature; until then it remains in this repository.
- Dependent projects (SwarmFS, `swarmwire-cli`) are consulted when the contract is drafted but do
  not need to exist in finished form.
