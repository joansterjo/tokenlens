import type { ElementRef, PropertyRegistration } from './model';
import type { Envelope } from '../transport/protocol';
import type { SheetSnapshot } from './resolve/snapshot';

export interface StyleHost {
  sheets(): SheetSnapshot[];
  computed(el: ElementRef, prop: string): string;
  ancestors(el: ElementRef): ElementRef[];
  registrations(): PropertyRegistration[];
  matchMedia(q: string): boolean;
  supports(cond: string): boolean;
}
export interface Transport {
  send(m: Envelope): void;
  on(f: (m: Envelope) => void): () => void;
}
