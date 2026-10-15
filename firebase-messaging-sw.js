/* Trip Split: service worker for closed-app alerts (Firebase Cloud Messaging).
   It only shows alerts. It has no fetch handler and caches nothing, so the app
   itself still loads from the network exactly as before.

   The page registers this file with scope "./" (the trip-split folder), so it
   never touches the other site that lives on the same github.io domain. */

// Registered first, as the Firebase docs require for custom handlers.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "";
  const target = new URL(link, self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope) && "focus" in w) {
        try { if (w.url !== target && "navigate" in w) await w.navigate(target); } catch (e) { /* fall through */ }
        return w.focus();
      }
    }
    return clients.openWindow(target);
  })());
});

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

// Public client identifiers (same as index.html), not secrets.
firebase.initializeApp({
  apiKey: "AIzaSyBNpyrEzaU2x-3z8Xf1xhuQzri5f8eNCVg",
  authDomain: "spark-610ee.firebaseapp.com",
  projectId: "spark-610ee",
  storageBucket: "spark-610ee.firebasestorage.app",
  messagingSenderId: "505264928481",
  appId: "1:505264928481:web:421d7ea9aeffcea03c29a0"
});

const messaging = firebase.messaging();

// Messages are data-only (title/body/tag/link), so this handler is what shows them.
messaging.onBackgroundMessage(async payload => {
  const d = (payload && payload.data) || {};
  // If this very trip is open and in front, the page already shows its own alert.
  // Only count windows inside this app's folder and on the same trip: another
  // trip, or another site on the same github.io domain, must not swallow it.
  const target = new URL(d.link || "", self.registration.scope);
  const tripOf = u => new URL(u).searchParams.get("trip") || "";
  const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
  if (wins.some(w => w.visibilityState === "visible"
      && w.url.startsWith(self.registration.scope)
      && tripOf(w.url) === tripOf(target.href))) return;
  return self.registration.showNotification(d.title || "Trip Split", {
    body: d.body || "",
    tag: d.tag || undefined, // same tag as the in-app alert, so they replace each other
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { link: d.link || "" }
  });
});
