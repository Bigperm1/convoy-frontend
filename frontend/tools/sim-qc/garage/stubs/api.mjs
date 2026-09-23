export const calls = [];
export const routes = { get: {} };   // url -> () => ({ status, data }) or throws
export const api = {
  async get(url, cfg) {
    calls.push({ m: "GET", url });
    const h = routes.get[url];
    if (!h) throw new Error("no route " + url);
    const r = await h();
    if (r.status !== 200 && !(cfg && cfg.validateStatus)) { const e = new Error("status " + r.status); e.response = r; throw e; }
    return r;
  },
  async put(url, body) { calls.push({ m: "PUT", url, body }); return { status: 200, data: body }; },
  async post(url, body) { calls.push({ m: "POST", url, body }); return { status: 200, data: {} }; },
};
