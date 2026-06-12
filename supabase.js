'use strict';

/* ══════════════════════════════════════════════════════════
   Sip Tracker — Supabase cloud sync layer

   Offline-first design:
   • IndexedDB (via Storage) is always the source of truth.
   • This file wraps Storage so every mutation also queues a
     sync op. The queue is persisted in the existing `meta`
     table and is flushed when online + authenticated.
   • Auth state changes (sign-in / token refresh) trigger a
     bidirectional merge (LWW by id for drinks, LWW by row
     presence for settings).
   • If @supabase/supabase-js isn't loaded (offline first run
     before SW caches the CDN copy), this whole IIFE is a
     no-op — the app keeps working exactly as before.

   This file is .gitignored — it carries connection keys.
   Anon keys are public-safe, but we keep them out of git so
   forks/clones don't ship someone else's project URL.
   ══════════════════════════════════════════════════════════ */

const SUPABASE_URL      = 'https://bjhkcyynyutvjvmhqnmq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ChAsP6gLpt4p9-OeJhtEbA_Dv1kLX-z';

(function () {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.info('[sync] @supabase/supabase-js not loaded — cloud sync disabled');
    window.CloudSync = null;
    return;
  }

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession:     true,
      autoRefreshToken:   true,
      detectSessionInUrl: true,
      storageKey:         'sip-supabase-auth'
    }
  });

  /* ── State ─────────────────────────────────────────────── */
  const QUEUE_KEY        = 'syncQueue';
  const LAST_USER_KEY    = 'lastSyncedUserId';
  const FLUSH_DEBOUNCE   = 600;
  const QUEUE_SAVE_DELAY = 150;

  let bridge          = null;     // injected by index.html boot
  let queue           = [];
  let queueSaveTid    = null;
  let flushTid        = null;
  let flushing        = false;
  let currentUserId   = null;
  let currentEmail    = null;
  let syncing         = false;
  const statusListeners = [];

  // Auth events can fire before init() finishes; gate them on this.
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  /* ── Status ────────────────────────────────────────────── */
  function status() {
    return {
      signedIn: !!currentUserId,
      email:    currentEmail,
      online:   navigator.onLine,
      pending:  queue.length,
      syncing
    };
  }

  function notifyStatus() {
    const s = status();
    statusListeners.forEach(cb => { try { cb(s); } catch (_) { /* ignore */ } });
  }

  /* ── Queue persistence ─────────────────────────────────── */
  async function loadQueue() {
    try {
      const row = await bridge.db.meta.get(QUEUE_KEY);
      return Array.isArray(row && row.value) ? row.value : [];
    } catch { return []; }
  }

  function persistQueue() {
    clearTimeout(queueSaveTid);
    queueSaveTid = setTimeout(() => {
      bridge.db.meta.put({ key: QUEUE_KEY, value: queue })
        .catch(err => console.warn('[sync] queue persist failed:', err));
    }, QUEUE_SAVE_DELAY);
  }

  function enqueueOp(op) {
    // Pre-sign-in writes are absorbed by the next fullSync's "push
    // missing local rows" step, so we don't need to queue them.
    if (!currentUserId) return;
    op.queuedAt = Date.now();
    queue.push(op);
    notifyStatus();
    persistQueue();
    scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(flushTid);
    flushTid = setTimeout(flushQueue, FLUSH_DEBOUNCE);
  }

  /* ── Queue flush ───────────────────────────────────────── */
  async function flushQueue() {
    if (flushing)              return;
    if (!navigator.onLine)     return;
    if (!currentUserId)        return;
    if (queue.length === 0)    return;

    flushing = true; notifyStatus();
    try {
      while (queue.length) {
        const ok = await runOp(queue[0]);
        if (!ok) break;
        queue.shift();
        persistQueue();
        notifyStatus();
      }
    } finally {
      flushing = false; notifyStatus();
    }
  }

  async function runOp(op) {
    try {
      if (op.op === 'upsert_drink') {
        const d = op.payload;
        const { error } = await client.from('drinks').upsert({
          id: d.id, user_id: currentUserId, type: d.type, timestamp: d.timestamp
        });
        if (error) throw error;
      } else if (op.op === 'delete_drink') {
        const { error } = await client.from('drinks').delete()
          .eq('id', op.payload.id).eq('user_id', currentUserId);
        if (error) throw error;
      } else if (op.op === 'clear_drinks') {
        const { error } = await client.from('drinks').delete().eq('user_id', currentUserId);
        if (error) throw error;
      } else if (op.op === 'replace_drinks') {
        const { error: delErr } = await client.from('drinks').delete().eq('user_id', currentUserId);
        if (delErr) throw delErr;
        const rows = (op.payload || []).map(d => ({
          id: d.id, user_id: currentUserId, type: d.type, timestamp: d.timestamp
        }));
        if (rows.length) {
          const { error: insErr } = await client.from('drinks').insert(rows);
          if (insErr) throw insErr;
        }
      } else if (op.op === 'upsert_settings') {
        const { error } = await client.from('settings').upsert({
          user_id: currentUserId,
          data: op.payload,
          updated_at: new Date().toISOString()
        });
        if (error) throw error;
      } else {
        console.warn('[sync] unknown op:', op.op);
      }
      return true;
    } catch (err) {
      console.warn('[sync] op failed:', op.op, err);
      return false;
    }
  }

  /* ── Full sync (bidirectional merge) ───────────────────── */
  async function fullSync() {
    if (!currentUserId)    return;
    if (!navigator.onLine) return;

    syncing = true; notifyStatus();
    try {
      // If a different account signed in on this device, wipe local
      // drinks so we don't bleed previous data into the new account.
      const lastRow    = await bridge.db.meta.get(LAST_USER_KEY).catch(() => null);
      const lastUserId = lastRow && lastRow.value;
      if (lastUserId && lastUserId !== currentUserId) {
        await bridge.db.drinks.clear();
        bridge.setDrinks([]);
      }
      await bridge.db.meta.put({ key: LAST_USER_KEY, value: currentUserId });

      // Pull from server
      const [drinksRes, settingsRes] = await Promise.all([
        client.from('drinks').select('id, type, timestamp').eq('user_id', currentUserId),
        client.from('settings').select('data, updated_at').eq('user_id', currentUserId).maybeSingle()
      ]);
      if (drinksRes.error)   throw drinksRes.error;
      if (settingsRes.error) throw settingsRes.error;

      const serverDrinks = drinksRes.data || [];
      const localDrinks  = bridge.drinks() || [];
      const serverIds    = new Set(serverDrinks.map(d => d.id));

      // Merge drinks — union by id (LWW falls out trivially since
      // drinks are immutable post-creation; same id = same content).
      const byId = new Map();
      localDrinks.forEach(d => byId.set(d.id, d));
      serverDrinks.forEach(d => {
        if (!byId.has(d.id)) {
          byId.set(d.id, { id: d.id, type: d.type, timestamp: d.timestamp });
        }
      });
      const mergedDrinks = Array.from(byId.values())
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Replace local IDB. We touch db.drinks directly (not Storage)
      // to avoid re-enqueueing ops we just synced.
      await bridge.db.transaction('rw', bridge.db.drinks, async () => {
        await bridge.db.drinks.clear();
        if (mergedDrinks.length) await bridge.db.drinks.bulkPut(mergedDrinks);
      });
      bridge.setDrinks(mergedDrinks);

      // Push drinks that only exist locally
      const toPush = localDrinks
        .filter(d => !serverIds.has(d.id))
        .map(d => ({ id: d.id, user_id: currentUserId, type: d.type, timestamp: d.timestamp }));
      if (toPush.length) {
        const { error } = await client.from('drinks').upsert(toPush);
        if (error) console.warn('[sync] push drinks failed:', error);
      }

      // Settings: server wins if present, else push local up
      const serverSettings = settingsRes.data;
      if (serverSettings && serverSettings.data) {
        const mergedSettings = bridge.mergeSettings(serverSettings.data);
        bridge.setSettings(mergedSettings);
        await bridge.db.meta.put({ key: 'settings', value: mergedSettings });
      } else {
        const { error } = await client.from('settings').upsert({
          user_id: currentUserId,
          data: bridge.settings(),
          updated_at: new Date().toISOString()
        });
        if (error) console.warn('[sync] push settings failed:', error);
      }

      bridge.rerenderAll();
    } catch (err) {
      console.warn('[sync] full sync failed:', err);
    } finally {
      syncing = false; notifyStatus();
    }
  }

  /* ── Hook Storage methods ──────────────────────────────── */
  function hookStorage() {
    const S = bridge.Storage;
    if (S.__synced) return;
    S.__synced = true;

    const orig = {
      addDrink:      S.addDrink.bind(S),
      deleteDrink:   S.deleteDrink.bind(S),
      clearDrinks:   S.clearDrinks.bind(S),
      replaceDrinks: S.replaceDrinks.bind(S),
      saveSettings:  S.saveSettings.bind(S)
    };

    S.addDrink      = d   => orig.addDrink(d).then(r      => { enqueueOp({ op: 'upsert_drink',    payload: d });        return r; });
    S.deleteDrink   = id  => orig.deleteDrink(id).then(r  => { enqueueOp({ op: 'delete_drink',    payload: { id } });   return r; });
    S.clearDrinks   = ()  => orig.clearDrinks().then(r    => { enqueueOp({ op: 'clear_drinks' });                       return r; });
    S.replaceDrinks = arr => orig.replaceDrinks(arr).then(r => { enqueueOp({ op: 'replace_drinks', payload: arr });     return r; });
    S.saveSettings  = s   => orig.saveSettings(s).then(r  => { enqueueOp({ op: 'upsert_settings', payload: s });        return r; });
  }

  /* ── Auth subscription ─────────────────────────────────── */
  client.auth.onAuthStateChange(async (event, session) => {
    await ready;  // hold until CloudSync.init has loaded queue / hooked storage

    if (session && session.user) {
      currentUserId = session.user.id;
      currentEmail  = session.user.email || null;
    } else {
      currentUserId = null;
      currentEmail  = null;
    }
    notifyStatus();

    if (event === 'SIGNED_OUT') {
      // Drop pending ops — they belong to the previous user. Local
      // IDB data is preserved so the user can keep tracking offline.
      queue = [];
      persistQueue();
      notifyStatus();
      return;
    }

    if (!currentUserId) return;

    // Strip magic-link tokens from URL hash
    if (window.location.hash.includes('access_token=')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    // Push pending changes from a previous session before reconciling.
    try { await flushQueue(); } catch (_) {}

    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
      try { await fullSync(); } catch (_) {}
    }
  });

  /* ── Online / offline ──────────────────────────────────── */
  window.addEventListener('online',  () => { notifyStatus(); if (currentUserId) flushQueue(); });
  window.addEventListener('offline',  notifyStatus);

  /* ── Public API ────────────────────────────────────────── */
  window.CloudSync = {
    async init(b) {
      bridge = b;
      hookStorage();
      queue = await loadQueue();
      resolveReady();
      notifyStatus();
    },
    async signIn(email) {
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo }
      });
      if (error) throw error;
    },
    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    },
    onStatusChange(cb) {
      statusListeners.push(cb);
      cb(status());
    },
    getStatus: status
  };
})();
