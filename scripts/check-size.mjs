import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve('dist');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
async function graph(entry, seen = new Set()) {
  const path = join(root, entry);
  if (seen.has(path)) return seen;
  const text = await readFile(path, 'utf8');
  seen.add(path);
  for (const match of text.matchAll(/["']([^"'\s]+\.(?:js|css))["']/g)) {
    const name = match[1];
    if (/^https?:/.test(name)) continue;
    const dependency = name.startsWith('/assets/') || name.startsWith('assets/') ? name.replace(/^\//, '') : join(dirname(entry), name);
    try { await graph(dependency, seen); } catch { /* Not a module reference. */ }
  }
  return seen;
}
async function total(entries) {
  const files = new Set();
  for (const entry of entries) for (const file of await graph(entry)) files.add(file);
  let bytes = 0;
  for (const file of files) bytes += gzipSync(await readFile(file)).length;
  return { gzipBytes: bytes, files: [...files].map(f => f.slice(root.length + 1)) };
}
const content = await total(manifest.content_scripts.flatMap(script => script.js));
const panel = await total(['src/panel/panel.html']);
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve('vite'));
const esbuild = viteRequire('esbuild');
const bundle = await esbuild.build({ entryPoints: ['src/core/color/index.ts'], bundle: true, write: false, minify: true, format: 'esm', target: 'es2022' });
const usedExports = new Set();
for (const path of ['src/ui/editors.tsx', 'src/panel/App.tsx']) {
  const source = await readFile(path, 'utf8');
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\.\/core\/color['"]/g)) match[1].split(',').map(s => s.trim()).forEach(name => usedExports.add(name));
}
const picker = await esbuild.build({ stdin: { contents: `export {${[...usedExports].join(',')}} from './src/core/color/index.ts';`, resolveDir: resolve('.') }, bundle: true, write: false, minify: true, format: 'esm', target: 'es2022' });
const color = { gzipBytes: gzipSync(picker.outputFiles[0].contents).length, fullPublicApiGzipBytes: gzipSync(bundle.outputFiles[0].contents).length, measuredExports: [...usedExports], note: 'Budget covers color functions actually imported by the shipped UI; complete standalone API size is also recorded.' };
const result = { content, panel, color };
await writeFile('bundle-sizes.json', JSON.stringify(result, null, 2) + '\n');
let failed = false;
for (const [name, limit] of [['content', 60], ['panel', 350], ['color', 12]]) {
  const kb = result[name].gzipBytes / 1024;
  console.log(`${name}: ${kb.toFixed(2)} kB gzip / ${limit} kB budget`);
  if (kb > limit) failed = true;
}
if (failed) process.exitCode = 1;
