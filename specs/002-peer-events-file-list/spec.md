# Feature Specification: Peer Events, Counts and Folder File List

**Feature Branch**: `002-peer-events-file-list`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "peer events, counts and file-list reader"

## Clarifications

### Session 2026-10-21

- Q: Should reading a folder's file list make this machine findable as a provider, or only look for peers? → A: Only look. The reader never announces itself; downloads announce as they do today.
- Q: For a folder, do seeders and leechers mean peers holding the file list, or peers holding every file? → A: Every file. A folder's seeder holds the file list and every listed file; a leecher holds part of it; a peer holding nothing yet is in neither.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Knowing who is connected, live (Priority: P1)

An application that serves or downloads content (first `swarmwire-cli`, later SwarmFS) wants to show
how many peers it is connected to and how many of them hold the whole content, and to update that
display the moment a peer arrives or leaves. Today the only way to learn about peers is to
count connections itself, and it never learns when one goes away: a sender's screen keeps showing
"1 peer" after the receiver has disconnected.

The application is told when a peer connects and when it disconnects, and can ask at any time for
the current counts: how many peers are connected, and for a given piece of content how many of
them hold all of it ("seeders") and how many hold only part ("leechers").

**Why this priority**: it is the visible polish the command-line tool needs, it fixes a known
wrong display, and it is the smallest of the three pieces.

**Independent Test**: in the deterministic test network, connect three peers to a serving peer, let
one hold the whole file, one half of it, and one nothing; check the counts; disconnect one and
check the notification and the counts again.

**Acceptance Scenarios**:

1. **Given** a node serving a file, **When** a peer connects, **Then** the application is notified
   once, with the peer's identity, and the connected count goes up by one.
2. **Given** a connected peer, **When** it disconnects or loses power, **Then** the application is
   notified once and the count goes down by one.
3. **Given** a file being served, **When** one connected peer has downloaded all of it and
   another only half, **Then** the counts for that file are one seeder and one leecher.
4. **Given** a peer that downloads the file and finishes, **When** the application reads the counts
   before and after, **Then** that peer moves from leecher to seeder.
5. **Given** a served folder where one peer holds the file list only and another holds the list and
   every file, **When** the folder's counts are read, **Then** the first is a leecher and the
   second a seeder.
6. **Given** a connected peer that has said nothing about a particular file, **When** the counts
   for that file are read, **Then** it is in the connected total but in neither the seeders nor
   the leechers of that file.

---

### User Story 2 - Reading a folder's file list without downloading it (Priority: P2)

An application with a folder link wants to know what is inside before fetching any of it: the
list of files with their relative paths and sizes, and the folder's total size. SwarmFS needs this
to let a user pick files as in a torrent client; the command-line tool needs it to show what is
about to be downloaded.

**Why this priority**: SwarmFS cannot offer file selection without it, but nothing is displayed to
users until SwarmFS exists, so it follows the visible counts.

**Independent Test**: serve a folder of three files from one peer; from another peer, read the
list from the link alone. The list names all three with correct sizes, and nothing has been written
to the receiver's disk.

**Acceptance Scenarios**:

1. **Given** a folder link and a peer serving it, **When** the application reads the file list,
   **Then** it receives every file's relative path and size and the total size, and no file content
   is fetched and nothing is written to disk.
2. **Given** a link to a single file rather than a folder, **When** the application reads the file
   list, **Then** it is told that the link is not a folder.
3. **Given** a folder whose list contains an unsafe path (absolute, parent-relative, drive letter,
   duplicate), **When** the application reads the file list, **Then** it is refused rather than
   repaired, exactly as a whole-folder download refuses it today.
4. **Given** no connected peer holds the folder, **When** the application reads the file list,
   **Then** it waits like a download does, and the application can stop waiting.
5. **Given** an application reading a folder's file list, **When** another peer looks the folder up
   on the network, **Then** the reader does not appear as a provider.

---

### User Story 3 - Downloading only chosen files of a folder (Priority: P3)

After reading the list, the application downloads just the files it wants and none of the others.
This is how the application, not swarmwire, implements "choose files like in a torrent client".

**Why this priority**: it proves the first two pieces fit together and that nothing hidden prevents
a partial download; it adds little new behaviour.

**Independent Test**: serve a folder of five files; read the list, download two of them; check that
exactly those two arrived intact and that the other three were never requested from the sender.

**Acceptance Scenarios**:

1. **Given** the list of a folder, **When** the application downloads two of its files using only
   what the list returned and the folder link, **Then** both arrive byte-identical.
2. **Given** that partial download, **When** the sender's activity is inspected, **Then** no group
   of any unchosen file was requested.
3. **Given** the chosen files, **When** they are downloaded, **Then** they are not announced on the
   network separately; the peers holding them are the ones already connected through the folder's
   link.
4. **Given** one chosen file was already downloaded earlier, **When** it is chosen again, **Then** it
   resumes or completes without re-fetching what it already holds.

---

### Edge Cases

- A peer connects, then disconnects before saying anything about any content. It is announced and
  then removed; it never appears in any content's seeders or leechers.
- The same peer connects twice (two connections with the same identity). The count reflects
  distinct peers, not connections.
- A seeder loses its copy or disconnects while the application is reading counts. Counts are a
  snapshot and may lag by one notification; they never go negative.
