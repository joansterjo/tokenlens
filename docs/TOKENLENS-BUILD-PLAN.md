# Tokenlens — Build Plan

**The deliverable is a robust Chrome extension for *editing* design tokens on a live page, not an inspector that only reads them.** Inspection is in service of the edit: the tool finds the token behind a pixel so that you can change it, under your finger, and then take the change with you as pasteable CSS. Any trade-off in this document resolves in favour of editing being immediate, scoped, reversible, and exportable.

It answers one sentence, live, on any page:

> **Which token feeds this pixel, through how many aliases, declared where, who lost the cascade fight, how many other elements does it move — and can I change it right now and paste the result somewhere durable?**

Nothing shipping today answers that sentence. Chrome DevTools resolves `var()` per declaration but never treats tokens as an inventory. Figma Dev Mode has the right interaction grammar but inspects the design file, not the DOM. Stylebot and Stylus edit blind. CSS Peeper flattens the chain to literals. That gap is the product.

---

## 0. How to use this document

This is written to be executed by coding agents, mostly in parallel, with a human reviewing at three gates.

**Reading order for an executing agent:** §1–§3 (what and why), §4–§5 (architecture and frozen contracts — non-negotiable), then **only your own workstream section** in §9, plus §6 (hazards), §10 (fixtures), §11 (budgets).

**Order of operations for the human:**

1. Run **Wave 0** — one agent, alone, builds the skeleton and freezes the contracts (§9, WS-0). Concurrently run **WS-S**, the spike agent, which answers the twelve empirical unknowns in §7. Nothing else starts until WS-0's `src/core/model.ts` is committed and `pnpm typecheck && pnpm test` is green on an empty repo.
2. **Gate 1** — review the contracts and the spike answers. Some spike results change the plan; §7 says exactly which decisions flip on which answer.
3. Run **Wave 1** — seven agents in parallel, one per workstream, each in its own git worktree and branch. They never touch each other's files (§8 ownership map). If you are driving this from Claude Code or the Agent SDK, launch each with `isolation: "worktree"` so the filesystems are genuinely independent.
4. **Gate 2** — the integrator (WS-8) merges in the stated order and makes the end-to-end path work on fixture 01.
5. Run **Wave 2** — audit view and hardening. **Gate 3** — perf budgets, packaging, done.

Every workstream section ends with a fenced `AGENT PROMPT` block. Paste that block, plus §4, §5, §6, §10, §11, into a fresh agent. Do not paste the whole document into every agent; the ownership boundaries matter more than the context.

**Codename and prefixes** (used consistently throughout, do not improvise): package `tokenlens`; custom element `<tokenlens-root>`; preview sheet id `tokenlens-preview`; storage key prefix `tl:`; export session sentinel `/*!tokenlens-session v1`.

---

## 1. The goal

A designer or design-systems engineer opens DevTools on a real product page, clicks an element, and immediately sees every design token that feeds it — colour, typography, shadow, spacing, radius, border — each one shown as its full alias chain down to the literal value, with the stylesheet, selector, layer, and specificity that won, and the declarations that lost and why. They change a colour with a picker that feels like Figma's, see the page update with no apply button, watch a counter tell them the change moves 41 other elements, and then copy a CSS override sheet that reproduces exactly what they are looking at.

The product is judged on four things, in this order:

**Truthfulness.** The tool must never confidently display a value no declaration produced. A resolver that is right 95% of the time is worse than useless for token work, because the 5% is where the interesting bugs live. Every report carries a `confidence` field and a `diagnostics[]` array, and the engine self-checks its own answer against `getComputedStyle` on every resolution (§5, `PROBE_MISMATCH`).

**Live editability.** Every token the tool can see, it can change — colour, spacing, radius, border, typography, and shadow layers — and the page reflects the change *while the pointer is still down*. No modes, no apply button, no dialog. Every numeric field is a drag handle; every colour opens the picker in one click; every token row reverts in one click. The user chooses explicitly whether they are changing the token everywhere, in one theme scope, or on one element, and sees the blast radius of each choice before committing (§9.3.1). The engineering consequence is a hard budget: pointer event to painted pixel in one frame, ≤ 16 ms p95 (§11), which is why preview writes never round-trip through the service worker and never re-parse a rule mid-drag (§9.3.2).

**Fidelity of the export.** What you see in the page is what the pasted CSS reproduces, on a page where the extension is not installed. This constraint is load-bearing and it dictates an early architectural decision (§3, D7).

**Honesty about limits.** Cross-origin iframes, closed shadow roots, canvas pixels, and unreadable cross-origin stylesheets are all real walls. The tool names them in the UI at the moment they bite, rather than silently returning a thinner answer.

---

## 2. Non-goals, and the seams that keep them cheap later

Out of scope for v1, deliberately:

| Not building | Seam that keeps it a small addition later |
|---|---|
| Tailwind / utility-class reverse mapping | `TokenCategory` inference and the reverse index are keyed on declarations, not on class names. A `UtilitySource` implementing the same `StyleSource` interface can be added without touching the resolver. |
| `tokens.json` / W3C DTCG / Figma Variables import | `ResolvedToken` already carries `terminalValue` normalised; a matcher comparing an external manifest against the token table is additive, and the audit view (WS-9) is where it would render. |
| React / Vue component identity (fibers, props) | `ElementMeta.frameworkHints: string[]` exists and ships empty. `src/content/bridge/main-world.iife.ts` ships as an empty MAIN-world script with a versioned `postMessage` protocol, because fiber access is the one thing that genuinely requires MAIN world. |
| Editing the page's source files | The exporter emits a `patch` target keyed on `CSSStyleSheet.href` when available, labelled best-effort. Nothing else assumes a filesystem. |
| Firefox / Safari | Every platform call sits behind `src/adapters/`. EyeDropper and `chrome.*` are the only hard blockers, both already isolated. |
| Publishing to the Chrome Web Store in v1 | §15 keeps a store-ready permission posture behind a build flag so the dev build stays frictionless. |

Also explicitly not goals: a general CSS editor (Stylebot exists), a stylesheet analytics product (Project Wallace exists), or a screenshot-diffing visual regression tool.

---

## 3. Locked decisions

These are settled. An agent that disagrees writes a change request (§8) rather than deviating.

| # | Decision | Choice | Why | What it forecloses |
|---|---|---|---|---|
| D1 | Primary surface | `devtools_page` → `chrome.devtools.panels.create("Tokens")` **plus** `panels.elements.createSidebarPane("Design Tokens")` | The user is already in DevTools because that is where they paste. Only a DevTools context gets `$0` and `panels.elements.onSelectionChanged`, which makes selection sync free and bidirectional (`inspect(node)` back). The sidebar pane is width-constrained and only `setHeight()`-adjustable, so the picker, alias graph, and export live in the full panel; the sidebar is a compact token list that can deep-link via `ExtensionPanel.show()`. | `chrome.sidePanel` as primary. It cannot see `$0` or the Elements selection and has no per-inspected-tab lifecycle. It stays a seam for a future no-DevTools mode — keep every shell driving the engine through `Transport` so a second shell is mechanical. |
| D2 | Resolver engine | CSSOM walk, hand-rolled cascade. `resolverMode: 'cssom' \| 'cdp' \| 'hybrid'` exists in the contract from day one | `chrome.debugger` cannot attach while DevTools is open on the same tab, and our entire UX assumes DevTools is open. It also shows the user a "started debugging this browser" banner and is a red-flag Web Store permission. | Free ground truth. We reimplement cascade sorting and pay for it in §6 hazards and §10 fixtures. |
| D3 | CDP | Dev-time **golden oracle only**, never shipped | `CSS.getMatchedStylesForNode` is literally what the Styles pane uses: matched rules in cascade order, inherited chains, `Specificity{a,b,c}`, `CSSLayerData.order`, `cssPropertyRegistrations`, spec-correct `getLonghandProperties`. As a test oracle it is worth more than as a feature. | Shipping a "high-fidelity mode". Revisit only for a standalone non-DevTools build. |
| D4 | Content script world | ISOLATED, everywhere | `getComputedStyle`, `document.styleSheets`, `adoptedStyleSheets`, `element.matches` are all fully available isolated. MAIN world buys nothing for custom properties, and cross-origin `cssRules` throws `SecurityError` in both worlds — that is CORS, not world isolation. | Framework-fiber reads. Deferred behind the empty MAIN-world bridge. |
| D5 | Build tooling | Vite + `@crxjs/vite-plugin` 2.7.x + React 19 + TypeScript, pnpm | v2 stable since 2025-06-10, actively released through 2026 (2.7.1, 2026-07-01); the 2024–25 "seeking maintainers" archive threat was resolved. Content-script HMR works in isolated and MAIN world since 2.7.0. | Nothing important. Named fallback: **WXT** (first-class `entrypoints/devtools/`), then `@samrum/vite-plugin-web-extension`. Keep all Chrome-surface code free of build-tool imports so a swap is mechanical. |
| D6 | Colour library | **culori 4.0.2, `culori/fn` imports only** | Measured: 7.6 kB gzip for the content-script subset versus 19.9 kB for `colorjs.io/fn`, with identical parse coverage on every syntax tested and byte-identical CSS gamut-mapping output. Ideally the content script carries **no** colour library at all — it harvests strings, the panel does the maths. | `colorjs.io` is the fallback, **panel only, never the content script**, if a correctness gap appears; it also brings free `contrastAPCA`. `chroma-js` is disqualified: it fails `hwb()`, all `color()` forms, and unitless `hsl`. ESLint must ban the bare `'culori'` barrel import — one accidental barrel costs 6 kB gzip. |
| D7 | Preview origin | **Author origin only.** `chrome.scripting.insertCSS({origin:'USER'})` is forbidden outside a debug-only, explicitly non-exportable "force" toggle | User-origin `!important` outranks every author declaration including inline `!important` — but no exported stylesheet, pasted anywhere, runs in user origin. DevTools and Stylus both inject author origin. Preview in user origin would make the tool lie about what the export achieves. | A guaranteed-win preview. In exchange, WYSIWYG is structurally true rather than aspirational. This is the single most important correctness decision in the plan. |
| D8 | Preview mechanism | One constructible `CSSStyleSheet` appended last to `document.adoptedStyleSheets`, one `CSSStyleRule` per scope, mutated via `rule.style.setProperty` | CSSOM spec: a document's final style sheet list is its stylesheets **then** `adoptedStyleSheets` in array order, so adopted sheets sort after every `<link>`/`<style>` in author origin and win document-order ties without `!important`. `setProperty` invalidates one declaration; `replaceSync` reparses the sheet; `textContent=` is worst. Not subject to page CSP. | Fallback: a single `<style id="tokenlens-preview">` as last child of `<body>`, used if `new CSSStyleSheet()` throws or the page reassigns `adoptedStyleSheets` wholesale. Never reassign the `adoptedStyleSheets` array per frame — that invalidates document-wide style. |
| D9 | Override specificity | Default **selector doubling** (`:root:root`, `.theme-dark.theme-dark`, `[data-theme="dark"][data-theme="dark"]`), no `!important` | Provably identical match set, +1 specificity notch, readable, and — critically — it survives being pasted at an *unknown* cascade position, where document-order tricks do not. | Escalation ladder is explicit and visible: `order` → `doubled` → `important` → `inline-only (not exportable)`. Applied automatically, always shown, always revertible. |
| D10 | Export at-rules | Overrides are emitted **unlayered** | Unlayered normal declarations beat every `@layer` at equal specificity. The trap: for `!important` the layer order **reverses**, so an unlayered `!important` loses to `!important` inside any page layer — at which point the only author-origin move left is inline, which is not exportable. Surface that, don't paper over it. | Using our own `@layer` for normal declarations. The overlay must not use `@layer` for isolation either. |
| D11 | Primary export target | Full-fidelity author CSS sized for **DevTools Local Overrides or Stylus**, plus a **flat-mode** clipboard variant for the DevTools inspector stylesheet | Verified from Chrome docs: the Styles pane's "New Style Rule" is a per-declaration editor writing into a synthetic `inspector-stylesheet` with no backing network resource, and Local Overrides is documented as the mechanism that "lets you keep the changes you make in DevTools across page loads" — the inspector stylesheet is a session artifact. Whether it accepts a pasted multi-rule blob with `@media`/comments is undocumented and I could not verify it. | Flat mode therefore resolves media/theme conditions against current page state, emits them unconditionally, strips at-rules and comments, one declaration per line — and the UI labels it "preview-only, light/dark collapsed". Spike S11 settles the reload question in sixty seconds. |
| D12 | Test substrate | Vitest 4 (Node) for `core/` against **snapshots captured from real Chromium**; Vitest browser mode (Playwright provider) for anything touching DOM/CSSOM; Playwright Test 1.63 (`channel: 'chromium'`) for E2E | jsdom issue #3785 (cascade layers) is still open: one `@layer` block throws `Could not parse CSS stylesheet` and jsdom **discards the whole sheet**, returning empty strings rather than wrong ones. jsdom #1696 was closed 2026-09-17 but only for inline colour inheritance — the maintainer states explicitly that this "does not imply that every CSS cascade feature is implemented". happy-dom is worse in exactly our domain: open issues #932, #1308, #1364, #1837 are all `var()`/custom-property resolution failures. Those four bugs *are* the product. | `environment: 'jsdom'` is banned by ESLint so no parallel agent reintroduces it. |
| D13 | Permissions, dev build | Static content script `matches: ["<all_urls>"]` + `host_permissions: ["<all_urls>"]`, `permissions: ["scripting","storage"]`, **no `"tabs"`**, **no `"debugger"`** | Guarantees the content script already exists so `useContentScriptContext` does not fail `E_NOTFOUND` — the most common real failure of the eval path. `activeTab` does not help: it is granted by a gesture on the extension's own action, not by opening DevTools, so a DevTools-first flow on `activeTab` alone is simply broken. tabId comes from `inspectedWindow.tabId`; `tabs.sendMessage` needs host permission, not `"tabs"`. | Store posture is a separate build flag (§15): `optional_host_permissions` requested at runtime. Note `chrome.permissions.request` from a devtools panel page is historically unreliable — fallback is the action popup. |
| D14 | Element identity across time | Never hold a JS element reference across navigation. Key state on `documentId` (not `frameId`), address elements by `{documentId, frameId, cssPath, nthOfType}`, check `el.isConnected` before every read | `documentId` is stable per document and changes on navigation, which is exactly the cache-invalidation signal we want. | Requires a robust `cssPath` generator, which WS-3 owns anyway for the exporter. |
| D15 | Overlay stacking | Top layer via `popover="manual"` + `showPopover()` on a `<tokenlens-root>` carrying a **closed** shadow root, appended to `document.documentElement` | z-index has no effect in the top layer, so `z-index: 2147483647` loses to `showPopover()`. Appending to `documentElement` rather than `body` survives frameworks that replace `body`. Top layer also escapes ancestor `overflow:hidden`, `transform`, `filter`, and `contain`. | `dialog.showModal()` is forbidden — it makes the rest of the page inert and would kill hover-picking. One residual hazard: top-layer elements stack in insertion order, last wins, so a page opening its own dialog after us covers us; mitigate by re-promoting on a watchdog. |

---

## 4. Architecture

### 4.1 Surfaces and message topology

