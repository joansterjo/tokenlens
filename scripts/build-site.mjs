import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkRelease } from './check-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.site-dist');
await checkRelease();
await readFile(join(root, 'site/index.html'));
await rm(output, { recursive: true, force: true });
await cp(join(root, 'site'), output, { recursive: true });
await mkdir(join(output, 'assets'), { recursive: true });
await cp(join(root, 'docs/ui'), join(output, 'assets'), { recursive: true });
await writeFile(join(output, '.nojekyll'), '');
await writeFile(join(output, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: https://joansterjo.github.io/tokenlens/sitemap.xml\n');
await writeFile(join(output, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://joansterjo.github.io/tokenlens/</loc></url></urlset>\n');
console.log('Built TokenLens product page in .site-dist/');
