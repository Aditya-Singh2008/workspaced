/**
 * Verifies the keybind registry's dispatch rules. **Dev builds only.**
 *
 * `./selftest.ts` covers the accelerator primitives; this covers the layer on
 * top of them — which binding answers a key press, when a binding declines to,
 * and whether a key press that lands in a text field is left alone. Those are
 * the rules that decide whether a shortcut silently eats a keystroke, which is
 * exactly the kind of bug that is invisible until someone hits it.
 *
 * It registers under ids nothing else uses and unregisters in `finally`, so it
 * is safe to run inside the live app alongside the real bindings.
 */

import { check, report, type SelfTestCheck, type SelfTestReport } from "../../dev/selftest";
import type { HostPlatform } from "../../platform";
import { registerViewerKeybinds } from "./contributions";
import {
  dispatchKeybind,
  findKeybindConflicts,
  listKeybindSections,
  registerKeybindGroup,
  registerKeybinds,
  type KeybindDefinition,
  type RegisteredKeybind,
} from "./registry";

/** Forced, so a macOS regression is caught while developing on Linux. */
const PLATFORM: HostPlatform = "linux";

const GROUP = "selftest";

/**
 * Builds a key press and hands it straight to the dispatcher.
 *
 * Deliberately *not* dispatched through the DOM: the app's own global listener
 * is already installed in capture phase and would consume the event before any
 * listener this test could add, so a real dispatch would test the running app
 * rather than the registry. `target` is defined as an own property, shadowing
 * the accessor an undispatched event would otherwise answer `null` from — the
 * text-entry guard reads it.
 */
function press(
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
  target?: EventTarget,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false,
  });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
}

function dispatch(event: KeyboardEvent): RegisteredKeybind | null {
  return dispatchKeybind(event, PLATFORM);
}

export function runKeybindRegistrySelfTest(): SelfTestReport {
  const checks: SelfTestCheck[] = [];
  const fired: string[] = [];

  const input = document.createElement("input");
  input.type = "text";
  input.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.append(input);

  const definitions: KeybindDefinition[] = [
    {
      id: "selftest.plain",
      group: GROUP,
      label: "plain",
      keys: ["Mod+Alt+Shift+F9"],
      order: 20,
      run: () => fired.push("plain"),
    },
    {
      id: "selftest.bareKey",
      group: GROUP,
      label: "bare key",
      keys: ["q"],
      order: 10,
      run: () => fired.push("bare"),
    },
    {
      id: "selftest.declines",
      group: GROUP,
      label: "declines",
      keys: ["Mod+Alt+Shift+F10"],
      order: 30,
      enabled: () => false,
      run: () => fired.push("declines"),
    },
    {
      id: "selftest.fallsThrough",
      group: GROUP,
      label: "falls through",
      keys: ["Mod+Alt+Shift+F10"],
      order: 40,
      run: () => fired.push("fallsThrough"),
    },
  ];

  registerKeybindGroup({ id: GROUP, title: "self-test", order: 1000 });
  const unregister = registerKeybinds(definitions);

  try {
    // 1. The basic contract: a matching press runs exactly one binding.
    fired.length = 0;
    const matched = dispatch(press("F9", { ctrl: true, alt: true, shift: true }));
    checks.push(
      check(
        "dispatches to the matching binding",
        matched?.id === "selftest.plain" && fired.join(",") === "plain",
        `matched=${matched?.id ?? "none"} fired=[${fired.join(",")}]`,
      ),
    );

    // 2. A non-match must not run anything, and must report that so the key
    //    press is left for the webview.
    fired.length = 0;
    const unmatched = dispatch(press("F9", { ctrl: true }));
    checks.push(
      check(
        "leaves unmatched presses alone",
        unmatched === null && fired.length === 0,
        `matched=${unmatched === null ? "none" : "unexpected"}`,
      ),
    );

    // 3. A binding that is not currently available declines the press rather
    //    than swallowing it, so a later binding can still take it.
    fired.length = 0;
    const fellThrough = dispatch(press("F10", { ctrl: true, alt: true, shift: true }));
    checks.push(
      check(
        "an unavailable binding does not consume the press",
        fellThrough?.id === "selftest.fallsThrough" &&
          fired.join(",") === "fallsThrough",
        `matched=${fellThrough?.id ?? "none"} fired=[${fired.join(",")}]`,
      ),
    );

    // 4. The rule that keeps shortcuts from eating typing: an unmodified key
    //    is inert inside a text field, a modified one still fires.
    fired.length = 0;
    const bareInInput = dispatch(press("q", {}, input));
    const bareOutside = dispatch(press("q", {}, document.body));
    const modifiedInInput = dispatch(
      press("F9", { ctrl: true, alt: true, shift: true }, input),
    );
    checks.push(
      check(
        "bare keys yield to text fields, modified keys do not",
        bareInInput === null &&
          bareOutside?.id === "selftest.bareKey" &&
          modifiedInInput?.id === "selftest.plain",
        `inInput=${bareInInput === null ? "ignored" : "fired"} outside=${
          bareOutside?.id ?? "none"
        } modified=${modifiedInInput?.id ?? "none"}`,
      ),
    );

    // 5. Two bindings answering one press is reported, not silently resolved.
    const conflicts = findKeybindConflicts(PLATFORM);
    const ours = conflicts.some(
      ([first, second]) =>
        first.id === "selftest.declines" && second.id === "selftest.fallsThrough",
    );
    checks.push(
      check(
        "detects conflicting bindings",
        ours,
        `${conflicts.length} conflict(s) registered across the whole app`,
      ),
    );

    // 6. What the reference modal renders: our group, sorted by declared order.
    const section = listKeybindSections().find((entry) => entry.group.id === GROUP);
    const order = section?.keybinds.map((keybind) => keybind.id).join(",");
    checks.push(
      check(
        "lists bindings grouped and ordered",
        section?.group.title === "self-test" &&
          order ===
            "selftest.bareKey,selftest.plain,selftest.declines,selftest.fallsThrough",
        `title=${section?.group.title ?? "none"} order=[${order ?? ""}]`,
      ),
    );
  } catch (thrown) {
    checks.push(
      check(
        "self-test ran to completion",
        false,
        thrown instanceof Error ? thrown.message : String(thrown),
      ),
    );
  } finally {
    unregister();
    input.remove();
  }

  // 7. Unregistering has to actually remove them, or a closed tile's bindings
  //    would outlive it.
  const stillListed = listKeybindSections().some((entry) => entry.group.id === GROUP);
  const afterUnregister = dispatch(press("F9", { ctrl: true, alt: true, shift: true }));
  checks.push(
    check(
      "unregistering removes bindings",
      !stillListed && afterUnregister === null,
      `listed=${stillListed} dispatched=${afterUnregister === null ? "none" : "unexpected"}`,
    ),
  );

  checks.push(...contributionChecks());

  return report("keybind registry", checks);
}

