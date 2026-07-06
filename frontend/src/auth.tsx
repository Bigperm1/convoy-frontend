import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, saveToken, getToken, clearToken } from "./api";
import * as AppleAuthentication from "expo-apple-authentication";
import { signInWithGoogle } from "./googleAuth";

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [token, setToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const t = await getToken();
      if (!t) {
        setUser(null);
        setToken(null);
        return;
      }
      setToken(t);
      const { data } = await api.get("/auth/me");
      setUser(data);
    } catch {
      await clearToken();
      setUser(null);
      setToken(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (email: string, password: string) => {
    const { data } = await api.post("/auth/login", { email, password });
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
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
  };

  // Returns true when signed in, false if the user cancelled the Google sheet.
  const loginWithGoogle = async (): Promise<boolean> => {
    const idToken = await signInWithGoogle();
    if (!idToken) return false;
    const { data } = await api.post("/auth/google", { id_token: idToken });
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
    return true;
  };

  const register = async (payload: any) => {
    const { data } = await api.post("/auth/register", payload);
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
  };

  const logout = async () => {
    await clearToken();
    setToken(null);
    setUser(null);
  };

  return <Ctx.Provider value={{ user, token, login, loginWithApple, loginWithGoogle, register, logout, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