```
┌─ DevTools (per inspected tab) ──────────────────────────┐
│  devtools.html  (no UI; registers panel + sidebar only) │
│   ├── panel.html    ← React, full width: picker,        │
│   │                   alias graph, export, audit        │
│   └── sidebar.html  ← React, compact token list         │
└──────────┬──────────────────────────────┬───────────────┘
           │ port "devtools:<tabId>"      │ inspectedWindow.eval
           │ (long-lived, bidirectional)  │ (fast read path, no SW hop)
           ▼                              ▼
   ┌─ service worker ─────────┐    ┌─ content script (per frame) ─────┐
   │ stateless router:        │    │ ISOLATED world                   │
   │  Map<tabId, Port>        │───▶│  capture-live  (CSSOM snapshot)  │
   │  frameId fan-out         │◀───│  override-apply (adopted sheet)  │
   │  cross-origin sheet      │    │  overlay (closed shadow + top    │
   │  re-fetch (CORS-exempt)  │    │           layer picker)          │
   └──────────────────────────┘    └──────────────────────────────────┘
```

Three rules govern this diagram.

**Reads bypass the service worker.** `chrome.devtools.inspectedWindow.eval` runs in the page's main world with the Console command-line API, so `$0` is available and there is no SW wake, no tabId plumbing, and no port. Ship a pure function, stringify it, call it with `$0`:

```ts
const res = await chrome.devtools.inspectedWindow.eval(`(${readTokens.toString()})($0)`);
```

Two constraints on that path. The return value must be JSON-compliant — primitives and acyclic plain objects only, no DOM nodes, no `Map`/`Set`, no functions — which is precisely why §5's contract normalises `Declaration` and `CascadeSource` into id-keyed records instead of nesting them. And because it runs in the page's main world, the page can shadow `getComputedStyle`; capture native references at the top of every injected function.

To hand a selection from the eval context to the ISOLATED content script, tag it from the page world (`$0.setAttribute('data-tokenlens-sel','')`) and query the attribute. **DOM attributes cross worlds; JS expandos on nodes do not.** Remove the attribute immediately after — it perturbs the page's MutationObservers.

**The service worker is a stateless router plus a `chrome.*` proxy.** It holds no authoritative state. It terminates after ~30 s idle, and while active ports extend its life, nothing may depend on that. Authoritative UI state lives in the panel, whose lifetime equals DevTools' lifetime. Durable state goes to `chrome.storage.session` (per-tab override sets; needs `setAccessLevel({accessLevel:'TRUSTED_AND_UNTRUSTED_CONTEXTS'})` if content scripts read it) and `chrome.storage.local` (prefs, palettes, recents, saved sessions).

**The tabId problem is solved in the port name.** A devtools context has `chrome.devtools.inspectedWindow.tabId` but no `chrome.tabs`, so encode it and avoid a hello round-trip race:

```ts
const port = chrome.runtime.connect({ name: `devtools:${chrome.devtools.inspectedWindow.tabId}` });
// SW: onConnect → const tabId = Number(port.name.split(':')[1]); ports.set(tabId, port);
```

On `port.onDisconnect`, read `chrome.runtime.lastError` (otherwise console noise), reconnect with 0 / 250 / 1000 ms backoff, and send `{type:'resync'}`. Every message carries `{v:1, id, type, payload}` so replays are idempotent.

**The service worker owns cross-origin stylesheet re-fetch.** A content script's `fetch()` initiates requests on behalf of the *page's* origin and is subject to CORS; the SW's is not, and page CSP does not apply to it. This is the only way to recover an unreadable cross-origin sheet without CDP.

### 4.2 Source tree

Ownership is enforced by this tree. One directory, one workstream (§8).

```
manifest.config.ts              # defineManifest(); WS-0
vite.config.ts                  # crx() + react(); rollupOptions.input.{panel,sidebar}
playwright.config.ts            # two webServers (:4173 app, :4174 foreign-origin)
size-limit.config.js
src/
  devtools/devtools.html|.ts    # registers panel + sidebar pane ONLY, zero UI    WS-7
  panel/panel.html|main.tsx     # React root, full panel                          WS-6
  sidebar/sidebar.html|main.tsx # React root, compact                             WS-6
  popup/popup.html|main.tsx     # onboarding copy only, not UI                    WS-6
  background/
    index.ts                    # SW entry                                        WS-7
    router.ts                   # Map<tabId,Port>, frameId fan-out                WS-7
    sheet-fetch.ts              # cross-origin re-fetch (CORS-exempt)             WS-7
    injector.ts                 # onInstalled/onStartup re-injection sweep        WS-7
  content/
    index.ts                    # ISOLATED entry; wires capture + override        WS-5
    overlay/                    # closed shadow DOM picker, highlight bands       WS-5
    override/                   # adopted-sheet apply engine, watchdog            WS-3
    bridge/main-world.iife.ts   # EMPTY seam for deferred MAIN-world features     WS-0
  core/                         # PURE. No chrome, document, window, CSSStyleSheet.
    model.ts                    # THE FROZEN CONTRACT                             WS-0
    resolve/                    # cascade sort + var() chain walk                 WS-1
    color/                      # parse | convert | serialize | ΔE | gamut        WS-2
    selector/                   # unique-selector generation                      WS-3
    emit/                       # TokenReport + Edit[] → CSS text                 WS-4
    audit/                      # page-wide token audit                           WS-9
  adapters/                     # the ONLY place platform APIs appear
    capture-live.ts             # real DOM/CSSOM → SheetSnapshot[]                WS-1
    capture-replay.ts           # fixture JSON → SheetSnapshot[]                  WS-0
    chrome-port.ts              # Transport impl over chrome.runtime              WS-7
    mock-transport.ts           # Transport impl over a recorded message log      WS-0
  transport/protocol.ts         # message envelope + port-name constants          WS-0
  ui/                           # design system, ColorPicker, primitives          WS-6
  shared/eval-fns.ts            # functions stringified into inspectedWindow.eval WS-1
test/
  fixtures/NN-name.html         # one per hazard, §10                             WS-0
  snapshots/*.json             # captured from real Chromium, committed           WS-1
  unit/ browser/ e2e/ spikes/ perf/
docs/
  spikes.md                     # WS-S answers
  cr/WS-N-*.md                  # change requests, one file per workstream
```

---

## 5. Frozen contracts

WS-0 writes these files verbatim and commits them before Wave 1 starts. After that they change **only** by change request (§8). Everything else in the repo is an implementation detail owned by exactly one workstream.

Three properties make this contract work for parallel development. It is `structuredClone`-able, so it crosses `chrome.runtime` and `inspectedWindow.eval` unchanged. `Declaration` and `CascadeSource` are normalised into id-keyed records, so thirty properties sharing one source do not explode the graph. And every lossy or uncertain outcome has a place to be recorded — `status`, `confidence`, `diagnostics` — so degradation is expressible rather than silent.

### 5.1 `src/core/model.ts`

```ts
export type SchemaVersion = 1;
export type PropId = string;                      // 'box-shadow' | '--elevation-2'
export type TokenName = `--${string}`;
export type Origin = 'user-agent'|'user'|'author'|'animation'|'transition'
                   |'inline'|'attribute'|'override';
export type ResolverMode = 'cssom'|'cdp'|'hybrid';
export type Confidence = 'exact'|'probable'|'degraded';
export type TokenCategory = 'color'|'typography'|'shadow'|'space'|'radius'|'border'
  |'motion'|'z-index'|'opacity'|'size'|'gradient'|'filter'|'other';
export type ChainStatus = 'resolved'|'fallback'|'missing'|'cycle'
  |'invalid-at-computed-value-time'|'animation-tainted'|'depth-exceeded';

export interface Specificity { a: number; b: number; c: number }

export interface TreeScopeRef {
  id: string; kind: 'document'|'shadow'; hostPath?: string; depth: number;
}
export interface ElementRef {
  id: string; cssPath: string; tagName: string;
  treeScope: TreeScopeRef; documentId?: string; frameId?: number;
  backendNodeId?: number;                         // CDP oracle only
}

export interface StyleSheetRef {
  id: string; href: string | null;
  kind: 'link'|'style'|'adopted'|'import'|'ua'|'injected'|'inspector';
  ownerNodePath: string | null; treeScope: TreeScopeRef;
  sheetIndex: number;                             // document order within tree scope
  media: string | null; disabled: boolean;
  readable: boolean;                              // cssRules accessible directly
  reparsed: boolean;                              // recovered via SW fetch + replaceSync
  importChain: string[];
  ruleCount: number | null;
}

export interface ConditionRef {
  type: 'media'|'supports'|'container'|'scope'|'layer'|'starting-style';
  text: string; matched: boolean | 'unknown';
}

/** The conditional wrapper an override must reproduce verbatim to take effect. */
export interface ConditionCtx {
  media: string | null; supports: string | null;
  layerPath: string[]; container: string | null;
}

export interface CascadeSource {
  id: string;
  sheet: StyleSheetRef | null;                    // null for inline/animation/override
  origin: Origin; important: boolean;
  layerPath: string[];                            // [] = implicit final (unlayered)
  layerOrder: number;                             // higher = later in layer order
  contextDepth: number;                           // shadow nesting depth (0 = document)
  selectorText: string | null;
  matchedSelector: string | null;                 // the complex selector that matched
  specificity: Specificity;
  documentOrder: number;                          // monotonic, assigned during walk
  ruleIndexPath: number[];                        // path into cssRules, for re-visiting
  conditions: ConditionRef[];
  pseudoElement: string | null;                   // '::before'
  sourceRange?: { startLine: number; startColumn: number;
                  endLine: number; endColumn: number };
  authoredText?: string;                          // exact bytes; CDP or re-fetch only
}

export interface Declaration {
  id: string;
  property: PropId;
  valueText: string;                              // var() INTACT — the provenance channel
  important: boolean;
  sourceId: string;                               // → CascadeSource.id
  shorthandOf?: PropId;                           // synthetic longhand from a shorthand
  shorthandText?: string;
  parsedOk: boolean;
  winner: boolean;
  loserReason?: 'origin'|'context'|'element-attached'|'layer'|'specificity'|'order'|'iacvt';
}

export interface TokenRef {                       // one var() occurrence
  name: TokenName; raw: string;
  startOffset: number; endOffset: number;         // into the containing valueText
  fallbackText: string | null;
  usedFallback: boolean;
  resolvedTo: string | null;
}

export interface PropertyRegistration {
  name: TokenName; syntax: string; inherits: boolean;
  initialValue: string | null;
  via: 'at-property'|'registerProperty';
  sourceId?: string;
}

export interface AliasChainNode {
  name: TokenName; depth: number;
  declaration: Declaration | null;
  declaredOn: ElementRef | null;                  // ancestor whose scope won
  scopeSelector: string | null;                   // ':root' | '.theme-dark' | ...
  scopeCtx: ConditionCtx | null;                  // what the override must re-wrap in
  rawValue: string | null;                        // 'var(--shadow-color)'
  refs: TokenRef[];
  registration: PropertyRegistration | null;
  computedValue: string | null;                   // getComputedStyle on the TARGET element
  terminalValue: string | null;
  status: ChainStatus;
  children: AliasChainNode[];                     // one per ref, order-aligned
}

export interface ShorthandGroup {
  id: string; shorthand: PropId;
  authoredText: string | null;
  longhands: PropId[];
  sourceId: string | null;
}

/** Owned by WS-2. Carries enough to round-trip the author's syntax byte-for-byte. */
export interface ColorValue {
  authored: string;                               // exact source text
  syntax: 'hex3'|'hex4'|'hex6'|'hex8'|'rgb-legacy'|'rgb-modern'|'hsl-legacy'
        |'hsl-modern'|'hwb'|'lab'|'lch'|'oklab'|'oklch'|'color-fn'|'named'
        |'keyword'|'opaque';                      // 'opaque' = Tier B/C, do not rewrite
  space?: 'srgb'|'display-p3'|'rec2020'|'xyz-d50'|'xyz-d65';
  oklch: [number, number, number];                // canonical working value; NaN for `none`
  alpha: number;
  alphaWasWritten: boolean;                       // '#f0a' vs '#f0af'; rgb() vs rgba()
  hueUnit: 'none'|'deg';
  lightnessUnit: 'number'|'percent';
  outOfSrgbGamut: boolean;
  engineResolved: boolean;                        // true if obtained via the probe recipe
}

export interface ResolvedProperty {
  property: PropId;                               // longhand
  computedValue: string;
  usedValue?: string;
  winningDeclarationId: string | null;
  losers: string[];                               // Declaration ids, cascade-sorted
  tokenRefs: TokenRef[];
  chains: AliasChainNode[];                       // one root per tokenRef
  category: TokenCategory;
  groupId?: string;                               // → ShorthandGroup.id
  hardcoded: boolean;
  suggestedToken?: { name: TokenName; matchKind: 'exact'|'near'; delta?: number };
  animating: boolean;
}

export interface ConsumerSummary {
  ruleCount: number; elementCount: number;
  sampleElements: ElementRef[]; properties: PropId[];
  truncated: boolean;
}

/** The override IR. Single source of truth for preview, export, and session restore. */
export type EditMode = 'token'|'element';
export type EditRung = 'order'|'doubled'|'important'|'inline-only';

export interface Edit {
  id: string;
  mode: EditMode;
  property: PropId;                               // '--brand-600' or 'background-color'
  scopeSelector: string;                          // ':root' | '.theme-dark' | generated
  ctx: ConditionCtx;                              // re-wrap target; {} for unconditional
  treeScope: TreeScopeRef;
  from: string | null;
  to: string;
  rung: EditRung;
  verified: boolean;                              // post-apply getComputedStyle check passed
  enabled: boolean;
  chainHint: string[];                            // ['--brand-600','--btn-bg','background-color']
  srcHint: string | null;                         // '/assets/tokens.css:112'
  blastRadius: number | null;                     // affected element count at apply time
  exportable: boolean;                            // false for rung 'inline-only'
}

export interface ResolvedToken {
  name: TokenName;
  category: TokenCategory; categoryConfidence: number;   // 0..1
  categoryAlternates: TokenCategory[];
  declarations: string[];                         // Declaration ids, cascade-sorted
  winningDeclarationId: string | null;
  declaredOn: ElementRef | null;
  scopes: { selector: string; ctx: ConditionCtx; value: string }[];  // light + dark + ...
  registration: PropertyRegistration | null;
  rawValue: string | null;
  computedValue: string | null;                   // on the inspected element
  terminalValue: string | null;
  aliasesTo: TokenName[]; aliasedBy: TokenName[];
  color?: ColorValue;
  usedBy?: ConsumerSummary;
  unusedOnPage: boolean;
  edit?: Edit;
}

export interface ElementMeta {
  ref: ElementRef;
  tagName: string; id: string | null; classList: string[];
  hashedClasses: string[];                        // subset of classList flagged generated
  attributes: Record<string, string>;
  box: { content: RectLike; padding: RectLike; border: RectLike; margin: RectLike };
  display: string; position: string; zIndex: string;
  isStackingContext: boolean;
  layoutRole: string | null;                      // 'flex child of div.row (grow 1 …)'
  containingBlock: ElementRef | null;
  fontStack: string[]; renderedFont?: string;
  a11y?: { role: string | null; name: string | null; nameSource: string | null;
           contrastRatio: number | null; approximate: boolean };
  pseudos: string[];                              // '::before' present with declarations
  frameworkHints: string[];                       // ships empty; MAIN-world seam
}
export interface RectLike { x: number; y: number; width: number; height: number }

export type DiagnosticCode =
  | 'CROSS_ORIGIN_SHEET_UNREADABLE' | 'SHEET_REPARSE_FAILED' | 'PROBE_MISMATCH'
  | 'CLOSED_SHADOW_ROOT' | 'CONTAINER_QUERY_UNEVALUATED' | 'SCOPE_UNEVALUATED'
  | 'CYCLE_DETECTED' | 'TOKEN_UNDEFINED' | 'SHORTHAND_UNSERIALIZABLE'
  | 'JS_REGISTERED_PROPERTY' | 'BUDGET_EXCEEDED' | 'CDP_UNAVAILABLE'
  | 'ANIMATION_ACTIVE' | 'OVERRIDE_LOST_CASCADE' | 'INLINE_STYLE_CONFLICT'
  | 'REGISTERED_SYNTAX_REJECTED' | 'GAMUT_MAPPED' | 'CROSS_ORIGIN_FRAME';

export interface Diagnostic {
  code: DiagnosticCode; severity: 'info'|'warn'|'error'; message: string;
  sheetId?: string; token?: TokenName; property?: PropId; editId?: string;
}

export interface ElementTokenReport {
  schemaVersion: SchemaVersion;
  element: ElementMeta;
  properties: ResolvedProperty[];
  groups: ShorthandGroup[];
  declarations: Record<string, Declaration>;      // normalised store
  sources: Record<string, CascadeSource>;
  tokensInScope: Record<TokenName, ResolvedToken>;
  sheets: StyleSheetRef[];
  layerOrder: { name: string; order: number }[];
  registrations: PropertyRegistration[];
  diagnostics: Diagnostic[];
  resolverMode: ResolverMode; confidence: Confidence;
  timings: { totalMs: number; indexMs: number; matchMs: number;
             resolveMs: number; sheetFetchMs: number };
}
```

