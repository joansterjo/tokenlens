import type { Edit } from '../model';
import { VERSION } from '../../shared/version';
import { isSafeCssFragment, isSafeProperty, selectorForEdit } from '../selector';

export type ExportTarget = 'stylus' | 'overrides' | 'flat' | 'patch';
export interface EmitOptions { target?: ExportTarget; url?: string; generatedAt?: string; toolVersion?: string; activeEditIds?: string[] }
export interface SavedSession { version: 1; url: string; generatedAt: string; edits: Edit[] }
const safeComment = (value: string) => value.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ');
export function validateEdit(edit: Edit): string | null {
  if (!isSafeProperty(edit.property)) return 'Invalid property name';
  if (!isSafeCssFragment(edit.scopeSelector, 'selector')) return 'Invalid scope selector';
  if (!isSafeCssFragment(edit.to)) return 'Invalid CSS value';
  if (/!\s*important\s*$/i.test(edit.to)) return 'Importance must use the override priority control';
  for (const condition of [edit.ctx?.media, edit.ctx?.supports, edit.ctx?.container]) if (condition && !isSafeCssFragment(condition, 'condition')) return 'Invalid conditional wrapper';
  return null;
}
export function wrapConditions(rule: string, ctx: Edit['ctx']): string {
  let output = rule;
  for (const [name, text] of [['container', ctx.container], ['supports', ctx.supports], ['media', ctx.media]]) {
    if (text) output = `@${name} ${text} {\n${output.split('\n').map(line => `  ${line}`).join('\n')}\n}`;
  }
  return output;
}
export function emitCSS(edits: Edit[], options: EmitOptions = {}): string {
  const target = options.target ?? 'stylus'; const active = options.activeEditIds ? new Set(options.activeEditIds) : null;
  const skipped: string[] = [], flattened = new Set<string>();
  const groups: { key: string; selector: string; ctx: Edit['ctx']; edits: Edit[] }[] = [];
  for (const edit of edits.filter(item => item.enabled)) {
    const reason = validateEdit(edit) ?? (!edit.exportable || edit.rung === 'inline-only' ? 'Preview only: author stylesheet cannot reproduce this edit' : edit.treeScope.kind === 'shadow' ? 'Shadow-root rules cannot be reached by a document stylesheet; override an inherited token on its host' : null);
    if (reason) { skipped.push(`${edit.property} on ${edit.scopeSelector}: ${reason}`); continue; }
    if (target === 'flat' && (active ? !active.has(edit.id) : !edit.verified)) { skipped.push(`${edit.property} on ${edit.scopeSelector}: inactive or unverified in the current page state`); continue; }
    const ctx = target === 'flat' ? { media: null, supports: null, container: null, layerPath: [] } : edit.ctx;
    if (target === 'flat') for (const [name, condition] of [['media', edit.ctx.media], ['supports', edit.ctx.supports], ['container', edit.ctx.container]]) if (condition) flattened.add(`${name}: ${condition}`);
    const selector = selectorForEdit(edit);
    const key = JSON.stringify([selector, ctx.media, ctx.supports, ctx.container]);
    const previous = groups.at(-1);
    if (previous?.key === key) previous.edits.push(edit);
    else groups.push({ key, selector, ctx, edits: [edit] });
  }
  const header = [`/*!tokenlens-session v1`, ` * url: ${safeComment(options.url ?? '')}`, ` * generated: ${safeComment(options.generatedAt ?? 'not recorded')}`, ` * tool: tokenlens ${safeComment(options.toolVersion ?? VERSION)}`, ` * edits: ${edits.filter(edit => edit.enabled).length}; target: ${target}`, ' */'];
  if (target === 'overrides') header.push('/* Chrome DevTools: Sources → Overrides → choose a folder; save this CSS as an override for a loaded stylesheet. */');
  if (target === 'flat') header.push('/* Temporary current-state preview. Conditional wrappers are removed; reload discards inspector edits. */');
  if (target === 'patch') header.push('/* BEST-EFFORT SOURCE SUGGESTION. Review source hints before editing files; this is not an applicable patch. */');
  const blocks = groups.map(group => {
    // Rule and declaration order affect overlapping selectors and shorthands.
    const lines = group.edits.map(edit => `  ${edit.property}: ${edit.to}${edit.rung === 'important' ? ' !important' : ''};`);
    const hints = target === 'patch' ? group.edits.filter(edit => edit.srcHint).map(edit => `/* source: ${safeComment(edit.srcHint!)} */\n`).join('') : '';
    return hints + wrapConditions(`${group.selector} {\n${lines.join('\n')}\n}`, group.ctx);
  });
  if (flattened.size) blocks.push(`/* FLATTENED CONDITIONS: ${[...flattened].sort().map(safeComment).join('; ')} */`);
  if (skipped.length) blocks.push(`/* NOT EXPORTED (${skipped.length})\n${skipped.map(reason => ` * ${safeComment(reason)}`).join('\n')}\n */`);
  return [...header, '', blocks.join('\n\n'), ''].join('\n');
}
export function serializeSession(edits: Edit[], options: Pick<EmitOptions, 'url' | 'generatedAt'> = {}): string {
  return JSON.stringify({ version: 1, url: options.url ?? '', generatedAt: options.generatedAt ?? new Date().toISOString(), edits } satisfies SavedSession, null, 2);
}
export function parseSession(text: string): SavedSession {
  if (text.length > 2_000_000) throw new Error('Session is too large');
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('Invalid TokenLens session');
  const session = data as Partial<SavedSession>;
  if (session.version !== 1 || typeof session.url !== 'string' || !Array.isArray(session.edits) || session.edits.length > 2000) throw new Error('Unsupported or invalid TokenLens session');
  const ids = new Set<string>();
  for (const value of session.edits) {
    const edit = value as Edit;
    if (!edit || typeof edit.id !== 'string' || ids.has(edit.id) || typeof edit.property !== 'string' || typeof edit.to !== 'string' || typeof edit.scopeSelector !== 'string' || !edit.ctx || !edit.treeScope || !['document', 'shadow'].includes(edit.treeScope.kind) || !['order', 'doubled', 'important', 'inline-only'].includes(edit.rung) || !['element', 'token'].includes(edit.mode) || !Array.isArray(edit.chainHint) || !Array.isArray(edit.ctx.layerPath) || typeof edit.enabled !== 'boolean' || typeof edit.exportable !== 'boolean') throw new Error('Invalid session edit');
    for (const condition of [edit.ctx.media, edit.ctx.supports, edit.ctx.container]) if (condition !== null && typeof condition !== 'string') throw new Error('Invalid condition');
    if (typeof edit.treeScope.id !== 'string' || typeof edit.treeScope.depth !== 'number' || !Number.isFinite(edit.treeScope.depth) || edit.ctx.layerPath.some(value => typeof value !== 'string') || edit.chainHint.some(value => typeof value !== 'string') || (edit.from !== null && typeof edit.from !== 'string') || (edit.srcHint !== null && typeof edit.srcHint !== 'string') || (edit.blastRadius !== null && (typeof edit.blastRadius !== 'number' || !Number.isFinite(edit.blastRadius))) || (edit.treeScope.hostPath !== undefined && typeof edit.treeScope.hostPath !== 'string')) throw new Error('Invalid session edit metadata');
    const error = validateEdit(edit); if (error) throw new Error(error); ids.add(edit.id);
    // Verification is local to the current document and never trusted from a session file.
    edit.verified = false;
  }
  return { version: 1, url: session.url, generatedAt: typeof session.generatedAt === 'string' ? session.generatedAt : '', edits: session.edits };
}
