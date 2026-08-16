/**
 * The plugin id, on its own so it can be imported without pulling in pdf.js.
 *
 * The id is persisted in session state (`WorkspaceClient.pluginId`) and is read
 * by the registry at startup, whereas the library is only needed once a PDF is
 * actually opened. Keeping them in separate modules is what lets `index.ts`
 * register a descriptor eagerly and load ~1MB of decoder lazily.
 */
export const PDF_PLUGIN_ID = "pdf";
