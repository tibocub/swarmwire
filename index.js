/**
 * swarmwire - content-addressed file transfer between filesystems, over Hyperswarm.
 *
 * See docs/roadmap.md for what exists; the real-swarm adapter and CLI land next.
 */

export { Swarmwire, Download } from './lib/swarmwire.js'
export { rootOf, formatLink, parseLink, discoveryTopic, swarmTopic, SCHEME } from './lib/address.js'
export { ContentSource } from './lib/source.js'
export { Destination } from './lib/destination.js'
export { verifyGroup, groupCount, groupRange, groupLength, DEFAULT_GROUP_LOG } from './lib/tree.js'
