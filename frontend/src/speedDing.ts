// Speed-alert ding — a short, self-contained notification chime for the "Ding"
// speed-alert mode (single ding ~21 km/h over the limit, double ding ~41 over).
//
// There is no bundled sound asset in the repo and no way to add a binary one
// through the text tooling, so the chime is embedded as a base64 WAV (a tiny
// ~5 KB 16 kHz mono bell, 160 ms) and played exactly the way nav.ts plays its
// TTS clips: on native it's written once to the cache dir and played via
// expo-av; on web it's a data-URI <Audio>. Fails soft everywhere — a missing
// audio module or a decode error just means no sound, never a crash.
//
// Deliberately does NOT grab/duck the audio session the way nav speech does: a
// 160 ms alert should mix over the driver's music, not pause it. Volume is
// pinned to 1.0 so it's audible over road noise.

import { Platform } from "react-native";
import { setIdleAudioMode } from "./audioMode";
import { isAudioBusy } from "./nav";

// 16 kHz mono 16-bit WAV, 260 ms — SOFT, Waze-like warm C5 (523 Hz) tone: a
// near-pure sine (mostly fundamental) with an 18 ms raised-cosine attack + a
// smooth exponential decay and a low baked-in amplitude. Lower + gentler than
// the old bright D6 (1174 Hz) bell so the over-limit alert nudges without
// piercing. ~8.2 KB raw → ~11 KB base64.
const DING_WAV_B64 =
  "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";

const DING_MIME = "audio/wav";
let _nativeUri: string | null = null;       // cache-dir path, written once
const GAP_MS = 190;                          // spacing between the two dings (double)

async function ensureNativeFile(): Promise<string | null> {
  try {
    const FileSystem: any = await import("expo-file-system/legacy");
    if (_nativeUri) return _nativeUri;
    const path = FileSystem.cacheDirectory + "convoy_speed_ding.wav";
    await FileSystem.writeAsStringAsync(path, DING_WAV_B64, { encoding: FileSystem.EncodingType.Base64 });
    _nativeUri = path;
    return path;
  } catch { return null; }
}

async function playOnceNative(): Promise<void> {
  try {
    const { Audio }: any = await import("expo-av");
    const uri = await ensureNativeFile();
    if (!uri) return;
    const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1.0 });
    sound.setOnPlaybackStatusUpdate((st: any) => {
      if (!st?.isLoaded || st?.didJustFinish) {
        sound.unloadAsync().catch(() => {});
      }
    });
  } catch { /* no sound on failure */ }
}

function playOnceWeb(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const a = new Audio(`data:${DING_MIME};base64,${DING_WAV_B64}`);
      a.onended = () => resolve();
      a.onerror = () => resolve();
      a.play().catch(() => resolve());
    } catch { resolve(); }
  });
}

// Play the speed-alert chime. `double` plays it twice (the +41-over warning);
// otherwise once (the +21-over nudge). Always resolves; never throws.
export async function playSpeedDing(double: boolean): Promise<void> {
  // Yield to Nova: never sound a ding ON TOP of a greeting / turn callout (the
  // confirmed "two sounds at once" overlap — the ding bypasses the speech queue).
  // Briefly wait for the voice to clear, then ding; give up after ~3s so a long
  // callout can't swallow a real speed alert entirely.
  for (let i = 0; i < 8 && isAudioBusy(); i++) {
    await new Promise((r) => setTimeout(r, 400));
  }
  if (Platform.OS === "web") {
    try { await playOnceWeb(); } catch {}
    if (double) setTimeout(() => { void playOnceWeb(); }, GAP_MS);
    return;
  }
  // Make sure the iOS session plays on the loudspeaker, in silent mode, and
  // MIXES with the driver's music rather than pausing/ducking it. The app's idle
  // audio mode is exactly that (allowsRecordingIOS:false + playsInSilentModeIOS
  // + MixWithOthers), so the chime is audible even with the ring switch on and
  // never interrupts music. Non-disruptive by construction.
  try { await setIdleAudioMode(); } catch {}
  try { await playOnceNative(); } catch {}
  if (double) setTimeout(() => { void playOnceNative(); }, GAP_MS);
}
