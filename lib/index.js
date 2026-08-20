//#region src/index.ts
/**
* dsh-file-link host half.
*
* v1 is client-only: the browser half (lib/client.js) detects `file:line`
* references in chat replies and opens them in the dsh-better-sidebar editor,
* jumping to the requested line. No host routes are needed for that — the
* editor loads file bytes through its own API. This module exists so the
* `cordis.patch.yml` row has a valid package export to mount.
*/
/** Plugin identity for the cordis.patch.yml row. */
const name = "dsh-file-link";
/** Host services required before mounting. None for v1. */
const inject = [];
/** Host plugin body: intentionally a no-op in v1. */
function apply(_ctx) {}
//#endregion
export { apply, inject, name };
