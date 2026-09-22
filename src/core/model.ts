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