- A leecher finishes between two reads: the counts move one from leechers to seeders and the total
  is unchanged.
- The application reads the counts for content it is neither serving nor downloading. It gets zeros
  and no error.
- The file list is read for a folder that is also being downloaded at the same time. Both succeed
  without fetching the list twice.
- A folder with zero files: the list is empty, total size zero.
- The list is large (tens of thousands of files). It is returned whole; there is no paging.
- A peer sends a malformed or implausibly large list. It is refused, the peer is not trusted for
  that content, and another peer can still supply the list.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The library MUST notify the application each time a peer that speaks the swarmwire
  protocol connects, with that peer's identity, and each time one disconnects, exactly once each.
- **FR-002**: The library MUST NOT report peers that never completed the swarmwire handshake.
- **FR-003**: The library MUST let the application read, at any time, the number of connected
  peers, counting distinct peers.
- **FR-004**: For any file the node is serving or downloading, the library MUST let the
  application read how many connected peers hold all of it and how many hold part of it.
- **FR-004a**: For a folder link the node is serving or downloading, "holds all of it" means the
  peer holds the file list and every listed file, and "holds part of it" means it holds the list
  or some groups of some file but not everything. A peer holding only the file list is a leecher
  of the folder, never a seeder.
- **FR-004b**: The counts MUST be correct for a node that is only serving, which never asks
  anyone for anything: the library MUST learn what connected peers hold even for content it
  serves. A peer whose holdings are unknown (for example an older peer that does not report them)
  MUST count in the connected total and in neither group.
- **FR-005**: A connected peer that has not announced anything about a given content MUST count in
  neither group for that content.
- **FR-006**: Counts MUST reflect a peer's departure no later than the notification of that
  departure, and MUST never be negative.
- **FR-007**: Counts MUST describe direct connections only and MUST NOT claim to describe the
  swarm. This is stated in the contract.
- **FR-008**: The library MUST let the application read a folder link's file list: each file's
  relative path and size, and the total size, without fetching any file's content and without
  writing anything to disk.
- **FR-009**: The file list reader MUST refuse a list containing a path that a whole-folder download
  would refuse, and MUST NOT repair or normalise paths (Invariant 4).
- **FR-010**: The file list reader MUST tell the application when the link is not a folder.
- **FR-011**: The file list reader MUST behave like a download when no peer has the list: wait, and
  let the application stop waiting.
- **FR-011a**: The file list reader MUST only look for peers and MUST NOT announce this machine as a
  provider of the folder. The swarm abstraction swarmwire runs against MUST therefore be able to
  join a topic in look-only mode, and the test network MUST support it.
- **FR-012**: The library MUST let the application download any single file listed, using only
  what the list returned and the folder's link, without announcing that file on the network
  separately (Invariant 6).
- **FR-013**: A partial download MUST NOT request any group of a file that was not chosen.
- **FR-014**: Whole-folder download MUST keep working unchanged, and MUST use the same list reader
  as the public one rather than a second copy of the logic.
- **FR-015**: `docs/contract.md` MUST be updated in the same change: the "peer activity" and
  "folder file-list reader" rows move from planned to exists with their proofs, the exports block
  lists any new export, and the planned markers for these two items are removed.
- **FR-016**: Every behaviour above MUST be proved in the deterministic test network, including a
  peer that disconnects abruptly (Constitution Principle IV).

### Key Entities

- **Peer event**: a connect or a disconnect, carrying the peer's identity.
- **Peer counts**: for the node as a whole, the number of connected peers; for one content root,
  the number of seeders and leechers among them.
- **Folder file list**: the folder's files, each with a relative path, size and content root, plus
  the total size.
- **Listed file**: one entry of the list, sufficient on its own, together with the folder link, to
  download that file.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a peer disconnects, the application's displayed peer count is correct within one
  notification, in 100% of runs of the disconnect tests, including abrupt power-loss disconnects.
- **SC-002**: For a folder of any size, reading the file list fetches zero bytes of file content and
  writes zero files to disk.
- **SC-003**: Downloading two chosen files from a five-file folder requests zero groups of the other
  three, in 100% of runs.
- **SC-004**: Whole-folder download results are unchanged: the existing folder tests pass without
  modification.
- **SC-005**: A developer with the contract and the changelog can show seeders and peers counts in an
  application in under one hour of work, as judged by the command-line tool's implementer.
- **SC-006**: Existing performance benchmarks (`npm run bench`) show no regression in requests per
  transferred file.

## Assumptions

- Seeders and leechers are known only for peers that have reported what they hold. Today a peer
  only learns another's holdings if it asked for that content, so a node that only serves does not
  see them; delivering FR-004b is expected to need a backward-compatible addition to the wire
  protocol (unknown messages are ignored by old peers, Invariant 5), designed in the plan. Peers
  that have not reported are counted in the connected total only.
- The count of connected peers includes only peers that completed the protocol handshake, not every
  network connection.
- "Identity" is the peer's public key, as described in the contract.
- The list is held in memory; there is no streaming or paging.
- Notifications are delivered in the order events happened, without a guarantee of timing.
- Admission decisions, peer hints and the random tie-break are separate features and are out of
  scope here; this feature does not change which peers are asked for which groups.
- The command-line tool's use of these features happens in its own repository, after extraction.
- The names of the new programming interfaces are chosen in the plan, not here.
