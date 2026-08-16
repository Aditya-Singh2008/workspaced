/**
 * Bottom bar: what is focused, and the keyboard-shortcuts trigger.
 * Consolidated alongside the toolbar in phase 08.
 */

export { StatusBar } from "./StatusBar";
export {
  announceStatus,
  STATUS_MESSAGE_MS,
  useStatusMessageStore,
} from "./messages";
export type { StatusMessage, StatusTone } from "./messages";
