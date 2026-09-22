# Export and preview fidelity

TokenLens writes author-origin CSS. Preview and export share the same selector and condition compiler; the page's own stylesheet and inline declarations are never rewritten. Removing the preview restores the page.

- **Stylesheet / Stylus (`stylus`)**: complete CSS with media, supports and container wrappers. Rules remain unlayered; selectors and `!important` match the verified preview. Paste into a user CSS editor operating at author origin or a site stylesheet.
- **Local Overrides (`overrides`)**: the same CSS, with Chrome setup guidance. In DevTools → Sources → Overrides, choose a local folder and save an override for a stylesheet the page loads. The inspector's temporary stylesheet has no backing network resource to persist this way.
- **Temporary (`flat`)**: only currently verified edits, with condition wrappers removed and listed as lost in a comment. It represents the current viewport/theme state. Keep theme-specific selectors; a future theme change may therefore stop matching. Full Styles declaration-editor blob paste behavior remains unverified; a stylesheet text editor in Sources can hold complete CSS.
- **Source suggestion (`patch`)**: best-effort source hints and CSS. This is not a mechanically applicable diff.

Rule order is preserved, including overlapping equal-specificity selectors and shorthand/longhand interactions. Only consecutive identical scopes/conditions are grouped. Lexically sorting selectors would change the cascade and is deliberately avoided. The same input produces the same output; an optional `generatedAt` value records session time.

Disabled edits are excluded. Unreachable shadow-root overrides, inline-important conflicts, and other explicitly nonexportable edits receive a `NOT EXPORTED` explanation. Inactive media scopes remain in complete CSS so their edits become active under the original conditions; temporary flat output omits them. Container conditions retain their original text, and unresolved verification remains visible.

The separate JSON session contains version 1, page URL, time, and full Edit records. `parseSession` validates CSS fragments and metadata; imported verification flags are reset because verification applies only to the original page/document. Imported sessions require reapplication and verification on the current page.

Important limits: ordinary author CSS cannot beat inline-important declarations or every important cascade-layer rule. Internal shadow-root rules cannot be reached by document CSS; override an inherited custom property on the host where possible. The engine stops at the important rung and reports failure instead of editing inline styles automatically. For context-dependent values it cannot safely normalize, the engine preserves priority and reports that verification is still required.