### 5.2 Ports — `src/core/ports.ts`

Two interfaces, deliberately tiny. They are the entire reason this codebase is testable in Node and the reason the panel can be developed with no browser extension loaded at all.

```ts
export interface StyleHost {                      // implemented only in src/adapters/
  sheets(): SheetSnapshot[];                      // flattened, incl. adoptedStyleSheets
  computed(el: ElementRef, prop: string): string;
  ancestors(el: ElementRef): ElementRef[];        // FLATTENED tree, slot-aware
  registrations(): PropertyRegistration[];
  matchMedia(q: string): boolean;
  supports(cond: string): boolean;
}

export interface Transport {
  send(m: Envelope): void;
  on(f: (m: Envelope) => void): () => void;       // returns unsubscribe
}
```

`resolveTokenChain(snapshot: SheetSnapshot[], el: ElementRef, prop: PropId): ElementTokenReport` is a **pure function of a serialisable snapshot**. Snapshots are captured from real Chromium once per fixture, committed to `test/snapshots/`, and replayed in millisecond Node tests. The fidelity lives in one capture adapter that is tested in-browser; the twelve thousand lines of cascade logic never touch a browser. Colour maths, selector generation, and CSS emission never touch one either.

### 5.3 `src/transport/protocol.ts`

```ts
export const PORT_DEVTOOLS = (tabId: number) => `devtools:${tabId}`;
export const PORT_CONTENT   = (frameId: number) => `content:${frameId}`;
export const PROTOCOL_VERSION = 1 as const;

export type MsgType =
  | 'resync' | 'pick:start' | 'pick:stop' | 'pick:hover' | 'pick:locked'
  | 'report:request' | 'report:result'
  | 'edit:apply' | 'edit:revert' | 'edit:verified' | 'edit:blast-radius'
  | 'audit:start' | 'audit:progress' | 'audit:result' | 'audit:cancel'
  | 'swatches:request' | 'swatches:result'
  | 'eyedropper:arm' | 'eyedropper:result'
  | 'sheet:fetch' | 'sheet:fetched'
  | 'nav:changed' | 'theme:changed' | 'diag';

export interface Envelope<T = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: string;                                     // uuid; replies echo it
  type: MsgType;
  tabId?: number; frameId?: number; documentId?: string;
  payload: T;
}
```

Every message is idempotent on `id`. Any handler must tolerate receiving the same envelope twice, because reconnect replays.

---

## 6. Hazard register

This section exists because a resolver that does not handle these will look like it works on a demo page and lie on a real one. Every row has an owning workstream, a fixture (§10), and a diagnostic code. **An implementation that cannot name which hazard a given fixture exercises is not done.**

### 6.1 Resolution hazards (WS-1)

| # | Hazard | Correct behaviour | Fixture |
|---|---|---|---|
| H1 | `getComputedStyle` destroys provenance — it returns the value *after* `var()` substitution | Provenance comes only from declaration **text** via CSSOM. Never try to reverse a computed value. | 02 |
| H2 | Undeclared custom property and explicitly empty (`--x:;`) both serialise as `""` | You cannot distinguish them via `getComputedStyle`. Consult the declaration index, and consult the `@property` registration table before concluding "undefined". | 03, 11 |
| H3 | Invalid-at-computed-value-time | A cycle, or substituting guaranteed-invalid with no fallback, makes the whole declaration IACVT. Effective value is `unset` — inherited if the property inherits, else initial. **It is not the runner-up declaration.** Getting this wrong is the single most likely "the tool lies" bug. | 03 |
| H4 | `!important` inverts layer order | Normal: latest layer wins. Important: **earliest** layer wins. Unlayered declarations sit in an implicit final layer. Wrong on Tailwind v4 and Open Props codebases if missed. | 04, 05 |
| H5 | The shadow-DOM "context" cascade step | Normal declarations: the **outer** tree scope wins. Important: the **inner** wins. Most hand-rolled resolvers omit this step entirely and get web-component pages backwards. | 08 |
| H6 | Cross-origin `cssRules` throws `SecurityError` | Try/catch per sheet; mark `readable:false`; ask the SW to re-fetch with `credentials:'omit'`; mark `reparsed:true`; emit `CROSS_ORIGIN_SHEET_UNREADABLE`. Report how many sheets you could not read — never present a partial picture as complete. | 09 |
| H7 | A re-fetched sheet may not be the served sheet | Auth-gated CSS, `Vary`, CDN edge variation. `reparsed:true` downgrades `confidence` to `probable`. | 09 |
| H8 | `replaceSync` silently drops `@import` | Recurse the fetch yourself, or whole subtrees of rules go missing. | 09 |
| H9 | `inherits:false` registered properties | The ancestor walk must **stop at the element itself**. An ancestor declaration of a non-inheriting registered token is invisible below it. | 11 |
| H10 | Registered properties are type-coerced at computed-value time | `<color>` → canonical form, `<length>` → px, `<number>` → re-serialised. Never string-compare a registered token's computed value against authored text. | 11 |
| H11 | `CSS.registerProperty` called from JS is invisible to CSSOM | Emit `JS_REGISTERED_PROPERTY`. Optional mitigation: monkey-patch `CSS.registerProperty` from a `document_start` MAIN-world script — deferred, seam exists. | — |
| H12 | Pending-substitution values | When a shorthand's value contains `var()`, its longhands serialise as `""`, and vice versa. **Never trust `style.getPropertyValue(shorthand)` alone** — iterate `style.item(i)` and keep raw declaration text. | 02 |
| H13 | `box-shadow` is not a shorthand | It is one comma-separated list property. Split on top-level commas into layers; a single `var()` may expand into several layers. | 02 |
| H14 | CSSOM normalises non-custom specified values | `#fff` becomes `rgb(255,255,255)`. Breaks byte-exact export and breaks hardcoded-value matching. Use re-fetched sheet text or CDP source ranges when byte fidelity matters. | 01 |
| H15 | `@container` and `@scope` cannot be evaluated from CSSOM | There is no public API to test a container query against an element. Emit `CONTAINER_QUERY_UNEVALUATED` / `SCOPE_UNEVALUATED`, set `matched:'unknown'`, degrade `confidence`. Optionally hand-roll the `width`/`inline-size` subset. Do not silently over-include. | — |
| H16 | Active transitions and animations | The computed value may match no declaration. Detect via `el.getAnimations()`, set `animating:true`, emit `ANIMATION_ACTIVE`. | — |
| H17 | Custom property names are case-sensitive and codepoint-compared | `--foo` ≠ `--FOO`. Never lowercase a token name. Use `Map`, not loosely-keyed objects. | 10 |
| H18 | Unbounded alias recursion | The spec explicitly requires UAs to defend against exponential substitution; so must we. Cap depth at 50, node count at 500, emit `depth-exceeded`. | 03 |
| H19 | `el.matches()` throws on unsupported selectors and pseudo-elements | Try/catch per selector part, or rules get silently skipped. | 01 |
| H20 | No notification for `insertRule`/`deleteRule` or `adoptedStyleSheets` mutation | There is no MutationObserver for either. Poll `styleSheets.length` plus per-sheet `cssRules.length` on every pick; debounce a `MutationObserver` on head/style/link at ~100 ms. | 08 |

### 6.2 Override and export hazards (WS-3, WS-4)

| # | Hazard | Correct behaviour |
|---|---|---|
| H21 | A token declared in several scopes (light and dark) | `ResolvedToken.scopes[]` lists them all. The UI must offer per-scope editing. A single flat "change this colour" silently edits one theme and looks broken on toggle. |
| H22 | Overriding a token declared inside `@media`/`@supports`/`@layer` | Re-wrap the override in the identical conditional context, verbatim. An unwrapped dark-mode override also hits light mode. |
| H23 | Page inline styles set by script | Inline beats any author stylesheet rule without `!important`, and the script re-sets it. Detect by inspecting the element's inline `style`, escalate to rung `important`, label "page script fights this". If the page uses inline `!important`, the only author-origin answer is `element.style.setProperty(p,v,'important')` — rung `inline-only`, `exportable:false`. Say so. |
| H24 | The page reassigns `adoptedStyleSheets` wholesale, or CSS-in-JS re-renders | No observer exists for `adoptedStyleSheets`. Run a ~2 Hz idle watchdog checking sheet identity and re-append. The `<style>` fallback *is* observable — use a MutationObserver for that path. |
| H25 | Theme toggled mid-session | Watch `<html>` class/attribute mutations and `matchMedia('(prefers-color-scheme: dark)')`. Re-resolve scopes, re-verify every `Edit`, and keep per-scope edits separate so a toggle does not discard work. |
| H26 | A registered property rejects the new value | An invalid value silently falls back to `initial-value`, which looks exactly like "the override did nothing". Validate against `syntax` **before** applying; emit `REGISTERED_SYNTAX_REJECTED`. |
| H27 | Nothing inside a shadow root can be selected from a document-level stylesheet | `::part(name)` reaches only explicitly exposed parts and cannot chain (`::part(x)::part(y)` is invalid). The exportable route is overriding the token **on the host element from the document**, which works because custom properties inherit across the shadow boundary. Otherwise: preview-only. |
| H28 | A registered custom property with a `transition` animates on every drag step | Emit a `transition:none` guard on the preview rule while dragging. |
| H29 | Page CSP and injected styles | Content scripts run in an isolated world with their own CSP and no `style-src`, so page `style-src` does not block our injected styles. CSP3 §6.1.13 nominally gates CSSOM mutation on `'unsafe-eval'`; the spec flags this as unresolved and Chrome does not enforce it — keep `chrome.scripting.insertCSS` as a fallback path anyway. |

### 6.3 Platform walls — state these in the UI, do not work around them

Cross-origin iframes: from the top frame you cannot hit-test in (`elementFromPoint` returns the `<iframe>`), read the DOM, or read computed styles. The workable path is `all_frames: true` plus `match_about_blank` and `match_origin_as_fallback`, so each frame runs its own picker and draws its own overlay **in its own viewport** — no coordinate translation — with the panel routing by `frameId`. v1 renders the boundary as a leaf labelled "iframe boundary — token scope ends here". A `sandbox` iframe without `allow-scripts` is genuinely impossible.

Closed shadow roots: `host.shadowRoot === null`, `composedPath()` truncates at the host, `elementFromPoint` stops at the host. Tokens still inherit inward, so overrides on the host work; we simply cannot enumerate internals. Same for UA shadow DOM (`<video>` controls, `<input>` internals). Emit `CLOSED_SHADOW_ROOT`.

Canvas, WebGL, and video are pixels, not elements. No tokens, no boxes. The only honest affordance is EyeDropper plus "nearest token, ΔE 3.1".

Pseudo-elements: `getComputedStyle(el, '::before')` resolves values and `.getPropertyValue('--x')` works on it (confirm in spike S6), so `::before`, `::after`, `::marker`, and `::placeholder` can be listed as child rows with their token usage and overridden via a generated `sel::before { --x: … }`. You cannot hit-test them, cannot get their box, cannot click-select them.

Dead surfaces where the extension cannot run at all, and must say so rather than appearing broken: `chrome://*`, `devtools://`, other `chrome-extension://` pages, `chromewebstore.google.com` and `chrome.google.com/webstore` (hard-blocked, no override exists), `view-source:`, the built-in PDF viewer, and `file://` unless the user enables "Allow access to file URLs".

---

## 7. Day-0 spikes

Twelve questions that research could not settle from documentation. Each is cheap to answer empirically and at least one design decision depends on it. **WS-S runs these in parallel with WS-0, writes `docs/spikes.md`, and commits a `test/spikes/*.spec.ts` per answer so the answer stays true.** Gate 1 does not open until this table is filled in.

| ID | Question | How to settle it | What changes if the answer is unfavourable |
|---|---|---|---|
| S1 | Does `$0` resolve under `inspectedWindow.eval(..., {useContentScriptContext:true})`? | Load unpacked, open a panel, eval `typeof $0` both ways | If no: all `$0` reads go through the default main-world path, and the content script learns the selection only via the `data-tokenlens-sel` attribute handshake. Affects WS-1 and WS-7. |
| S2 | Does bare `eval` reach the top frame when `$0` is inside an iframe? | Fixture 12, select a node in the child frame | Assume yes (docs say eval defaults to the main frame) — which is exactly why the per-frame content script exists. If eval *does* follow the selection, the frame routing in WS-7 simplifies. |
| S3 | Can `showPopover()` promote an element that lives inside a **closed** shadow root, and does re-promotion throw when already open? | Fixture with a hostile `z-index:2147483647` overlay | If closed roots cannot be promoted: use an open shadow root plus `all:initial` and accept selector-bleed risk, or move the paint layer to a sibling node outside the shadow root. Affects WS-5 and D15. |
| S4 | Does `getComputedStyle` in the target Chrome preserve `oklch()`/`color()` spaces, or downgrade to `rgb()`? | Read a known `oklch()` token's computed value | Determines whether WS-2's two-track authored-vs-computed design is required or merely prudent. If it downgrades, the authored-text track becomes mandatory for every colour edit. |
| S5 | Does Chrome preserve comments in the computed value of unregistered custom properties, as css-variables-2 §4.1 requires? | WPT-style fixture with `--x: /* a */ var(--y) /* b */` | Purely a trimming and normalisation rule in WS-1's parser. Write the test either way. |
| S6 | Does `getComputedStyle(el,'::before').getPropertyValue('--x')` resolve custom properties? | Fixture 01 with a `::before` declaring and consuming a token | If no: pseudo-element rows become declaration-only (no computed value), and the UI must label them as such. |
| S7 | Can `EyeDropper` be constructed **and its overlay actually rendered** from a DevTools panel document, docked and undocked? | Manual, ten minutes, both dock states | If no: the content-script fallback in §12.3 becomes the primary path, which costs one extra in-page click. Affects WS-2 and WS-6. |
| S8 | Is Chromium issue 530992437 (window input disabled after an EyeDropper pick, regressed 149→150) live in the target Chrome? | Pick a colour, then try to click the page | If live: ship a "click anywhere to restore focus" recovery affordance and a release note. |
| S9 | Does `chrome.permissions.request` work from a DevTools panel page? | Call it from the panel behind a button | If unreliable (expected): the store-posture build must route permission requests through the action popup or an options page. Affects §15 only. |
| S10 | What is `match_origin_as_fallback`'s minimum Chrome version, and does it cover `about:srcdoc`? | Fixture 12 variant with a `srcdoc` iframe | Sets `minimum_chrome_version` and decides whether srcdoc frames are supported or listed as a wall. |
| S11 | Does a rule added to the DevTools **inspector stylesheet** survive a page reload, and does the declaration editor accept a pasted multi-rule blob with `@media` and comments? | Manual, sixty seconds | Design already assumes **no** to both (D11). A yes on at-rules would let flat mode keep its conditions, which is a straight UX win — so check before building flat mode. |
| S12 | Does `new CSSStyleSheet()` constructed in a content-script isolated world adopt cleanly across the whole support matrix? | Fixtures 01 and 08 on the oldest supported Chrome | If not: the `<style id="tokenlens-preview">` fallback becomes primary. WS-3 must implement both regardless. |

