#!/usr/bin/env python3
"""A fake Backup app for test/run.sh: the agent protocol, version 1.

Usage: fake_backup_app.py PORT STATE_DIR (the token comes from FAKE_TOKEN).
It answers 400 to a poll whose app.secrets the Backup app would refuse.

The state folder steers it and holds what it received:
  job          when present, the next poll that is no check hands out a job
               with this many partBytes, and the file is removed
  faults       lines "<part> <fault>", each used once: 500, 422, store-500
               (stored, but the answer is lost) or slow (answers after 60 s)
  requests     one line per request: method, path, part checksum
  polls        the body of each poll, one JSON per line
  stream.tar   the parts of the last job, in order
  complete.json, fail.json   the last totals and the last failure
"""
import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
STATE = sys.argv[2]
TOKEN = os.environ["FAKE_TOKEN"]
PREFIX = "/api/agent/v1"
lock = threading.Lock()
jobs = {}
SECRET_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}")


def valid_poll(request):
    """The poll body as the Backup app checks it; app.secrets defaults to []."""
    secrets = request.get("app", {}).get("secrets", [])
    return isinstance(secrets, list) and len(secrets) <= 20 and all(
        isinstance(name, str) and SECRET_NAME.fullmatch(name) for name in secrets)


def path(name):
    return os.path.join(STATE, name)


def append(name, line):
    with open(path(name), "a", encoding="utf-8") as f:
        f.write(line + "\n")


def take_fault(n):
    """Removes and returns the first fault for part n, or None."""
    try:
        with open(path("faults"), encoding="utf-8") as f:
            lines = [line.split() for line in f if line.strip()]
    except FileNotFoundError:
        return None
    for i, (part, fault) in enumerate(lines):
        if int(part) == n:
            del lines[i]
            with open(path("faults"), "w", encoding="utf-8") as f:
                f.writelines(f"{p} {x}\n" for p, x in lines)
            return fault
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def answer(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, code, **extra):
        self.answer(status, {"error": {"code": code, "message": f"fake: {code}", **extra}})

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", "0")))

    def allowed(self):
        agent = self.headers.get("User-Agent", "")
        if self.headers.get("Authorization") != f"Bearer {TOKEN}" or not agent.startswith("backup-agent/"):
            self.body()
            self.error(401, "unauthorized")
            return False
        return True

    def do_POST(self):
        append("requests", f"POST {self.path}")
        if not self.allowed():
            return
        body = self.body()
        parts = self.path.removeprefix(PREFIX).strip("/").split("/")
        with lock:
            if parts == ["poll"]:
                request = json.loads(body)
                append("polls", json.dumps(request))
                if not valid_poll(request):
                    self.error(400, "invalid_request")
                    return
                job = None
                if not request.get("check") and os.path.exists(path("job")):
                    with open(path("job"), encoding="utf-8") as f:
                        job = {"id": str(uuid.uuid4()), "partBytes": int(f.read())}
                    os.remove(path("job"))
                    jobs[job["id"]] = {"expected": 0, "last": None, "sha": hashlib.sha256(), "bytes": 0, "size": job["partBytes"]}
                    open(path("stream.tar"), "wb").close()
                self.answer(200, {"source": {"id": "source-1", "name": "Example"}, "pollSeconds": 1, "job": job})
                return
            if len(parts) != 3 or parts[0] != "jobs" or parts[1] not in jobs:
                self.error(410, "job_ended")
                return
            job = jobs[parts[1]]
            if parts[2] == "complete":
                totals = json.loads(body)
                with open(path("complete.json"), "w", encoding="utf-8") as f:
                    json.dump(totals, f)
                del jobs[parts[1]]
                if (totals["parts"], totals["bytes"], totals["sha256"]) != (job["expected"], job["bytes"], job["sha"].hexdigest()):
                    self.error(422, "stream_mismatch")
                    return
                self.answer(202)
            elif parts[2] == "fail":
                with open(path("fail.json"), "w", encoding="utf-8") as f:
                    f.write(body.decode())
                del jobs[parts[1]]
                self.answer(204)
            elif parts[2] == "progress":
                self.answer(204)
            else:
                self.error(404, "not_found")

    def do_PUT(self):
        parts = self.path.removeprefix(PREFIX).strip("/").split("/")
        if not self.allowed():
            return
        if len(parts) != 4 or parts[0] != "jobs" or parts[2] != "parts":
            self.body()
            self.error(404, "not_found")
            return
        n = int(parts[3])
        fault = take_fault(n)
        append("requests", f"PUT {self.path} {fault or ''}".rstrip())
        if fault == "slow":
            time.sleep(60)
        try:
            data = self.body()
        except OSError:
            return
        sha = hashlib.sha256(data).hexdigest()
        with lock:
            job = jobs.get(parts[1])
            if job is None:
                self.error(410, "job_ended")
                return
            if fault == "500":
                self.answer(500)
                return
            if fault == "422" or self.headers.get("X-Part-Sha256") != sha:
                self.error(422, "checksum_mismatch")
                return
            if len(data) > job["size"]:
                self.error(413, "too_large")
                return
            if n == job["expected"] - 1 and sha == job["last"]:
                self.answer(204)
                return
            if n != job["expected"]:
                self.error(409, "out_of_order", expected=job["expected"])
                return
            with open(path("stream.tar"), "ab") as f:
                f.write(data)
            job["sha"].update(data)
            job["bytes"] += len(data)
            job["expected"] += 1
            job["last"] = sha
            self.answer(502 if fault == "store-500" else 204)


ThreadingHTTPServer.daemon_threads = True
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
