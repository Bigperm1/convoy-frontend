import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api, saveToken, readTokenState, clearToken } from "./api";
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
export type RefreshSrc = "boot" | "fg" | "retry" | "manual";

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
  logout: () => Promise<void>;
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

async function cacheUser(u: User | null): Promise<void> {
  try {
    if (u) await AsyncStorage.setItem(USER_KEY, JSON.stringify(u));
    else await AsyncStorage.removeItem(USER_KEY);
  } catch {}
}

async function readCachedUser(): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_KEY);
    const u = raw ? JSON.parse(raw) : null;
    // Guard the shape: a half-written or schema-changed blob must not become a
    // "signed in" user with no id, which would break every screen downstream.
    return (u && typeof u.id === "string") ? (u as User) : null;
  } catch {
    return null;
  }
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
//   1. token + cached profile → the profile is shown the moment the cache is read, BEFORE any network;
//      /auth/me confirms it afterwards (object identity kept when nothing changed, see sameUser).
//   2. token + NO cache + a reachability failure → `user` stays undefined and `connecting` is true:
//      the gate shows "Connecting…" and retries every 15 s (+ on foreground). Never the login screen.
//      Only a 401/403 FROM THE SERVER ends a session (unchanged).
//   3. the token store itself unreadable (iOS data protection before the first unlock, or a transient
//      read failure — api.ts readTokenState) → re-read once after TOKEN_REREAD_MS; still unreadable is
//      case 2, not "signed out". The old `getToken().catch(() => null)` made it the login screen (and
//      getToken() already swallowed the throw, so that catch never even ran).
//   4. every outcome writes `auth-refresh why=<ok|no-token|rejected:<status>|net:<code>|storage-unreadable>
//      cached=<0/1> ms=<t> src=<boot|fg|retry|manual>` with logEventReliable (plain logEvent drops rows
//      published before the Supabase client exists — RULES.md §3).
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
  // Every refresh, login and logout bumps the epoch; a /auth/me answer applies only if nothing newer
  // happened while it was in flight. Without this a slow boot answer (the 60 s budget) could re-sign-in
  // a driver who logged out at second 30, or overwrite a newer refresh's profile with an older one.
  const epochRef = useRef(0);
  // The epoch of the request in flight, for the AUTOMATIC sources: a 15 s retry or a foreground retry
  // must not stack a second request behind one still waiting out the 60 s budget.
  const inFlightRef = useRef<number | null>(null);

  const refresh = useCallback(async (srcArg: RefreshSrc = "manual") => {
    const src: RefreshSrc = typeof srcArg === "string" ? srcArg : "manual"; // tolerate onPress={refresh}
    if (inFlightRef.current !== null && (src === "retry" || src === "fg")) return;
    const epoch = ++epochRef.current;
    inFlightRef.current = epoch;
    const t0 = Date.now();
    const crumb = (why: string, cached: 0 | 1) => {
      try { logEventReliable(`auth-refresh why=${why} cached=${cached} ms=${Date.now() - t0} src=${src}`); } catch {}
    };
    try {
      let ts = await readTokenState();
      if (ts.state === "unreadable") {
        await new Promise<void>((r) => setTimeout(r, TOKEN_REREAD_MS));
        ts = await readTokenState();
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
        await cacheUser(null);
        setUser(null);
        setToken(null);
        crumb("no-token", 0);
        return;
      }
      setToken(t);
      const cached = await readCachedUser();
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
        if (epoch !== epochRef.current) { crumb("stale", cached ? 1 : 0); return; } // a login/logout/newer refresh won
        staleRef.current = false;
        setUser((prev) => (sameUser(prev, data) ? prev : data));
        setConnecting(false);
        void cacheUser(data);
        crumb("ok", cached ? 1 : 0);
      } catch (e: any) {
        if (epoch !== epochRef.current) { crumb("stale", cached ? 1 : 0); return; }
        if (isAuthRejection(e)) {
          // The server says this token is done — a real logout.
          staleRef.current = false;
          await clearToken();
          await cacheUser(null);
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
    } finally {
      if (inFlightRef.current === epoch) inFlightRef.current = null;
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
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    setConnecting(false);
    void cacheUser(data.user);
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
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    setConnecting(false);
    void cacheUser(data.user);
  };

  // Returns true when signed in, false if the user cancelled the Google sheet.
  const loginWithGoogle = async (): Promise<boolean> => {
    const idToken = await signInWithGoogle();
    if (!idToken) return false;
    const { data } = await api.post("/auth/google", { id_token: idToken });
    epochRef.current++;
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    setConnecting(false);
    void cacheUser(data.user);
    return true;
  };

  const register = async (payload: any) => {
    const { data } = await api.post("/auth/register", payload);
    epochRef.current++;
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    setConnecting(false);
    void cacheUser(data.user);
  };

  const logout = async () => {
    epochRef.current++;   // an /auth/me answer still in flight must not sign this driver back in
    await clearToken();
    await cacheUser(null);   // an explicit sign-out must not leave a profile behind
    setToken(null);
    setUser(null);
    setConnecting(false);
  };

  return <Ctx.Provider value={{ user, token, connecting, login, loginWithApple, loginWithGoogle, register, logout, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
