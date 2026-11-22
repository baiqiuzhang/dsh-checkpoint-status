/**
 * Host-side row for dsh-checkpoint-status.
 *
 * The whole feature lives in the browser bundle (`./client`): the Host has no
 * state to add, no route to expose, and nothing to persist. This module exists
 * only so the Cordis composition has one named entry to load, exactly like the
 * decoration template's `index.js`.
 *
 * @returns nothing; the Host side contributes no behaviour.
 */
export function apply() {}
