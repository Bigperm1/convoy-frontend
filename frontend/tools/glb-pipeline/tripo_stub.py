#!/usr/bin/env python3
"""tripo_stub.py — a local stand-in for the Tripo REST API so the scan worker can be
exercised END TO END without spending a credit or touching openapi.tripo3d.ai.

Serves exactly the endpoints supabase/functions/scan-worker/tripo.ts calls, with the
same envelope ({code: 0, data}) and the same field names the real service returned for
the two delivered scans (task.json output_fields = ["model_url", …]):

    POST /v3/files                          -> {file_token}
    POST /v3/generation/multiview-to-model  -> {task_id}
    POST /v3/models/convert                 -> {task_id}
    GET  /v3/tasks/<id>                     -> {task_id, type, status, progress, output}
    GET  /v3/account/balance                -> {balance}
    GET  /fixtures/twin.glb | hero.glb      -> the raw Tripo converts (from --fixtures)

Every request body is printed to stdout so the dry-run receipt shows the exact payloads
(named views, -x, 1.9101, face limits, no quad).

    python3 tripo_stub.py --port 8787 --fixtures <dir with raw_twin.glb raw_hero.glb>
           [--polls 2] [--balance 1890] [--fail-generate] [--insufficient-credits]
"""
import argparse
import json
import os
import re
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None
TASKS = {}
CREDITS = {"multiview_to_model": 30, "convert_model": 10}


def log(msg):
    print(msg, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, data, code=0, status=200, message=None):
        body = json.dumps({"code": code, "data": data, **({"message": message} if message else {})}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def log_message(self, *a):  # quiet the default access log; we print our own
        pass

    def do_GET(self):
        if self.path == "/v3/account/balance":
            log(f"GET {self.path} auth={'yes' if self.headers.get('Authorization','').startswith('Bearer ') else 'NO'}")
            return self._json({"balance": ARGS.balance, "frozen": 0})
        m = re.match(r"^/v3/tasks/([^/?]+)", self.path)
        if m:
            t = TASKS.get(m.group(1))
            if not t:
                return self._json(None, code=2000, status=404, message="task not found")
            t["polls"] += 1
            if t["polls"] < ARGS.polls:
                log(f"GET {self.path} -> running ({t['polls']}/{ARGS.polls})")
                return self._json({"task_id": t["id"], "type": t["type"], "status": "running", "progress": int(100 * t["polls"] / ARGS.polls)})
            if t.get("fail"):
                log(f"GET {self.path} -> {t['fail']}")
                return self._json({"task_id": t["id"], "type": t["type"], "status": t["fail"], "progress": 0})
            base = f"http://{self.headers.get('Host')}"
            if t["type"] == "convert_model":
                which = "twin" if t["params"].get("face_limit") == 20000 else "hero"
                output = {"model_url": f"{base}/fixtures/{which}.glb"}
            else:
                output = {"model_url": f"{base}/fixtures/hero.glb", "rendered_image_url": f"{base}/fixtures/preview.webp"}
            log(f"GET {self.path} -> success output={json.dumps(output)}")
            return self._json({"task_id": t["id"], "type": t["type"], "status": "success", "progress": 100,
                               "output": output, "credits_consumed": CREDITS[t["type"]]})
        m = re.match(r"^/fixtures/(twin|hero)\.glb$", self.path)
        if m:
            path = os.path.join(ARGS.fixtures, f"raw_{m.group(1)}.glb")
            if not os.path.exists(path):
                self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
            data = open(path, "rb").read()
            log(f"GET {self.path} -> {len(data)} B")
            self.send_response(200)
            self.send_header("Content-Type", "model/gltf-binary")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()

    def do_POST(self):
        auth_ok = self.headers.get("Authorization", "").startswith("Bearer ")
        raw = self._read()
        if self.path == "/v3/files":
            ctype = self.headers.get("Content-Type", "")
            fname = re.search(rb'filename="([^"]+)"', raw)
            log(f"POST /v3/files auth={'yes' if auth_ok else 'NO'} multipart={'yes' if 'multipart/form-data' in ctype else 'NO'} "
                f"field=file filename={fname.group(1).decode() if fname else '?'} bytes={len(raw)}")
            return self._json({"file_token": f"file_stub_{uuid.uuid4().hex[:12]}"})
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self._json(None, code=2001, status=400, message="bad json")
        if self.path == "/v3/generation/multiview-to-model":
            log(f"POST {self.path} auth={'yes' if auth_ok else 'NO'} body={json.dumps(body)}")
            if ARGS.insufficient_credits:
                return self._json(None, code=2010, status=400, message="Insufficient credits")
            tid = str(uuid.uuid4())
            TASKS[tid] = {"id": tid, "type": "multiview_to_model", "polls": 0, "params": body,
                          "fail": "failed" if ARGS.fail_generate else None}
            return self._json({"task_id": tid})
        if self.path == "/v3/models/convert":
            log(f"POST {self.path} auth={'yes' if auth_ok else 'NO'} body={json.dumps(body)}")
            if body.get("quad"):
                return self._json(None, code=2002, status=400, message="quad forbidden by the stub (trap 4)")
            tid = str(uuid.uuid4())
            TASKS[tid] = {"id": tid, "type": "convert_model", "polls": 0, "params": body}
            return self._json({"task_id": tid})
        self._json(None, code=2000, status=404, message="no such endpoint")


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--fixtures", required=True, help="dir holding raw_twin.glb and raw_hero.glb")
    ap.add_argument("--polls", type=int, default=2, help="GETs before a task reports success")
    ap.add_argument("--balance", type=int, default=1890)
    ap.add_argument("--fail-generate", action="store_true")
    ap.add_argument("--insufficient-credits", action="store_true")
    ARGS = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    log(f"tripo_stub listening on http://127.0.0.1:{ARGS.port} fixtures={ARGS.fixtures} polls={ARGS.polls} balance={ARGS.balance}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
