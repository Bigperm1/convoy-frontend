import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api, saveToken, getToken, clearToken } from "./api";
import * as AppleAuthentication from "expo-apple-authentication";
import { signInWithGoogle } from "./googleAuth";
import { setBreadcrumbHandle } from "./crashBreadcrumb";

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

type AuthCtx = {
  user: User | null | undefined; // undefined = loading
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  loginWithApple: () => Promise<void>;
  loginWithGoogle: () => Promise<boolean>;
  register: (data: any) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [token, setToken] = useState<string | null>(null);
  // Telemetry rows carry the signed-in handle (crash_reports.handle, 2026-08-21).
  useEffect(() => { try { setBreadcrumbHandle(user?.handle ?? null); } catch {} }, [user]);

  // True when the last refresh failed for a REACHABILITY reason, so we are running on
  // the cached profile and should try again the next time the app comes forward.
  const staleRef = React.useRef(false);

  const refresh = useCallback(async () => {
    const t = await getToken().catch(() => null);
    if (!t) {
      // No token at all is the one unambiguous signed-out state.
      staleRef.current = false;
      await cacheUser(null);
      setUser(null);
      setToken(null);
      return;
    }
    setToken(t);
    try {
      const { data } = await api.get("/auth/me");
      staleRef.current = false;
      setUser(data);
      void cacheUser(data);
    } catch (e: any) {
      if (isAuthRejection(e)) {
        // The server says this token is done — a real logout.
        staleRef.current = false;
        await clearToken();
        await cacheUser(null);
        setUser(null);
        setToken(null);
        return;
      }
      // Could not reach the server. KEEP the token and run on the last known
      // profile, so an offline launch continues into the app instead of bouncing
      // to a login screen that also needs the network.
      staleRef.current = true;
      const cached = await readCachedUser();
      // No cache (first ever launch offline, or a pre-fix install that never wrote
      // one) → signed out for now, but the token STAYS so the retry below can
      // recover the session the moment there is signal.
      setUser(cached);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Retry a reachability-failed refresh when the app comes forward. Without this a
  // driver who launched underground would run on the cached profile for the whole
  // session, and anyone with no cache would stay stuck at the login screen even
  // after regaining signal. Cheap: it only fires when the last attempt actually
  // failed to reach the server.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && staleRef.current) void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const login = async (email: string, password: string) => {
    const { data } = await api.post("/auth/login", { email, password });
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
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
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    void cacheUser(data.user);
  };

  // Returns true when signed in, false if the user cancelled the Google sheet.
  const loginWithGoogle = async (): Promise<boolean> => {
    const idToken = await signInWithGoogle();
    if (!idToken) return false;
    const { data } = await api.post("/auth/google", { id_token: idToken });
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    void cacheUser(data.user);
    return true;
  };

  const register = async (payload: any) => {
    const { data } = await api.post("/auth/register", payload);
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    void cacheUser(data.user);
  };

  const logout = async () => {
    await clearToken();
    await cacheUser(null);   // an explicit sign-out must not leave a profile behind
    setToken(null);
    setUser(null);
  };

  return <Ctx.Provider value={{ user, token, login, loginWithApple, loginWithGoogle, register, logout, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
