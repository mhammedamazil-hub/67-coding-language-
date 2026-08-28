/** Register the offline service worker in production builds. */
if (location.protocol !== 'file:' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../../public/sw.js', import.meta.url), { type: 'classic' }).catch(() => {
      // Offline support is best-effort; the app works without a SW.
    });
  });
}
