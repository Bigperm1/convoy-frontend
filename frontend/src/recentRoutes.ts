// recentRoutes.ts — the driver's recently-navigated destinations, persisted to
// AsyncStorage so the full-screen search can offer them as quick re-pick rows
// (Google-Maps-style "Recents"). A "recent" is recorded when the user actually
// presses Start (or auto-starts by driving off), NOT on every search keystroke.
// Capped at 8, most-recent first, de-duped by rounded coordinate so the same
// place never stacks.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "convoy:recentRoutes";
const CAP = 8;

export type RecentRoute = { label: string; lat: number; lng: number; ts: number };

const coordKey = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

export async function getRecentRoutes(): Promise<RecentRoute[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r: any) => r && typeof r.lat === "number" && typeof r.lng === "number" && typeof r.label === "string"
    );
  } catch {
    return [];
  }
}

export async function addRecentRoute(r: { label: string; lat: number; lng: number }): Promise<RecentRoute[]> {
  try {
    if (!r || typeof r.lat !== "number" || typeof r.lng !== "number") return await getRecentRoutes();
    const list = await getRecentRoutes();
    const k = coordKey(r.lat, r.lng);
    const deduped = list.filter((x) => coordKey(x.lat, x.lng) !== k);
    const next: RecentRoute[] = [
      { label: r.label || "Dropped pin", lat: r.lat, lng: r.lng, ts: Date.now() },
      ...deduped,
    ].slice(0, CAP);
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}

export async function clearRecentRoutes(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {}
}
