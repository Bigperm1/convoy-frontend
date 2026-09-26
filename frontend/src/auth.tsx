import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { AppState, Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api, saveToken, readTokenState, clearToken, TOKEN_KEY, type TokenState } from "./api";
import * as AppleAuthentication from "expo-apple-authentication";
import { signInWithGoogle } from "./googleAuth";
import { setBreadcrumbHandle, logEventReliable } from "./crashBreadcrumb";

export type User = {
  id: string;
  email: string;
  handle: string;
  car_make?: string;
  car_model?: string;
  car_year?: number | null;
  car_color?: string;
  car_type?: string;
  top_speed_record?: number;
  lat?: number | null;
  lng?: number | null;
};

// Why a refresh ran — carried on the `auth-refresh` crumb so a boot row can be told from a retry.
// `tap` = the "Try again" button on the index gate's Connecting… screen: it JOINS a request already in flight
// (a profile save's `manual` refresh still always asks afresh — it needs the answer from after its PUT).
export type RefreshSrc = "boot" | "fg" | "retry" | "manual" | "tap";

type AuthCtx = {
  user: User | null | undefined; // undefined = loading, null = signed out (CLAUDE.md: keep this three-state contract)
  token: string | null;
  // True while a token is stored (or the token store cannot be read) but there is no profile to show and the
  // server has not answered yet. The index gate shows "Connecting…" and retries instead of the login screen.
  connecting: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithApple: () => Promise<void>;
  loginWithGoogle: () => Promise<boolean>;
  register: (data: any) => Promise<void>;
  // true = signed out (the token is confirmed gone from disk). false = it could not be removed: the session is
  // left exactly as it was and the driver is told ("Couldn't sign out") — never a login screen over a live token.
  logout: () => Promise<boolean>;
  refresh: (src?: RefreshSrc) => Promise<void>;
};

const Ctx = createContext<AuthCtx>({} as any);

// ── OFFLINE SESSION SURVIVAL (2026-07-30) ────────────────────────────────────
// The last profile /auth/me returned. It exists so that launching with no signal
// does not look like being signed out.
//
// THE BUG THIS FIXES: refresh()'s catch used to run clearToken() + setUser(null) for
// EVERY failure. A thrown request cannot tell "this token is no longer valid" from
// "there is no network", so opening the app in a parkade, a tunnel or a dead zone
// DELETED the saved session — and the login screen it then landed on also needs the
// network, so the driver was stranded until they had signal again. It also meant a
// Render cold start (that backend sleeps) could log people out on a slow morning.
//
// The rule now: only an explicit rejection FROM the server ends a session.
// ⚠ navNotification.ts reads this SAME key directly (its cold-arrival recordTrip).
// It deliberately does not import this module: auth pulls in
// @react-native-google-signin, whose spec calls TurboModuleRegistry.getEnforcing at
// MODULE SCOPE, and that throws in a headless background context — which would kill
// the location task that drives the car surface. Rename here = rename there.
const USER_KEY = "convoy_user";

// ── THE CACHED PROFILE IS BOUND TO ITS TOKEN (2026-09-25) ────────────────────────────────────────
// Booting from the cache (below) SHOWS whoever is in USER_KEY before the server is asked. The token and
// the profile are two separate AsyncStorage writes, and every helper here swallows its failures, so disk
// can hold token B next to profile A (a crash between saveToken and cacheUser, or a remove that silently
// failed) — and the gate would open the map as A until /auth/me answered for B (Codex, 2026-09-25;
// scratchpad codex_check_auth_1 R1). So each profile write also writes a tag of (profile id, token), and
// a cached profile is used only when the tag matches the token on disk right now. A tag for another
// token/id = no cache: the plain no-cache path ("Connecting…" until the server answers).
// NO tag at all = an install from before this change (round 2, 2026-09-25): its profile is used exactly as
// the shipped build uses it — offline it opens the map, as it always did — and the first /auth/me answer
// writes the tag (crumb ` bind=legacy`). For that to mean ONLY "from before the tag", this code must never
// leave a profile without a tag: the tag is written FIRST and the profile only if the tag landed, and every
// removal lists the profile before the tag (one multiRemove — atomic on both platforms: iOS writes the
// manifest once, Android deletes in one SQL transaction; a store that stops part-way leaves the tag).
// A SEPARATE key on purpose: navNotification.ts and crashBreadcrumb.ts parse USER_KEY's JSON directly.
// Not a secret: the token itself sits in plain AsyncStorage (api.ts TOKEN_KEY); this only has to tell
// two tokens apart.
const USER_TAG_KEY = "convoy_user_tok";