/**
 * The plugin contribution seam (phase 03).
 *
 * Driven with a synthetic `ViewerKeybindApi` rather than a real plugin, for the
 * reason the contract self-test uses a stub: the seam has to be proven for
 * every file type, not shaped around the first one that needed it. What matters
 * is that ids are namespaced away from the shell's, that the section carries
 * the plugin's own title, and that un-focusing takes the whole thing away
 * again — a viewer's shortcuts outliving its tile would be a `PageDown` that
 * pages a document nobody is looking at.
 */
function contributionChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];
  const fired: string[] = [];

  const remove = registerViewerKeybinds("selftest-viewer", {
    groupTitle: "Self-test viewer",
    getKeybinds: () => [
      {
        id: "nextThing",
        label: "next thing",
        keys: ["Mod+Alt+Shift+F11"],
        order: 10,
        run: () => fired.push("nextThing"),
      },
    ],
  });

  try {
    const section = listKeybindSections().find(
      (entry) => entry.group.title === "Self-test viewer",
    );
    const contributed = section?.keybinds[0];
    const matched = dispatch(press("F11", { ctrl: true, alt: true, shift: true }));

    checks.push(
      check(
        "a viewer's keybinds register, namespaced, in their own section",
        section !== undefined &&
          contributed?.id === "viewer.selftest-viewer.nextThing" &&
          matched?.id === contributed.id &&
          fired.join(",") === "nextThing",
        `group=${section?.group.id ?? "none"} id=${contributed?.id ?? "none"} fired=[${fired.join(",")}]`,
      ),
    );
  } finally {
    remove();
  }

  const lingering = listKeybindSections().some(
    (entry) => entry.group.title === "Self-test viewer",
  );
  const afterBlur = dispatch(press("F11", { ctrl: true, alt: true, shift: true }));
  checks.push(
    check(
      "a viewer's keybinds leave with its focus",
      !lingering && afterBlur === null,
      `still listed=${lingering} still dispatching=${afterBlur !== null}`,
    ),
  );

  return checks;
}
