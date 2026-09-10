// watchPtt — a clip recorded on the wrist reaches the convoy through the SAME path as a phone
// clip: base64 → POST /api/ptt, with the floor held from the watch's press-down to the press-up.
//
// The floor is bound to the channel that was active AT PRESS-DOWN and released with THAT channel,
// never with whatever getChannel() happens to return later — a channel switch mid-clip used to
// acquire on A and release on B, leaving A's floor held until the server TTL expired.
// floor released on press-up like talk.tsx — another driver may take the floor while the clip is
// still uploading; that is the phone's semantics too.
import { Platform } from "react-native";
import { HairpinWatch } from "../modules/hairpin-watch";
import { api } from "./api";
import { uriToBase64 } from "./pttChannel";
import { acquireFloor, releaseFloor } from "./livePtt";
import { logEventReliable } from "./crashBreadcrumb";

let _stop: (() => void) | null = null;
const ROWS_MAX = 30; let _rows = 0;
// The channel the floor is held on (null = we hold no floor). Set at press-down, kept across
// press-up so the file that follows uploads to the SAME channel, cleared by the upload.
let _pttChannel: string | null = null;
let _pttUploadPending = false;
// A press-down whose press-up never arrives (watch app killed, link dropped mid-hold) would hold
// the floor forever — 30 s is longer than any usable clip and shorter than a stuck mic matters.
let _pttWatchdog: ReturnType<typeof setTimeout> | null = null;
const PTT_WATCHDOG_MS = 30_000;

function releaseBound(why: string) {
  if (_pttWatchdog) { clearTimeout(_pttWatchdog); _pttWatchdog = null; }
  if (_pttChannel) {
    try { releaseFloor(_pttChannel); } catch {}
    if (why !== "up") { _pttChannel = null; _pttUploadPending = false; }
  }
}

export function startWatchPtt(getChannel: () => string | null | undefined): () => void {
  if (_stop) return _stop;
  if (Platform.OS !== "ios" || !HairpinWatch) return () => {};
  const msgSub = HairpinWatch.addListener("onWatchMessage", (m) => {
    try {
      const o = JSON.parse(m.json);
      if (o?.ptt === "down") {
        const ch = getChannel();
        if (!ch) return;
        _pttChannel = ch;
        _pttUploadPending = false;
        acquireFloor(ch);
        if (_pttWatchdog) clearTimeout(_pttWatchdog);
        _pttWatchdog = setTimeout(() => releaseBound("watchdog"), PTT_WATCHDOG_MS);
      }
      if (o?.ptt === "up") { _pttUploadPending = true; releaseBound("up"); }
    } catch {}
  });
  const fileSub = HairpinWatch.addListener("onWatchFile", async (f) => {
    const ch = _pttChannel ?? getChannel() ?? null;
    let ok = false;
    let fail = "-";
    let bytes = 0;
    try {
      if (f.kind !== "ptt") fail = "kind";
      else if (!f.path) fail = "path";
      else if (!ch) fail = "chan";
      else {
        const audio_b64 = await uriToBase64(f.path);
        bytes = Math.round(audio_b64.length * 3 / 4);
        if (!audio_b64) fail = "read";
        else { await api.post("/ptt", { channel: ch, audio_b64, duration_ms: Math.round(f.ms) }); ok = true; }
      }
    } catch (e: any) {
      fail = String(e?.message || e || "err").slice(0, 40).replace(/\s+/g, "_");
    }
    // The floor was already released on press-up — do NOT release it here.
    _pttChannel = null; _pttUploadPending = false;
    if (_rows < ROWS_MAX) { _rows += 1; try { logEventReliable(`watch-ptt ms=${Math.round(f.ms)} bytes=${bytes} ok=${ok ? 1 : 0} fail=${fail}`); } catch {} }
  });
  // A dropped link mid-hold never delivers the press-up: release on unreachable too.
  const linkSub = HairpinWatch.addListener("onWatchState", (s) => {
    if (!s.reachable && _pttChannel && !_pttUploadPending) releaseBound("unreachable");
  });
  _stop = () => {
    releaseBound("stop");
    msgSub.remove(); fileSub.remove(); linkSub.remove();
    _pttChannel = null; _pttUploadPending = false;
    _stop = null;
  };
  return _stop;
}
