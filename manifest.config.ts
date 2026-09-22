import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest(({ mode }) => ({
  manifest_version: 3,
  name: 'TokenLens — Design token studio',
  version: '0.1.0',
  description: 'Pick elements, trace design tokens, edit styles live, and export CSS. Built by Joan Sterjo.',
  minimum_chrome_version: '120',
  permissions: mode === 'store' ? ['scripting', 'storage', 'activeTab'] : ['scripting', 'storage'],
  ...(mode === 'store' ? { optional_host_permissions: ['http://*/*', 'https://*/*'] } : { host_permissions: ['<all_urls>'] }),
  devtools_page: 'src/devtools/devtools.html',
  action: { default_popup: 'src/popup/popup.html', default_title: 'Open TokenLens' },
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [{
    matches: ['<all_urls>'], js: ['src/content/index.ts'], run_at: 'document_idle',
    all_frames: true, match_about_blank: true, match_origin_as_fallback: true,
  }],
}));
