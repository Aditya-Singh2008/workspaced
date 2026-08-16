/**
 * The image plugin's id, in its own module.
 *
 * Same reason `viewers/pdf/id.ts` exists: the id is needed by things that must
 * not pull in the plugin's implementation — the keybind namespace, a restored
 * session naming which plugin was in use, the self-test. Importing it from
 * `index.ts` would work, but importing it from anywhere *deeper* would drag a
 * decoder along with it.
 */

export const IMAGE_PLUGIN_ID = "image";
