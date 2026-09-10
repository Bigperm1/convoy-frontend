// watchPtt — a clip recorded on the wrist reaches the convoy through the SAME path as a phone
// clip: base64 → POST /api/ptt, with the floor held from the watch's press-down to the upload.
import { Platform } from "react-native";
import { HairpinWatch } from "../modules/hairpin-watch";
import { api } from "./api";
import { uriToBase64 } from "./pttChannel";
import { acquireFloor, releaseFloor } from "./livePtt";
import { logEventReliable } from "./crashBreadcrumb";

let _stop: (() => void) | null = null;
const ROWS_MAX = 30; let _rows = 0;

export function startWatchPtt(getChannel: () => string | null | undefined): () => void {
  if (_stop) return _stop;
  if (Platform.OS !== "ios" || !HairpinWatch) return () => {};
  const msgSub = HairpinWatch.addListener("onWatchMessage", (m) => {
    try {
      const o = JSON.parse(m.json);
      const ch = getChannel();
      if (o?.ptt === "down" && ch) acquireFloor(ch);
    } catch {}
  });
  const fileSub = HairpinWatch.addListener("onWatchFile", async (f) => {
    const ch = getChannel();
    let ok = false;
    try {
      if (f.kind === "ptt" && f.path && ch) {
        const audio_b64 = await uriToBase64(f.path);
        if (audio_b64) { await api.post("/ptt", { channel: ch, audio_b64, duration_ms: Math.round(f.ms) }); ok = true; }
      }
    } catch {}
    if (ch) releaseFloor(ch);
    if (_rows < ROWS_MAX) { _rows += 1; try { logEventReliable(`watch-ptt ms=${Math.round(f.ms)} ok=${ok ? 1 : 0} ch=${ch ? 1 : 0}`); } catch {} }
  });
  _stop = () => { msgSub.remove(); fileSub.remove(); _stop = null; };
  return _stop;
}
