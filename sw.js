// === Aladdin Service Worker (v398) ===
// 戦略:
//   - HTML/JS/CSS/JSON/TXT: network-first (ネット失敗時にキャッシュフォールバック)
//     → 常に最新のコードを取得、確実にバージョン更新
//   - フォント・画像: cache-first (高速表示・オフライン対応)
//   - その他: network-first
//
// SW のバージョンは clinic-analysis のリリース毎に手動で更新する (キャッシュ名で版管理)
const CACHE_VERSION = 'aladdin-cache-v1';
const RUNTIME_CACHE = 'aladdin-runtime-v1';

self.addEventListener('install', (event) => {
  // 新SW を即座に有効化 (waiting 状態を skip)
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 旧キャッシュ削除
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k !== CACHE_VERSION && k !== RUNTIME_CACHE)
        .map(k => caches.delete(k))
    );
    // すべてのクライアント (タブ) を即時制御下に
    await self.clients.claim();
  })());
});

// fetch ハンドラ
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // POST等は無視
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase API・GAS等は SW を介さず素通し
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('googleusercontent.com') ||
    url.hostname.includes('googleapis.com') && url.pathname.includes('scripts')
  ) return;

  // HTML/JS/CSS/JSON/TXT: network-first
  const isCodeAsset =
    req.mode === 'navigate' ||
    /\.(html?|js|mjs|css|json|txt)$/.test(url.pathname);

  if (isCodeAsset) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        // 成功時はランタイムキャッシュに保存 (オフライン用)
        try {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
        } catch(_){}
        return fresh;
      } catch (e) {
        // ネット失敗 → キャッシュ
        const cached = await caches.match(req);
        if (cached) return cached;
        // index.html (ルート) を fallback
        if (req.mode === 'navigate') {
          const root = await caches.match('./');
          if (root) return root;
        }
        throw e;
      }
    })());
    return;
  }

  // フォント・画像: cache-first
  const isAsset = /\.(woff2?|ttf|otf|png|jpe?g|svg|gif|webp|ico)$/i.test(url.pathname)
    || url.hostname === 'fonts.gstatic.com'
    || url.hostname === 'fonts.googleapis.com';

  if (isAsset) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        try {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
        } catch(_){}
        return fresh;
      } catch (e) { throw e; }
    })());
    return;
  }

  // それ以外: network-first
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch (e) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw e;
    }
  })());
});

// クライアントからのメッセージ (例: 強制更新)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
