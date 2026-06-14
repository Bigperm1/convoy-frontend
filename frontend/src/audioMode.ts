// audioMode.ts — centralized iOS/Android audio session config for Convoy.
//
// Why this exists: PTT walkie-talkie needs THREE different audio session
// states across the lifecycle, and getting any of them wrong causes very
// confusing bugs (quiet earpiece-only playback after recording, no Bluetooth
// routing, audio dropping when the screen locks, etc.).
//
//   1. IDLE      — silent, ready to receive incoming PTT
//   2. RECORDING — mic is active, monitor low-latency
//   3. PLAYBACK  — speaker (or paired Bluetooth) at full volume
//
// The single biggest gotcha is `allowsRecordingIOS`. When set to `true`, iOS
// uses the `.playAndRecord` audio category and DEFAULTS playback to the tiny
// earpiece speaker at the top of the phone. To get loud loudspeaker output
// you MUST flip `allowsRecordingIOS: false` before playing back any audio.
// We do that in `setPlaybackAudioMode()` below.
//
// Bluetooth caveat (this is the mono/low-volume-in-car bug): iOS `.playAndRecord`
// does NOT give you stereo A2DP. To have a mic input available it routes Bluetooth
// to the hands-free profile (HFP) — mono, low-bitrate, quiet — for the WHOLE phone,
// so paired car stereos / AirPods drop to one-speaker, low-volume output (and any
// other app's music with them). Stereo A2DP only comes back in `.playback`
// (`allowsRecordingIOS: false`). So a session left in `.playAndRecord` while NOT
// actively recording is a bug: always flip back to `.playback` the moment the mic
// stops (see setIdleAudioMode / setPlaybackAudioMode, and useVoice.ts's reset).

import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";

/** RECORDING state — mic is hot. Call BEFORE `Recording.startAsync()`. */
export async function setRecordingAudioMode() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      // staysActiveInBackground keeps the audio session alive when the user
      // locks the screen / switches apps. Required for "transmitting while
      // backgrounded" to keep working and for Bluetooth routing to persist.
      staysActiveInBackground: true,
      // DuckOthers → music (Apple Music / Spotify) is temporarily LOWERED while
      // comms is active and automatically restored when comms stops, instead of
      // being hard-stopped (DoNotMix) and left dead. Trade-off: ducked music can
      // bleed faintly into a transmission, acceptable for walkie-grade voice.
      interruptionModeIOS: InterruptionModeIOS.DuckOthers,
      shouldDuckAndroid: true,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      // Android: route to loudspeaker / Bluetooth, never the earpiece.
      playThroughEarpieceAndroid: false,
    });
  } catch {
    // Some platforms (web preview, simulator without audio devices) reject
    // various modes. Failing audio mode setup must not block UX — the next
    // recording attempt will throw a clearer error if it really can't play.
  }
}

/** PLAYBACK state — speaker / Bluetooth output at max volume.
 *
 * Critical: `allowsRecordingIOS: false` switches the iOS audio category from
 * `.playAndRecord` to `.playback`, which kicks output OFF the earpiece and
 * ON to the loudspeaker (or any active Bluetooth route). Without this flip
 * after a recording, playback comes out quiet from the top earpiece — this
 * is the exact bug behind the "Comms volume too low" report. */
export async function setPlaybackAudioMode() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      // DuckOthers → an incoming transmission dips the music and it pops back up
      // when the clip finishes (the "music never comes back" fix). Ducking is
      // tied to ACTIVE playback, so while idle the session doesn't touch music.
      interruptionModeIOS: InterruptionModeIOS.DuckOthers,
      shouldDuckAndroid: true,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      playThroughEarpieceAndroid: false,
    });
  } catch {}
}

/** IDLE / listener state — speaker-ready but NON-ducking.
 *
 * Same loudspeaker routing as playback (`allowsRecordingIOS: false` →
 * `.playback`, never the earpiece) so the moment a PTT clip or a Nova callout
 * arrives it can play at full volume without us racing to reconfigure. The key
 * difference from playback is the interruption mode: idle MUST NOT duck other
 * apps.
 *
 * Why this matters (the "music stuck quiet until force-quit" regression): the
 * `.duckOthers` / `shouldDuckAndroid` modes dip external audio (Spotify,
 * podcasts) for as long as OUR session stays active. Because the session stays
 * active in the background (`staysActiveInBackground: true`), leaving it in a
 * ducking mode after a Nova clip or PTT transmission finished kept the user's
 * music permanently quiet. Returning to a MIX (non-ducking) mode the instant
 * the TTS/PTT queue drains releases the duck so external audio pops back to
 * full volume. Active playback re-applies `setPlaybackAudioMode()` (ducking)
 * right before each clip, so we only duck while something is actually speaking.
 *
 * iOS vs Android: the lingering-duck bug is iOS-specific — its AVAudioSession
 * stays active (`staysActiveInBackground`) with the `.duckOthers` option, so
 * other apps stay ducked even with nothing playing. `InterruptionModeIOS
 * .MixWithOthers` is what releases that. Android ducks via per-playback audio
 * focus, which is abandoned the moment the clip's Sound unloads, so idle holds
 * no focus and external music is already full-volume; `shouldDuckAndroid: false`
 * is set for completeness. (Android has no MixWithOthers interruption mode — the
 * enum only exposes DoNotMix/DuckOthers — and the idle value is inert while
 * nothing is playing, since active clips set `setPlaybackAudioMode()` first.) */
export async function setIdleAudioMode() {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      // MIX, not duck — idle must leave external music at full volume (iOS).
      interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
      // Android ducks via per-playback focus (released on unload), so idle holds
      // no focus; shouldDuckAndroid:false is the meaningful non-duck toggle here.
      shouldDuckAndroid: false,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      playThroughEarpieceAndroid: false,
    });
  } catch {}
}
