import { afterEach, expect, test, vi } from 'vitest';
import { createPanelTransport } from '../../src/adapters/chrome-port';
import type { Envelope } from '../../src/transport/protocol';
afterEach(()=>vi.unstubAllGlobals());
function setup() {
  let receive: (m: Envelope)=>void = ()=>{};
  const sent: Envelope[] = [];
  vi.stubGlobal('addEventListener',()=>{});
  vi.stubGlobal('chrome',{
    devtools:{inspectedWindow:{tabId:5,eval:vi.fn()}},
    storage:{session:{get:async()=>({}),set:async()=>{}}},
    runtime:{connect:()=>({postMessage:(m:Envelope)=>sent.push(m),onMessage:{addListener:(f:(m:Envelope)=>void)=>{receive=f;}},onDisconnect:{addListener:()=>{}},disconnect:()=>{}})},
  });
  const transport=createPanelTransport();
  const events: Envelope[]=[]; transport.on(m=>events.push(m));
  return{transport,sent,events,receive:(m:Envelope)=>receive(m)};
}
test('picker always fans out after an element in a frame has been selected',()=>{
  const t=setup();
  t.transport.send({v:1,id:'pick',type:'pick:start',frameId:2,documentId:'child',payload:{}});
  expect(t.sent.at(-1)?.frameId).toBeUndefined(); expect(t.sent.at(-1)?.documentId).toBeUndefined();
});
test('same-document service-worker reconnect does not invalidate panel state',()=>{
  const t=setup();
  t.receive({v:1,id:'sync',type:'resync',frameId:0,documentId:'main',payload:{report:null,edits:[]}});
  t.receive({v:1,id:'restart',type:'nav:changed',frameId:0,documentId:'main',payload:{}});
  expect(t.events.map(m=>m.type)).toEqual(['resync']);
  t.receive({v:1,id:'navigation',type:'nav:changed',frameId:0,documentId:'next',payload:{}});
  expect(t.events.at(-1)?.type).toBe('nav:changed');
});
test('old-frame background reports and verification cannot steal selection or edits',()=>{
  const t=setup();
  t.receive({v:1,id:'pick-child',type:'report:result',frameId:2,documentId:'child',payload:{}});
  t.receive({v:1,id:'refresh-main',type:'resync',frameId:0,documentId:'main',payload:{}});
  t.receive({v:1,id:'verify-main',type:'edit:verified',frameId:0,documentId:'main',payload:{edits:[]}});
  expect(t.events.map(m=>m.type)).toEqual(['report:result']);
  t.transport.send({v:1,id:'edit-child',type:'edit:apply',payload:{edits:[]}});
  expect(t.sent.at(-1)).toMatchObject({frameId:2,documentId:'child'});
});
