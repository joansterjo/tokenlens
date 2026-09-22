import { captureStyleSheets, cssPath } from './capture-live';
import { inferCategory } from '../core/resolve/category';
import { allVarNames } from '../core/resolve/variables';
import type { AuditFinding, AuditResult, AuditToken } from '../transport/payloads';

/** A cancellable page-scoped scan. Counts are CSS declaration consumers, not usage across an application. */
export async function auditPage(signal: AbortSignal, progress: (p: { scanned: number; total: number }) => void, doc: Document = document): Promise<AuditResult> {
  const snapshots = captureStyleSheets(doc);
  const rules = snapshots.flatMap(sheet => sheet.rules);
  const tokens = new Map<string, AuditToken>();
  const dependencies = new Map<string, Set<string>>();
  const counts = new Map<string, Set<Element>>();
  const findings: AuditFinding[] = [];
  const rootStyle = getComputedStyle(doc.documentElement);
  for (const rule of rules) for (const declaration of rule.declarations) {
    if (declaration.property.startsWith('--')) {
      const name = declaration.property;
      const existing = tokens.get(name);
      const scope = rule.source.selectorText || ':root';
      if (!existing) tokens.set(name, { name, value: rootStyle.getPropertyValue(name).trim() || declaration.valueText, category: inferCategory(name, declaration.valueText), consumers: 0, scopes: [scope] });
      else if (!existing.scopes.includes(scope)) existing.scopes.push(scope);
      const deps = dependencies.get(name) || new Set<string>(); allVarNames(declaration.valueText).forEach(t => deps.add(t)); dependencies.set(name, deps);
    }
  }
  function addConsumers(name: string, elements: Element[], seen = new Set<string>()) {
    if (seen.has(name) || seen.size > 50) return;
    seen.add(name); if (!counts.has(name)) counts.set(name, new Set());
    const set = counts.get(name)!; elements.forEach(el => set.add(el));
    dependencies.get(name)?.forEach(dep => addConsumers(dep, elements, seen));
  }
  const elements = [...doc.querySelectorAll('*')].filter(el => !el.closest('tokenlens-root'));
  const limit = 10000;
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const check = () => { if (signal.aborted) throw new DOMException('Audit cancelled', 'AbortError'); };
  const exactColors = new Map<string, string>();
  const colorEntries: { name: string; lab: number[]; alpha: number }[] = [];
  const probe = doc.createElement('span'); probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
  doc.documentElement.append(probe);
  const normalize = (value: string): string | null => {
    if (!CSS.supports('color', value) || /var\(|currentcolor|inherit|initial|unset/i.test(value)) return null;
    probe.style.color = value; return getComputedStyle(probe).color;
  };
  try {
    const canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1;
    const paint = canvas.getContext('2d', { willReadFrequently: true });
    for (const token of tokens.values()) {
      check();
      const color = normalize(token.value);
      if (color) {
        const other = exactColors.get(color);
        if (other) findings.push({ type: 'duplicate', token: token.name, message: `${token.name} and ${other} resolve to the same color on this page.` });
        else exactColors.set(color, token.name);
        if (paint) { paint.clearRect(0,0,1,1); paint.fillStyle = color; paint.fillRect(0,0,1,1); const rgba = [...paint.getImageData(0,0,1,1).data]; colorEntries.push({ name: token.name, lab: oklab(rgba), alpha: rgba[3] }); }
      }
    }
    // ΔE_OK uses the OKLab 0..1 scale: .02 corresponds to 2 on a 0..100 display.
    for (let i = 0; i < colorEntries.length; i++) for (let j = i + 1; j < colorEntries.length; j++) {
      const a = colorEntries[i], b = colorEntries[j];
      const delta = Math.hypot(...a.lab.map((v,k) => v - b.lab[k]));
      if (delta > .0001 && delta < .02 && Math.abs(a.alpha-b.alpha) <= 2) findings.push({ type: 'duplicate', token: a.name, message: `${a.name} and ${b.name} are close colors (ΔE_OK ${(delta*100).toFixed(2)} / 100, sRGB preview). Review whether both are needed.` });
    }
    const hardcodedSeen = new Set<string>();
    for (let i = 0; i < rules.length; i++) {
      check(); const rule = rules[i];
      if (rule.source.conditions.some(c => c.matched !== true) || !rule.source.selectorText) continue;
      let matched: Element[];
      try { matched = [...doc.querySelectorAll(rule.source.selectorText)].slice(0, limit); } catch { continue; }
      if (!matched.length) continue;
      for (const decl of rule.declarations) {
        if (decl.property.startsWith('--')) continue;
        const refs = allVarNames(decl.valueText);
        refs.forEach(name => addConsumers(name, matched));
        if (!refs.length && /color|background|fill|stroke/.test(decl.property)) {
          const color = normalize(decl.valueText); const token = color ? exactColors.get(color) : undefined;
          const key = `${rule.source.selectorText}|${decl.property}|${token}`;
          if (token && !hardcodedSeen.has(key)) { hardcodedSeen.add(key); findings.push({ type: 'hardcoded', token, selector: rule.source.selectorText, message: `${rule.source.selectorText} uses ${decl.valueText} for ${decl.property}; matches ${token}. Check the cascade before replacing.` }); }
        }
      }
      if (i % 100 === 0) { progress({ scanned: Math.round(i / Math.max(rules.length, 1) * elements.length * .5), total: elements.length }); await pause(); }
    }
    for (let i = 0; i < Math.min(elements.length, limit); i++) {
      check(); const element = elements[i];
      if ('style' in element) {
        for (const prop of (element as HTMLElement).style) if (!prop.startsWith('--')) allVarNames((element as HTMLElement).style.getPropertyValue(prop)).forEach(name => addConsumers(name, [element]));
      }
      if (element.childNodes.length && [...element.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())) {
        const style = getComputedStyle(element);
        let background = style.backgroundColor;
        let parent = element.parentElement;
        while (parent && background === 'rgba(0, 0, 0, 0)') { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; }
        const ratio = contrast(style.color, background);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        if (ratio !== null && ratio < (large ? 3 : 4.5) && style.display !== 'none' && findings.filter(f => f.type === 'contrast').length < 100) findings.push({ type: 'contrast', selector: cssPath(element), message: `${cssPath(element)}: ${ratio.toFixed(2)}:1 text contrast, below ${large ? '3' : '4.5'}:1. Approximate solid-background check; imagery and compositing need review.` });
      }
      if (i % 100 === 0) { progress({ scanned: Math.round(elements.length * .5 + i * .5), total: elements.length }); await pause(); }
    }
    for (const token of tokens.values()) {
      token.consumers = counts.get(token.name)?.size || 0;
      if (!token.consumers) findings.push({ type: 'orphan', token: token.name, message: `${token.name}: no consumers found in readable, active declarations on this page. This does not imply it is unused elsewhere.` });
    }
    progress({ scanned: Math.min(elements.length, limit), total: elements.length });
    return { tokens: [...tokens.values()].sort((a,b) => b.consumers - a.consumers || a.name.localeCompare(b.name)), findings, scanned: Math.min(elements.length, limit), total: elements.length, truncated: elements.length > limit || snapshots.some(s => !s.sheet.readable) };
  } finally { probe.remove(); }
}

function contrast(foreground: string, background: string): number | null {
  const parse = (s: string) => { const m = /^rgb\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)\s*\)$/.exec(s); return m ? m.slice(1).map(Number) : null; };
  const fg = parse(foreground), bg = parse(background); if (!fg || !bg) return null;
  const luminance = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126,.7152,.0722][i], 0);
  const l1 = luminance(fg), l2 = luminance(bg); return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
}

function oklab(rgb: number[]): number[] {
  const [r,g,b] = rgb.slice(0,3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  const l = Math.cbrt(.4122214708*r + .5363325363*g + .0514459929*b);
  const m = Math.cbrt(.2119034982*r + .6806995451*g + .1073969566*b);
  const s = Math.cbrt(.0883024619*r + .2817188376*g + .6299787005*b);
  return [.2104542553*l + .793617785*m - .0040720468*s, 1.9779984951*l - 2.428592205*m + .4505937099*s, .0259040371*l + .7827717662*m - .808675766*s];
}
