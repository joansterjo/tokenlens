/** Serializable DevTools helpers. Their bodies deliberately have no module dependencies. */
export function tagSelectedElement(element: Element | null): { selected: boolean; tagName?: string } {
  if (!element || element.nodeType !== 1 || !element.isConnected) return { selected: false };
  element.setAttribute('data-tokenlens-sel', '');
  return { selected: true, tagName: element.localName };
}
export function selectedElementPreview(element: Element | null): { tagName: string; id: string; className: string } | null {
  if (!element || element.nodeType !== 1 || !element.isConnected) return null;
  return { tagName: element.localName, id: element.id, className: element.getAttribute('class') ?? '' };
}
