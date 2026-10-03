/**
 * swarmwire — content-addressed file transfer between filesystems, over Hyperswarm.
 *
 * Only the addressing layer exists so far (M0). The transfer engine lands in M1:
 * see docs/roadmap.md.
 */

export { rootOf, formatLink, parseLink, discoveryTopic, SCHEME } from './lib/address.js'
