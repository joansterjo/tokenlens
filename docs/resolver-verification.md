# Resolver verification

The resolver reports the browser's computed values as authoritative. Provenance is CSSOM-derived and reports `probable` at best; unsupported conditions and mismatches downgrade it to `degraded`. It does not claim a universally exact implementation of the browser cascade.

## Reproduce

- `pnpm test -- test/unit/resolve` exercises the pure cascade, specificity, alias engine and saved Chromium captures.
- `pnpm test:browser -- test/browser/capture.test.ts` exercises live CSSOM capture against all 13 fixtures and targeted cascade edge cases.
- `node test/browser/capture-snapshots.mjs` regenerates all 13 real-Chrome report snapshots, the basic/layer sheet snapshots, a stable value summary, and `test/snapshots/perf.json`. This generator uses installed Google Chrome and a temporary local fixture server; it intercepts fixture09's foreign CSS request without adding CORS headers so CSSOM access really fails.

The current resolver suite contains 29 Node tests and 31 real-browser tests. The randomized alias test generates 150 cyclic graphs per run. Browser checks cover inherited alias evaluation at the declaring ancestor, important layer reversal, shadow-host context ordering, non-inheriting registrations, canonical typed aliases, missing and empty variables, IACVT without runner-up promotion, pending shorthands, preview origins, unreadable sheets, best-effort recovery, and nested/same-count CSSOM mutations.

Fixtures 01, 02, 04, 05 and 10 produce no probe mismatches. Fixture03 reports cycles, fixture09 reports unreadable sheets, and fixture11 reports JavaScript-only registration provenance. Selected computed property values are checked against the committed golden summary, and all report references are checked in Node.

## Measured performance

The committed measurement is from Google Chrome 153.0.8010.52 on this machine. Fixture07 has 8,016 style rules. Six rule candidates remain after conservative selector bucketing for the primary button, a reduction factor of 1,336.

Cold index: 39.1 ms. Complete cold capture: 62.7 ms. Warm selection p95 over 20 captures: 22.4 ms. Raw measurements and browser version are in `test/snapshots/perf.json`. Other cold runs during browser-test startup reached roughly 150–161 ms because the initial page style/layout computation was still pending. These measurements are machine-specific, and do not establish every performance budget in the build plan.

## Deliberate limits

- Consumer counts are bounded **estimates of selector matches**, always `truncated: true`. They can include losing declarations and omit inherited consumers, so the UI must show `~`, never a lower-bound sign or an exact blast-radius claim. Inspection does not walk and resolve every element on every selection.
- `@container` and `@scope` declarations are retained in sheet metadata but excluded from asserted winners because their conditions cannot be evaluated here. Visible diagnostics explain the resulting partial provenance.
- `:host` declarations and inheritance across open shadow roots are covered. Complex `:host` descendant selectors, `:host-context`, `::part`, `::slotted`, closed roots and browser internals are not fully traced. Pseudo-elements are identified in component metadata; they do not yet get independent token reports.
- Typed registered token substitution uses browser-computed values at the declaring element while retaining raw declaration text. Common `<color>`, `<number>` and `<length>` rejection cases are diagnosed; arbitrary registration grammar is not reimplemented.
- Registered properties declared through JavaScript have no CSSOM registration table. An otherwise unexplained computed custom property receives a diagnostic. We cannot prove the absence of invisible registrations.
- Cross-origin sheets can be recovered through `recoverStyleSheet(url, text, document)`, using a detached constructible sheet that is **never adopted**. Recovered sources keep `readable: false`, set `reparsed: true`, and explicitly warn that credential-free fetched content may differ from served content. `@import` or escaped at-rules in fetched content cause recovery rejection rather than silent import loss. Same-origin CSSImportRule trees are indexed normally.
- CSSOM text is normalized, not original file bytes. Shorthand provenance is retained, including pending substitutions, but synthetic longhands do not claim byte-exact source mapping. Layer, selector and declaration metadata have no fabricated line numbers.
- Token aliases and absolute/simple CSS values are checked against browser results. General contextual expressions (`calc`, relative units, modern color functions, percentages), pending shorthands and active animations are not all independently normalized by an isolated probe. Their displayed values still come directly from the browser. Every detected mismatch remains visible.
- Layer ordering, origin ordering, inline attachment, matching-branch specificity and context ordering are implemented. This is an author-CSS inspector: user/UA stylesheet provenance is not available from CSSOM. The root integration's separate CDP oracle measures the tested author-rule subset rather than all browser behavior.
- Indexing stops at 20,000 style rules, token inventory at 500 entries (selected-property references and aliases first), alias expansion at depth 50 or 500 nodes, and reverse scans at 600 rules / about 18 ms. Limits produce a partial report or explicitly estimated consumers. Stylesheet identity, nested rule identity/count, media and selectors are checked each pick; declarations are read live and the index periodically refreshes.
- Meta includes geometry, box model, font stack, layout role, approximate accessible name/role and pseudo presence. Exact rendered fonts and full accessibility-tree semantics are not claimed.
