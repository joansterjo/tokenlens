import { captureElement, invalidateCapture } from '../../src/adapters/capture-live';
import { auditPage } from '../../src/adapters/audit-live';
import { OverrideEngine } from '../../src/content/override';
import { emitCSS } from '../../src/core/emit';
import type { Edit } from '../../src/core/model';
const percentile = (values: number[], p = .95) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.floor(values.length*p))];
export async function measure() {
  const target = document.querySelector('#primary')!;
  invalidateCapture(document);
  const cold = captureElement(target);
  const warm: number[] = [];
  for (let i=0;i<25;i++) { const start=performance.now(); captureElement(target); warm.push(performance.now()-start); }
  const token = cold.tokensInScope['--brand-500']; const scope = token.scopes.find(s => s.selector === ':root')!;
  const edit: Edit = { id:'perf', mode:'token', property:'--brand-500', scopeSelector:scope.selector, ctx:scope.ctx, treeScope:{id:'document',kind:'document',depth:0},from:token.rawValue,to:'#118a6f',rung:'doubled',enabled:true,verified:false,chainHint:[],srcHint:null,blastRadius:null,exportable:true };
  const engine = new OverrideEngine(); const writes: number[] = []; const paints: number[] = [];
  engine.apply([edit],target);
  for (let i=0;i<30;i++) {
    await new Promise(requestAnimationFrame);
    const start=performance.now(); engine.apply([{...edit,to:i%2?'#118a6f':'#dd5577'}],target); void getComputedStyle(target).backgroundColor; writes.push(performance.now()-start);
    await new Promise(requestAnimationFrame); paints.push(performance.now()-start);
  }
  const exportStart=performance.now(); emitCSS(Array.from({length:50},(_,i)=>({...edit,id:`export-${i}`,property:`--p-${i}`}))); const exportMs=performance.now()-exportStart;
  engine.destroy();
  const auditStart=performance.now(); const audit=await auditPage(new AbortController().signal,()=>{}); const auditMs=performance.now()-auditStart;
  return { userAgent:navigator.userAgent, fixture:'07-heavy', elementCount:document.querySelectorAll('*').length,
    coldIndexMs:cold.timings.indexMs,coldCaptureMs:cold.timings.totalMs,warmCaptureP95Ms:percentile(warm),
    previewApplyAndStyleP95Ms:percentile(writes),nextFrameP95Ms:percentile(paints),export50EditsMs:exportMs,auditMs,auditTokenCount:audit.tokens.length,
    samples:{warm,writes,paints}, notes:['Preview timing is local engine apply plus style read; extension message transport is measured separately by functional E2E.','Next-frame intervals depend on display refresh and scheduling; they are recorded, not represented as sub-16ms paint proof.','Hover overlay paint and memory trend budgets are not measured here.'] };
}
export function pickMany() {
  const container = document.createElement('div'); container.innerHTML = Array.from({length:100},(_,i)=>`<button id="memory-${i}" class="button">Memory sample</button>`).join('');
  document.body.append(container);
  for (const element of container.children) captureElement(element);
  container.remove();
}
