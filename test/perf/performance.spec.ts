import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
test('record real-browser resolver, preview, export and audit performance', async ({ page, browser }) => {
  await page.goto('http://127.0.0.1:4175/test/fixtures/07-heavy.html');
  const results = await page.evaluate(async () => { const path = '/test/perf/harness.ts'; const harness = await import(path); return harness.measure(); });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='JSHeapUsedSize')!.value; };
  const heapBefore=await heap();
  await page.evaluate(async()=>{const path='/test/perf/harness.ts';const harness=await import(path);harness.pickMany();});
  const heapAfter=await heap();
  await writeFile('perf-results.json',JSON.stringify({ browserVersion:browser.version(),measuredAt:new Date().toISOString(),...results, memory:{picks:100,heapBefore,heapAfter,deltaBytes:heapAfter-heapBefore,note:'One bounded 100-element pick run after explicit garbage collection; not proof of indefinite stability.'} },null,2)+'\n');
  expect(results.coldIndexMs).toBeLessThan(400);
  expect(results.warmCaptureP95Ms).toBeLessThan(150);
  expect(results.previewApplyAndStyleP95Ms).toBeLessThan(16);
  expect(results.export50EditsMs).toBeLessThan(100);
  expect(results.auditMs).toBeLessThan(3000);
  expect(heapAfter-heapBefore).toBeLessThan(8*1024*1024);
});
