/**
 * swarmwire - content-addressed file transfer between filesystems, over Hyperswarm.
 *
 * Runs on Node and on Bare. docs/contract.md lists which exports are stable.
 */

export { Swarmwire, Download } from './lib/swarmwire.js'
export { rootOf, formatLink, parseLink, discoveryTopic, swarmTopic, SCHEME } from './lib/address.js'
export { ContentSource, MemorySource, hashFile } from './lib/source.js'
export { encodeManifest, decodeManifest, isSafePath, MANIFEST_TYPE } from './lib/collection.js'
export { Destination } from './lib/destination.js'
export { verifyGroup, groupCount, groupRange, groupLength, DEFAULT_GROUP_LOG } from './lib/tree.js'

/** @typedef {import('./lib/address.js').ParsedLink} ParsedLink */
/** @typedef {import('./lib/address.js').LinkFields} LinkFields */
/** @typedef {import('./lib/collection.js').FileEntry} FileEntry */
/** @typedef {import('./lib/listing.js').FileList} FileList */
/** @typedef {import('./lib/listing.js').Listing} Listing */
/** @typedef {import('./lib/destination.js').DestinationLike} DestinationLike */
/** @typedef {import('./lib/timers.js').Timers} Timers */
/** @typedef {import('./lib/tree.js').GroupTree} GroupTree */
/** @typedef {import('./lib/swarmwire.js').Swarm} Swarm */
/** @typedef {import('./lib/swarmwire.js').SwarmSession} SwarmSession */
/** @typedef {import('./lib/swarmwire.js').ConnectionInfo} ConnectionInfo */
/** @typedef {import('./lib/swarmwire.js').PeerIdentity} PeerIdentity */
/** @typedef {import('./lib/swarmwire.js').Resolve} Resolve */
/** @typedef {import('./lib/swarmwire.js').Allowed} Allowed */
/** @typedef {import('./lib/swarmwire.js').DestinationFactory} DestinationFactory */
