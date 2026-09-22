# Color engine

All imports use `culori/fn`, with CSS color modes explicitly registered. The UI keeps the authored string intact until the user makes an edit. The working representation is OKLCH plus alpha.

| Syntax | Handling |
| --- | --- |
| Hex 3/4/6/8; named; transparent | Parsed locally. Unedited bytes preserved. Edited values use hex 6/8. |
| RGB and HSL, comma or space syntax | Parsed locally; the format family and alpha are retained. |
| HWB; Lab/LCH; OKLab/OKLCH | Parsed locally. |
| `color(srgb/display-p3/rec2020/xyz-d50/xyz-d65/a98-rgb/prophoto-rgb …)` | Parsed locally. |
| `color-mix`, relative colors, `light-dark`, system colors, `currentColor`, `var` | Context dependent. `parseColor(authored, computed)` accepts an explicit browser readback; `engineResolved` and `opaque` preserve this distinction. The UI accepts browser-valid CSS strings without inventing a local resolution. |
| Invalid CSS | Not parsed; the live color field retains its last valid value. |

`serializeColor(color)` returns the original string unchanged. Editing a supported syntax retains its syntax family where possible; editing an opaque/context-dependent color with the plane intentionally writes a concrete OKLCH value. RGB/hex/HSL output uses Culori's CSS Color 4 local-MINDE gamut mapping (JND 0.02), not naive clipping. The color plane marks chroma outside sRGB. It is an sRGB editing preview, not a claim of physical monitor gamut measurement.

`deltaEOK` is an OKLab Euclidean distance (0..1 scale); 0.02 is the local-MINDE perceptual threshold. `deltaE00` is CIEDE2000. `contrastRatio` calculates WCAG luminance contrast for opaque colors only, returning null for transparency that requires backdrop compositing. APCA is not implemented or represented as a verified metric.

Known format limitation: edited A98/ProPhoto colors use the fallback RGB/OKLCH working serialization rather than preserving their original space. Authored strings are always retained when unedited. Exact whitespace formatting is preserved only for unedited values.
