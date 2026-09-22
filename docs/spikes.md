# TokenLens platform spikes

Measured on 2026-09-22. These are implementation evidence, not a claim that the whole extension passed the build plan's acceptance criteria. Manual UI cases are explicitly outstanding; none is marked passed based on API availability alone.

## Environment and reproduction

| Browser | Driver | Run |
| --- | --- | --- |
| Installed Google Chrome **153.0.8010.52**, macOS arm64 | Playwright 1.62.1 | Headless platform probes |
| Cached Chromium / Chrome for Testing **149.0.7827.55**, revision 1228 | Playwright 1.62.1 | Headless platform and actual unpacked extension probes |
| Cached Chromium / Chrome for Testing **143.0.7499.4**, revision 1200 | Playwright 1.62.1 | Headless platform and actual unpacked extension probes |
| Installed Google Chrome **153.0.8010.52** | Repository @playwright/test 1.58.2 | All seven `platform.spec.ts` regression tests passed |

Raw observed output lives in `test/spikes/chrome-153.json`, `chromium-1228.json`, `chromium-1200.json`, `extension-chromium-149.json`, and `extension-chromium-143.json`. The extension probe builds a disposable extension and profile in the OS temporary directory, serves only a loopback fixture, and removes them afterward. It does not load the user's browser profile.

Run the regression tests with `pnpm exec playwright test test/spikes/platform.spec.ts`. Run raw platform probes with `node test/spikes/probe.mjs`; optionally set `CHROME_EXECUTABLE` to an exact binary and `SPIKE_OUTPUT` to a results path. Run actual extension probes with `CHROME_EXECUTABLE=/path/to/chrome-for-testing node test/spikes/extension-probe.mjs`. `PLAYWRIGHT_MODULE` can point to an existing installation. Both scripts default to the repository's `@playwright/test`.

A sandboxed Chrome launch failed with SIGABRT/EPERM on this host. Retrying the isolated test launch with an approved sandbox escalation succeeded. This is test infrastructure behavior, not an extension defect.

The cached Chromium was **older** than installed stable Chrome, contrary to the plan's assumption. Version comparison must use the recorded binaries. **143 is the oldest empirically tested milestone here.** The documented API floor does not establish a tested Chrome 120 support matrix.

## S1 — `$0` in the content-script context

**Observed: yes, Chromium 143 and 149.** A real temporary MV3 extension installed a content script, registered a DevTools panel, called `inspect(document.querySelector('#target'))`, then called `inspectedWindow.eval` in both execution worlds. Both returned `$0.id === 'target'`. The content-script context saw its private global; MAIN returned that global as undefined.

**Decision:** the isolated-world path works when the extension script is already injected. Keep a fallback for absent contexts and selection races. This also agrees with Chrome's documented example using `setSelectedElement($0)` with `useContentScriptContext:true`. [Official DevTools extension guide](https://developer.chrome.com/docs/extensions/how-to/devtools/extend-devtools)

Reproduction and assertions: `extension-probe.mjs`. This was a real DevTools extension API call in headless Chrome for Testing, not a mock of `$0`.

## S2 — iframe selection and default eval frame

**Observed: default execution remains in the top frame, Chromium 143 and 149.** After `inspect()` selected `#inside` in a same-origin child frame, bare eval returned the top page's `location.href`; `$0.id` was `inside`, and `$0.ownerDocument.URL` was the child URL.

**Decision:** preserve explicit frame routing. The selected node and eval execution realm can belong to different documents; never infer frame identity from the default realm. Cross-origin selection was not measured in this spike. Chrome documents top-frame default and explicit `frameURL`. [Official inspectedWindow reference](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)

Reproduction: `extension-probe.mjs`, `childSelection` result.

## S3 — closed-shadow popover

**Observed: yes, Chrome 153 and Chromium 143/149.** Create a closed shadow root, append a `div` with `popover='manual'`, and call `showPopover()` twice. `:popover-open` is true; neither call throws. The regression fixture includes a full-page `z-index:2147483647` element.

