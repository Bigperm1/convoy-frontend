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
// For Bluetooth headsets, expo-av's underlying iOS `.playAndRecord` category
// auto-includes `.allowBluetoothA2DP` so paired AirPods / car stereos light
// up with zero extra config — provided `allowsRecordingIOS` is set correctly
// during the SESSION (not just the recording step).

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

/** IDLE / listener state — same as playback but called on app boot.
 *
 * Configured so that the moment a PTT message arrives over WebSocket the
 * sound can play at full volume without us racing to reconfigure first. */
export async function setIdleAudioMode() {
  return setPlaybackAudioMode();
}
