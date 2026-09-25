// The privacy gate, driven by the test: "live" shares the fix it is given; "spot" shares the parked car spot.
const priv = { mode: "live", status: "live", spot: null };
export function __set(p) { Object.assign(priv, p); }
export function shareablePosition(live) {
  if (priv.mode === "live") return { share: true, status: priv.status, lat: live.lat, lng: live.lng, heading: live.heading ?? 0, speed: live.speed ?? 0 };
  if (!priv.spot) return { share: false, reason: "no-car-spot" };
  return { share: true, status: priv.status, lat: priv.spot.lat, lng: priv.spot.lng, heading: 0, speed: 0 };
}
export function noteFix() {}
export async function hydrateLocationPrivacy() {}
