// A fake realtime client: one channel per topic, whose presenceState() the test sets and whose "sync" it fires.
export const SUPABASE_ENABLED = true;
export const channels = new Map();
export function __sync(topic, state) {
  const c = channels.get(topic);
  if (!c) throw new Error("no channel " + topic);
  c.state = state;
  c.syncCb?.();
}
export function __status(topic, st) {
  const c = channels.get(topic);
  if (!c) throw new Error("no channel " + topic);
  c.statusCb?.(st);
}
export const supabase = {
  channel(topic) {
    const c = {
      topic: "realtime:" + topic, state: {}, syncCb: null, statusCb: null,
      on(type, filter, cb) { if (type === "presence" && filter?.event === "sync") c.syncCb = cb; return c; },
      subscribe(cb) { c.statusCb = cb; try { cb?.("SUBSCRIBED"); } catch {} return c; },
      presenceState() { return c.state; },
      track() { return Promise.resolve("ok"); },
      untrack() { return Promise.resolve("ok"); },
    };
    channels.set(topic, c);
    return c;
  },
  getChannels() { return [...channels.values()]; },
  removeChannel(c) { for (const [k, v] of channels) if (v === c) channels.delete(k); },
};
