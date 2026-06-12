// SaverPro service worker
// Minimal: enables "Add to Home Screen" / installability.
// Does not cache aggressively since financial data must always be fresh.

const VERSION = "v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

// Network-first, no offline cache for API or HTML —
// financial data should never be served stale.
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return new Response(
        "You're offline. Please reconnect to use SaverPro.",
        { status: 503, headers: { "Content-Type": "text/plain" } }
      );
    })
  );
});
