// What the app's logEvent would have written (convoyPresence / carDataService inject it into presenceHub).
export const rows = [];
export function logEvent(message) { rows.push(message); }
