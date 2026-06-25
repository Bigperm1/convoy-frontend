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

// 16 kHz mono 16-bit WAV, 160 ms — bright D6 bell (fundamental + 2 harmonics,
// fast attack, exponential decay). ~5 KB raw → ~6.9 KB base64.
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
