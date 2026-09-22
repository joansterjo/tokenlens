import { escapeIdentifier, isHashedClass, selectorCandidates } from '../../core/selector';

export interface ElementSelector { selector: string; matches: number; fragile: boolean; rejectedClasses: string[]; reason: string }
export function uniqueSelector(element: Element): ElementSelector {
  const root = element.getRootNode() as Document | ShadowRoot;
  const attributes = Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value]));
  const rejectedClasses = [...element.classList].filter(isHashedClass);
  const count = (selector: string) => { try { return root.querySelectorAll(selector).length; } catch { return 0; } };
  if (element === element.ownerDocument.documentElement) return { selector: ':root', matches: 1, fragile: false, rejectedClasses, reason: 'document root' };
  for (const candidate of selectorCandidates({ tagName: element.localName, id: element.id, classes: [...element.classList], attributes })) {
    if (count(candidate.selector) === 1) return { ...candidate, matches: 1, fragile: false, rejectedClasses };
  }
  const parts: string[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    const siblings = current.parentElement ? [...current.parentElement.children] : [...root.children];
    const position = siblings.indexOf(current) + 1;
    parts.unshift(`${escapeIdentifier(current.localName)}:nth-child(${position})`);
    const selector = parts.join(' > ');
    if (count(selector) === 1) return { selector, matches: 1, fragile: true, rejectedClasses, reason: 'structural path; may change when siblings move' };
  }
  return { selector: parts.join(' > '), matches: count(parts.join(' > ')), fragile: true, rejectedClasses, reason: 'structural path' };
}
