// scanStill.ts — the Garage's keyed still of a scanned car, kept on this phone (2026-09-23).
//
// WHY. A scan's only still used to be its hero shot (car-scans/<id>/hero.jpg): a JPEG, so the transparent canvas
// around the car came out black and the Garage framed it as a photo card. Swiping to Ultra, that black card stood
// over the turntable until the live model loaded, then faded off it — the stage changed under the car (sim video,
// 2026-09-23: card on screen ~1 s, gone in ~100 ms). Jeff: "when swiping to ultra the 3d car has a wierd animation
// that pops the car into the carasoul, remove that pop and make it smooth".
//
// So the live model also hands the Garage a PNG of itself, taken on 'load' — the camera is still at the framing
// orbit then (auto-rotate waits 600 ms; CarHero3D) and the page background is transparent — and it is kept here,
// one file per scan. It IS the live frame, 1:1, so standing it in the frame puts the car exactly where the live
// model stands at load: going live is a fade between two identical cars on the same turntable.
//
// Local only: hero.jpg stays the shared image (Crew / friend tiles read it). A phone without the file — the first
// visit after install, or a new scan — shows the photo card once, until its car has been live here.

import { Directory, File, Paths } from "expo-file-system";

type Listener = () => void;
const listeners = new Set<Listener>();
/** Files known to exist this session (a miss is re-checked, a hit never is). */
const known = new Set<string>();

function dir(): Directory {
  return new Directory(Paths.document, "garage-stills");
}
function fileFor(scanId: string): File {
  return new File(dir(), `${scanId.replace(/[^A-Za-z0-9_-]/g, "_")}.png`);
}

/** The keyed still's file:// URI, or null when this phone has none for the scan. */
export function scanStillUri(scanId: string): string | null {
  if (!scanId) return null;
  try {
    const f = fileFor(scanId);
    if (known.has(scanId) || f.exists) {
      known.add(scanId);
      return f.uri;
    }
  } catch {}
  return null;
}

/** Keep the live model's PNG (a data:image/png URI) for this scan — once; a scan's car never changes. Written to a
 *  temporary file and moved into place only when complete, so a failed write (a full disk) never leaves a partial
 *  file that scanStillUri would trust (Codex review of 83da6282). */
export function saveScanStill(scanId: string, dataUri: string): boolean {
  if (!scanId || scanStillUri(scanId)) return false;
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUri || "");
  if (!m) return false;
  let tmp: File | null = null;
  try {
    dir().create({ idempotent: true, intermediates: true });
    tmp = new File(dir(), `${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    tmp.create({ overwrite: true });
    tmp.write(m[1], { encoding: "base64" });
    tmp.move(fileFor(scanId));
    known.add(scanId);
  } catch {
    try { if (tmp?.exists) tmp.delete(); } catch {}
    return false;
  }
  listeners.forEach((fn) => { try { fn(); } catch {} });
  return true;
}

/** The still could not be shown (unreadable file): delete it, so the card shows and the next live view re-takes it. */
export function forgetScanStill(scanId: string): void {
  known.delete(scanId);
  try {
    const f = fileFor(scanId);
    if (f.exists) f.delete();
  } catch {}
  listeners.forEach((fn) => { try { fn(); } catch {} });
}

export function subscribeScanStills(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