One standing instruction for WS-S: also pin the exact `@property` and `color-mix()` behaviour of **Playwright's bundled Chromium**, which typically runs one to two milestones ahead of stable Chrome. A token that resolves in CI can fail for a user on an older Chrome. Set `minimum_chrome_version` from that experiment, not from guesswork.

---

## 8. The parallel plan

### 8.1 Why this decomposition is safe

Parallel agents fail for three reasons: they edit the same files, they disagree about types, or one silently blocks on another. This plan removes all three. Ownership is exclusive at the **directory** level (§8.2) — no two workstreams write the same file, ever. Types are frozen before Wave 1 begins (§5) and change only by change request. And every dependency between workstreams is satisfied by a **type plus a fixture**, never by working code: WS-4 (export) builds against a committed `ElementTokenReport` JSON fixture, so it does not wait for WS-1's resolver to work; WS-6 (panel) builds against `mock-transport.ts` replaying a recorded message log, so it does not wait for WS-7's ports or even for the extension to load.

### 8.2 Ownership map

| WS | Name | Owns (exclusive write access) | Must not touch |
|---|---|---|---|
| WS-0 | Scaffold & contracts | `package.json`, `vite.config.ts`, `manifest.config.ts`, `tsconfig*`, `eslint.config.js`, `playwright.config.ts`, `size-limit.config.js`, `src/core/model.ts`, `src/core/ports.ts`, `src/transport/protocol.ts`, `src/adapters/capture-replay.ts`, `src/adapters/mock-transport.ts`, `src/content/bridge/`, `test/fixtures/**`, `.github/workflows/**` | everything else |
| WS-S | Spikes | `test/spikes/**`, `docs/spikes.md` | all `src/` |
| WS-1 | Resolver | `src/core/resolve/**`, `src/adapters/capture-live.ts`, `src/shared/eval-fns.ts`, `test/snapshots/**`, `test/unit/resolve/**`, `test/browser/capture.spec.ts` | `core/color`, `core/emit`, `core/selector`, all UI |
| WS-2 | Colour engine | `src/core/color/**`, `test/unit/color/**` | everything else |
| WS-3 | Selector + override apply | `src/core/selector/**`, `src/content/override/**`, `test/unit/selector/**`, `test/browser/override.spec.ts` | `core/emit` (consumes its own `Edit[]` output, does not format CSS) |
| WS-4 | Export compiler | `src/core/emit/**`, `test/unit/emit/**`, `test/goldens/**` | anything that produces `Edit[]`; it only consumes them |
| WS-5 | Overlay & picker | `src/content/index.ts`, `src/content/overlay/**`, `test/browser/overlay.spec.ts`, `test/perf/overlay.spec.ts` | `src/content/override/**` (WS-3 owns it; wire via an injected interface) |
| WS-6 | Panel UI | `src/panel/**`, `src/sidebar/**`, `src/popup/**`, `src/ui/**`, `test/browser/panel/**` | all `core/`, all `content/` |
| WS-7 | Transport & background | `src/background/**`, `src/devtools/**`, `src/adapters/chrome-port.ts`, `test/e2e/transport.spec.ts` | `core/`, `ui/` |
| WS-8 | Integrator | merge commits, `src/**` glue only where a seam is missing, `test/e2e/**` | may not rewrite another workstream's logic; files a CR instead |
| WS-9 | Audit view | `src/core/audit/**`, `src/panel/audit/**`, `test/unit/audit/**` | everything else |

### 8.3 Waves and dependency graph

```
WAVE 0 ──────────────────────────────────────────────────────────────
  WS-0 scaffold + FROZEN CONTRACTS + fixture matrix + CI  ─┐
  WS-S spikes (independent, no src/)                       │
                                             ══ GATE 1 ════╧═══════
WAVE 1 (7 agents, fully parallel, one worktree each) ─────────────────
  WS-1 resolver        ← needs model.ts, fixtures
  WS-2 colour          ← needs model.ts only
  WS-3 selector+apply  ← needs model.ts, fixtures
  WS-4 export          ← needs model.ts + a committed report fixture
  WS-5 overlay         ← needs model.ts, protocol.ts
  WS-6 panel UI        ← needs model.ts, protocol.ts, mock-transport
  WS-7 transport       ← needs protocol.ts
                                             ══ GATE 2 ════════════
WAVE 2 ──────────────────────────────────────────────────────────────
  WS-8 integration (solo) → then WS-9 audit (parallel with hardening)
                                             ══ GATE 3 ════════════
```

Only two real edges exist inside Wave 1, and both are satisfied by fixtures rather than code: WS-4 consumes an `ElementTokenReport` and an `Edit[]`, which WS-0 commits as `test/fixtures/report-01.json`; WS-9 consumes WS-1's reverse index plus WS-2's ΔE, which is why it sits in Wave 2 rather than Wave 1.

### 8.4 Branch and integration protocol

One branch per workstream, named `ws/<n>-<slug>`, all forked from the Gate 1 commit. Nobody rebases anyone else. Each branch must be green on **its own** required checks (§11.2) before it is offered for merge.

WS-8 merges in this order, because it is the order in which a broken merge is cheapest to diagnose: `ws/0` (already on main) → `ws/2 colour` (pure, zero dependencies) → `ws/4 export` (pure) → `ws/3 selector+apply` → `ws/1 resolver` → `ws/7 transport` → `ws/5 overlay` → `ws/6 panel`. After each merge WS-8 runs the full suite; a failure is attributed to the just-merged branch and returned to its owner, never fixed in place.

### 8.5 Change requests

When a workstream discovers that a frozen contract is wrong — and this will happen, probably in WS-1 around shorthand expansion and in WS-3 around scope representation — it writes `docs/cr/WS-<n>-<slug>.md` containing: the field or type at issue, the concrete case that breaks it, the minimal proposed change, and every workstream affected. One file per workstream, so CRs never collide. The human (or WS-8) accepts or rejects at the next gate; accepted CRs are applied to `model.ts` by WS-8 alone, in one commit, and broadcast. **No workstream edits `model.ts` directly, including WS-1.**

### 8.6 Instructions that apply to every agent

Write the test before the implementation for anything in `core/`; the fixtures already exist, so there is no excuse. Never introduce a platform global into `core/` — ESLint enforces it, and a violation means your module boundary is wrong, not that the rule is wrong. Never bless a snapshot with `--update-snapshots`; if a golden changed, either it is a bug or the change is intentional and belongs in the commit message. Record every number your budget cares about into `perf-results.json`. When you hit one of the §7 spikes and WS-S has not answered it yet, implement both branches behind a flag and say so in your handback rather than guessing. Prefer a visible `Diagnostic` over a silent fallback, always — the product's first virtue is truthfulness, and a tool that degrades loudly is worth more than one that degrades gracefully.

---

## 9. Workstreams

Each subsection is self-contained. An agent receives §4, §5, §6, §10, §11, its own subsection, and nothing else.

### WS-0 — Scaffold, frozen contracts, fixtures, CI

**Mission.** Produce a repository in which seven agents can work simultaneously without talking to each other. You are not writing product logic. You are writing the walls.

**Owns.** Build config, the three contract files from §5, the adapter stubs, every fixture, and CI.

**Deliverables.**

A working Vite + CRXJS + React + TS extension that loads unpacked in Chrome and shows an empty "Tokens" panel and an empty "Design Tokens" Elements sidebar pane. Pin CRXJS to `@crxjs/vite-plugin@2.7.x` and Vite to the version its peer range names; if the version matrix fights you for more than thirty minutes, switch to WXT (D5) and record the switch in `docs/decisions.md`. Entry points: `src/devtools/index.html`, `src/panel/index.html`, `src/background/index.ts`, `src/content/index.ts`. Verify HMR works for the panel and that the content script reloads on rebuild.

`src/core/model.ts`, `src/core/ports.ts`, `src/transport/protocol.ts` — copied **verbatim** from §5. Do not improve them. They are frozen at the moment you commit them, and the whole parallel plan rests on that.

`src/adapters/mock-transport.ts` — an in-memory `Transport` that replays a JSON array of `Envelope`s with configurable latency and a `failNext()` hook. WS-6 builds the entire UI against this.

`src/adapters/capture-replay.ts` — a `StyleHost` implementation reading a `SheetSnapshot[]` JSON blob, so `core/` is testable in Node.

`src/content/bridge/main-world.iife.ts` — an empty MAIN-world script that posts `{source:'tokenlens-bridge', v:1, type:'hello'}` once and exits. It exists so the framework-identity seam (§2) is real rather than aspirational.

The thirteen fixtures of §10, as static HTML under `test/fixtures/`, served by `vite preview` on a fixed port. Fixture 01 additionally gets a committed `report-01.json` (a hand-written `ElementTokenReport` for its primary button) and `edits-01.json` (a hand-written `Edit[]`), because WS-4 and parts of WS-6 consume those instead of waiting for WS-1.

ESLint with `no-restricted-globals` for `window`, `document`, `chrome`, `getComputedStyle` scoped to `src/core/**`, and `no-restricted-imports` banning `src/content/**` and `src/panel/**` from `src/core/**`. This single rule is what makes the resolver testable and what stops seven agents from quietly merging layers.

Vitest with two projects — `node` (default, for `core/`) and `browser` (`provider: 'playwright'`, `instances: [{browser: 'chromium'}]`) — and **no jsdom or happy-dom anywhere in the dependency tree**; add a CI grep that fails if either appears in the lockfile. Playwright config using `channel: 'chromium'` with `launchPersistentContext`, `--disable-extensions-except`, `--load-extension`, `--auto-open-devtools-for-tabs`, and `headless: false` (MV3 extensions do not load in old headless). `size-limit` entries per bundle with the §11 numbers. The GitHub Actions workflow of §11.2 with `xvfb-run` on Linux.

**Acceptance.** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:browser`, `pnpm build` all green on a repo with zero product logic. A deliberate `document.body` reference inside `src/core/` fails lint. `pnpm test` imports `model.ts` and asserts the JSON round-trip of `report-01.json` against the type (use a small runtime schema check or a type-level assertion — your choice, but assert it).

**DoD.** Tagged commit `gate-1`. `docs/ownership.md` reproduces §8.2. `docs/decisions.md` records any deviation.

```AGENT PROMPT
You are WS-0 on the Tokenlens project. Read the attached sections §4 (architecture), §5 (frozen contracts), §10 (fixture matrix), §11 (budgets), and the WS-0 subsection of §9.

Build the repository skeleton only. Write no product logic — no cascade resolution, no colour maths, no UI beyond an empty panel shell. Your output is the walls that let seven other agents work in parallel without coordinating.

Copy src/core/model.ts, src/core/ports.ts and src/transport/protocol.ts verbatim from §5. Do not improve, rename, or extend them; other agents are being given the identical text and any divergence breaks the build for all of them.

