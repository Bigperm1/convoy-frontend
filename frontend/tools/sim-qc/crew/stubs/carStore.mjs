// The car store as carDataService sees it: the LIVE self fix, and a subscription that fires on every write.
let state = { selfLat: null, selfLng: null, speedMs: 0, heading: 0, selfCourse: null };
const subs = new Set();
export function __set(p) { state = { ...state, ...p }; subs.forEach((fn) => fn()); }
export function getCarState() { return state; }
export function subscribeCarState(fn) { subs.add(fn); return () => { subs.delete(fn); }; }
export function setCarPeers() {}
export function setCarHazards() {}
export function carFeedWouldAccept() { return false; }