**Decision:** retain the closed shadow/top-layer design. This verifies platform state, not a screenshot-based stacking comparison or interaction under page dialogs. A second `showPopover()` on an already open element is harmless but does **not establish** that its insertion order changed; re-promotion should hide then show if required.

Reproduction: `probe.mjs` and `platform.spec.ts` S3.

## S4 — computed color spaces

**Observed: retained, all three tested versions.** `oklch(0.6 0.2 240)` remains that representation for both token and consuming `color`; `color(display-p3 1 0.2 0.3)` remains a P3 color.

**Decision:** keep authored and computed tracks. Retaining a color space does not retain alias provenance or author formatting.

Reproduction: `probe.mjs` and `platform.spec.ts` S4.

## S5 — custom-property comments

**Observed: surrounding comments stripped, all three versions.** For `--y:12px; --x: /* a */ var(--y) /* b */`, CSSOM's authored `--x` is `var(--y)` and computed `--x` is `12px`.

**Decision:** the plan's suggested preserved-comment assumption does not hold for this input. Tokenization must tolerate comments but cannot promise byte-exact recovery of source comments from CSSOM. This probe is limited to the specified surrounding-comment case.

Reproduction: `probe.mjs` and `platform.spec.ts` S5.

## S6 — pseudo-element tokens

**Observed: yes, all three versions.** A `::before` declaration that defines and consumes an OKLCH token returns that token through `getComputedStyle(element,'::before').getPropertyValue(...)`; the consuming color resolves too.

**Decision:** computed pseudo-element rows are feasible. Hit testing and geometry were not established. Unregistered custom-property token text preserves its original numeric spelling (`.7` versus `0.7`), while the consuming color canonicalizes it.

Reproduction: `probe.mjs` and `platform.spec.ts` S6.

## S7 — EyeDropper rendered from docked/undocked panel

**Not manually verified.** No claim is made about overlay rendering, user activation, or dock state. Merely testing `typeof EyeDropper` would not answer this spike.

**Decision:** feature-detect, catch rejection, and keep an explicit in-page gesture fallback. Do not make native EyeDropper a prerequisite for editing colors.

Remaining reproduction: open the actual Tokens panel docked and undocked; click EyeDropper; record the rendered native overlay, completion/cancel behavior, and screenshots for each state.

## S8 — EyeDropper input-lock regression

**Not manually verified.** Issue 530992437 was neither reproduced nor declared fixed. Tested browser versions alone do not settle this behavior.

**Decision:** do not advertise verified native-picker compatibility. Preserve an escape/cancel/focus recovery affordance if EyeDropper is implemented.

Remaining reproduction: in both dock states, complete a pick and immediately interact with both the inspected page and extension panel. Record the exact browser build and result, including failure screenshots.

## S9 — optional permission prompt from DevTools

**Not manually verified.** No actual user-gesture permission prompt from a DevTools panel was exercised.

**Decision:** use the extension action popup for optional-host permission requests in store mode. This is conservative product behavior, not an empirical finding that all panel requests fail.

Remaining reproduction: load a temporary store-mode extension and invoke `chrome.permissions.request` from a panel button; verify the visible prompt and callback, then repeat via action popup.

## S10 — origin fallback / srcdoc

**Observed: srcdoc covered, Chromium 143 and 149.** A real content-script declaration used `all_frames:true`, `match_origin_as_fallback:true`, and a loopback host match. With `match_about_blank` omitted, the SW received a content-script message from `about:srcdoc` carrying its own `frameId` and `documentId`.

Chrome documents the dynamic `matchOriginAsFallback` API as **Chrome 119+**, covering `about:`, `data:`, `blob:`, and `filesystem:` schemes. [Official scripting reference](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-RegisteredContentScript)

**Decision:** srcdoc has a real supported path. Minimum 119 is an API floor; the oldest tested browser here is 143. Do not claim Chrome 120 was run. Static manifest options are documented separately. [Official content-script manifest reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)