Deliver, in this order: (1) a Vite + CRXJS + React + TS MV3 extension that loads unpacked and opens an empty "Tokens" DevTools panel plus an empty "Design Tokens" Elements sidebar pane; (2) the three contract files; (3) src/adapters/mock-transport.ts and src/adapters/capture-replay.ts as described; (4) src/content/bridge/main-world.iife.ts as a near-empty seam; (5) all thirteen fixtures from §10 as static HTML plus test/fixtures/report-01.json and edits-01.json hand-written to match the contract; (6) ESLint boundary rules that forbid window/document/chrome/getComputedStyle inside src/core/**; (7) Vitest with separate node and browser projects, Playwright with channel:'chromium' and launchPersistentContext, size-limit, and the CI workflow.

Hard constraints: jsdom and happy-dom must not appear anywhere in the dependency tree, and CI must fail if they do — they do not implement the cascade and would make every resolver test a lie. Headless mode must be off for extension tests. Pin CRXJS 2.7.x; if the Vite peer-version matrix costs you more than thirty minutes, switch to WXT and record why in docs/decisions.md.

Done when pnpm typecheck, lint, test, test:browser and build are all green on a repo with no product logic, a deliberate document reference inside src/core/ fails lint, and you have tagged the commit gate-1 and written docs/ownership.md. Report back: the exact dependency versions you pinned, anything in §5 you believe is wrong (as a docs/cr/ file, not an edit), and the fixture list you actually shipped.
```

---

### WS-S — Spikes

**Mission.** Convert the twelve unknowns in §7 into written answers with regression tests, before anyone builds on a guess.

**Owns.** `test/spikes/**`, `docs/spikes.md`. Touches no `src/`.

**Deliverables.** `docs/spikes.md` with one section per spike: the question, the exact reproduction, the observed result, the Chrome and Playwright-Chromium versions observed, and **which plan decision this confirms or flips**. A `test/spikes/S<n>.spec.ts` per mechanically-testable spike so the answer cannot silently rot; S7, S8, S9 and S11 are manual and get a written result plus a screenshot.

**Acceptance.** All twelve rows answered, or explicitly marked BLOCKED with the reason. A recommended `minimum_chrome_version` derived from the observations, plus a note on any behaviour that differs between Playwright's bundled Chromium and stable Chrome.

**DoD.** Reviewed at Gate 1. Any answer that flips a decision is written into `docs/decisions.md` by WS-8 before Wave 1 starts.

```AGENT PROMPT
You are WS-S on the Tokenlens project. Read §7 (day-0 spikes), §6 (hazards) and §3 (locked decisions).

Your job is empirical. Answer all twelve questions in §7 by running them in a real Chrome and a real Playwright Chromium — not by reasoning from documentation, and not by reading more documentation. Where a spike is manual (S7 EyeDropper in a DevTools panel, S8 the input-lock regression, S9 permissions.request from a panel, S11 the DevTools inspector stylesheet), do it by hand and record what you saw plus a screenshot.

Write docs/spikes.md with one section per spike containing: question, exact reproduction steps, observed result, Chrome version, Playwright Chromium version, and the sentence "this confirms D<n>" or "this flips D<n>, because …". For every mechanically testable spike also commit test/spikes/S<n>.spec.ts so the answer stays true as Chrome moves.

You may write only test/spikes/** and docs/spikes.md. Do not touch src/.

Finish by recommending a minimum_chrome_version based on what you actually observed, and by listing any behaviour where Playwright's bundled Chromium disagrees with stable Chrome — that gap will otherwise produce CI-green features that fail for users. If a spike is genuinely unanswerable in your environment, mark it BLOCKED with the reason rather than guessing.
```

---

### WS-1 — The resolver

**Mission.** Given an element, produce a truthful `ElementTokenReport`. This is the heart of the product and the only workstream where being 95% right is a failure.

**Owns.** `src/core/resolve/**`, `src/adapters/capture-live.ts`, `src/shared/eval-fns.ts`, `test/snapshots/**`, `test/unit/resolve/**`, `test/browser/capture.spec.ts`.

**Pipeline to implement, in this order.**

*Index.* Walk `document.styleSheets` plus every `ShadowRoot`'s `styleSheets` and `adoptedStyleSheets`, recursing `CSSImportRule`, `CSSMediaRule`, `CSSSupportsRule`, `CSSLayerBlockRule`, `CSSContainerRule`, `CSSScopeRule`, `CSSStyleRule` (nested rules — CSS Nesting means a style rule can contain style rules). Build the layer order table by encountering `CSSLayerStatementRule` and block rules in document order; unlayered lives in an implicit final layer. Record every declaration with its full `ConditionRef[]` chain, its `TreeScopeRef`, and its raw text. Cache per `documentId` with invalidation on sheet-count or rule-count change (H20).

*Candidate buckets.* Do not test every selector against every element — that is O(rules × elements) and blows the budget on a Tailwind page. Bucket selectors by their rightmost compound's id, class, tag and attribute, then test only the union of buckets the element could match, plus the always-test bucket (`*`, pseudo-only, complex-rightmost). Measure the reduction on fixture 07 and put the number in your handback.

*Cascade sort.* Implement the six-step sort exactly as §6 H4 and H5 describe, including the important-inverts-layers rule and the tree-scope context step. Compute specificity yourself as `[a,b,c]`, handling `:is()`/`:not()`/`:has()` (most specific argument), `:where()` (zero), and the fact that a selector list's specificity is per-branch — match against the branch that actually matched, not the whole list.

*Longhand expansion.* Expand shorthands to longhands. `box-shadow` is a single list property, not a shorthand (H13). Keep pending-substitution values as their own state (H12) — never conclude "empty" from a shorthand read.

*Alias chain.* For each resolved value containing `var()`, parse `var(--name, fallback)` with correct nesting and comma handling, walk up the flattened ancestor tree to find each custom property's winning declaration (respecting `inherits:false` registrations, H9), and build `AliasChainNode[]` with `status` per node. Handle cycles (H3 → IACVT → `unset`, and say so in `diagnostics`), short-circuiting (a fallback is not evaluated if the primary resolves), depth and node caps (H18), and case sensitivity (H17).

*Self-check.* After resolving, compare your computed answer to `getComputedStyle(el).getPropertyValue(prop)`. On mismatch, set `confidence: 'probable'` or `'uncertain'` and push `PROBE_MISMATCH` with both values. **Never suppress the mismatch.** This one behaviour is what makes the tool trustworthy, and it is also your own best bug detector during development.

*Reverse index.* For each token, count and sample the elements that consume it, so the UI can say "moves 41 elements". Cap the sampled element list; return an exact count if under a threshold and an estimate flagged as such above it.

*Capture.* `src/adapters/capture-live.ts` serialises the real browser's sheets into the `SheetSnapshot` JSON that `capture-replay.ts` consumes. `test/browser/capture.spec.ts` runs in Playwright against each fixture and writes `test/snapshots/<fixture>.json`. Every unit test then runs in Node against those snapshots. This is how a 3000-line cascade engine gets 200 fast tests without a browser in the loop.

**Acceptance.** All thirteen fixtures produce a report. Fixtures 01–11 match a committed golden. Zero `PROBE_MISMATCH` on fixtures 01, 02, 04, 05, 10 (the ones with no legitimate ambiguity). Fixtures 03, 09, 11 must emit their expected diagnostics — a clean report there is a **failure**. Property-based test with fast-check: generate random alias graphs including cycles and assert the resolver terminates, never throws, and flags every cycle. Budget: resolve ≤ 150 ms p95 on fixture 07, index ≤ 400 ms cold, from `perf-results.json`.

**DoD.** No platform globals in `core/resolve/**` (lint enforces it). A CDP-oracle comparison script exists under `test/oracle/` comparing your matched-rule order against `CSS.getMatchedStylesForNode` on fixtures 01–08 with a documented pass rate. Every §6.1 hazard is named in a test name.

```AGENT PROMPT
You are WS-1 on the Tokenlens project — the resolver. Read §4, §5, §6.1, §10, §11, and the WS-1 subsection of §9.

Build the engine that turns an element into a truthful ElementTokenReport: index every stylesheet (including shadow roots, adoptedStyleSheets, @import, @layer, @media, @supports, @container, @scope and nested rules), bucket candidate selectors so you are not testing every rule against every element, sort the cascade correctly, expand shorthands, resolve every var() chain to its terminal value, and count consumers per token.

Two rules matter more than everything else. First: src/core/resolve/** must contain no platform globals — no window, document, chrome or getComputedStyle. All browser access goes through the StyleHost port from §5. ESLint enforces this, and it is what lets your 3000-line engine be tested by 200 fast Node tests. Second: after every resolution, self-check your answer against getComputedStyle and, on mismatch, downgrade confidence and emit PROBE_MISMATCH with both values. Never suppress a mismatch to make output look clean — a visibly uncertain answer is the product working correctly, and a confident wrong answer is the one failure mode that makes the whole tool worthless.

§6.1 lists twenty hazards. Each one has a fixture. Name the hazard in the test name. Pay particular attention to H3 (IACVT resolves to unset, NOT to the runner-up declaration), H4 (!important inverts layer order), H5 (the shadow-DOM context step: outer wins for normal declarations, inner wins for important), H9 (inherits:false registrations stop the ancestor walk) and H12 (pending-substitution values serialise as empty — never read a shorthand and conclude "empty").

Also build src/adapters/capture-live.ts plus test/browser/capture.spec.ts so real Chromium sheet data is captured to test/snapshots/*.json, and write your unit tests against those snapshots in Node.

Done when: all 13 fixtures produce a report; 01-11 match committed goldens; fixtures 01, 02, 04, 05, 10 produce zero PROBE_MISMATCH; fixtures 03, 09, 11 DO emit their expected diagnostics (a clean report there is a failure); a fast-check property test proves random alias graphs with cycles always terminate and are always flagged; resolve is under 150ms p95 on fixture 07. Report back the candidate-bucket reduction factor you measured, your CDP-oracle agreement rate, and any §5 type that could not express what you needed — as docs/cr/WS-1-*.md, not as an edit to model.ts.
```

---

### WS-2 — Colour engine

**Mission.** Parse, convert, compare, gamut-map and format colour, and provide the picker's maths. Pure functions only; no DOM, no React.

**Owns.** `src/core/color/**`, `test/unit/color/**`.

**Deliverables.** A culori-based module importing only from `culori/fn` with explicitly registered modes (`rgb`, `hsl`, `oklch`, `oklab`, `p3`, `lab`, `lch`, `hwb`) so the bundle stays near 8 kB rather than pulling the full 40 kB. Parse every CSS Color 4 form the target Chrome accepts, and expose a `probe()` recipe for anything culori cannot parse: hand the string to the browser (via `StyleHost`) by setting it on a throwaway element and reading the computed value back, so `color-mix()`, `light-dark()`, relative colour syntax and `system-ui` keywords still yield a usable `ColorValue` with `parsedBy: 'probe'`.

Two-track value handling: keep the **authored** string (for export fidelity) and the **computed** string (for accuracy) separately, and never silently substitute one for the other. Implement CSS Color 4's gamut mapping algorithm (local-MINDE, ΔE_OK step 0.02) for out-of-sRGB values rather than naive clipping, and label a mapped value as mapped. Provide ΔE_OK for "nearest token" search and ΔE₀₀ for human-facing "how different is this" numbers, with the thresholds documented. Provide WCAG 2.x contrast (the standard people are audited against) and APCA Lc alongside it, clearly labelled as informative.

Picker maths: OKLCH-plane hue/chroma/lightness conversion with the visible-gamut boundary per hue, so the UI can grey out impossible chroma instead of clamping surprisingly. Swatch harvesting: given the token table, produce a deduplicated, perceptually sorted palette of the document's actual colours.

**Acceptance.** Round-trip every fixture colour authored→parsed→formatted→re-parsed with ΔE_OK < 0.001. Gamut-map a known set of wide-gamut colours and match the reference values in the CSS Color 4 spec examples. `size-limit` shows the colour bundle under 12 kB gzipped. No import of `culori` top-level anywhere (lint rule).

**DoD.** 100% branch coverage on the parser. A documented table of which CSS colour syntaxes are parsed natively versus by probe.

```AGENT PROMPT
You are WS-2 on the Tokenlens project — the colour engine. Read §5 (the ColorValue contract), §6.2 (hazards H26, H28), and the WS-2 subsection of §9.

Build src/core/color/** as pure functions: parse, convert, format, compare, gamut-map, and the maths the picker needs. No DOM, no React, no chrome APIs — if you need the browser (and you will, for colours culori cannot parse), go through the StyleHost port.

Use culori, importing only from culori/fn with explicitly registered modes (rgb, hsl, oklch, oklab, p3, lab, lch, hwb). The tree-shakeable entry point is the difference between roughly 8 kB and 40 kB, and there is a size-limit check on it.

Three things are easy to get subtly wrong and matter a lot. First, keep the authored string and the computed string as separate tracks — export fidelity depends on the authored form, accuracy depends on the computed form, and silently swapping them produces exports that do not match what the user saw. Second, implement CSS Color 4's actual gamut mapping algorithm (local-MINDE, ΔE_OK step 0.02) rather than clipping channels, and label mapped values as mapped. Third, for anything culori cannot parse — color-mix(), light-dark(), relative colour syntax — implement the probe recipe: set the string on a throwaway element via StyleHost, read the computed value back, and return a ColorValue with parsedBy:'probe' rather than failing.

Expose ΔE_OK for nearest-token search, ΔE₀₀ for human-facing difference numbers, WCAG 2.x contrast (what people get audited against) and APCA Lc labelled informative. For the picker, expose the visible-gamut chroma boundary per hue so the UI can grey out impossible values instead of clamping unexpectedly.

Done when: every colour in the fixture set round-trips authored→parsed→formatted→re-parsed with ΔE_OK under 0.001; your gamut mapping matches the CSS Color 4 spec's worked examples; size-limit reports the colour bundle under 12 kB gzipped; and you have committed a table of which CSS colour syntaxes are parsed natively versus by probe. Report back that table and any syntax you could not handle either way.
```

---

### WS-3 — Live token editing, override scoping, and real-time preview

**Mission.** Make a token editable and make the page reflect the edit *while the user is still dragging*. This workstream is the reason the tool is a design tool rather than an inspector. Two capabilities, one engine: change the **token** and everything it feeds moves together; change one **element** and only it moves.

**Owns.** `src/core/selector/**`, `src/content/override/**`, `test/unit/selector/**`, `test/browser/override.spec.ts`.

#### 9.3.1 The three edit scopes

Every edit the user makes must resolve to exactly one of these, chosen explicitly, shown in the UI, and recorded on the `Edit`:

| Scope | Meaning | Emitted as | When it is the right default |
|---|---|---|---|
| `token-global` | Redefine the token everywhere it is declared, in every scope | one rule per declaring scope, each re-wrapped in its own conditional context | The user clicked a token row in the token list. This is the Figma-variable mental model and should be the default for token work. |
| `token-scoped` | Redefine the token only in one declaring scope (e.g. only under `[data-theme="dark"]`) | one rule, that scope's selector, that scope's conditions | The token has more than one declaring scope and the user chose one, or the current theme is dark and they are editing what they can see. |
| `element-local` | Redefine the token, or the property directly, only on the picked element and its subtree | a generated selector for that element (§9.3.3) | The user wants a one-off, or the token is not reachable (closed shadow root, UA styles, inline-`!important` fight). |

The scope selector is not a settings screen. It is a three-segment control directly above the value editor, pre-selected by the heuristic above, with a live consumer count next to each option — "moves 41 elements / 12 elements / 1 element". A designer picks the right scope because they can see the blast radius, not because they read documentation.

#### 9.3.2 The real-time preview loop

This is the interaction the product is judged on, so its mechanics are specified rather than left to taste.

There is **no apply button and no debounce on the visual result.** Every pointer move during a colour drag or a numeric scrub writes through to the page in the same frame. The loop: pointer event → `Edit` in memory → coalesce into a per-frame dirty set → on rAF, one `rule.style.setProperty()` per dirty property on the already-inserted preview rule → done. Do not insert, delete, or re-parse rules during a drag; insert the rule once on first edit and mutate its `style` thereafter. Do not round-trip through the service worker during a drag (§4 rule 1); the content script holds the sheet and the panel talks to it over the long-lived port. Budget: **≤ 16 ms from pointer event to paint, p95** (§11), measured on fixture 07.

Guards that make this safe rather than merely fast: emit `transition: none` on the preview rule for the duration of a drag so a registered property with a `transition` does not animate every step (H28); validate against the `@property` `syntax` **before** writing, because an invalid value silently reverts to `initial-value` and looks identical to "the tool did nothing" (H26); and never touch the page's own rules — all preview writes go to our own sheet.

Commit semantics: `pointerdown` opens a transaction, pointer moves mutate it, `pointerup` commits it to the undo stack as one entry, `Escape` mid-drag reverts to the pre-drag value in the same frame. Undo and redo are `Edit[]` stack operations, and every edit is individually revertible from its row. Nothing is ever written to the page's source; removing the preview sheet must restore the page exactly, and there is a test for that.

The preview must also survive the page fighting back. A ~2 Hz idle watchdog re-checks that our sheet is still in `adoptedStyleSheets` and still last, and re-appends if a re-render or a wholesale `adoptedStyleSheets` reassignment dropped it (H24). A theme toggle mid-session re-verifies every `Edit` against the new scope set rather than discarding the work (H25).

#### 9.3.3 Injection and selector generation

Preview injection: `document.adoptedStyleSheets = [...existing, ourSheet]` with a constructed `CSSStyleSheet`, appended last so it wins document order; `<style id="tokenlens-preview">` appended to `<head>` as the fallback if construction or adoption fails (S12). Author origin only, never `chrome.scripting.insertCSS` for preview — a user-origin preview would not be reproducible by pasted CSS and would break the WYSIWYG guarantee (D7). One sheet per tree scope: a token declared inside a shadow root needs a sheet adopted into that root, and a separate document-level sheet cannot reach it.

Selector generation for `element-local`, in descending preference: a stable `id`; a `data-*` or ARIA attribute that looks semantic (`data-testid`, `data-component`, `role`, `aria-label`); a class combination that is stable — reject anything matching hashed-class patterns (`/^[a-z]+-[a-z0-9]{5,}$/`, `/^css-[a-z0-9]+$/`, emotion/styled-components/CSS-modules shapes) and say in the UI that you rejected it and why; then a structural path with `:nth-child` as the last resort, labelled fragile. Always report how many elements the generated selector actually matches, verified by `querySelectorAll`, next to how many you intended. A selector that matches 7 elements when the user picked 1 is a bug the user must be able to see.

The escalation ladder for making an override win, applied in order and never skipping: (1) plain rule, unlayered, appended last; (2) **selector doubling** — `.btn.btn`, or `:root:root` for tokens — which raises specificity without `!important` and is the workhorse; (3) `!important`; (4) `!important` plus doubling; (5) inline via `element.style.setProperty(p, v, 'important')`, which is `exportable: false` and must be labelled as preview-only. Record the rung reached on the `Edit` as `EditRung`, and show it. Verify each rung by reading back `getComputedStyle` after applying; escalate only on a verified failure, never speculatively. Pages with inline styles set by script (H23) and pages whose own rules are `!important` are the normal reason the ladder gets used, so the UI should explain the rung in one sentence rather than exposing a number.

**Acceptance.** Fixture 06 (the hostile page: `!important` everywhere, inline styles, a `z-index: 2147483647` overlay, a `MutationObserver` that reverts attribute changes) is overridable, and the report names the rung used. Fixture 08 (shadow DOM) is overridable via a host-level token override. A drag of 200 synthetic pointer moves on fixture 07 stays within the 16 ms budget and produces exactly one undo entry. Removing the preview sheet restores every computed value byte-for-byte — assert on a full computed-style diff of 50 elements, not on a spot check. A token with three declaring scopes edited at `token-global` updates all three and survives a theme toggle in both directions.

**DoD.** `core/selector/**` is pure and platform-free; all DOM work is in `content/override/**`. The `Edit[]` your module produces is consumed unmodified by WS-4 — if you need a field it does not have, file a CR, do not add it locally.

```AGENT PROMPT
You are WS-3 on the Tokenlens project — live token editing, override scoping, and real-time preview. Read §5 (the Edit, EditRung and ResolvedToken contracts), §6.2 (hazards H21-H29), §11 (budgets), and the WS-3 subsection of §9.

You own the capability the whole product exists for: the user changes a token value and the page updates while they are still dragging. Build two things that share one engine — token-level edits, where changing --brand-500 moves all 41 elements that consume it, and element-local edits, where only the picked element moves.

Implement the three edit scopes exactly as specified (token-global, token-scoped, element-local), each recorded on the Edit, each with a live consumer count so the user can see the blast radius before committing.

The preview loop has no apply button and no debounce on the visual result. Pointer event to painted pixel must be under 16 ms p95: insert your preview rule once on the first edit, then only call rule.style.setProperty() on it, coalesced into one write per rAF. Never insert, delete or re-parse rules mid-drag, and never round-trip through the service worker during a drag — the content script owns the sheet and the panel talks to it over a long-lived port. pointerdown opens a transaction, pointerup commits one undo entry, Escape reverts in the same frame.

Three guards are not optional. Emit transition:none on the preview rule while dragging, or a registered property with a transition will animate on every pointer move. Validate values against the @property syntax before writing, because an invalid value silently falls back to initial-value and is indistinguishable from the tool being broken. And never mutate the page's own rules — everything goes in our own author-origin sheet, because a user-origin preview could not be reproduced by the CSS we export, which would break the product's core promise.

Preview injection is adoptedStyleSheets with a constructed sheet appended last, with a <style id="tokenlens-preview"> fallback, and one sheet per tree scope (a document sheet cannot reach a token declared inside a shadow root). Run a 2 Hz watchdog that re-appends if the page reassigns adoptedStyleSheets or re-renders it away.

For element-local selectors, prefer id, then semantic data-*/ARIA attributes, then stable classes — explicitly reject hashed CSS-in-JS classes and tell the user you rejected them and why — then :nth-child paths labelled fragile. Always verify with querySelectorAll and report actual match count against intended. To make an override win, climb the ladder in order (plain → selector doubling like .btn.btn or :root:root → !important → both → inline important, which is exportable:false), verifying each rung by reading back getComputedStyle, and escalating only on a verified failure.

