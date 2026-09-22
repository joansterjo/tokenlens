# Public-site field notes

Actual read-only captures were run on **22 September 2026**, using **Google Chrome 153.0.8010.52** on macOS, at a 1440 × 1000 viewport. Every site used a disposable browser context and an isolated-world bundle built from the current resolver source. No login, clicks, edits, form submissions, or changes to external data occurred. This validates capture behavior, not live editing or exported-CSS fidelity on those sites. Extension background stylesheet recovery was deliberately absent from this adapter-only audit.

Raw timestamped results, selected CSS paths, sample token names, computed values and every diagnostic are in [`test/oracle/public-site-results.json`](../test/oracle/public-site-results.json). The final five-site audit began at 09:45 UTC. All five pages loaded; none is being counted as tested merely because a request was attempted.

| Site and actual URL | Selected element | Tokens shown / direct token references | Traced properties | Unreadable sheets | Capture time | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| [Tailwind CSS](https://tailwindcss.com/docs/colors) | Library-version button | 500 / 11 | 39 | 0 of 2 | 121.0 ms | Degraded |
| [Material Web](https://material-web.dev/components/button/) | Inner button in `md-filled-button`, “Filled” | 188 / 7 | 44 | 1 of 13 | 28.0 ms | Degraded |
| [Shopify Polaris documentation](https://shopify.dev/docs/api/polaris) | “Install AI Toolkit” button | 500 / 0 | 0 | 29 of 30 | 12.3 ms | Degraded |
| [Material UI / Emotion](https://mui.com/material-ui/react-button/) | “Contained” example button | 500 / 5 | 55 | 1 of 37 | 105.5 ms | Degraded |
| [Shoelace](https://shoelace.style/components/button) | Inner button of the main “Button” example | 431 / 10 | 42 | 0 of 9 | 47.5 ms | Degraded |

“Direct token references” counts distinct names in inspected property expressions; the token inventory also includes ancestors, aliases and unused in-scope variables. Counts of 500 hit the explicit inventory cap. These single-shot capture times are observations, not p95 performance measurements. “Traced” means a declaration was identified; it is not proof that every inferred winner was correct.

## What happened

**Tailwind:** The scope contained 501 variables. Twenty container-query diagnostics explained unavailable condition evaluation. Five undefined-token diagnostics described fallback paths. There were no probe mismatches on the selected version button. The large token inventory exposed a usability defect: browser enumeration order could put directly used tokens beyond the 500-entry cap. The resolver now prioritizes selected-property token references and their alias dependencies, with a regression containing 620 unrelated variables.

**Material Web:** An actual open-shadow button was captured, with 188 tokens and seven distinct direct token references. Fifteen scope/shadow-selector diagnostics and one unreadable sheet disclosed incomplete provenance. Fifty-two missing-variable diagnostics were recorded; Material's optional token overrides frequently use fallbacks, so this count is not a claim that 52 page values are broken. No probe mismatch was detected for the selected example. This does not establish complete support for every Material component or shadow selector.

**Shopify:** `https://polaris.shopify.com/` redirected to the current Shopify developer documentation at the URL in the table. This is a documentation-site capture, not a validation of the former Polaris React library. The scope exposed 2,238 computed variables, but 29 cross-origin stylesheets were unreadable. Consequently the resolver could show 500 computed values while tracing no selected-property declarations in this adapter-only run. It emitted 29 unreadable-sheet diagnostics, the inventory-cap diagnostic, and unavailable-definition/possible-registration diagnostics. Computed values remain useful, but this is a **provenance failure without stylesheet recovery**, not a successful full token trace. The extension's recovery path is tested separately; no recovery improvement is claimed here.

**Material UI:** The selected rendered example exposed 685 in-scope variables, with 500 shown, five direct references and 55 traced properties. One stylesheet remained unreadable. No probe mismatch was detected on that example. This supplies a real CSS-in-JS/Emotion capture check, not a guarantee for arbitrary Emotion apps.

**Shoelace:** The main example's 431-token capture had 27 explicit scope/shadow-selector diagnostics and no detected probe mismatches. A **second navigation-button sample remains a known failure**: the traced color predicted `rgb(2, 132, 199)` while Chrome computed `rgb(255, 255, 255)`. The report correctly showed Chrome's white value with `PROBE_MISMATCH` and degraded confidence. A separate reproducible script and full result preserve this discrepancy in [`test/oracle/shadow-discrepancy-results.json`](../test/oracle/shadow-discrepancy-results.json). It has not been hidden by selecting the easier main example.

The initial Shoelace capture also revealed a false font comparison: on macOS, Chromium rewrites `BlinkMacSystemFont` to the quoted `system-ui` family. That specific platform normalization is now handled, confirmed by Chromium's [style-builder implementation](https://chromium.googlesource.com/chromium/src/+/27c7fe6e7a57093e09bcdb675cc6cfedac716110/third_party/blink/renderer/core/css/resolver/style_builder_converter.cc) and a real-browser regression. Other font-name distinctions and the genuine shadow color discrepancy remain visible.

## CDP comparison: declaration coverage, not a cascade oracle

The separate local-fixture script compared custom-property **selector/property-pair presence** in CSSOM reports against `CSS.getMatchedStylesForNode` author rules and inherited author rules for fixtures 01–08, selecting `#primary` in each fixture.

All **492 of 492** CDP pairs were represented, with no extra resolver pairs in that measured set. Raw counts per fixture are in [`test/oracle/fixture-coverage-results.json`](../test/oracle/fixture-coverage-results.json).

This is **100% matching-declaration coverage for that subset, not 100% cascade agreement**. It does not compare declaration values, actual winners, rule ordering, origin conflicts, UA rules or shadow-internal nodes. A complete CDP winner/order oracle remains unimplemented. Fixture08's primary button is in the document; the public Material and Shoelace samples supply separate open-shadow captures with the limitations above.

## Reproduce

- `node test/oracle/public-sites.mjs` — five public-site captures, read-only, with timestamped results.
- `node test/oracle/shadow-discrepancy.mjs` — the known Shoelace navigation-color mismatch.
- `node test/oracle/fixture-coverage.mjs` — local fixture01–08 CDP declaration-presence comparison.

These scripts require installed Google Chrome and network access for public pages. Site changes, platform fonts and browser revisions can change the observations. The complete capture limitation list remains in [`resolver-verification.md`](resolver-verification.md).
