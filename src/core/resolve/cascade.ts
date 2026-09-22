import type { CascadeSource, Declaration, Specificity } from '../model';

export const compareSpecificity = (a: Specificity, b: Specificity): number =>
  a.a - b.a || a.b - b.b || a.c - b.c;

function originRank(source: CascadeSource): number {
  if (source.origin === 'transition') return 8;
  if (source.important) {
    if (source.origin === 'user-agent') return 7;
    if (source.origin === 'user') return 6;
    return 5;
  }
  if (source.origin === 'animation') return 4;
  if (source.origin === 'user-agent') return 0;
  if (source.origin === 'user') return 1;
  return 2;
}

/** Positive means a wins. Context precedes inline attachment and layer order. */
export function compareCascade(a: CascadeSource, b: CascadeSource): number {
  return originRank(a) - originRank(b)
    || (a.important ? a.contextDepth - b.contextDepth : b.contextDepth - a.contextDepth)
    || Number(a.origin === 'inline') - Number(b.origin === 'inline')
    || compareLayer(a, b)
    || compareSpecificity(a.specificity, b.specificity)
    || a.documentOrder - b.documentOrder;
}

function compareLayer(a: CascadeSource, b: CascadeSource): number {
  const aLayer = a.layerPath.length ? a.layerOrder : Number.MAX_SAFE_INTEGER;
  const bLayer = b.layerPath.length ? b.layerOrder : Number.MAX_SAFE_INTEGER;
  return a.important ? bLayer - aLayer : aLayer - bLayer;
}

export function loserReason(winner: CascadeSource, loser: CascadeSource): Declaration['loserReason'] {
  if (originRank(winner) !== originRank(loser)) return 'origin';
  if (winner.contextDepth !== loser.contextDepth) return 'context';
  if ((winner.origin === 'inline') !== (loser.origin === 'inline')) return 'element-attached';
  if (compareLayer(winner, loser)) return 'layer';
  if (compareSpecificity(winner.specificity, loser.specificity)) return 'specificity';
  return 'order';
}