Done when: fixture 06 (hostile !important page with a reverting MutationObserver) is overridable and reports its rung; fixture 08's shadow DOM is overridable via a host-level token override; 200 synthetic pointer moves on fixture 07 stay inside 16 ms and produce exactly one undo entry; removing the preview sheet restores a 50-element computed-style diff byte-for-byte; and a token with three declaring scopes edited globally updates all three and survives a theme toggle both ways. Keep src/core/selector/** platform-free. The Edit[] you emit is consumed unmodified by WS-4 — if a field is missing, file docs/cr/WS-3-*.md rather than adding it.
```

---

### WS-4 — Export compiler

**Mission.** Turn `Edit[]` plus the report into CSS text that reproduces the preview on a machine where this extension does not exist. Pure; no DOM.

**Owns.** `src/core/emit/**`, `test/unit/emit/**`, `test/goldens/**`.

**Deliverables.** The emitter for the four targets and the format specified in §12: `stylus` (the primary, full-fidelity target), `overrides` (a file for DevTools Local Overrides), `flat` (the DevTools inspector-stylesheet variant, conditions stripped and annotated as lost), and `patch` (best-effort source-file suggestion, labelled as such). Grouping: edits collapse by scope selector and condition chain, so ten token edits under one `[data-theme=dark] @media (prefers-color-scheme: dark)` context emit one rule, not ten. Conditions are reproduced **verbatim** from `ConditionRef[]` — never reconstructed from your own understanding of what the media query meant (H22). Layer strategy is unlayered by design (D10): an unlayered declaration beats every layered one, and `@layer` in exported output is a footgun the user will not diagnose. Selector doubling carries into the export because the preview used it, and preview and export must agree.

Deterministic output: stable ordering (by scope, then condition chain, then property name), stable formatting, so a golden diff means a real change. Every file gets a header comment with the session sentinel `/*!tokenlens-session v1`, the URL, the timestamp, the tool version, and the count of edits; and a machine-readable sidecar (the session JSON, §12.4) so a paste can be re-imported into the tool later. Values are emitted in the **authored** colour syntax by default with a one-click toggle to computed, because a designer pasting `oklch()` into a codebase that uses hex will be told about it in review.

Also emit the honest parts: a trailing comment block listing every edit that could **not** be exported and why — inline-only rungs, closed shadow roots, UA-styled internals — because a silently incomplete stylesheet is the worst possible output of this workstream.

**Acceptance.** Golden files for edit sets over fixtures 01–11. The round-trip test is the real acceptance criterion and it belongs to WS-8 at Gate 2: preview on, capture computed styles, preview off, paste exported CSS into a fresh page load, capture again, assert identical. Build the comparison harness now so WS-8 only has to run it.

**DoD.** Zero platform globals. Every target documented with its known limitations in `docs/export-targets.md`.

```AGENT PROMPT
You are WS-4 on the Tokenlens project — the export compiler. Read §5 (Edit, ConditionRef, ResolvedToken), §12 (export format spec), §6.2 (H22, H23, H27), and the WS-4 subsection of §9.

Build src/core/emit/** as pure functions that turn an Edit[] plus an ElementTokenReport into CSS text. You do not need any other workstream to finish: WS-0 has committed test/fixtures/report-01.json and edits-01.json, so build against those.

The promise you are implementing is that the pasted CSS reproduces exactly what the user saw in the preview, on a machine without this extension. Four targets: stylus (primary, full fidelity), overrides (for DevTools Local Overrides), flat (for the DevTools inspector stylesheet, which cannot hold at-rules — strip conditions and annotate every one you dropped), and patch (best-effort source suggestion, clearly labelled).

Rules that carry the fidelity guarantee. Reproduce condition chains verbatim from ConditionRef[] — never reconstruct a media query from your own reading of it, because an unwrapped dark-mode override also fires in light mode. Emit unlayered, deliberately: an unlayered declaration beats every layered one, and an exported @layer is a footgun the user will not diagnose. Carry the preview's selector doubling into the export, because preview and export must agree. Group edits by scope selector plus condition chain so ten token edits in one context become one rule. Emit deterministic, stably-ordered, stably-formatted output so a golden diff means a real change.

Default to the authored colour syntax with a toggle to computed — a designer pasting oklch() into a hex codebase gets told about it in review, and that is our fault, not theirs.

Be honest in the output itself: every file ends with a comment block naming each edit that could NOT be exported and why (inline-only rung, closed shadow root, UA-styled internal). A silently incomplete stylesheet is the worst thing this workstream can produce.

Done when: golden files exist for edit sets over fixtures 01-11; every file carries the /*!tokenlens-session v1 header and the machine-readable session sidecar from §12.4 so a paste can be re-imported; docs/export-targets.md documents each target's limitations; and you have built (not run) the round-trip comparison harness that WS-8 will use at Gate 2 — preview on, capture computed styles, preview off, paste export into a fresh load, capture again, assert identical.
```

---

### WS-5 — Overlay and picker

**Mission.** The in-page hover highlight, click-to-select, and multi-select, robust on hostile pages and fast enough to feel native.

**Owns.** `src/content/index.ts`, `src/content/overlay/**`, `test/browser/overlay.spec.ts`, `test/perf/overlay.spec.ts`.

**Deliverables.** A `<tokenlens-root>` custom element holding a **closed** shadow root, with `all: initial` on the internal wrapper so page CSS cannot reach in, promoted to the top layer via `popover="manual"` + `showPopover()` so it defeats any `z-index` the page can invent (D15, S3). Keep every layer inside one host: four edge divs plus a label, `pointer-events: none`, `contain: layout style size`, transforms only — never `top`/`left`/`width`/`height`, which cost layout on every pointer move.

Picking: `document.elementFromPoint` during hover, `composedPath()[0]` on click so shadow-DOM internals resolve to the real target (open roots only; closed roots stop at the host, H/§6.3 — label it). Swallow the page's handlers during pick mode with capture-phase listeners on `pointerdown`, `pointerup`, `click`, `mousedown`, `mouseup`, `contextmenu`, `keydown`, all `{capture: true}` and all registered through one `AbortController` so exiting pick mode cannot leak a single listener. `Escape` exits. Hold-modifier walks up the ancestor chain; `[`/`]` walk the tree; `Shift`-click adds to a multi-select set for comparing token usage across elements.

One **self-idling** rAF loop for the whole overlay — not one per tracked element. It runs while pick mode is active or a tracked rect is changing, and stops itself after N idle frames, restarting on scroll, resize, or a `ResizeObserver`/`IntersectionObserver` signal. A permanently-running rAF loop in a content script is a battery complaint and a Web Store review question. `getBoxQuads` is not available, so use `getBoundingClientRect` plus `getClientRects` for inline and wrapped boxes, and draw one outline per rect rather than one bounding box around a wrapped link.

Cross-frame: with `all_frames: true`, each frame draws in its own viewport and reports its own `frameId` — no coordinate translation, which is the whole reason for that choice. The top frame renders a labelled "iframe boundary — token scope ends here" affordance for cross-origin children (§6.3).

**Acceptance.** Fixture 06: the overlay is visible above a `z-index: 2147483647` page overlay, and a click in pick mode does not trigger the page's own click handler (assert the page handler's call count is zero). Fixture 12: hovering inside a same-origin iframe highlights correctly; a cross-origin iframe shows the boundary affordance instead of a wrong highlight. Perf: hover-to-highlight ≤ 8 ms p95 on fixture 07, no dropped frames during a 2-second continuous hover sweep, and the rAF loop is provably stopped 500 ms after pick mode exits. Exiting pick mode leaves zero listeners attached — assert via `getEventListeners` in a CDP-enabled Playwright session or by an instrumented counter.

**DoD.** No page-visible side effects after teardown: no leftover nodes, no leftover attributes, no leftover listeners, and a passing "page is pristine" assertion.

```AGENT PROMPT
You are WS-5 on the Tokenlens project — the in-page overlay and element picker. Read §4, §5 (ElementRef, RectLike, ElementMeta), §6.3 (platform walls), §11 (budgets), and the WS-5 subsection of §9.

Build the hover highlight, click-to-select, ancestor walking and multi-select. It has to survive hostile pages and feel native.

Structure: a <tokenlens-root> custom element with a CLOSED shadow root, all:initial on the inner wrapper, promoted to the top layer with popover="manual" plus showPopover() so no page z-index can beat it. One host holding four edge divs and a label; pointer-events:none; contain:layout style size; animate with transforms only — never top/left/width/height, which force layout on every pointer move.

Picking: elementFromPoint on hover, composedPath()[0] on click so open shadow-DOM internals resolve to the real node. Swallow the page's own handlers in pick mode with capture-phase listeners on pointerdown/up, mousedown/up, click, contextmenu and keydown, every one registered through a single AbortController so exiting pick mode cannot leak a listener. Escape exits, a held modifier walks ancestors, [ and ] walk the tree, Shift-click adds to a multi-select set.

Use ONE self-idling rAF loop for the entire overlay, not one per element. It runs while pick mode is active or a rect is moving, stops itself after a few idle frames, and restarts on scroll, resize, or a ResizeObserver/IntersectionObserver signal — a content script with a permanently running rAF loop is a battery complaint and a Web Store review question. getBoxQuads does not exist here: use getBoundingClientRect plus getClientRects and draw one outline per rect, so a wrapped inline link gets two outlines rather than one wrong bounding box.

With all_frames:true each frame draws in its own viewport and reports its own frameId, so you never translate coordinates. For cross-origin children the top frame draws a labelled "iframe boundary — token scope ends here" affordance instead of a guess.

Done when: on fixture 06 your overlay sits above a z-index:2147483647 page overlay and a pick-mode click leaves the page's own click handler call count at zero; on fixture 12 a same-origin iframe highlights correctly and a cross-origin one shows the boundary affordance; hover-to-highlight is under 8 ms p95 on fixture 07 with no dropped frames across a 2-second hover sweep; the rAF loop is provably stopped 500 ms after pick mode exits; and after teardown the page is pristine — zero leftover nodes, attributes or listeners, asserted, not assumed.
```

---

### WS-6 — Panel UI and the editing surfaces

**Mission.** The whole visible product: the token list, the alias chain, the cascade story, the meta panel, and — the part that makes it a design tool — a set of editors where changing a value is one gesture and the page responds under your finger.

**Owns.** `src/panel/**`, `src/sidebar/**`, `src/popup/**`, `src/ui/**`, `test/browser/panel/**`.

**Builds against mocks.** You do not wait for anyone. `mock-transport.ts` replays a recorded envelope log and `report-01.json` gives you a real report shape. Import **nothing** from `src/core/` or `src/content/`; you consume `model.ts` types and emit `Edit` objects over `Transport`.

#### 9.6.1 Information architecture

Eight regions, laid out per §13. Region ordering is a product decision, not a layout preference: the answer to "which token is this" must be above the fold at the default DevTools panel height, and the export must be reachable without scrolling past the editors.

A = selection breadcrumb with the flattened tree path and shadow-boundary markers. B = the token list grouped by category (colour, typography, shadow, spacing, radius, border, motion, z-index), each row showing token name, a swatch or a rendered preview, the terminal value, the consumer count, and an edit affordance. C = the alias chain for the selected row, rendered as a horizontal chain with each hop's declaring selector and sheet, `status` per hop, and the winning declaration marked. D = the cascade story: who won, who lost, and **why** in one sentence per loser ("lost on layer order", "lost on specificity 0-2-1 vs 0-3-0", "IACVT: cycle"). E = the editors (§9.6.2). F = the meta panel: tag, computed role, dimensions, box model, a11y name and role, contrast pair result, fonts actually used, pseudo-element rows, framework hints if any. G = the diff / edit list: every active edit with its scope, rung, consumer count, and a one-click revert. H = export, with target selector, live preview of the CSS text, copy button, and the honest "N edits could not be exported" notice.

Diagnostics are never hidden behind a disclosure. A `confidence` of anything but `certain` renders an inline marker on the affected row with the diagnostic's plain-English text on hover. The product's first virtue is truthfulness (§1) and a UI that buries uncertainty defeats the resolver's entire self-check design.

#### 9.6.2 The editors — one gesture each

Every editor writes through `Transport` on every input event, with no apply button, and reflects the page's verified read-back rather than the value it hopefully sent. If the write was rejected or escalated, the editor shows it immediately.

**Colour.** One click on a swatch opens the picker inline (not a modal — a modal in a 400 px DevTools panel is a dead end). OKLCH plane plus hue slider plus alpha, with the impossible-chroma region greyed rather than clamped (WS-2 supplies the boundary). A text field accepting any CSS colour syntax. An EyeDropper button (S7; fall back to the content-script picker if a DevTools panel cannot render the native overlay). Document-palette swatches harvested from the token table, so "make this the same blue as the nav" is two clicks. Drag anywhere in the plane updates the page in the same frame.

**Numbers with units** — spacing, radius, border width, font size, line height. Every numeric field is a drag handle: horizontal drag scrubs, `Shift` ×10, `Alt` ×0.1, arrow keys step, and the unit is a separate segmented control so px↔rem↔em is not a text edit. The page moves while the pointer is down.

**Shadow.** A layer list, because `box-shadow` is one comma-separated list property and not a shorthand (H13). Per layer: x, y, blur, spread as numeric drag handles, colour via the colour editor, inset toggle, reorder, duplicate, delete, and a live rendered preview chip. A `var()` that expands into several layers is shown as one origin row with its expanded layers beneath, read-only unless the user chooses to flatten — and flattening is an explicit, labelled action because it destroys the alias.

**Typography.** Family (with the fonts actually used by the element listed first), weight, size, line height, letter spacing, and a rendered specimen line that uses the element's own text content. Show the resolved font stack alongside the token, because the token usually names a stack and the element usually renders one member of it.

**The scope control.** Above every editor, the three-segment token-global / token-scoped / element-local control from §9.3.1, each segment labelled with its live consumer count. This is the single most important control in the UI and it must never be hidden or collapsed.

Keyboard: `Esc` cancels a drag, `Cmd/Ctrl+Z` and `Shift+Cmd/Ctrl+Z` undo and redo, `Cmd/Ctrl+C` in region H copies the export, `/` focuses token search. Every editor is reachable and operable from the keyboard; a drag-only control is a bug.

#### 9.6.3 Theming and shell constraints

Match the DevTools host theme by reading `chrome.devtools.panels.themeName` and reacting to it; a panel that is light inside a dark DevTools reads as broken. React 18+ with `useSyncExternalStore` over the transport store, or a small store of your choice — but state must be serialisable, because the panel is destroyed and recreated when DevTools closes and the session restores from `chrome.storage.session` keyed by `documentId` (D14). Virtualise the token list; a design-system page has hundreds of tokens and region B must stay at 60 fps.

**Acceptance.** The full UI is navigable and every editor functional against `mock-transport` with the extension unloaded — i.e. as a plain Vite page in a browser tab, which is also how you test it fast. Playwright tests drive each editor and assert the emitted `Edit` objects match expected shapes. A 400-token report renders and scrolls at 60 fps. Panel reopen after DevTools close restores selection, edits, and scroll position. Axe-clean on the panel document; visible focus rings; no colour-only state encoding.

**DoD.** No import from `core/` or `content/` except types. Screenshots of all eight regions in `docs/ui/`. A recorded envelope log committed so the mock stays realistic.

```AGENT PROMPT
You are WS-6 on the Tokenlens project — the panel UI and every editing surface. Read §5 (all types), §13 (panel IA spec), §9.3.1 (the three edit scopes) and §9.6 (your subsection). You may also read §1 for the product's priorities.

You build the entire visible product and you build it against mocks, so you never wait for another workstream: src/adapters/mock-transport.ts replays a recorded envelope log, and test/fixtures/report-01.json is a real report. Import NOTHING from src/core/ or src/content/ beyond types from model.ts. You consume reports and emit Edit objects over Transport.

Two halves. The reading half is eight regions per §13: selection breadcrumb, token list by category, alias chain with per-hop status and the winning declaration marked, the cascade story with a one-sentence reason each loser lost, the editors, the element meta panel, the active-edit list with per-edit revert, and export. The writing half is the editors, and they are what make this a design tool rather than an inspector.

Every editor writes through Transport on every input event — no apply button, ever — and displays the verified read-back from the page rather than the value it hoped it sent, so a rejected or escalated write shows up instantly. Colour: one click opens an inline OKLCH picker (never a modal; a modal in a 400px panel is a dead end), with the impossible-chroma region greyed rather than clamped, a free-text CSS colour field, EyeDropper, and document-palette swatches harvested from the token table. Numbers: every numeric field is a drag handle — horizontal scrub, Shift ×10, Alt ×0.1, arrows to step, unit as a segmented control rather than a text edit. Shadow: a layer list, because box-shadow is one comma-separated list property and not a shorthand; per layer x/y/blur/spread as drag handles, colour, inset, reorder, duplicate, delete, live chip. Typography: family with the element's actually-used fonts first, weight, size, line height, letter spacing, and a specimen line rendered with the element's own text.

Above every editor put the three-segment scope control (token-global / token-scoped / element-local), each segment labelled with its live consumer count — "moves 41 / 12 / 1 elements". That control is the most important thing in the UI: it is how a designer sees blast radius before committing. Never hide or collapse it.

Never bury uncertainty. Any confidence below 'certain' renders an inline marker on the affected row with plain-English diagnostic text — the resolver deliberately self-reports when it might be wrong, and a UI that hides that defeats the design.

Match the DevTools theme via chrome.devtools.panels.themeName. Keep state serialisable: the panel is destroyed when DevTools closes and restores from chrome.storage.session keyed by documentId. Virtualise the token list — design-system pages have hundreds of tokens.

Done when: the whole UI works against mock-transport as a plain Vite page with the extension unloaded; Playwright tests drive every editor and assert the emitted Edit shapes; a 400-token report scrolls at 60 fps; reopening the panel restores selection, edits and scroll; every editor is fully keyboard-operable (a drag-only control is a bug); and the panel is axe-clean with visible focus rings and no colour-only state. Commit screenshots of all eight regions to docs/ui/.
```

---

### WS-7 — Transport, background router, DevTools shell

**Mission.** Make messages arrive, exactly once, across a service worker that dies every thirty seconds.

**Owns.** `src/background/**`, `src/devtools/**`, `src/adapters/chrome-port.ts`, `test/e2e/transport.spec.ts`.

**Deliverables.** `chrome-port.ts` implementing `Transport` over `chrome.runtime.connect` with the tab id encoded in the port name (`tokenlens-devtools:<tabId>`), because a DevTools page has no `sender.tab` (§4 rule 3). The background worker is a **stateless router** (§4 rule 2): it pairs ports by tab id, forwards envelopes, and holds no session state — anything it needs to remember goes to `chrome.storage.session`. Reconnect with exponential backoff on `onDisconnect`, and replay of unacknowledged envelopes on reconnect; every handler must be idempotent on `Envelope.id` because replay will deliver duplicates (§5). Programmatic content-script injection via `chrome.scripting.executeScript` when the content script is absent — with the injected-state handshake, since a script injected into an already-loaded page must not double-register listeners. Frame routing by `frameId`, and document identity by `documentId` so a same-URL navigation invalidates the session (D14). Protocol version negotiation on connect: a panel and content script from different builds must refuse to talk and say so, rather than misbehaving subtly.

The DevTools shell: `devtools_page`, `panels.create("Tokens")`, `panels.elements.createSidebarPane("Design Tokens")`, `panels.elements.onSelectionChanged`, and the `$0` read path via `inspectedWindow.eval` with `useContentScriptContext` per S1's answer. Wire `inspect(node)` for panel→Elements selection so the two surfaces stay in sync both ways. Handle the panel being destroyed and recreated on DevTools close, and the inspected page navigating under you.

**Acceptance.** `test/e2e/transport.spec.ts`: connect, exchange, kill the service worker (`chrome.runtime.reload` or an idle wait), assert automatic recovery with no lost envelopes. Two tabs open simultaneously with two DevTools panels never cross-deliver — this is the bug the tab-id-in-port-name design exists to prevent, so test it explicitly. A navigation mid-session produces a clean session invalidation, not a stale report. A version mismatch produces a visible, actionable error.

**DoD.** No business logic in `background/**` — if a future reader can tell what the product does from reading the router, the router is doing too much.

```AGENT PROMPT
You are WS-7 on the Tokenlens project — transport, the background router and the DevTools shell. Read §4 (architecture and its three rules), §5 (protocol.ts), §3 (D1, D14), §7 (spikes S1, S2, S9) and the WS-7 subsection of §9.

Build src/adapters/chrome-port.ts implementing the Transport interface over chrome.runtime.connect, with the tab id encoded in the port name as tokenlens-devtools:<tabId> — a DevTools page has no sender.tab, so this is the only way the router can pair ports.

The background service worker is a stateless router and nothing else. It pairs ports by tab id and forwards envelopes. Anything it would want to remember goes to chrome.storage.session, because MV3 kills it after ~30 seconds idle. Implement reconnect with exponential backoff on onDisconnect and replay of unacknowledged envelopes — which means every handler must be idempotent on Envelope.id, since replay will deliver duplicates. Do not route resolver reads through the worker at all: those go panel→page via inspectedWindow.eval (§4 rule 1).

Also: programmatic injection via chrome.scripting.executeScript when the content script is missing, with an injected-state handshake so a script injected into an already-loaded page does not double-register listeners; frame routing by frameId; document identity by documentId so a same-URL navigation invalidates the session; and protocol version negotiation on connect so a panel and content script from different builds refuse to talk instead of misbehaving subtly.

Then the DevTools shell: devtools_page, panels.create("Tokens"), panels.elements.createSidebarPane("Design Tokens"), onSelectionChanged, the $0 read path via inspectedWindow.eval (use WS-S's S1 answer for whether useContentScriptContext works; if it is unanswered, implement both paths behind a flag), and inspect(node) for panel→Elements selection so both surfaces stay in sync.

Done when: test/e2e/transport.spec.ts connects, exchanges, kills the service worker, and recovers with zero lost envelopes; two tabs each with their own DevTools panel never cross-deliver (test this explicitly — it is the exact bug the port-name design exists to prevent); a mid-session navigation cleanly invalidates rather than showing a stale report; and a protocol version mismatch produces a visible, actionable error. Keep all business logic out of background/** — if a reader can tell what the product does from the router, the router does too much.
```

---

### WS-8 — Integration

**Mission.** Merge seven branches into one working extension and prove the end-to-end promise on a real page.

**Owns.** Merge commits, `test/e2e/**`, and glue only where a seam is genuinely missing. May not rewrite another workstream's logic — files a CR instead.

**Work.** Merge in the §8.4 order, running the full suite after each merge and attributing any failure to the just-merged branch. Apply accepted change requests to `model.ts` in one commit and broadcast. Then build the four end-to-end tests that are the actual product:

1. **Pick → report.** Load fixture 01, open DevTools, select the primary button, assert the panel shows the expected token rows with the expected alias chains.
2. **Live edit.** Drag the colour picker; assert the page's computed colour changes within one frame and that the consumer count matches the number of elements that actually changed (query and compare — this is the claim the UI makes and it must be true).
3. **Round-trip fidelity.** Capture computed styles for 50 elements with preview on; remove the preview; assert the page returns to its original computed styles exactly; paste the exported CSS into a fresh page load with the extension **disabled**; capture again; assert identical to the preview capture. This test is the product's central promise and it is the one test that must never be skipped or marked flaky.
4. **Pixel check.** Screenshot-clip a 1×1 region of the edited element before and after, decode with pngjs, and assert the sampled pixel matches the intended colour within tolerance — because a computed-style match with a wrong paint is a real failure mode (compositing, blend modes, opacity ancestors).

Then hardening: run the extension against five real sites with published design systems (a Tailwind v4 site, a Material site, a Shopify Polaris or similar, a site using CSS-in-JS with hashed classes, and a site using web components), record what broke in `docs/field-notes.md`, and convert each break into a fixture or a diagnostic. A break that becomes neither is a break that will recur.

**DoD.** All §11 budgets met with numbers recorded. Gate 2 declared with a written statement of what works and what does not.

```AGENT PROMPT
You are WS-8 on the Tokenlens project — integration. Read the whole document; you are the only agent who should.

Merge the seven Wave 1 branches in this order, because it is the order in which a bad merge is cheapest to diagnose: ws/2 colour, ws/4 export, ws/3 selector+apply, ws/1 resolver, ws/7 transport, ws/5 overlay, ws/6 panel. Run the full suite after each merge and attribute any failure to the branch you just merged, returning it to its owner rather than fixing it in place — you are not allowed to rewrite another workstream's logic. Apply accepted change requests to model.ts yourself, in one commit, and broadcast the change.

Then build the four end-to-end tests that are the actual product. (1) Pick to report on fixture 01. (2) Live edit: drag the picker, assert the page's computed value changes within one frame AND that the consumer count the UI displays equals the number of elements that actually changed — query and compare, because that number is a claim we make to the user. (3) Round-trip fidelity: capture 50 elements' computed styles with preview on, remove the preview and assert the page is byte-for-byte original again, then paste the exported CSS into a fresh page load with the extension DISABLED and assert the capture matches the preview capture. This third test is the product's central promise; it must never be skipped, quarantined, or marked flaky. (4) Pixel check: 1×1 screenshot clip before and after, decoded with pngjs, asserting the actual painted pixel — a computed-style match with a wrong paint is a real failure mode via compositing, blend modes and opacity ancestors.

Then harden against five real sites with published design systems: a Tailwind v4 site, a Material site, a Polaris-style enterprise app, a CSS-in-JS site with hashed classes, and a site built on web components. Record every break in docs/field-notes.md and convert each into either a fixture or a diagnostic — a break that becomes neither will recur.

Done when all §11 budgets are met with recorded numbers and you have declared Gate 2 with a written, specific statement of what works and what does not.
```

---

### WS-9 — Audit view

**Mission.** Zoom out from one element to the whole page: the token inventory, and where the design system is not being followed.

**Owns.** `src/core/audit/**`, `src/panel/audit/**`, `test/unit/audit/**`. Wave 2, because it consumes WS-1's reverse index and WS-2's ΔE.

**Deliverables.** A page-wide token inventory: every token, its declaring scopes, its terminal value, its consumer count, grouped by category and sorted by usage. A **hardcoded-value finder**: declarations whose value is a literal that is within ΔE_OK of an existing colour token, or within a tolerance of an existing spacing/radius/shadow token — i.e. "this `#3b82f6` should be `--blue-500`", which is the single highest-value report for a design-systems engineer and the reason this workstream exists. An **orphan finder**: tokens declared but consumed by nothing on this page, flagged as page-scoped rather than globally unused, because a page is not the whole app and overclaiming here destroys trust. A **near-duplicate finder**: token pairs within ΔE_OK < 2, which is how palettes quietly grow to 40 blues. Contrast pairs computed for actual text-on-background pairings found in the DOM, WCAG 2.x primary and APCA informative. Export of the whole inventory as JSON and CSV.

Performance: the audit walks the document, so it is explicitly a user-triggered action with progress and cancellation, not something that runs on selection. Budget ≤ 3 s on fixture 07 and it must remain cancellable throughout.

**Acceptance.** On fixture 13 (a realistic design-system page with deliberate violations), the audit finds every planted hardcoded value, every planted near-duplicate, and every planted orphan, with zero false positives on the clean parts. Document the tolerance you chose per category and why.

```AGENT PROMPT
You are WS-9 on the Tokenlens project — the page-wide audit view. Read §5, §9's WS-9 subsection, and §11. You run in Wave 2 and consume WS-1's reverse index and WS-2's ΔE functions, which now exist.

Build the zoomed-out view: a full token inventory for the page (every token, its declaring scopes, terminal value and consumer count, grouped by category and sorted by usage), plus four finders. The hardcoded-value finder is the most valuable thing in this workstream — declarations whose literal value is within ΔE_OK of an existing colour token, or within tolerance of an existing spacing/radius/shadow token, reported as "this #3b82f6 should be --blue-500". The orphan finder lists tokens declared but consumed nowhere on this page, and must be labelled page-scoped rather than unused, because a page is not an app and overclaiming here destroys the user's trust in every other number we show. The near-duplicate finder reports token pairs within ΔE_OK < 2, which is how a palette quietly grows to forty blues. And compute contrast for the actual text-on-background pairings present in the DOM, WCAG 2.x as primary with APCA informative.

The audit walks the whole document, so make it explicitly user-triggered with visible progress and working cancellation — never run it on selection change. Budget is 3 seconds on fixture 07, cancellable throughout. Export the inventory as JSON and CSV.

Done when fixture 13 — a realistic design-system page with deliberately planted violations — yields every planted hardcoded value, near-duplicate and orphan, with zero false positives on the clean parts, and you have documented the tolerance you chose per category and the reasoning behind it.
```

---

## 10. Fixture matrix

WS-0 builds these as static HTML under `test/fixtures/`. They are the shared vocabulary of the whole project: every hazard in §6 points at one, every acceptance test names one, and a bug report that cannot be expressed as a fixture is not yet understood.

| # | Fixture | Exercises | Primary owner |
|---|---|---|---|
| 01 | `01-basic.html` | `:root` tokens, one alias hop, a button, a `::before`, semantic classes | everyone; the smoke fixture |
| 02 | `02-shorthands.html` | `font`, `border`, `background`, `box-shadow` with multiple layers, `var()` inside shorthands → pending-substitution (H12, H13) | WS-1 |
| 03 | `03-broken.html` | Cycles, missing tokens, empty `--x:;`, IACVT, fallback chains 8 deep, a 60-deep chain to trip the cap (H2, H3, H18) | WS-1 |
| 04 | `04-layers.html` | Four `@layer`s, `@layer` statement ordering, unlayered declarations, `!important` in the earliest layer (H4) | WS-1 |
| 05 | `05-tailwind-v4.html` | Tailwind v4 output shape: `@layer theme, base, components, utilities`, `@property` registrations, `oklch()` tokens, utility classes | WS-1, WS-2 |
| 06 | `06-hostile.html` | `!important` on everything, inline styles set by script, a `MutationObserver` that reverts attribute changes, `z-index: 2147483647` overlay, `pointer-events` traps, a click handler that counts calls | WS-3, WS-5 |
| 07 | `07-heavy.html` | 5,000 elements, 300 tokens, 12 stylesheets, ~8,000 rules — the perf fixture for every budget in §11 | WS-1, WS-5, WS-9 |
| 08 | `08-shadow.html` | Open and closed shadow roots, `adoptedStyleSheets`, `::part()`, slotted content, tokens inherited across the boundary, a root that reassigns `adoptedStyleSheets` after 2 s (H5, H24, H27) | WS-1, WS-3 |
| 09 | `09-cross-origin.html` | A stylesheet from a different origin (served by the fixture server on a second port) plus an `@import` chain (H6, H7, H8) | WS-1 |
| 10 | `10-case-and-escapes.html` | `--foo` vs `--FOO`, escaped identifiers, unicode token names, tokens with quotes and commas in values (H17) | WS-1, WS-4 |
| 11 | `11-registered.html` | `@property` with `inherits:false`, `<color>`/`<length>`/`<number>` syntaxes, a transition on a registered property, a `CSS.registerProperty` call from script (H9, H10, H11, H26, H28) | WS-1, WS-3 |
| 12 | `12-frames.html` | Same-origin iframe, cross-origin iframe, `srcdoc` iframe, sandboxed iframe without `allow-scripts` | WS-5, WS-7 |
| 13 | `13-design-system.html` | A realistic themed page: light/dark via both `[data-theme]` and `prefers-color-scheme`, ~80 tokens, and **deliberately planted** hardcoded values, near-duplicate tokens, and orphans | WS-9 |

Two standing rules. Fixtures 03, 09 and 11 must produce diagnostics — a clean report on those is a test failure, not a pass. And the fixture server serves fixture 09's second origin on a separate port with real CORS headers; faking cross-origin with a mock defeats the only thing that fixture tests.

---

## 11. Performance budgets and CI

### 11.1 Budgets

Enforced in `test/perf/**`, written to `perf-results.json`, and failed in CI on regression. Measured on fixture 07 unless stated.

| Metric | Budget | Why this number |
|---|---|---|
| Hover highlight → painted overlay | ≤ 8 ms p95 | Anything slower reads as lag on a 120 Hz display. |
| Pointer move → painted page change during a drag | ≤ 16 ms p95 | One frame. This is the whole "real-time" claim. |
| Element pick → full report rendered | ≤ 150 ms p95 | Above ~200 ms the interaction stops feeling like inspection and starts feeling like a query. |
| Cold stylesheet index | ≤ 400 ms | Once per page, hidden behind the first pick. |
| Warm re-resolve after a mutation | ≤ 50 ms | Theme toggles and re-renders must not stutter. |
| Token override applied → paint | ≤ 16 ms | Same frame as the input. |
| Export generation (≤ 50 edits) | ≤ 100 ms | Feels instant on copy. |
| Full-page audit | ≤ 3 s, cancellable | User-triggered, with progress. |
| Overlay idle CPU | ~0% after 500 ms idle | The rAF loop must genuinely stop (WS-5). |
| Content script bundle | ≤ 60 kB gzipped | It is injected into every page on every load. |
| Panel bundle | ≤ 350 kB gzipped | Lazy-load the audit view and the picker. |
| Colour module | ≤ 12 kB gzipped | Enforces the `culori/fn` import discipline (WS-2). |
| Memory after 100 picks | no unbounded growth | Caches are keyed by `documentId` and must be evicted. |

### 11.2 Required checks

Every branch: `typecheck`, `lint` (including the `core/` boundary rules), `test` (Node), `test:browser` (Vitest browser mode, Chromium), `size-limit`. Additionally on integration branches: `test:e2e` (Playwright, persistent context, non-headless, `xvfb-run` on Linux) and `test:perf` with regression comparison against the committed baseline.

Two CI rules that exist because of specific failure modes. First, a lockfile grep that fails the build if `jsdom` or `happy-dom` appears anywhere: neither implements the cascade, neither supports `adoptedStyleSheets` or `@layer` faithfully, and a resolver test running on them would pass while being wrong — which is the exact failure this project cannot tolerate. Second, `--update-snapshots` is forbidden in CI and discouraged locally; a changed golden is either a bug or an intentional change that belongs in a commit message with a reason.

Pin the Chrome/Chromium version in CI and record it in `perf-results.json`, because a budget measured on a different milestone is not comparable, and because Playwright's bundled Chromium typically runs ahead of stable (WS-S).

---

## 12. Export format specification

### 12.1 What the export must guarantee

A person with no extension installed, pasting this text, sees what the editing user saw. That single sentence is why the preview is author-origin (D7), why conditions are copied verbatim (H22), why the export is unlayered (D10), and why selector doubling appears in the output. Every one of those decisions is downstream of the guarantee, so none of them may be "simplified" without breaking it.

### 12.2 Targets

`stylus` is primary and full-fidelity: complete at-rule nesting, comments, grouping, the session sidecar. It works in Stylus, Stylebot, any user-stylesheet extension, and as a file in a codebase.

`overrides` targets Chrome DevTools → Sources → Overrides, which persists across reloads and is the honest answer to "I want this to stick". Same content as `stylus`, plus a header comment explaining the three-step setup, since most users have never enabled Overrides.

`flat` targets the DevTools **inspector stylesheet** — the thing the original request called "the inspect element custom stylesheet page". Per spike S11 this surface is a per-declaration editor that does not survive reload, so `flat` mode strips at-rules, resolves the current condition state (current theme, current viewport) into unconditional declarations, and appends a comment listing exactly which conditions were flattened away and what that costs. It is labelled "temporary" in the UI. If S11 comes back saying at-rules paste fine and survive reload, `flat` becomes a thin wrapper over `stylus` and the UI stops calling it temporary.

`patch` is a best-effort suggestion of where in the source this belongs, keyed on `CSSStyleSheet.href` and the declaring selector. Labelled best-effort; never presented as a diff that can be applied blindly.

### 12.3 Example output

```css
/*!tokenlens-session v1
 * url: https://app.example.com/dashboard
 * generated: 2026-09-22T10:14:03Z
 * tool: tokenlens 0.1.0 · chrome 141
 * edits: 4 (4 exportable, 0 preview-only)
 * paste target: stylus / user stylesheet
 */

