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
  private var starting = false
  private var cancelled = false

  func start() {
    guard rec == nil, !starting else { return }
    starting = true
    cancelled = false
    let session = AVAudioSession.sharedInstance()
    session.requestRecordPermission { [weak self] granted in
      guard let self = self else { return }
      guard granted else {
        DispatchQueue.main.async { self.lastError = "Mic not allowed"; self.starting = false; self.cancelled = false }
        return
      }
      do {
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ptt-\(Int(Date().timeIntervalSince1970)).m4a")
        let settings: [String: Any] = [
          AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 22050, AVNumberOfChannelsKey: 1,
          AVEncoderBitRateKey: 64000, AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        let r = try AVAudioRecorder(url: url, settings: settings)
        guard r.record() else {
          DispatchQueue.main.async { self.lastError = "Record failed"; self.starting = false; self.cancelled = false }
          try? session.setActive(false)
          return
        }
        DispatchQueue.main.async {
          if self.cancelled {
            self.cancelled = false; self.starting = false
            r.stop(); try? FileManager.default.removeItem(at: r.url); try? session.setActive(false)
            return
          }
          self.rec = r; self.startedAt = Date()
          self.recording = true; self.lastError = nil
          self.starting = false
          if WCSession.default.isReachable { WCSession.default.sendMessage(["json": "{\"ptt\":\"down\"}"], replyHandler: nil, errorHandler: nil) }
        }
      } catch {
        DispatchQueue.main.async { self.lastError = "Record failed"; self.starting = false; self.cancelled = false }
      }
    }
  }

  func stop() {
    guard let r = rec else {
      if starting { cancelled = true }
      return
    }
    r.stop(); rec = nil
    let ms = Int((Date().timeIntervalSince(startedAt ?? Date())) * 1000)
    DispatchQueue.main.async { self.recording = false }
    try? AVAudioSession.sharedInstance().setActive(false)
    if WCSession.default.isReachable { WCSession.default.sendMessage(["json": "{\"ptt\":\"up\"}"], replyHandler: nil, errorHandler: nil) }
    if ms < 300 { try? FileManager.default.removeItem(at: r.url); return }   // a tap, not a clip
    WCSession.default.transferFile(r.url, metadata: ["kind": "ptt", "ms": Double(ms)])
  }
}
