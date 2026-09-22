import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Copy, GripHorizontal, Pipette, Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import type { ColorValue } from '../core/model';
import { parseColor, serializeColor, toHex, gamutBoundary } from '../core/color';

export interface EditorProps {
  value: string; onChange: (value: string) => void;
  onBegin: () => void; onCommit: () => void; onCancel: () => void;
}
export function ValueField({ value, onChange, onBegin, onCommit, label = 'CSS value', multiline = false }: EditorProps & { label?: string; multiline?: boolean }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const common = { 'aria-label': label, value: focused.current ? draft : value, onFocus: () => { focused.current = true; setDraft(value); onBegin(); }, onBlur: () => { focused.current = false; onCommit(); setDraft(value); }, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(e.target.value); onChange(e.target.value); }, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !multiline) (e.target as HTMLElement).blur(); } };
  return multiline ? <textarea className="value-input multiline" {...common} /> : <input className="value-input" spellCheck={false} {...common} />;
}

export function NumberEditor({ value, onChange, onBegin, onCommit, onCancel, label = 'Value' }: EditorProps & { label?: string }) {
  const match = /^(-?[\d.]+)([a-z%]*)$/i.exec(value.trim());
  const numeric = match ? Number(match[1]) : 0;
  const unit = match?.[2] ?? '';
  const drag = useRef<{ x: number; value: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState(String(numeric));
  useEffect(() => setDraft(String(numeric)), [numeric]);
  useEffect(() => { const cancel = (e: KeyboardEvent) => { if (e.key === 'Escape') drag.current = null; }; window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel); }, []);
  const change = (n: number, u = unit) => onChange(`${Number(n.toFixed(4))}${u}`);
  if (!match) return <ValueField value={value} onChange={onChange} onBegin={onBegin} onCommit={onCommit} onCancel={onCancel} label={label} />;
  return <div className="number-control">
    <label className="scrub-label" title="Drag to scrub. Shift: ×10 · Alt: ×0.1" onPointerDown={e => { onBegin(); drag.current = { x: e.clientX, value: numeric, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (drag.current) { drag.current.moved = true; change(drag.current.value + (e.clientX - drag.current.x) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)); } }} onPointerUp={() => { drag.current = null; onCommit(); }} onPointerCancel={() => { drag.current = null; onCancel(); }}><GripHorizontal size={12}/>{label}</label>
    <div className="number-field"><input aria-label={label} inputMode="decimal" value={draft} onFocus={onBegin} onChange={e => { setDraft(e.target.value); if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(e.target.value)) change(Number(e.target.value)); }} onBlur={onCommit} onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); onBegin(); change(numeric + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)); onCommit(); } if (e.key === 'Enter') e.currentTarget.blur(); }}/>
      <select aria-label={`${label} unit`} value={unit} onChange={e => { onBegin(); change(numeric, e.target.value); onCommit(); }}>{[...new Set([unit, '', 'px', 'rem', 'em', '%', 'vh', 'vw', 'ms', 's'])].map(u => <option key={u} value={u}>{u || '—'}</option>)}</select></div>
  </div>;
}