Reproduction and assertions: `extension-probe.mjs`.

## S11 — inspector stylesheet paste and reload

**Partially measured.** In Chrome 153, `CSS.createStyleSheet` created an inspector sheet; `CSS.setStyleSheetText` accepted a multi-rule blob including a comment and `@media`, changed the target color, and a reload discarded the effect. This was a real browser/CDP test, **not a clipboard paste into the Styles declaration editor**. The editor's acceptance of multi-rule clipboard text remains unverified.

Chrome documents DevTools edits as transient unless persisted through Local Overrides or workspaces. [Official Changes panel guide](https://developer.chrome.com/docs/devtools/changes)

**Decision:** retain full author CSS export and temporary flat mode. The inspector stylesheet storage supports at-rules; the declaration editor's paste affordance is a different question. Avoid claiming that all inspector stylesheets inherently cannot contain at-rules. Prefer opening the stylesheet as text in Sources for full CSS editing, with persistence guidance.

Reproduction: `platform.spec.ts` S11. Remaining manual reproduction: paste the same blob into a Styles declaration editor and into Sources, inspect resulting rules, reload, and capture screenshots.

## S12 — constructed sheets in isolated worlds

**Observed: works in actual extension ISOLATED contexts on Chromium 143 and 149.** A temporary extension constructs and adopts one document sheet and one open-shadow sheet. Both computed colors change as expected in the top page, child iframe, and srcdoc.

A second probe uses a CDP-created isolated world on Chrome 153 and Chromium 143/149, also succeeding. That CDP world is explicitly distinguished from an extension world. Actual unpacked extension loading in branded stable Chrome was not attempted; Chrome 137 removed the command-line loading flag there. [Official Chrome extension update](https://developer.chrome.com/blog/extension-news-june-2025)

**Decision:** retain adopted sheets as primary plus the DOM style fallback. The fallback remains necessary for hostile page replacement, construction/adoption failures, and unsupported environments. Testing on Chrome 120 is outstanding.

Reproduction: `extension-probe.mjs`, `probe.mjs`, and `platform.spec.ts` S12.

## Registered properties and color-mix

Identical on Chrome 153 and Chromium 143/149: `<length>` registration with `inherits:false` and initial `8px` returns `8px` on an undeclared child even when its ancestor defines `20px`; `2em` at 10px font size coerces to `20px`; invalid `red` yields the initial `8px`. `color-mix(in oklch, red 50%, blue)` computes to `oklch(0.539974 0.285457 326.643)`.

These are committed observations and regression tests, not a complete registration grammar or gamut correctness suite.

## Plan contradictions and implementation resolutions

- **Permissions:** D13 omits `tabs`, §15 requires it. Follow D13 and only add a permission with a concrete API need. No shipped `debugger` permission.
- **Port names:** frozen `PORT_DEVTOOLS` and §4 use `devtools:<tabId>`; WS-7 prose uses `tokenlens-devtools:<tabId>`. Use the frozen constant at both ends.
- **Confidence:** frozen values are `exact`, `probable`, `degraded`; later prose says `certain` and `uncertain`. Use the frozen union; any value other than `exact` renders uncertainty.
- **Style fallback location:** D8 says last body child, WS-3 says head. Retain one explicit implementation and make priority verification independent of append position.
- **H29 fallback:** `insertCSS` is not inherently user-origin; Chrome's default is AUTHOR. If used, specify `origin:'AUTHOR'` explicitly to preserve D7. [Official CSS injection reference](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-CSSInjection)
- **Flat export:** D11 says strip comments, §12.2 asks for a comment explaining flattened conditions. Keep copyable CSS simple and display the condition-loss explanation in the export UI, or define one consistent contract before implementation.

## Performance boundary

These platform spikes do not measure the product's ≤16ms drag-to-paint, ≤150ms report, audit, memory, or bundle budgets. Passing these probes must not be reported as passing §11. Product performance evidence belongs in the integration/performance suite with browser version and metric definitions recorded.
