// askScout.ts — the two-way voice loop (the foundation for hands-free Scout).
//
// Today voice is one-way: tap the mic → /voice/transcribe → emit one intent. There is
// no way for Scout to ASK something and listen for the answer. askScout() is that
// primitive: it speaks a prompt via /tts, waits for it to finish, opens the mic for a
// short window, transcribes the reply, and returns a parsed result (yes / no / "tell me
// more" + the raw text/intent). Any feature — hands-free reroute, in-drive Q&A, the
// arrival debrief — is then a thin caller, not its own audio pipeline.
//
// Audio-session discipline (see audio-ducking memory): play the prompt on a PLAYBACK
// session, flip to a RECORDING session only AFTER it finishes, and ALWAYS restore idle
// in finally so a failure can't strand Bluetooth on mono HFP. Single-flight (_busy) so
// two prompts never fight the mic. Best-effort everywhere: any failure → null, and the
// caller keeps its visual fallback (the tap card).

import { Platform, AppState } from "react-native";
import { Audio } from "expo-av";
import { api } from "./api";
import { getNovaVoice, getSettings, getAudioVol } from "./settings";
import { isAudioBusy } from "./nav";
import { callSilence } from "./callState";
import { setPlaybackAudioMode, setRecordingAudioMode, setIdleAudioMode } from "./audioMode";
import { acquireMic, micOwner, type MicLease } from "./micArbiter";
import { getPttRecordingOptions } from "./proximityAudio";

export type AskResult = {
  text: string;          // raw transcript
  intent: string | null; // backend-recognized intent, if any
  query?: string;        // backend-extracted query (e.g. a place), if any
  yes: boolean;          // affirmative reply
  no: boolean;           // negative reply
  more: boolean;         // "tell me more" / wants detail
};

const YES = /\b(yes|yeah|yep|yup|sure|ok|okay|do it|switch|take it|let'?s go|go for it|please|affirmative|absolutely|sounds good)\b/i;
const NO = /\b(no|nope|nah|stay|keep going|cancel|don'?t|do not|negative|leave it|i'?m good)\b/i;
const MORE = /\b(tell me more|more|details|detail|why|explain|how much|how long|what'?s|whats)\b/i;

let _busy = false;
export function scoutIsAsking(): boolean { return _busy; }

// Speak `prompt`, then listen ~listenMs for a reply. Returns the parsed answer, or null
// if voice isn't available (no mic permission, web, busy, or any error) — in which case
// the caller should fall back to its on-screen control.
export async function askScout(prompt: string, opts?: { listenMs?: number }): Promise<AskResult | null> {
  if (Platform.OS === "web" || _busy) return null;
  // Scout is a FOREGROUND-only assistant: it speaks a prompt and opens the mic.
  // It must never fire while the app is backgrounded (screen locked, another app,
  // or driving on CarPlay — Scout isn't a CarPlay feature) or after a force-quit.
  // Turn-by-turn nav directions are separate (nav.ts) and DO continue backgrounded;
  // this guard is only for Scout's interactive voice loop. ("active" = foreground.)
  if (AppState.currentState !== "active") return null;
  // Don't talk over an in-flight nav callout — wait briefly for the lane to clear.
  for (let i = 0; i < 6 && isAudioBusy(); i++) await new Promise((r) => setTimeout(r, 250));
  // Need the mic already granted; we never prompt for permission mid-drive.
  try {
    const perm = await Audio.getPermissionsAsync();
    if (perm.status !== "granted") return null;
  } catch { return null; }

  // Don't speak a question we cannot hear the answer to: if comms is already
  // transmitting, bail before the prompt. This is a CHECK, not an acquire — the lease
  // itself is taken after the prompt, below, because a lease has a hard deadline and
  // the spoken prompt's length is not ours to bound (a /tts round-trip plus up to the
  // 12s speak safety timeout). A 9s lease taken here expired mid-RECORDING: the mic
  // was handed to the next caller and the deferred idle flip landed on a live
  // recorder — the arbiter switching itself off for the one span it exists to guard.
  if (micOwner()) return null;

  _busy = true;
  let rec: Audio.Recording | null = null;
  let lease: MicLease | null = null;
  try {
    await speakAndWait(prompt);

    // NOW take the mic, sized to the window we actually record for. Someone could have
    // started transmitting while the prompt played — a denial here is the right answer.
    const listenMs = Math.max(2000, Math.min(8000, opts?.listenMs ?? 4500));
    lease = acquireMic("scout", listenMs + 4000);
    if (!lease) return null;

    // Flip to a recording session and capture a short window.
    await setRecordingAudioMode();
    rec = new Audio.Recording();
    await rec.prepareToRecordAsync(getPttRecordingOptions("far"));
    await rec.startAsync();
    await new Promise((r) => setTimeout(r, listenMs));
    await rec.stopAndUnloadAsync();
    const uri = rec.getURI();
    rec = null;
    // The mic is done — free it before the network leg below, so a slow /transcribe
    // can't keep comms locked out. Release first, then restore the session (a held
    // lease makes setIdleAudioMode defer).
    lease?.release(); lease = null;
    void setIdleAudioMode();
    if (!uri) return null;

    // Transcribe.
    const res = await fetch(uri);
    const blob = await res.blob();
    const b64: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(((reader.result as string) || "").split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const { data } = await api.post("/voice/transcribe", { audio_b64: b64, mime: "audio/m4a" });
    const text = (data?.text || "").toString();
    const t = ` ${text.toLowerCase()} `;
    const no = NO.test(t);
    return {
      text,
      intent: data?.intent ?? null,
      query: data?.query,
      yes: YES.test(t) && !no,
      no,
      more: MORE.test(t),
    };
  } catch {
    return null;
  } finally {
    try { if (rec) await rec.stopAndUnloadAsync(); } catch {}
    // Release BEFORE the idle flip, or the arbiter defers our own restore.
    lease?.release(); lease = null;
    void setIdleAudioMode(); // restore session no matter what
    _busy = false;
  }
}

// Speak a line and resolve when it finishes (standalone sound, independent of the nav
// TTS queue — askScout owns the floor while it's asking).
async function speakAndWait(text: string): Promise<void> {
  if (callSilence()) return; // muted during a phone call (Settings → Mute During Calls)
  try {
    await setPlaybackAudioMode();
    const { data } = await api.post("/tts", { text, voice: getNovaVoice() });
    const b64 = data?.audio_b64;
    if (!b64) return;
    // volume — expo-av defaults to ~0.5, which made Scout sound faint next to the
    // nav callouts. Full by default; tester-tunable via Settings → Audio (Voice).
    const vVol = getAudioVol(getSettings(), "volVoice");
    const { sound } = await Audio.Sound.createAsync(
      { uri: `data:${data?.mime || "audio/mp3"};base64,${b64}` },
      { shouldPlay: true, volume: vVol },
    );
    try { await sound.setVolumeAsync(vVol); } catch {}
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; sound.unloadAsync().catch(() => {}); resolve(); };
      sound.setOnPlaybackStatusUpdate((st: any) => { if (st?.didJustFinish || st?.error) finish(); });
      // Safety timeout so a stuck status callback can't hang the whole loop.
      setTimeout(finish, 12000);
    });
  } catch {}
}
