import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
export function pwa(): Plugin {
  return {
    name: 'wfd-public-pwa',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((p) => p.endsWith('.js') || p.endsWith('.css'))
        .map((p) => '/' + p);
      const version = createHash('sha256').update(assets.join(',')).digest('hex').slice(0, 16);
      const code = `const CACHE='wfd-shell-${version}';const ASSETS=${JSON.stringify(['/', '/index.html', ...assets])};self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('wfd-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/public/')||u.pathname.startsWith('/private/')||u.pathname.startsWith('/admin/'))return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));return;}if(ASSETS.includes(u.pathname))e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));});`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify({
          name: 'open sxgo',
          short_name: 'sxgo',
          start_url: '/',
          display: 'standalone',
          background_color: '#f7f9fc',
          theme_color: '#245b48',
        }),
      });
    },
  };
}
