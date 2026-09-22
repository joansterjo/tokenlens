import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function checkRelease() {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a three-part release version, got ${version}`);
  const currentFiles = ['README.md', 'site/index.html', 'docs/verification.md', `docs/releases/v${version}.md`];
  const releaseBase = 'https://github.com/joansterjo/tokenlens/releases';
  for (const file of currentFiles) {
    const content = await readFile(join(root, file), 'utf8');
    // Historical release notes keep their original versions. Only current
    // release surfaces are checked against the package being published.
    const references = [
      ...content.matchAll(/releases\/download\/v(\d+\.\d+\.\d+)/g),
      ...(file === 'README.md' || file === 'site/index.html' ? content.matchAll(/releases\/tag\/v(\d+\.\d+\.\d+)/g) : []),
      ...content.matchAll(/tokenlens-(\d+\.\d+\.\d+)(?:-optional-permissions)?\.zip/g),
      ...content.matchAll(/\b(?:TokenLens [vV]?|Version |V)(\d+\.\d+\.\d+)/g),
    ];
    for (const match of references) {
      if (match[1] !== version) throw new Error(`${file}: stale release ${match[1]}; expected ${version}`);
    }
    if (file === 'README.md' || file === 'site/index.html') {
      for (const path of [`tag/v${version}`, `download/v${version}/tokenlens-${version}.zip`, `download/v${version}/tokenlens-${version}-optional-permissions.zip`]) {
        if (!content.includes(`${releaseBase}/${path}`)) throw new Error(`${file}: missing current release link ${path}`);
      }
    }
  }
  console.log(`Release content matches TokenLens ${version}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) await checkRelease();
