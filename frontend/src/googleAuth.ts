// googleAuth.ts — Google Sign-In config + one-shot helper.
//
// Client IDs are from the Google Cloud project `convoy-5c1c3`. The iOS client
// drives the native sign-in sheet; the Web client is the id_token audience that
// the backend (/auth/google) verifies. Both are safe to ship in the app (client
// IDs are public; there is no secret here).
import { GoogleSignin } from "@react-native-google-signin/google-signin";

export const GOOGLE_IOS_CLIENT_ID = "661488764764-6t8fkojm7gnkdjfp6k83dbnbnrjchtt3.apps.googleusercontent.com";
export const GOOGLE_WEB_CLIENT_ID = "661488764764-3t1ha6h0mtk6bpgi53ifkfcqhtufdh6g.apps.googleusercontent.com";

let _configured = false;
function ensureConfigured() {
  if (_configured) return;
  GoogleSignin.configure({
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    webClientId: GOOGLE_WEB_CLIENT_ID,
    scopes: ["profile", "email"],
  });
  _configured = true;
}

// Runs the native Google sign-in and returns the id_token (verified server-side),
// or null if the user cancelled. Throws on real errors so the caller can alert.
export async function signInWithGoogle(): Promise<string | null> {
  ensureConfigured();
  try { await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: false }); } catch {}
  const res: any = await GoogleSignin.signIn();
  if (res?.type === "cancelled") return null;
  // v13+ returns { type:'success', data:{ idToken } }; older returns { idToken }.
  const idToken = res?.data?.idToken ?? res?.idToken;
  return idToken || null;
}