export function ColorEditor({ value, onChange, onBegin, onCommit, onCancel, swatches, onEyeDropper }: EditorProps & { swatches: { name: string; value: string }[]; onEyeDropper: () => Promise<string | undefined> }) {
  const color = parseColor(value);
  const fallback: ColorValue = { authored: '#000000', syntax: 'hex6', oklch: [0, 0, 0], alpha: 1, alphaWasWritten: false, hueUnit: 'none', lightnessUnit: 'number', outOfSrgbGamut: false, engineResolved: false };
  const parsed = color ?? fallback;
  const [format, setFormat] = useState<'authored'|'hex'|'oklch'|'rgb'|'hsl'>('authored');
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const hue = parsed.oklch[2];
  const planeHue = Math.round(hue);
  useEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context) return;
    const width = 120; const height = 72;
    const pixels = context.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const lightness = 1 - y / (height - 1); const boundary = gamutBoundary(lightness, planeHue);
      for (let x = 0; x < width; x++) {
        const chroma = x / (width - 1) * 0.4;
        const hex = chroma <= boundary ? toHex(`oklch(${lightness} ${chroma} ${planeHue})`) : '#90909c';
        const offset = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const v = parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16);
          pixels.data[offset + channel] = chroma > boundary ? v * 0.3 + (((x + y) % 7 < 2) ? 142 : 114) : v;
        }
        pixels.data[offset + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
  }, [planeHue]);
  useEffect(() => { const cancel = (e: KeyboardEvent) => { if (e.key === 'Escape') dragging.current = false; }; window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel); }, []);
  const change = (next: Partial<{ l: number; c: number; h: number; alpha: number }>) => onChange(serializeColor(parsed, next, format === 'authored' ? undefined : format));
  const move = (e: ReactPointerEvent) => {
    const bounds = plane.current!.getBoundingClientRect();
    change({ c: Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)) * 0.4, l: 1 - Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height)) });
  };
  return <div className="color-editor">
    <div className="color-plane" ref={plane} role="slider" tabIndex={0} aria-label="Color lightness and chroma" aria-valuetext={`Lightness ${Math.round(parsed.oklch[0] * 100)}%, chroma ${parsed.oklch[1].toFixed(3)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(parsed.oklch[0] * 100)} onPointerDown={e => { onBegin(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); move(e); }} onPointerMove={e => { if (dragging.current) move(e); }} onPointerUp={() => { dragging.current = false; onCommit(); }} onPointerCancel={() => { dragging.current = false; onCancel(); }} onKeyDown={e => { if (e.key.startsWith('Arrow')) { e.preventDefault(); onBegin(); const step = e.shiftKey ? 0.1 : 0.01; change({ l: Math.min(1, Math.max(0, parsed.oklch[0] + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0))), c: Math.min(0.4, Math.max(0, parsed.oklch[1] + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0))) }); onCommit(); } }}>
      <canvas width="120" height="72" ref={canvas}/><span className="color-cursor" style={{ left: `${Math.min(100, parsed.oklch[1] / 0.4 * 100)}%`, top: `${(1 - parsed.oklch[0]) * 100}%`, background: value }}/><span className="plane-label">OKLCH</span>
    </div>
    <div className="color-sliders"><span className="large-swatch checker"><i style={{ background: color ? value : 'transparent' }}/></span><div className="sliders"><input className="hue-range" type="range" min="0" max="360" step="0.1" aria-label="Hue" value={hue} onPointerDown={onBegin} onChange={e => { onBegin(); change({ h: +e.target.value }); }} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit}/><input className="alpha-range" style={{ '--alpha-color': toHex(parsed) } as React.CSSProperties} type="range" min="0" max="1" step="0.01" aria-label="Opacity" value={parsed.alpha} onPointerDown={onBegin} onChange={e => { onBegin(); change({ alpha: +e.target.value }); }} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit}/></div><button className="icon-button" aria-label="Pick color from screen" title="Pick color from screen" onClick={async () => { try { const picked = await onEyeDropper(); if (picked) { onBegin(); onChange(picked); onCommit(); setError(''); } } catch (e) { setError(e instanceof Error ? e.message : 'Screen eyedropper unavailable.'); } }}><Pipette size={16}/></button></div>
    <div className="color-format"><select aria-label="Color format" value={format} onChange={e => { const next = e.target.value as typeof format; setFormat(next); if (next !== 'authored' && color) { onBegin(); onChange(serializeColor(parsed, {}, next)); onCommit(); } }}><option value="authored">Original format</option><option value="hex">HEX · sRGB</option><option value="oklch">OKLCH</option><option value="rgb">RGB · sRGB</option><option value="hsl">HSL · sRGB</option></select><span>{Math.round(parsed.alpha * 100)}% alpha</span></div>
    <ValueField value={value} onBegin={onBegin} onCommit={onCommit} onCancel={onCancel} onChange={text => { if (CSS.supports('color', text)) { onChange(text); setError(''); } else setError('Enter a valid CSS color. The last valid color stays on the page.'); }} label="CSS color"/>
    {error && <p className="inline-warning" role="status">{error}</p>}
    {parsed.outOfSrgbGamut && <p className="inline-note">Wide gamut color · HEX/RGB export maps to sRGB.</p>}
    {!color && <p className="inline-note">Context-dependent color. Edit its CSS value directly, or choose a palette color.</p>}
    <div className="channel-grid">{[['L', parsed.oklch[0] * 100, 0, 100, 0.1], ['C', parsed.oklch[1], 0, 0.4, 0.001], ['H', hue, 0, 360, 1]].map(([name, n, min, max, step]) => <label key={name}><span>{name}</span><input type="number" aria-label={`OKLCH ${name}`} min={min} max={max} step={step} value={Number(Number(n).toFixed(3))} onFocus={onBegin} onChange={e => change({ [name === 'L' ? 'l' : name === 'C' ? 'c' : 'h']: +e.target.value / (name === 'L' ? 100 : 1) })} onBlur={onCommit}/></label>)}</div>
    {!!swatches.length && <div className="document-palette"><div className="eyebrow">Page palette <span>{swatches.length}</span></div><div className="palette-swatches">{swatches.slice(0, 40).map(s => <button key={s.name} title={`${s.name}: ${s.value}`} aria-label={`Use ${s.name}`} className="palette-swatch checker" onClick={() => { onBegin(); onChange(s.value); onCommit(); }}><i style={{ background: s.value }}/></button>)}</div></div>}
    <p className="microcopy">Hatched colors are outside sRGB. Drag or use arrow keys.</p>
  </div>;
}

export function splitCSSList(value: string): string[] {
  const list: string[] = []; let depth = 0; let quote = ''; let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) { if (c === quote && value[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++; if (c === ')') depth--;
    if (c === ',' && depth === 0) { list.push(value.slice(start, i).trim()); start = i + 1; }
  }
  list.push(value.slice(start).trim()); return list.filter(Boolean);
}
interface Shadow { x: string; y: string; blur: string; spread: string; color: string; inset: boolean }
function parseShadow(value: string): Shadow | null {
  const words: string[] = value.match(/(?:[^\s(]+\((?:[^()]|\([^()]*\))*\)|[^\s]+)/g) ?? [];
  const lengths = words.filter(w => /^-?(?:\d|\.)/.test(w));
  if (lengths.length < 2 || lengths.length > 4) return null;
  return { x: lengths[0], y: lengths[1], blur: lengths[2] ?? '0px', spread: lengths[3] ?? '0px', color: words.filter(w => !lengths.includes(w) && w !== 'inset').join(' ') || 'currentColor', inset: words.includes('inset') };
}
const serializeShadow = (layer: Shadow) => `${layer.inset ? 'inset ' : ''}${layer.x} ${layer.y} ${layer.blur} ${layer.spread} ${layer.color}`;
export function ShadowEditor(props: EditorProps & { raw?: string }) {
  const { value, onChange, onBegin, onCommit, raw } = props;
  const layers = value === 'none' ? [] : splitCSSList(value);
  const [flattened, setFlattened] = useState(false);
  const alias = raw?.includes('var(') && layers.length > 1 && !flattened;
  const update = (index: number, next?: string) => { const copy = [...layers]; if (next == null) copy.splice(index, 1); else copy[index] = next; onChange(copy.join(', ') || 'none'); };
  return <div className="shadow-editor"><div className="shadow-preview"><span style={{ boxShadow: value }}>Aa</span></div>{alias && <div className="inline-warning">This alias expands to {layers.length} layers.<button className="text-button" onClick={() => setFlattened(true)}>Flatten to edit layers</button></div>}
    {!alias && layers.map((text, i) => { const layer = parseShadow(text); return <div className="shadow-layer" key={i}><div className="layer-heading"><span>Layer {i + 1}</span><div className="button-group"><button className="icon-button" aria-label={`Move layer ${i + 1} up`} disabled={i === 0} onClick={() => { onBegin(); const copy = [...layers]; [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]]; onChange(copy.join(', ')); onCommit(); }}><ChevronUp size={13}/></button><button className="icon-button" aria-label={`Move layer ${i + 1} down`} disabled={i === layers.length - 1} onClick={() => { onBegin(); const copy = [...layers]; [copy[i + 1], copy[i]] = [copy[i], copy[i + 1]]; onChange(copy.join(', ')); onCommit(); }}><ChevronDown size={13}/></button><button className="icon-button" aria-label={`Duplicate layer ${i + 1}`} onClick={() => { onBegin(); onChange([...layers.slice(0, i + 1), text, ...layers.slice(i + 1)].join(', ')); onCommit(); }}><Copy size={12}/></button><button className="icon-button" aria-label={`Delete layer ${i + 1}`} onClick={() => { onBegin(); update(i); onCommit(); }}><Trash2 size={12}/></button></div></div>{layer ? <><div className="shadow-numbers">{(['x', 'y', 'blur', 'spread'] as const).map(field => <NumberEditor key={field} {...props} label={field} value={layer[field]} onChange={v => update(i, serializeShadow({ ...layer, [field]: v }))}/>)}</div><div className="shadow-color"><input type="color" aria-label={`Layer ${i + 1} color`} value={toHex(layer.color)} onFocus={onBegin} onChange={e => update(i, serializeShadow({ ...layer, color: e.target.value }))} onBlur={onCommit}/><ValueField {...props} label={`Layer ${i + 1} color CSS`} value={layer.color} onChange={v => update(i, serializeShadow({ ...layer, color: v }))}/><label><input type="checkbox" checked={layer.inset} onChange={e => { onBegin(); update(i, serializeShadow({ ...layer, inset: e.target.checked })); onCommit(); }}/>Inset</label></div></> : <ValueField {...props} value={text} label={`Shadow layer ${i + 1}`} onChange={v => update(i, v)}/>}</div>; })}
    {!alias && <button className="secondary-button full-width" onClick={() => { onBegin(); onChange([...layers, '0px 4px 16px 0px rgb(0 0 0 / 0.12)'].join(', ')); onCommit(); }}><Plus size={14}/>Add shadow layer</button>}<ValueField {...props} label="Shadow CSS" multiline/>
  </div>;
}