// cyrb53 (53-bit, public domain) — sync and dependency-free, enough to tell two tokens apart.
function hash53(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function userTag(id: string, token: string): string {
  return `v1.${hash53(`${id}\n${token}`)}`;
}

// Profile + tag are written and cleared together. A profile without a token to bind to is not cached.
// Tag first: a crash between the two leaves the NEW tag beside the old profile, which matches only if it is
// the same account; a tag write that fails skips the profile write (the throw lands in the catch).
async function cacheUser(u: User | null, token?: string | null): Promise<void> {
  try {
    if (u && token) {
      await AsyncStorage.setItem(USER_TAG_KEY, userTag(u.id, token));
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(u));
    } else {
      await AsyncStorage.multiRemove([USER_KEY, USER_TAG_KEY]);
    }
  } catch {}
}

// How the profile on disk relates to THIS token — carried on the auth-refresh crumb as ` bind=<…>` when not
// plain: `miss` = a tag for another token/id (not used), `legacy` = no tag at all, an install from before the
// tag (used, as shipped).
type Bind = "ok" | "miss" | "legacy" | "none";
async function readCachedUser(token: string): Promise<{ user: User | null; bind: Bind }> {
  try {
    const raw = await AsyncStorage.getItem(USER_KEY);
    const u = raw ? JSON.parse(raw) : null;
    // Guard the shape: a half-written or schema-changed blob must not become a
    // "signed in" user with no id, which would break every screen downstream.
    if (!(u && typeof u.id === "string")) return { user: null, bind: "none" };
    const tag = await AsyncStorage.getItem(USER_TAG_KEY);
    if (tag === null) return { user: u as User, bind: "legacy" };
    if (tag !== userTag(u.id, token)) return { user: null, bind: "miss" };
    return { user: u as User, bind: "ok" };
  } catch {
    return { user: null, bind: "none" };
  }
}

// ── EVERY STORAGE WAIT HAS A BUDGET (round 2, 2026-09-25) ────────────────────────────────────────────
// A storage call that never answers must not hold a refresh (or a sign-out) open for good: an open refresh
// blocks the 15 s / foreground retries, and "Try again" now waits on it. 5 s is ~100× a normal read; a read
// that runs out counts as unreadable — "Connecting…", never the login screen.
const STORAGE_BUDGET_MS = 5_000;
type Settled<T> = { ok: true; v: T } | { ok: false; why: "timeout" | "error" };
function settle<T>(p: Promise<T>, ms = STORAGE_BUDGET_MS): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, why: "timeout" }), ms);
    p.then(
      (v) => { clearTimeout(t); resolve({ ok: true, v }); },
      () => { clearTimeout(t); resolve({ ok: false, why: "error" }); },
    );
  });
}
async function readTokenWithin(): Promise<TokenState> {
  const r = await settle(readTokenState());
  return r.ok ? r.v : { token: null, state: "unreadable" };
}

// ── A SIGN-IN WRITES ITS TAG BEFORE ITS TOKEN (round 2, 2026-09-25) ──────────────────────────────────
// With a tag-less profile now meaning "an install from before the tag" (used as shipped), a new token must never
// land beside an old profile that no tag rules out. So: the new tag first (any older profile then mismatches);
// if that write fails, remove the old profile + tag first; if THAT fails too, the new token is not persisted —
// this launch stays signed in from memory, the next one finds the old account's own token + profile (never
// someone else's). Then the token, then the profile (only beside the tag that binds it).
// Receipt: the identity fuzz's pre-tag flows (auth_h/h1 fuzz.mts "legacy A -> …").
async function persistSession(u: User, token: string): Promise<void> {
  const tagged = await settle(AsyncStorage.setItem(USER_TAG_KEY, userTag(u.id, token)));
  if (!tagged.ok) {
    const cleared = await settle(AsyncStorage.multiRemove([USER_KEY, USER_TAG_KEY]));
    if (!cleared.ok) return;
  }
  await settle(saveToken(token));
  if (tagged.ok) await settle(AsyncStorage.setItem(USER_KEY, JSON.stringify(u)));
}

// Did the SERVER actively reject us, or did we simply never reach it? Only the
// former is a logout. 401/403 = this token is finished. Everything else — no
// network, DNS failure, timeout, 5xx, a sleeping Render dyno — is transient and must
// leave the session alone.
function isAuthRejection(e: any): boolean {
  const status = e?.response?.status;
  return status === 401 || status === 403;
}

