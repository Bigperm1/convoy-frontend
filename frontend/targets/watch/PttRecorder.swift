// targets/watch/PttRecorder.swift — hold-to-talk capture. AAC mono 22.05 kHz 64 kbps, the same
// shape src/proximityAudio.ts uses for the "mid" tier; the clip rides WCSession.transferFile
// back to the phone, which uploads it exactly like a phone-recorded clip.
import Foundation
import AVFAudio
import WatchConnectivity

final class PttRecorder: ObservableObject {
  @Published var recording = false
  @Published var lastError: String? = nil
  private var rec: AVAudioRecorder?
  private var startedAt: Date?

  func start() {
    let session = AVAudioSession.sharedInstance()
    session.requestRecordPermission { [weak self] granted in
      guard let self = self else { return }
      guard granted else { DispatchQueue.main.async { self.lastError = "Mic not allowed" }; return }
      do {
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ptt-\(Int(Date().timeIntervalSince1970)).m4a")
        let settings: [String: Any] = [
          AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 22050, AVNumberOfChannelsKey: 1,
          AVEncoderBitRateKey: 64000, AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        let r = try AVAudioRecorder(url: url, settings: settings)
        r.record()
        self.rec = r; self.startedAt = Date()
        DispatchQueue.main.async { self.recording = true; self.lastError = nil }
        if WCSession.default.isReachable { WCSession.default.sendMessage(["json": "{\"ptt\":\"down\"}"], replyHandler: nil, errorHandler: nil) }
      } catch {
        DispatchQueue.main.async { self.lastError = "Record failed" }
      }
    }
  }

  func stop() {
    guard let r = rec else { return }
    r.stop(); rec = nil
    let ms = Int((Date().timeIntervalSince(startedAt ?? Date())) * 1000)
    DispatchQueue.main.async { self.recording = false }
    try? AVAudioSession.sharedInstance().setActive(false)
    if WCSession.default.isReachable { WCSession.default.sendMessage(["json": "{\"ptt\":\"up\"}"], replyHandler: nil, errorHandler: nil) }
    if ms < 300 { try? FileManager.default.removeItem(at: r.url); return }   // a tap, not a clip
    WCSession.default.transferFile(r.url, metadata: ["kind": "ptt", "ms": Double(ms)])
  }
}