/* --brand-500 · token-global · moves 41 elements
 * was: oklch(62% 0.19 258)  declared in :root @ theme.css:12 (layer theme)
 */
:root:root {
  --brand-500: oklch(58% 0.21 262);
}

/* --brand-500 · dark scope · declared in [data-theme="dark"] @ theme.css:84 */
[data-theme="dark"]:root {
  --brand-500: oklch(71% 0.16 258);
}

@media (prefers-color-scheme: dark) {
  /* verbatim condition from the declaring rule — do not merge with the scope above */
  :root:root {
    --brand-500: oklch(71% 0.16 258);
  }
}

/* --space-4 · element-local · [data-testid="card-header"] · matched 1 of 1 intended
 * rung: doubled (plain rule lost to .card-header specificity 0-2-0)
 */
[data-testid="card-header"][data-testid="card-header"] {
  --space-4: 20px;
}

/* NOT EXPORTED (1)
 * · color on <input> internal (UA shadow DOM) — preview only, no author-origin selector exists
 */
```

### 12.4 Session sidecar

Alongside the CSS, a JSON blob (copied separately, or embedded as a base64 comment at the user's option) containing `PROTOCOL_VERSION`, the URL, the timestamp, and the full `Edit[]`. Pasting it back into the panel restores a session, which is how a designer hands work to an engineer, and how the tool recovers a session it could not keep in `chrome.storage.session`. The CSS sentinel `/*!tokenlens-session v1` lets the tool recognise its own previous output and offer to re-import instead of double-applying.

---

## 13. Panel IA specification

Default DevTools panel is short and wide; the sidebar pane is narrow and only height-adjustable. Design for the short-and-wide case and let the tall case breathe.

Region priority, in order of what must be visible without scrolling: the selection breadcrumb (A), the token list (B), the scope control and active editor (E), and the alias chain for the focused token (C). The cascade story (D) is one collapsed line per loser that expands on demand — it is essential when it is needed and noise when it is not. Element meta (F) sits in a second column at wide widths and a collapsed section at narrow ones. The active-edit list (G) and export (H) pin to the bottom as a persistent bar showing edit count and a copy button, expanding into the full export view. Region B is the only scroll container in the normal case; nested scroll areas in a 300 px-tall panel are how tools become unusable.

At sidebar-pane width the layout collapses to A + B only, with each row deep-linking into the full panel via `ExtensionPanel.show()` — the sidebar's job is "which tokens are here", not editing.

Interaction grammar, consistent everywhere: single click selects, double click edits, drag scrubs any number, `Esc` cancels, every row has a revert affordance once edited, and every uncertain value carries an inline marker. Nothing important is behind a hover-only affordance, because a designer on a trackpad mid-drag cannot hover something else.

---

## 14. Risk register and kill criteria

| Risk | Signal it is happening | Response | Kill criterion |
|---|---|---|---|
| The hand-rolled cascade is wrong in ways fixtures do not catch | CDP-oracle agreement below ~95% on fixtures 01–08, or field notes showing wrong winners on real sites | Add the failing case as a fixture; consider shipping `resolverMode: 'hybrid'` where the user can opt into a CDP session with DevTools closed | If agreement stays below 90% after two rounds of fixes, stop and reconsider D2 — a beautiful UI over an untrustworthy resolver is worse than no product |
| CRXJS version churn eats days | More than half a day lost to Vite peer ranges or HMR breakage | Switch to WXT (D5); the source tree is designed to survive the swap | — |
| Real-time preview cannot hit 16 ms on heavy pages | Fixture 07 budget missed by >2× | Reduce scope of re-resolution during drag: mutate only the edited property, defer consumer recount to pointerup | If a single `setProperty` on an adopted sheet cannot paint in a frame on fixture 07, the "no apply button" promise needs a documented exception for heavy pages — state it rather than shipping a laggy drag |
| Export does not round-trip on real sites | WS-8's test 3 fails on field sites but passes on fixtures | Treat each failure as a missing hazard; the usual causes are unreproduced conditions and layer assumptions | If round-trip cannot be made reliable, reframe the export as "starting point" in the UI — but do not keep claiming fidelity we do not have |
| The DevTools inspector stylesheet turns out to be useless as a paste target | S11 confirms no persistence and no at-rules | Already mitigated: Local Overrides is primary (D11). Keep `flat` mode, keep it labelled temporary | — |
| Parallel agents diverge on `model.ts` | Two branches with different `model.ts` hashes at merge time | WS-8 reverts the unauthorised edit and applies it as a CR | — |
| Scope creep into a general CSS editor | Features appearing that are not about tokens | §2 is the answer; re-read it | — |

Honest framing of the biggest one: this project's value is concentrated in WS-1 being *correct*, and correctness there is unglamorous work against a cascade specification with genuinely surprising corners. If effort has to be traded, trade UI polish for resolver correctness, not the other way around.

---

## 15. Global definition of done, packaging, release

**The product is done when**, on a real third-party page nobody planned for: you pick an element and see its tokens with full alias chains and the winning declaration identified; every value carries a `confidence` and any uncertainty is visible rather than buried; you change a colour token and the page updates under your finger, with a consumer count that matches reality when checked; you change spacing, radius, shadow layers and typography with the same immediacy; you choose between changing the token everywhere, in one scope, or on one element, and can see the blast radius of each before committing; you copy a stylesheet, disable the extension, reload, paste it, and the page looks the way it did in the preview; every edit is individually revertible and removing the preview restores the page exactly; the walls (cross-origin frames, closed shadow roots, canvas, unreadable sheets) are named in the UI at the moment they bite; and all §11 budgets are met with recorded numbers.

**Packaging.** Two build modes. `dev` uses `<all_urls>` host permissions for frictionless local use (D13). `store` uses `activeTab` plus `optional_host_permissions` with an in-product permission request, because broad host permissions trigger the slowest Web Store review path — and per S9 the request may need to originate from an action popup or options page rather than a DevTools panel. Required permissions are `scripting`, `storage`, and `tabs`; `debugger` must never appear in a shipped manifest (D3). Set `minimum_chrome_version` from WS-S's observations, not from guesswork. Ship source maps for the panel only, never for the content script.

**Release checklist.** `docs/spikes.md` current; `docs/field-notes.md` listing every real site tested and what broke; `docs/export-targets.md` naming each target's limitations; `perf-results.json` committed with the Chrome version; a written list of known-unsupported surfaces (§6.3) shown in the UI as well as in the README; and a one-page README whose first paragraph is the product sentence at the top of this document, because if that sentence stops being true the project has drifted.

---

## Appendix A — Launch checklist for the human

1. Paste WS-0's `AGENT PROMPT` into one agent with `isolation: "worktree"`. Paste WS-S's into a second, concurrently.
2. When both report, read `docs/spikes.md` and apply any decision flips to §3. **Gate 1.**
3. Launch WS-1 through WS-7 in parallel, each with §4, §5, §6, §10, §11 plus its own `AGENT PROMPT`. Seven agents, seven worktrees, seven branches.
4. Collect CRs. Accept or reject. Have WS-8 apply accepted ones to `model.ts` in one commit.
5. Launch WS-8. It merges in the stated order and builds the four end-to-end tests. **Gate 2.**
6. Launch WS-9 alongside hardening. **Gate 3.** Ship.

If you only have budget for part of this, the minimum coherent product is WS-0 + WS-1 + WS-2 + WS-3 + WS-5 + WS-6 + WS-7: pick, resolve, edit live, no export. Adding WS-4 is what makes the work leave the browser, and it is cheap because it is pure. WS-9 is the highest-leverage thing to add after that, and the easiest to defer.