// The failure, for the crumb: axios code (+ HTTP status when the server answered), e.g. `ERR_NETWORK`,
// `ECONNABORTED` (the 60 s budget ran out), `ERR_BAD_RESPONSE:503` (a Render deploy window).
function netCode(e: any): string {
  const code = e?.code ? String(e.code) : e?.message === "Network Error" ? "ERR_NETWORK" : "unknown";
  const status = e?.response?.status;
  return status ? `${code}:${status}` : code;
}

// Same profile? Then keep the object the screens already hold, so the `[user]` effects in
// app/(app)/_layout.tsx (device report, push token, garage claim) do not run a second time when the
// server merely confirms the cache.
function sameUser(a: User | null | undefined, b: User): boolean {
  try { return !!a && JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// ── BOOT FROM THE CACHE, CONFIRM IN THE BACKGROUND (2026-09-24) ──────────────────────────────────
// Rodrigo (iOS build 79) launched underground: a black spinner — the index gate waits for `user`, and
// refresh() sat on /auth/me behind the 60 s axios budget — then after a relaunch the Sign-in screen
// with his token still stored ("Apple sign in failed" = he tapped it with no network). This file had
// no crumbs, so which path put him there is NOT known (memory
// field-2026-09-24-tester-chat-compass-poll-and-three-issues). The rules now:
//   1. token + cached profile BOUND TO THAT TOKEN (USER_TAG_KEY above) → the profile is shown the moment
//      the cache is read, BEFORE any network; /auth/me confirms it afterwards (object identity kept when
//      nothing changed, see sameUser). A profile whose tag does not match is no cache at all (rule 2).
//      A profile with NO tag (an install from before the tag) is used as the shipped build uses it.
//   2. token + NO cache + a reachability failure → `user` stays undefined and `connecting` is true:
//      the gate shows "Connecting…" and retries every 15 s (+ on foreground). Never the login screen.
//      Only a 401/403 FROM THE SERVER ends a session (unchanged).
//   3. the token store itself unreadable (iOS data protection before the first unlock, or a transient
//      read failure — api.ts readTokenState — or a read that outlives STORAGE_BUDGET_MS) → re-read once
//      after TOKEN_REREAD_MS; still unreadable is case 2, not "signed out". The old
//      `getToken().catch(() => null)` made it the login screen (and getToken() already swallowed the throw,
//      so that catch never even ran).
//   4. every outcome writes `auth-refresh why=<ok|no-token|rejected:<status>|net:<code>|storage-unreadable|
//      stale> cached=<0/1> ms=<t> src=<boot|fg|retry|manual|tap>` (+ ` bind=miss|legacy`, see Bind) with
//      logEventReliable (plain logEvent drops rows published before the Supabase client exists — RULES.md §3).
//      A "Try again" that joins a request already running writes `auth-refresh join src=tap in-flight=<src>`.
// 250 ms: one runloop's worth of settling for the AsyncStorage manifest read, short enough that a
// signed-in launch still feels instant; Jeff's spec, 2026-09-24 ("retry getToken() once after 250 ms").
const TOKEN_REREAD_MS = 250;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [token, setToken] = useState<string | null>(null);
  // Telemetry rows carry the signed-in handle (crash_reports.handle, 2026-08-21).
  useEffect(() => { try { setBreadcrumbHandle(user?.handle ?? null); } catch {} }, [user]);

  const [connecting, setConnecting] = useState(false);
  // True when the last refresh failed for a REACHABILITY (or storage) reason, so we are running on
  // the cached profile — or on nothing — and should try again the next time the app comes forward.
  const staleRef = useRef(false);
  // The refresh callback has no deps, so it reads the current user through this mirror.
  const userRef = useRef<User | null | undefined>(undefined);
  useEffect(() => { userRef.current = user; }, [user]);
  // Every new refresh, login and logout bumps the epoch; a refresh applies what it learned only if nothing
  // newer happened while it waited (checked after EVERY wait, not just /auth/me). Without this a slow boot
  // answer (the 60 s budget) could re-sign-in a driver who logged out at second 30, or overwrite a newer
  // refresh's profile with an older one.
  const epochRef = useRef(0);
  // The request in flight and its promise. A 15 s retry or a foreground retry never stacks a second request
  // behind it, and a "Try again" tap WAITS ON IT (round 2, 2026-09-25): starting over would throw away an
  // answer that is already on its way (measured: tap at ~75 s → map at ~109 s instead of ~90 s).
  const inFlightRef = useRef<{ epoch: number; src: RefreshSrc; p: Promise<void> } | null>(null);
  // Set by logout() and held until a sign-in (or an explicit refresh — a Try again, a profile save): while it
  // is set nothing AUTOMATIC (the 15 s retry, the foreground retry) may bring the session back in this
  // process. It matters when a sign-out could not remove the token: the driver asked to leave and was told
  // it failed; a retry quietly landing them on the map would be the session coming back behind their back.
  const signOutRef = useRef(false);

  const refresh = useCallback((srcArg: RefreshSrc = "manual"): Promise<void> => {
    const src: RefreshSrc = typeof srcArg === "string" ? srcArg : "manual"; // tolerate onPress={refresh}
    if (signOutRef.current) {
      if (src === "boot" || src === "retry" || src === "fg") return Promise.resolve();
      signOutRef.current = false;   // the driver explicitly asked for the session
    }
    const cur = inFlightRef.current;
    if (cur && cur.epoch === epochRef.current) {
      if (src === "retry" || src === "fg") return cur.p;
      if (src === "tap") {
        try { logEventReliable(`auth-refresh join src=tap in-flight=${cur.src}`); } catch {}
        return cur.p;
      }
    }
    const epoch = ++epochRef.current;
    const p = runRefresh(epoch, src);
    inFlightRef.current = { epoch, src, p };
    const done = () => { if (inFlightRef.current?.epoch === epoch) inFlightRef.current = null; };
    p.then(done, done);
    return p;

    async function runRefresh(epoch: number, src: RefreshSrc): Promise<void> {
      const t0 = Date.now();
      let bind: Bind = "none";
      const crumb = (why: string, cached: 0 | 1) => {
        const b = bind === "miss" || bind === "legacy" ? ` bind=${bind}` : "";
        try { logEventReliable(`auth-refresh why=${why} cached=${cached} ms=${Date.now() - t0} src=${src}${b}`); } catch {}
      };
      // A login, a logout or a newer refresh happened while we waited: apply nothing.
      const superseded = () => epoch !== epochRef.current;
      let ts = await readTokenWithin();
      if (superseded()) { crumb("stale", 0); return; }
      if (ts.state === "unreadable") {
        await new Promise<void>((r) => setTimeout(r, TOKEN_REREAD_MS));
        ts = await readTokenWithin();
        if (superseded()) { crumb("stale", 0); return; }
      }
      if (ts.state === "unreadable") {
        // We cannot tell signed-in from signed-out: NOT a logout. Keep whatever is showing (undefined at
        // boot → "Connecting…"), and let the foreground / 15 s retries read the store again.
        staleRef.current = true;
        if (userRef.current === undefined) setConnecting(true);
        crumb("storage-unreadable", 0);
        return;
      }
      const t = ts.token;
      if (!t) {
        // No token at all is the one unambiguous signed-out state.
        staleRef.current = false;
        setConnecting(false);
        await settle(cacheUser(null));
        if (superseded()) { crumb("stale", 0); return; }
        setUser(null);
        setToken(null);
        crumb("no-token", 0);
        return;
      }
      const readR = await settle(readCachedUser(t));
      if (superseded()) { crumb("stale", 0); return; }
      const read = readR.ok ? readR.v : { user: null, bind: "none" as Bind };
      const cached = read.user;
      bind = read.bind;
      setToken(t);
      if (userRef.current === undefined) {
        if (cached) {
          // Render now — the index gate sends the driver to the map on this state — and confirm below.
          userRef.current = cached;
          setUser(cached);
          setConnecting(false);
        } else {
          // Nothing to show yet: "Connecting…" until the server answers (never the login screen).
          setConnecting(true);
        }
      }
      try {
        // The token goes on THIS request explicitly: the interceptor re-reads the store, and a read that
        // fails there would send the call unauthenticated — a 401 for a token that is perfectly good.
        const { data } = await api.get("/auth/me", { headers: { Authorization: `Bearer ${t}` } });
        if (superseded()) { crumb("stale", cached ? 1 : 0); return; } // a login/logout/newer refresh won
        staleRef.current = false;
        setUser((prev) => (sameUser(prev, data) ? prev : data));
        setConnecting(false);
        void cacheUser(data, t);   // (re)binds the profile to this token — the first one for a legacy cache
        crumb("ok", cached ? 1 : 0);
      } catch (e: any) {
        if (superseded()) { crumb("stale", cached ? 1 : 0); return; }
        if (isAuthRejection(e)) {
          // The server says this token is done — a real logout.
          staleRef.current = false;
          await settle(clearToken());
          await settle(cacheUser(null));
          setUser(null);
          setToken(null);
          setConnecting(false);
          crumb(`rejected:${e?.response?.status}`, cached ? 1 : 0);
          return;
        }
        // Could not reach the server. KEEP the token. A cached profile is already on screen; with none,
        // `user` stays undefined and `connecting` keeps the gate on "Connecting…" with its retries.
        staleRef.current = true;
        crumb(`net:${netCode(e)}`, cached ? 1 : 0);
      }
    }
  }, []);

  useEffect(() => {
    void refresh("boot");
  }, [refresh]);

  // Retry a reachability-failed refresh when the app comes forward. Without this a
  // driver who launched underground would run on the cached profile for the whole
  // session, and anyone with no cache would sit on "Connecting…" even after regaining
  // signal. Cheap: it only fires when the last attempt actually failed to reach the server.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && staleRef.current) void refresh("fg");
    });
    return () => sub.remove();
  }, [refresh]);

  const login = async (email: string, password: string) => {
    const { data } = await api.post("/auth/login", { email, password });
    epochRef.current++;
    signOutRef.current = false;
    await persistSession(data.user, data.token);
    setToken(data.token);
    setUser(data.user);
    setConnecting(false);
  };

  const loginWithApple = async () => {
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    // Apple returns name/email ONLY on the first authorization — forward them so the
    // backend can seed the profile; later sign-ins rely on the stable apple `sub`.
    const fullName = cred.fullName
      ? [cred.fullName.givenName, cred.fullName.familyName].filter(Boolean).join(" ") || undefined
      : undefined;
    const { data } = await api.post("/auth/apple", {
      identity_token: cred.identityToken,
      email: cred.email ?? undefined,
      full_name: fullName,
    });
    epochRef.current++;
    signOutRef.current = false;
    await persistSession(data.user, data.token);
    setToken(data.token);
    setUser(data.user);
    setConnecting(false);
  };

  // Returns true when signed in, false if the user cancelled the Google sheet.
  const loginWithGoogle = async (): Promise<boolean> => {
    const idToken = await signInWithGoogle();
    if (!idToken) return false;
    const { data } = await api.post("/auth/google", { id_token: idToken });
    epochRef.current++;
    signOutRef.current = false;
    await persistSession(data.user, data.token);
    setToken(data.token);
    setUser(data.user);
    setConnecting(false);
    return true;
  };

  const register = async (payload: any) => {
    const { data } = await api.post("/auth/register", payload);
    epochRef.current++;
    signOutRef.current = false;
    await persistSession(data.user, data.token);
    setToken(data.token);
    setUser(data.user);
    setConnecting(false);
  };

  // ── SIGN-OUT STICKS (round 2, 2026-09-25) ──────────────────────────────────────────────────────────
  // Token, profile and tag go in ONE multiRemove (profile listed before its tag — see USER_TAG_KEY), then the
  // token is read BACK. A sign-out = the store confirmed the remove AND the read-back does not find the token.
  // A remove that threw or ran out of budget, or a token still there, leaves the session exactly as it was and
  // says so. (A failed remove fails even if the read-back says "gone": iOS edits its in-memory manifest before
  // the disk write, so after a failed write the read-back can say gone while the disk keeps the token —
  // RNCAsyncStorage.mm multiRemove / _writeManifest. A confirmed remove whose read-back cannot answer counts:
  // the store itself said it was done.) The old code swallowed the failure and showed the login screen over a
  // live token, and the next foreground retry (staleRef was never reset) signed the driver straight back in
  // (scratchpad auth_verify_contract repro2 / auth_verify_escape V3b, V7). Crumb: `auth-signout ok=<0|1>
  // remove=<ok|error|timeout> token=<gone|present|unreadable> ms=`. ⚠ The Alert is a no-op on web
  // (react-native-web); the web build is not in use.
  const logout = async (): Promise<boolean> => {
    epochRef.current++;          // an /auth/me answer still in flight must not sign this driver back in
    staleRef.current = false;    // ...nor the foreground retry
    signOutRef.current = true;   // ...nor any automatic retry, even if this fails (see signOutRef)
    const t0 = Date.now();
    const rm = await settle(AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY, USER_TAG_KEY]));
    const back = await settle(AsyncStorage.getItem(TOKEN_KEY));
    const tok = !back.ok ? "unreadable" : back.v == null ? "gone" : "present";
    const ok = rm.ok && tok !== "present";
    try { logEventReliable(`auth-signout ok=${ok ? 1 : 0} remove=${rm.ok ? "ok" : rm.why} token=${tok} ms=${Date.now() - t0}`); } catch {}
    if (ok) {
      setToken(null);
      setUser(null);
      setConnecting(false);
      return true;
    }
    try {
      Alert.alert("Couldn't sign out", "Hairpin couldn't clear the saved sign-in on this phone. Try again.");
    } catch {}
    return false;
  };

  return <Ctx.Provider value={{ user, token, connecting, login, loginWithApple, loginWithGoogle, register, logout, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
