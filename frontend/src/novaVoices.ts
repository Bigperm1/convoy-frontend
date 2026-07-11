// novaVoices.ts — selectable Nova voices.
//
// Nova's spoken lines are synthesized by OpenAI TTS via the backend POST /tts
// ({ text, voice }) — the endpoint forwards `voice` straight to OpenAI, so any
// of OpenAI's TTS voices works. We expose the SIX universal voices (the ones
// supported across every OpenAI TTS model) so a pick never silently fails back
// to the device voice. The chosen id is stored in settings.novaVoiceName and
// read by nav.ts (callouts) + novaGreeting.ts (the greeting) via getNovaVoice().
//
// previewNovaVoice() lets the settings screen AUDITION a voice: it fetches a one
// short sample line (cached per voice for the session, so re-tapping costs no
// extra TTS quota) and plays it through a standalone expo-av sound — independent
// of the nav speech queue.

import { Audio } from "expo-av";
import { api } from "./api";
import { setPlaybackAudioMode, setIdleAudioMode } from "./audioMode";
import { getSettings, getAudioVol } from "./settings";

export type NovaVoice = { id: string; label: string; blurb: string };

// The full OpenAI voice set. The backend was confirmed on gpt-4o-mini-tts (the Coral
// preview spoke on production, 2026-06-29), so the newer expressive voices below
// (coral / ash / ballad / sage / verse) all synthesize. The first six also work on
// tts-1 / tts-1-hd; the rest are gpt-4o-mini-tts-only — if the backend's TTS model is
// ever downgraded, trim back to the first six.
export const NOVA_VOICES: NovaVoice[] = [
  { id: "nova", label: "Nova", blurb: "Bright & friendly" },
  { id: "shimmer", label: "Shimmer", blurb: "Soft & warm" },
  { id: "alloy", label: "Alloy", blurb: "Neutral & clear" },
  { id: "echo", label: "Echo", blurb: "Calm & measured" },
  { id: "fable", label: "Fable", blurb: "Expressive storyteller" },
  { id: "onyx", label: "Onyx", blurb: "Deep & authoritative" },
  // Newer expressive voices (gpt-4o-mini-tts). NOTE: "ballad" and "verse" were
  // removed — they returned no audio on this backend (the TTS endpoint rejects them
  // even though Coral/Ash/Sage synthesize). Re-add only if confirmed working.
  { id: "coral", label: "Coral", blurb: "Warm & upbeat" },
  { id: "ash", label: "Ash", blurb: "Clear & direct" },
  { id: "sage", label: "Sage", blurb: "Calm & soothing" },
];

// Each audition line names the VOICE itself (not a fixed "Nova"), so you can tell
// the voices apart while picking — e.g. tapping Onyx says "Hey, I'm Onyx…".
function sampleTextFor(voiceId: string): string {
  const v = NOVA_VOICES.find((x) => x.id === voiceId);
  const name = v?.label || "your guide";
  return `Hey, I'm ${name}. Take the next right and I'll get you there.`;
}
const _cache: Record<string, { b64: string; mime: string }> = {};
let _sound: Audio.Sound | null = null;
let _token = 0; // bumped per request so a newer tap supersedes an in-flight one

// Audition a voice. Fetches (once per voice per session) + plays a short sample.
// Safe to call rapidly: the latest tap wins, earlier ones are abandoned.
export async function previewNovaVoice(voiceId: string): Promise<void> {
  const myToken = ++_token;
  try { if (_sound) { await _sound.unloadAsync(); } } catch {}
  _sound = null;
  try {
    let clip = _cache[voiceId];
    if (!clip) {
      const { data } = await api.post("/tts", { text: sampleTextFor(voiceId), voice: voiceId });
      const b64 = data?.audio_b64;
      if (!b64) { void setIdleAudioMode(); return; } // backend unavailable / no quota
      clip = { b64, mime: data?.mime || "audio/mp3" };
      _cache[voiceId] = clip;
    }
    if (myToken !== _token) return; // superseded while fetching
    await setPlaybackAudioMode(); // duck music + ensure audible in silent mode
    const { sound } = await Audio.Sound.createAsync(
      { uri: `data:${clip.mime};base64,${clip.b64}` },
      { shouldPlay: true, volume: getAudioVol(getSettings(), "volVoice") },
    );
    if (myToken !== _token) { try { await sound.unloadAsync(); } catch {} void setIdleAudioMode(); return; }
    _sound = sound;
    sound.setOnPlaybackStatusUpdate((st: any) => {
      if (st?.didJustFinish || st?.error) {
        sound.unloadAsync().catch(() => {});
        if (_sound === sound) _sound = null;
        void setIdleAudioMode(); // un-duck once the sample ends
      }
    });
  } catch {
    void setIdleAudioMode();
  }
}

// Stop any playing/loading preview and restore the idle audio session. Call when
// leaving the settings screen so a half-played sample never lingers.
export async function stopNovaPreview(): Promise<void> {
  _token++;
  try { if (_sound) { await _sound.unloadAsync(); } } catch {}
  _sound = null;
  void setIdleAudioMode();
}
