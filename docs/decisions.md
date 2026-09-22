# Implementation decisions

The supplied build plan is the planning baseline. The user's request authorizes autonomous delivery; its suggested human review gates are implemented as automated integration checkpoints, not approval stops.

- The original `model.ts` and protocol vocabulary are preserved. Conflicting prose yields to those contracts: `devtools:<tabId>`, and confidence `exact | probable | degraded`.
- No `tabs` or `debugger` permission. D13 and least privilege take precedence over §15's conflicting `tabs` requirement.
- Workstreams share this fresh workspace with exclusive file ownership. Four concurrent agent slots require batching the seven workstreams. Shared types are frozen before parallel implementation; the plan's undefined `SheetSnapshot` is supplied by the resolver in its own module.
- Preview and export use author-origin CSS. Unsupported provenance is disclosed. No export fidelity or performance claims are made without measured evidence.
- Minimum Chrome 120 is the platform floor for `match_origin_as_fallback`, not a claim that every release from 120 has been tested. See spikes for actual browser versions tested.

- Development output is `dist-dev`, separate from production `dist` and optional-permission `dist-store`, so HMR cannot overwrite installable release files.
- The optional-permission package removes static content scripts after CRXJS compiles the production loader. A popup-approved site gets a persistent registered content script.
- Color size measures the functions actually imported by the shipped picker. The complete standalone API size (including otherwise unshipped comparison helpers) is recorded separately; native CSS Color 4 parsing was preserved.
- The full research plan remains a roadmap: exact consumer counts, complete CDP winner ordering, APCA and advanced shadow tracing are explicitly unclaimed. Release evidence and remaining gaps are in `verification.md`.
