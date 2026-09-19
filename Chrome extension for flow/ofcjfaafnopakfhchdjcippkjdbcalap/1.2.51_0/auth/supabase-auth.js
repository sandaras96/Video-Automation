// =============================================
// ViralDNA Auto Flow — Supabase Auth (Google)
// Harici SDK yok: GoTrue REST + PKCE.
// chrome.identity.launchWebAuthFlow ile Supabase'in Google
// sağlayıcısı üzerinden giriş yapılır. Aynı Supabase projesi/auth.users
// paylaşılır; Pro durumu entitlements tablosundan okunur.
// =============================================
(function (g) {

  const SESSION_KEY = 'sb_session';

  function cfg() {
    return (typeof AUTOFLOW_CONFIG !== 'undefined') ? AUTOFLOW_CONFIG : {};
  }
  function base() {
    return (cfg().SUPABASE_URL || '').replace(/\/+$/, '');
  }
  function anon() {
    return cfg().SUPABASE_ANON_KEY || '';
  }
  function isConfigured() {
    const b = base(), a = anon();
    return !!b && !b.includes('YOUR_') && !!a && !a.includes('YOUR_');
  }

  // ── PKCE yardımcıları ───────────────────────────────
  function b64url(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomVerifier() {
    const a = new Uint8Array(64);
    crypto.getRandomValues(a);
    return b64url(a.buffer);
  }
  async function challengeOf(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return b64url(digest);
  }

  // ── Oturum saklama ──────────────────────────────────
  async function getStored() {
    const o = await chrome.storage.local.get(SESSION_KEY);
    return o[SESSION_KEY] || null;
  }
  async function setStored(sess) {
    await chrome.storage.local.set({ [SESSION_KEY]: sess });
  }
  async function clearStored() {
    await chrome.storage.local.remove(SESSION_KEY);
  }

  function sessionFromTokens(d) {
    const expiresAt = Date.now() + (parseInt(d.expires_in || '3600', 10) * 1000);
    return {
      access_token:  d.access_token,
      refresh_token: d.refresh_token,
      expires_at:    expiresAt,
      user:          d.user || null
    };
  }

  // ── Giriş ───────────────────────────────────────────
  async function signInWithGoogle() {
    if (!isConfigured()) throw new Error('not-configured');

    const redirectUrl = chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/
    const verifier = randomVerifier();
    const chal     = await challengeOf(verifier);

    const authUrl = `${base()}/auth/v1/authorize?provider=google`
      + `&redirect_to=${encodeURIComponent(redirectUrl)}`
      + `&code_challenge=${encodeURIComponent(chal)}`
      + `&code_challenge_method=s256`;

    const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    const session  = await parseRedirect(redirect, verifier);
    if (!session || !session.access_token) throw new Error('no-session');

    await setStored(session);
    // Kullanıcı bilgisi eksikse çek
    if (!session.user) await getUser();
    return session;
  }

  async function parseRedirect(redirectUrl, verifier) {
    const u = new URL(redirectUrl);
    const hash  = new URLSearchParams((u.hash || '').replace(/^#/, ''));
    const query = u.searchParams;

    const errd = query.get('error_description') || hash.get('error_description');
    if (errd) throw new Error(errd);

    // Implicit akış (fragment'te token)
    if (hash.get('access_token')) {
      return sessionFromTokens({
        access_token:  hash.get('access_token'),
        refresh_token: hash.get('refresh_token'),
        expires_in:    hash.get('expires_in')
      });
    }

    // PKCE akışı (query'de code) → token ile takas
    const code = query.get('code');
    if (code) {
      const res = await fetch(`${base()}/auth/v1/token?grant_type=pkce`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', apikey: anon() },
        body:    JSON.stringify({ auth_code: code, code_verifier: verifier })
      });
      if (!res.ok) throw new Error('token-exchange-failed');
      return sessionFromTokens(await res.json());
    }
    return null;
  }

  // ── Yenileme ────────────────────────────────────────
  async function refresh(session) {
    const res = await fetch(`${base()}/auth/v1/token?grant_type=refresh_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon() },
      body:    JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) throw new Error('refresh-failed');
    const s = sessionFromTokens(await res.json());
    await setStored(s);
    return s;
  }

  async function getValidSession() {
    let s = await getStored();
    if (!s) return null;
    if (Date.now() > (s.expires_at - 60000)) {
      try { s = await refresh(s); }
      catch (_) { await clearStored(); return null; }
    }
    return s;
  }

  // ── Kullanıcı ───────────────────────────────────────
  async function getUser() {
    const s = await getValidSession();
    if (!s) return null;
    if (s.user) return s.user;
    const res = await fetch(`${base()}/auth/v1/user`, {
      headers: { apikey: anon(), Authorization: `Bearer ${s.access_token}` }
    });
    if (!res.ok) return null;
    const user = await res.json();
    s.user = user;
    await setStored(s);
    return user;
  }

  // ── Çıkış ───────────────────────────────────────────
  async function signOut() {
    const s = await getStored();
    if (s) {
      try {
        await fetch(`${base()}/auth/v1/logout`, {
          method:  'POST',
          headers: { apikey: anon(), Authorization: `Bearer ${s.access_token}` }
        });
      } catch (_) {}
    }
    await clearStored();
  }

  // ── Yetki (Pro) — Stripe fazında doldurulacak ───────
  // entitlements tablosu: user_id, product, plan, status, current_period_end
  // RLS: kullanıcı yalnızca kendi satırını okuyabilir.
  async function getEntitlement() {
    const def = { plan: 'free', pro: false };
    if (!isConfigured()) return def;
    const s = await getValidSession();
    if (!s) return def;
    try {
      const url = `${base()}/rest/v1/entitlements`
        + `?select=plan,status,current_period_end`
        + `&product=eq.autoflow&limit=1`;
      const res = await fetch(url, {
        headers: { apikey: anon(), Authorization: `Bearer ${s.access_token}` }
      });
      if (!res.ok) return def;
      const rows = await res.json();
      const row  = Array.isArray(rows) ? rows[0] : null;
      if (!row) return def;
      const active = row.status === 'active' || row.status === 'trialing';
      const notExpired = !row.current_period_end || (new Date(row.current_period_end).getTime() > Date.now());
      return {
        plan: row.plan || 'free',
        pro:  active && notExpired && (row.plan && row.plan !== 'free'),
        raw:  row
      };
    } catch (_) {
      return def;
    }
  }

  g.SBAuth = {
    isConfigured,
    signInWithGoogle,
    signOut,
    getUser,
    getValidSession,
    getEntitlement,
    getRedirectURL: () => chrome.identity.getRedirectURL()
  };

})(globalThis);
