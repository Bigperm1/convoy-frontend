// carComms.ts — MODULE-SCOPE crew-comms transmit for the CarPlay/AA comms button.
//
// The phone's PTT recorder lives inside the usePttChannel HOOK, mounted in exactly
// one place (app/(app)/talk.tsx) — so nothing outside the Comms tab could transmit,
// and the hook kills any hot mic on unmount. This is the headless lift of its
// record→send core (pttChannel.ts:146-249, mirrored deliberately step-for-step:
// same recording options, same duck reasons, same session restore paths, same
// POST /ptt shape) so the head unit can transmit with the phone in a pocket.
//
// CarPlay has NO hold-to-talk (CPBarButtonHandler is a single fire-on-select
// block — CPBarButton.h:34), so this is TAP-TO-TOGGLE: tap = open mic, tap = send.
// The hard cap is 25s (vs the phone's 60s): a driver who taps and forgets has a
// hot mic and no screen they're looking at.
//
// MIC GUARD (interim until the build-68 mic arbiter): refuses to start while Scout
// is capturing. expo-av allows ONE recorder process-wide and the loser's cleanup
// PAUSES the winner (EXAV.m:275-279) — refusing beats colliding.
import { Audio } from "expo-av";
import { api } from "../api";
import { getPttRecordingOptions, getLatestTier } from "../proximityAudio";
import { setRecordingAudioMode, setIdleAudioMode } from "../audioMode";
import { acquireMic, micOwner, type MicLease } from "../micArbiter";
import { duckMusicFor, unduckMusicFor } from "../applePlayer";
import { getSettings } from "../settings";
import { getCarState, setCarState } from "./carStore";

const MAX_TX_MS = 25000;
const MIN_TX_MS = 300; // ignore accidental taps — nothing meaningful was said

let _rec: Audio.Recording | null = null;
// Held for exactly as long as _rec is non-null. Released on BOTH exit paths below.
let _lease: MicLease | null = null;
let _startedAt = 0;
let _capTimer: ReturnType<typeof setTimeout> | null = null;
let _busy = false; // serialize toggles — a double-tap mid-transition must not race

async function uriToBase64(uri: string): Promise<string> {
  // fetch + FileReader works for file:// URIs on RN — the proven single-path
  // approach from pttChannel.ts:41 / useVoice.ts.
  const res = await fetch(uri);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const r = (reader.result as string) || "";
      resolve(r.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function carCommsRecording(): boolean {
  return _rec !== null;
}

// Tap-to-toggle. Resolves to a short user-facing message (shown as a CarPlay
// alert by the caller), or null when the state change is self-evident from the
// on-screen indicator (recording started).
export async function toggleCarComms(): Promise<string | null> {
  if (_busy) return null;
  _busy = true;
  try {
    if (_rec) return await stopAndSend();
    return await start();
  } finally {
    _busy = false;
  }
}

async function start(): Promise<string | null> {
  const s = getCarState();
  // Mic guard: Scout owns the mic right now — see header. (scoutThinking means
  // the recorder is already released, so only listening blocks.)
  // The hand-rolled Scout check is now the ARBITER's job — it covers all four
  // recorders (scout, voice, ptt, carComms), not just Scout, and it is the same
  // lease audioMode consults before it flips allowsRecordingIOS off under us.
  if (s.scoutListening) return "Scout is using the mic";
  const held = micOwner();
  if (held) return held === "scout" ? "Scout is using the mic" : "Mic is busy";
  const st = getSettings();
  const channel = st.activeThreadId || st.activeCommunityId;
  if (!channel) return "No comms channel — pick one on the phone";
  const perm = await Audio.getPermissionsAsync();
  if (perm.status !== "granted") {
    // Asking for mic permission needs the PHONE unlocked and in hand — a CarPlay
    // alert can't host the OS prompt. Request so it's granted for next time.
    if (perm.canAskAgain) { try { await Audio.requestPermissionsAsync(); } catch {} }
    return "Allow the microphone on your phone first";
  }
  try {
    // 25s cap + the arbiter's own grace: a tap-and-forget cannot strand the mic.
    _lease = acquireMic("carComms", MAX_TX_MS);
    if (!_lease) return "Mic is busy";
    await setRecordingAudioMode();
    const rec = new Audio.Recording();
    await rec.prepareToRecordAsync(getPttRecordingOptions(getLatestTier().tier));
    await rec.startAsync();
    _rec = rec;
    _startedAt = Date.now();
    setCarState({ commsTx: "recording" });
    // Same-app music would play over the transmission — pause it for the duration
    // (distinct duck reason, same as the phone's hold-to-talk).
    void duckMusicFor("ptt-tx");
    if (_capTimer) clearTimeout(_capTimer);
    _capTimer = setTimeout(() => { void toggleCarComms(); }, MAX_TX_MS);
    return null; // the on-screen "Transmitting…" indicator is the feedback
  } catch {
    _rec = null;
    setCarState({ commsTx: "idle" });
    // prepare/start threw AFTER the ducked .playAndRecord session was armed —
    // restore idle or music stays quiet/mono (the phone had this exact bug).
    _lease?.release(); _lease = null;   // before the idle flip, or it defers
    void setIdleAudioMode();
    return "Mic failed to start";
  }
}

async function stopAndSend(): Promise<string | null> {
  if (_capTimer) { clearTimeout(_capTimer); _capTimer = null; }
  const rec = _rec;
  _rec = null;
  if (!rec) {
    // No Recording, but start() may still hold a lease from an attempt that never
    // opened one — free it rather than waiting on the lease deadline.
    if (_lease) { _lease.release(); _lease = null; void setIdleAudioMode(); }
    setCarState({ commsTx: "idle" });
    return null;
  }
  let uri: string | null = null;
  let durationMs = Date.now() - _startedAt;
  try {
    try {
      const status: any = await rec.getStatusAsync();
      if (status?.durationMillis) durationMs = status.durationMillis;
    } catch {}
    await rec.stopAndUnloadAsync();
    uri = rec.getURI();
  } catch {
    uri = rec.getURI?.() ?? null;
  } finally {
    // Session back to idle + resume music — the exact restore pair the phone uses.
    _lease?.release(); _lease = null;   // before the idle flip, or it defers
    void setIdleAudioMode();
    void unduckMusicFor("ptt-tx");
  }
  if (!uri || durationMs < MIN_TX_MS) { setCarState({ commsTx: "idle" }); return null; }
  const st = getSettings();
  const channel = st.activeThreadId || st.activeCommunityId;
  if (!channel) { setCarState({ commsTx: "idle" }); return "No comms channel"; }
  try {
    setCarState({ commsTx: "sending" });
    const audio_b64 = await uriToBase64(uri);
    if (!audio_b64) return "Send failed";
    await api.post("/ptt", { channel, audio_b64, duration_ms: Math.round(durationMs) });
    // The backend echoes our clip to channel members over the WS — no optimistic
    // append needed (mirrors the phone's dedupe-by-echo behaviour).
    return "Sent ✓";
  } catch {
    return "Send failed — no connection";
  } finally {
    setCarState({ commsTx: "idle" });
  }
}
