# Release verification — TokenLens 0.1.2

Built as a usable local Chrome extension with source, a production `dist` folder, an optional-permission `dist-store` build, fixtures, tests and a browser UI demo. Practical implementation decisions are in `decisions.md`.

Final release checks (v0.1.2, 22 September 2026): **85 Node tests, 63 Chromium browser tests, and 16 Playwright extension/platform/performance tests passed**. Typecheck, lint, both production builds and shipped bundle-size checks passed.

## Release 0.1.2

This patch aligns the extension manifest, runtime display, website downloads and CSS export header with one release version. The CSS header previously retained an old version string; it now identifies the version that generated the export. Installation and update guidance explains the popup's connection role, the DevTools Tokens editor and how to reload an unpacked installation.

The release-content check passes for current links and rejects a deliberately stale download URL. CSS export tests verify the generated header uses the package version. The popup and narrow panel visibly show v0.1.2; the connected popup fits within Chrome’s 600px height.

The connection, Elements-selection recovery and source-tracing fixes from 0.1.1 are included. Historical release notes remain in [v0.1.0](releases/v0.1.0.md) and [v0.1.1](releases/v0.1.1.md); current changes are in [v0.1.2](releases/v0.1.2.md).

## Functional evidence

- Actual Chrome toolbar popup: connect a page already open before injection, confirm inspector readiness, close/reopen the popup, and retain the connected state. A separate real DevTools check selects an element before opening Tokens and verifies its token report appears without repicking, then selects an element inside an iframe and verifies the panel follows it.
- Popup browser tests cover direct user-gesture permission requests, declined access, missing background responses, protected pages, readiness recovery, and truthful manual DevTools guidance. Normal, connected and error states fit within Chrome's 600px popup height in visual checks.
- Chrome's `ExtensionPanel.show()` silently ignores popup/runtime-triggered calls in the tested Chromium build. Onboarding and sidebar actions therefore guide the user to select Tokens manually instead of reporting a false panel-opening success.

- Actual packaged extension: pick → token/alias report → live edit → verified computed color and sampled pixel.
- Preview removal restores 50 elements' captured styles exactly. Exported CSS reproduces the preview on a fresh page in a separate browser without the extension.
- Click suppression while picking, Escape cleanup, document navigation reset, tab separation and frame routing.
- Actual DevTools Tokens panel: selection from Elements, picker editing, export and revert. Service-worker execution context was genuinely stopped; page edits survived and panel editing resumed after reconnection.
- Optional-permission build: in a disposable test copy with only the local fixture origin granted, its production loader injects and a registered site script persists after reload. This is not a test of the native permission prompt.
- Source-tracing regressions confirm token editors and palette colors use browser-computed values when recovered declarations disagree, including valid empty results. Original declarations and alias chains remain available separately.
- Browser fixture coverage includes layers/important, cycles/missing aliases, shorthands, registered values, open shadow roots, cross-origin failures/recovery, undo/redo, session import, cascade-order export, hostile inline-important styles, theme verification and an audit with planted findings.
- Read-only captures on five public design-system sites are documented in `field-notes.md`, including failures and limitations. These were capture checks, not real-site export round-trip tests.

## Performance and size

Machine-specific raw measurements and browser version are in `perf-results.json`. Size measurements, including dependency closures, are in `bundle-sizes.json`. The measured large fixture has approximately 5,000 elements and 8,000 rules. The content-script dependency graph is about 24 kB gzip and the panel graph about 104 kB gzip. The color budget measures functions imported by the shipped UI; the complete standalone color API is also recorded separately.

Resolver warm latency, local preview apply plus computed-style verification, 50-edit export and cancellable page audit have automated budget assertions. Next-frame intervals are recorded separately: a ~16.7 ms display interval is **not** presented as proof of a strict ≤16 ms pointer-to-painted-pixel result. Cold capture can exceed 150 ms during initial page layout in concurrent tests, despite faster isolated measurements. Hover-to-paint latency is not measured. The memory check samples 100 picks after explicit garbage collection; it is not a claim of indefinite stability.

## Known limits

Consumer counts are explicitly estimated selector matches, not exact visual blast radii. The CDP comparison covers matched declaration presence, not complete cascade winner/order agreement. Shadow-internal and advanced scope/container provenance remain partial and can emit a mismatch; browser-computed values stay authoritative. Source confidence is conservatively aggregated across the inspected stylesheet scope, so an unrelated conditional rule can lower report confidence. Pseudo-elements are listed but do not yet have independent editing reports. Exact rendered-font identification, APCA, recursive cross-origin `@import` recovery and source-file patching are not implemented. See `resolver-verification.md` for precise limits.

Manual docked/undocked EyeDropper behavior, native optional-permission prompting and bulk paste into the DevTools declaration editor remain unverified. The synthetic inspector stylesheet's transient reload behavior was measured. Chrome 120 is the manifest API floor; actual platform probes ran on Chrome 153 and Chromium 143/149. No store publication or certification is claimed.

## Reproduce

`pnpm typecheck && pnpm lint && pnpm test && pnpm test:browser && pnpm build && pnpm size-limit && pnpm build:store && pnpm test:e2e`

Extension tests use disposable Chromium profiles; ordinary DOM/CSSOM tests use real Chrome. The CI workflow installs browsers and runs the headful extension checks under Xvfb. Public-site and extended spike scripts are under `test/oracle` and `test/spikes`.
