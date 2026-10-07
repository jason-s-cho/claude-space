"""논문 서재 — 내 컴퓨터에서 돌아가는 논문 관리 앱.

    python app.py                     # 기본 폴더(~/Papers)
    python app.py --library D:/논문    # 폴더 지정

브라우저가 자동으로 열린다. 이 컴퓨터(127.0.0.1)에서만 접속할 수 있다.
"""

import argparse
import json
import os
import platform
import re
import subprocess
import sys
import threading
import traceback
import urllib.parse
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import metadata as md  # noqa: E402
from library import Library  # noqa: E402

HERE = Path(__file__).resolve().parent
CONFIG_PATH = Path.home() / ".papershelf.json"
DEFAULT_LIBRARY = Path.home() / "Papers"
MAX_UPLOAD = 300 * 1024 * 1024

state = {"lib": None, "online": True}


def log(*a):
    print(*a, flush=True)


def load_config():
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg):
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        log("설정 저장 실패:", e)


def reveal(path):
    system = platform.system()
    if system == "Windows":
        subprocess.Popen(["explorer", "/select,", str(path)])
    elif system == "Darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])


class Handler(BaseHTTPRequestHandler):
    server_version = "PaperShelf/1.0"

    def log_message(self, fmt, *args):
        pass

    # ------------------------------------------------------------ 응답 도우미

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def allowed(self):
        # 다른 웹사이트가 이 서버를 건드리지 못하도록 Host·Origin 확인
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
            return False
        return True

    def route(self, method):
        if not self.allowed():
            return self.send_error_json(403, "forbidden")
        url = urllib.parse.urlparse(self.path)
        path = url.path
        qs = {k: v[-1] for k, v in urllib.parse.parse_qs(url.query).items()}
        for m, pattern, fn in ROUTES:
            if m != method:
                continue
            match = re.fullmatch(pattern, path)
            if match:
                try:
                    return fn(self, qs, *match.groups())
                except Exception as e:
                    traceback.print_exc()
                    return self.send_error_json(500, str(e))
        self.send_error_json(404, "not found")

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    # ------------------------------------------------------------ 화면·파일

    def index(self, qs):
        body = (HERE / "static" / "index.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def pdf(self, qs, pid):
        lib = state["lib"]
        p = lib.get(int(pid))
        if not p or p["missing"]:
            return self.send_error_json(404, "파일이 없습니다")
        path = lib.path_of(p)
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(size))
        quoted = urllib.parse.quote(path.name)
        self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quoted}")
        self.end_headers()
        with open(path, "rb") as f:
            while chunk := f.read(1 << 16):
                self.wfile.write(chunk)

    # ------------------------------------------------------------ API

    def info(self, qs):
        lib = state["lib"]
        self.send_json({"library": str(lib.root), "online": state["online"], **lib.stats()})

    def settings(self, qs):
        data = self.read_json()
        path = Path(os.path.expanduser(str(data.get("library", "")).strip()))
        if not str(path) or not path.is_absolute():
            return self.send_error_json(400, "전체 경로를 입력하세요 (예: C:\\Users\\me\\Papers, /Users/me/Papers)")
        if not path.exists() and not path.parent.exists():
            return self.send_error_json(400, "상위 폴더가 존재하지 않습니다")
        state["lib"] = Library(path)
        cfg = load_config()
        cfg["library"] = str(state["lib"].root)
        save_config(cfg)
        self.info(qs)

    def list_papers(self, qs):
        res = state["lib"].search(
            q=qs.get("q", ""), field=qs.get("field", "all"),
            year_from=qs.get("from") or None, year_to=qs.get("to") or None,
            sort=qs.get("sort", "relevance"), review_only=qs.get("review") == "1")
        self.send_json(res)

    def get_paper(self, qs, pid):
        p = state["lib"].get(int(pid))
        if not p:
            return self.send_error_json(404, "없는 논문입니다")
        self.send_json(self.with_extras(p))

    @staticmethod
    def with_extras(p):
        lib = state["lib"]
        p["citations"] = md.citations(p)
        with lib.connect() as c:
            p["supplements"] = [dict(r) for r in c.execute(
                "SELECT id, file_name, original_name FROM papers WHERE parent_id=? ORDER BY added_at, id", (p["id"],))]
            if p.get("parent_id"):
                r = c.execute("SELECT id, title, file_name FROM papers WHERE id=?", (p["parent_id"],)).fetchone()
                p["parent"] = dict(r) if r else None
        return p

    def mains(self, qs):
        with state["lib"].connect() as c:
            rows = c.execute("SELECT id, title, year, authors FROM papers WHERE kind='main' ORDER BY title").fetchall()
        self.send_json({"items": [{"id": r["id"], "title": r["title"], "year": r["year"],
                                   "who": md.first_author_key(json.loads(r["authors"] or "[]"))} for r in rows]})

    def set_parent(self, qs, pid):
        data = self.read_json()
        try:
            p = state["lib"].set_parent(int(pid), data.get("parent_id"))
        except Exception as e:
            return self.send_error_json(400, str(e))
        if not p:
            return self.send_error_json(404, "없는 논문입니다")
        self.send_json(self.with_extras(p))

    def upload(self, qs):
        lib = state["lib"]
        name = urllib.parse.unquote(self.headers.get("X-Filename") or "paper.pdf")
        name = os.path.basename(name.replace("\\", "/")) or "paper.pdf"
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            return self.send_error_json(400, "파일 크기가 올바르지 않습니다")
        tmp = lib.tmp_dir / f"{uuid.uuid4().hex}.pdf"
        remaining = length
        with open(tmp, "wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 16, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        with open(tmp, "rb") as f:
            if not f.read(1024).lstrip().startswith(b"%PDF"):
                tmp.unlink(missing_ok=True)
                return self.send_error_json(400, f"{name}: PDF 파일이 아닙니다")
        parent_id = self.headers.get("X-Parent-Id")
        try:
            status, p = lib.import_pdf(tmp, name, online=state["online"], log=log,
                                       parent_id=int(parent_id) if parent_id and parent_id.isdigit() else None)
        except (LookupError, ValueError) as e:
            tmp.unlink(missing_ok=True)
            return self.send_error_json(400, f"{name}: {e}")
        except Exception as e:
            tmp.unlink(missing_ok=True)
            traceback.print_exc()
            return self.send_error_json(500, f"{name}: 읽을 수 없는 PDF입니다 ({e})")
        log(f"[{status}] {name} → {p['file_name']}")
        self.send_json({"status": status, "paper": p})

    def update_paper(self, qs, pid):
        p = state["lib"].update(int(pid), self.read_json())
        if not p:
            return self.send_error_json(404, "없는 논문입니다")
        self.send_json(self.with_extras(p))

    def refetch(self, qs, pid):
        data = self.read_json()
        try:
            p = state["lib"].refetch(int(pid), doi=data.get("doi"), arxiv_id=data.get("arxiv_id"))
        except Exception as e:
            return self.send_error_json(400, f"정보를 가져오지 못했습니다: {e}")
        self.send_json(self.with_extras(p))

    def lookup(self, qs):
        """수정 창의 '제목으로 찾기': Crossref 후보 목록."""
        q = qs.get("q", "").strip()
        if not q:
            return self.send_json({"items": []})
        try:
            items = md.crossref_search(q, rows=8)
        except Exception as e:
            return self.send_error_json(502, f"Crossref 검색 실패: {e}")
        for it in items:
            it["scholar_authors"] = md.scholar_authors(it["authors"])
        self.send_json({"items": items})

    def delete_paper(self, qs, pid):
        ok = state["lib"].delete(int(pid))
        self.send_json({"ok": ok})

    def reveal_paper(self, qs, pid):
        lib = state["lib"]
        p = lib.get(int(pid))
        if not p or p["missing"]:
            return self.send_error_json(404, "파일이 없습니다")
        reveal(lib.path_of(p))
        self.send_json({"ok": True})

    def open_folder(self, qs):
        root = state["lib"].root
        system = platform.system()
        cmd = ["explorer", str(root)] if system == "Windows" else ["open" if system == "Darwin" else "xdg-open", str(root)]
        subprocess.Popen(cmd)
        self.send_json({"ok": True})

    def rescan(self, qs):
        res = state["lib"].rescan(online=state["online"], log=log)
        self.send_json(res)

    def export_bib(self, qs):
        body = "\n\n".join(md.bibtex(p) for p in state["lib"].all_papers()).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-bibtex; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="library.bib"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ROUTES = [
    ("GET", r"/", Handler.index),
    ("GET", r"/pdf/(\d+)(?:/.*)?", Handler.pdf),
    ("GET", r"/api/info", Handler.info),
    ("POST", r"/api/settings", Handler.settings),
    ("GET", r"/api/papers", Handler.list_papers),
    ("POST", r"/api/papers", Handler.upload),
    ("GET", r"/api/papers/(\d+)", Handler.get_paper),
    ("PUT", r"/api/papers/(\d+)", Handler.update_paper),
    ("DELETE", r"/api/papers/(\d+)", Handler.delete_paper),
    ("POST", r"/api/papers/(\d+)/refetch", Handler.refetch),
    ("POST", r"/api/papers/(\d+)/reveal", Handler.reveal_paper),
    ("PUT", r"/api/papers/(\d+)/parent", Handler.set_parent),
    ("GET", r"/api/mains", Handler.mains),
    ("GET", r"/api/lookup", Handler.lookup),
    ("POST", r"/api/open-folder", Handler.open_folder),
    ("POST", r"/api/rescan", Handler.rescan),
    ("GET", r"/api/export\.bib", Handler.export_bib),
]


def main():
    ap = argparse.ArgumentParser(description="논문 서재")
    ap.add_argument("--library", help="논문을 보관할 폴더 (기본: 지난번 폴더 또는 ~/Papers)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--offline", action="store_true", help="Crossref·arXiv 조회를 하지 않음")
    ap.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = ap.parse_args()

    cfg = load_config()
    root = args.library or cfg.get("library") or str(DEFAULT_LIBRARY)
    state["lib"] = Library(root)
    state["online"] = not args.offline
    cfg["library"] = str(state["lib"].root)
    save_config(cfg)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    log(f"논문 서재: {url}")
    log(f"논문 폴더: {state['lib'].root}")
    log("끝내려면 이 창에서 Ctrl+C")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
