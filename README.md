# Sip Tracker

> A lightweight, offline-first drink tracking PWA — built because every other app required an internet connection and had animations that bogged it down.

![Live](https://img.shields.io/badge/live-github%20pages-brightgreen)
![PWA](https://img.shields.io/badge/PWA-offline%20ready-blue)

---

## Live App

**[https://jamestill-dev.github.io/sip-tracker/](https://jamestill-dev.github.io/sip-tracker/)**

On iPhone: Safari → Share → Add to Home Screen for a full native-like experience.

---

## Features

- **One-tap logging** — track beer, wine, and liquor with + / − buttons
- **Configurable settings** — set cost and calories per drink type, weekly limit goal
- **Weekly progress bar** — segmented by drink type, turns red when you're over limit
- **History view** — calendar with drink intensity dots + scrollable day-by-day log
- **Stats screen** — charts showing trends over time
- **Fully offline** — works with zero internet connection, data stored in IndexedDB
- **Cloud sync** — optional magic link email login backs up and syncs across devices via Supabase
- **Export / Import** — download your data as JSON anytime

---

## Usage

1. Open the app and tap **+** to log a drink
2. Tap the **cog icon** to open Settings and configure costs, calories, and your weekly limit
3. View your history and stats via the bottom navigation
4. Optionally sign in under **Cloud Sync** with your email to enable backup and cross-device sync

---

## Tech Stack

| Layer | Tool |
|---|---|
| Frontend | Vanilla HTML / CSS / JS |
| Local storage | [Dexie.js](https://dexie.org/) (IndexedDB wrapper) |
| Auth + cloud sync | [Supabase](https://supabase.com/) |
| Offline support | Service Worker (PWA) |
| Hosting | GitHub Pages |

---

## Self-Hosting

1. Clone the repo
2. Create a [Supabase](https://supabase.com/) project and run `supabase-schema.sql` in the SQL Editor
3. Create a `supabase.js` file in the root with your project URL and publishable key (see `supabase-schema.sql` for the expected format)
4. Add your app's URL to Supabase → Authentication → URL Configuration → Redirect URLs
5. Serve with any static file server

> `supabase.js` is excluded from the repo via `.gitignore`. The app works fully offline without it — cloud sync is optional.

---

## License

MIT
