"""논문 서재 — 내 컴퓨터에서 돌아가는 논문 관리 앱.

    python app.py                     # 기본 폴더(~/Papers)
    python app.py --library D:/논문    # 폴더 지정

브라우저가 자동으로 열린다. 이 컴퓨터(127.0.0.1)에서만 접속할 수 있다.
"""

import argparse
import json
import mimetypes
import os
import platform
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import metadata as md  # noqa: E402
from library import BLOCKED_EXTS, Library, is_video, parse_my_names  # noqa: E402

APP_VERSION = "1.4.15"
HERE = Path(__file__).resolve().parent
# 설치판(PyInstaller)으로 묶였을 때는 화면 파일이 압축 해제 폴더에 있다
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", HERE))
FROZEN = getattr(sys, "frozen", False)
LOG_PATH = Path.home() / ".papershelf.log"
CONFIG_PATH = Path.home() / ".papershelf.json"
DEFAULT_LIBRARY = Path.home() / "Papers"
MAX_UPLOAD = 300 * 1024 * 1024
MAX_VIDEO_UPLOAD = 8 * 1024 * 1024 * 1024

state = {"lib": None, "online": True, "server": None, "on_quit": None, "standalone": False}
cite_job = {"running": False, "done": 0, "total": 0, "found": 0, "finished_at": None}
cite_lock = threading.Lock()
CITATION_MAX_AGE_DAYS = 30


def start_citation_job(only_stale=True):
    """인용 수를 뒤에서 차례로 받아 온다. 이미 돌고 있으면 False."""
    if not state["online"]:
        return False
    with cite_lock:
        if cite_job["running"]:
            return False
        lib = state["lib"]
        ids = lib.stale_citation_ids(CITATION_MAX_AGE_DAYS) if only_stale else None
        if ids is not None and not ids:
            return False
        cite_job.update(running=True, done=0, total=len(ids) if ids is not None else 0, found=0)

    def progress(done, total):
        cite_job.update(done=done, total=total)

    def run():
        try:
            cite_job["found"] = lib.refresh_citations(ids, log=log, progress=progress,
                                                      stop=lambda: state["lib"] is not lib)
        except Exception as e:
            log("인용 수 새로 고침 실패:", e)
        finally:
            cite_job.update(running=False, finished_at=time.time())
    threading.Thread(target=run, daemon=True).start()
    return True


def log(*a):
    try:
        print(*a, flush=True)
    except Exception:
        pass


def setup_logging():
    """창 없는 설치판에서는 print 할 곳이 없으므로 로그 파일로 보낸다."""
    if sys.stdout is None or sys.stderr is None or FROZEN:
        try:
            f = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
        except Exception:
            f = open(os.devnull, "w")
        sys.stdout = sys.stderr = f


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


def open_file(path):
    """기본 프로그램(PDF 보기)으로 연다."""
    system = platform.system()
    if system == "Windows":
        os.startfile(str(path))  # noqa: S606
    elif system == "Darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


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
        body = (RESOURCE_DIR / "static" / "index.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def static_file(self, qs, name):
        """앱에 들어 있는 글꼴·아이콘 파일 (static/ 아래만)."""
        base = (RESOURCE_DIR / "static").resolve()
        path = (base / name).resolve()
        if base not in path.parents or not path.is_file():
            return self.send_error_json(404, "not found")
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or
                         ("font/woff2" if path.suffix == ".woff2" else "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def pdf(self, qs, pid):
        """논문 PDF·보충 동영상 파일. 동영상 앞뒤 넘기기를 위해 Range 요청도 받는다."""
        lib = state["lib"]
        p = lib.get(int(pid))
        if not p or p["missing"] or not p["has_file"]:
            return self.send_error_json(404, "파일이 없습니다")
        path = lib.path_of(p)
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range") or "")
        if m and size:
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            elif m.group(2):  # 끝에서 n 바이트
                start = max(0, size - int(m.group(2)))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        quoted = urllib.parse.quote(path.name)
        # 내 정리 자료 중 HTML·SVG 같은 파일이 이 앱 주소에서 스크립트로 돌지 않도록 PDF·그림·동영상만 바로 보여 준다
        inline = ctype == "application/pdf" or ctype.split("/")[0] in ("video", "audio") or (
            ctype.startswith("image/") and "svg" not in ctype)
        self.send_header("Content-Disposition", f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quoted}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        remaining = end - start + 1
        try:
            with open(path, "rb") as f:
                f.seek(start)
                while remaining > 0 and (chunk := f.read(min(1 << 16, remaining))):
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 동영상 재생 중 앞뒤로 넘기면 브라우저가 연결을 끊는다

    # ------------------------------------------------------------ API

    def info(self, qs):
        lib = state["lib"]
        self.send_json({"app": "papershelf", "version": APP_VERSION, "library": str(lib.root),
                        "standalone": state["standalone"], "my_names": load_config().get("my_names", ""),
                        "kci_key": bool(md.KCI_KEY),
                        "online": state["online"], **lib.stats()})

    def settings(self, qs):
        data = self.read_json()
        path = Path(os.path.expanduser(str(data.get("library", "")).strip()))
        if not str(path) or not path.is_absolute():
            return self.send_error_json(400, "전체 경로를 입력하세요 (예: C:\\Users\\me\\Papers, /Users/me/Papers)")
        if not path.exists() and not path.parent.exists():
            return self.send_error_json(400, "상위 폴더가 존재하지 않습니다")
        cfg = load_config()
        if path.resolve() != state["lib"].root:
            state["lib"] = Library(path)
        if "my_names" in data:
            cfg["my_names"] = str(data["my_names"]).strip()
        if "kci_key" in data:
            cfg["kci_key"] = md.KCI_KEY = str(data["kci_key"]).strip()
        state["lib"].my_names = parse_my_names(cfg.get("my_names", ""))
        cfg["library"] = str(state["lib"].root)
        save_config(cfg)
        self.info(qs)

    def list_papers(self, qs):
        res = state["lib"].search(
            q=qs.get("q", ""), field=qs.get("field", "all"),
            year_from=qs.get("from") or None, year_to=qs.get("to") or None,
            sort=qs.get("sort", "relevance"), review_only=qs.get("review") == "1", doc=qs.get("doc", "all"),
            mine_only=qs.get("mine") == "1", read=qs.get("read") or None,
            collection=int(qs["coll"]) if (qs.get("coll") or "").isdigit() else None,
            rating_min=int(qs["stars"]) if (qs.get("stars") or "").isdigit() else 0,
            offset=int(qs.get("offset") or 0) if (qs.get("offset") or "0").isdigit() else 0,
            limit=min(int(qs["limit"]), 200) if (qs.get("limit") or "").isdigit() and int(qs["limit"]) > 0 else None)
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
            kids = [dict(r) for r in c.execute(
                "SELECT id, kind, file_name, original_name FROM papers WHERE parent_id=? ORDER BY added_at, id", (p["id"],))]
            p["supplements"] = [k for k in kids if k["kind"] != "note"]
            p["attachments"] = [k for k in kids if k["kind"] == "note"]
            if p.get("parent_id"):
                r = c.execute("SELECT id, title, file_name FROM papers WHERE id=?", (p["parent_id"],)).fetchone()
                p["parent"] = dict(r) if r else None
        return p

    def match_parent(self, qs):
        """동영상 파일 이름으로 본문 논문을 미리 찾아 본다(큰 파일을 올리기 전에)."""
        pid = state["lib"].find_parent_by_name(qs.get("name", ""))
        p = state["lib"].get(pid) if pid else None
        self.send_json({"id": p["id"], "title": p["title"]} if p else {"id": None})

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
        ext = Path(name).suffix.lower()
        # 내 정리 자료: 명시했거나(X-Kind: note), PDF·동영상이 아닌 파일
        note = self.headers.get("X-Kind") == "note" or (ext != ".pdf" and not is_video(name))
        video = is_video(name) and not note
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > (MAX_VIDEO_UPLOAD if video or note else MAX_UPLOAD):
            return self.send_error_json(400, "파일 크기가 올바르지 않습니다")
        if note and ext in BLOCKED_EXTS:
            return self.send_error_json(400, f"{name}: 실행 파일은 정리 자료로 넣을 수 없습니다")
        tmp = lib.tmp_dir / f"{uuid.uuid4().hex}{ext if video or note else '.pdf'}"
        remaining = length
        with open(tmp, "wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 16, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        parent_id = self.headers.get("X-Parent-Id")
        if note:
            try:
                status, p = lib.import_note(tmp, name, int(parent_id) if parent_id and parent_id.isdigit() else None)
            except LookupError as e:
                tmp.unlink(missing_ok=True)
                if str(e) == "needs_parent":
                    return self.send_json({"error": f"{name}: 어느 논문의 정리 자료인지 골라 주세요",
                                           "needs_parent": True}, 409)
                return self.send_error_json(400, f"{name}: {e}")
            except ValueError as e:
                tmp.unlink(missing_ok=True)
                return self.send_error_json(400, f"{name}: {e}")
            log(f"[{status}] {name} → {p['file_name']}")
            return self.send_json({"status": status, "paper": p})
        if video:
            try:
                status, p = lib.import_video(tmp, name, parent_id=int(parent_id) if parent_id and parent_id.isdigit() else None)
            except LookupError as e:
                tmp.unlink(missing_ok=True)
                if str(e) == "needs_parent":
                    return self.send_json({"error": f"{name}: 어느 논문의 보충 동영상인지 골라 주세요",
                                           "needs_parent": True}, 409)
                return self.send_error_json(400, f"{name}: {e}")
            except ValueError as e:
                tmp.unlink(missing_ok=True)
                return self.send_error_json(400, f"{name}: {e}")
            log(f"[{status}] {name} → {p['file_name']}")
            return self.send_json({"status": status, "paper": p})
        with open(tmp, "rb") as f:
            if not f.read(1024).lstrip().startswith(b"%PDF"):
                tmp.unlink(missing_ok=True)
                return self.send_error_json(400, f"{name}: PDF나 동영상 파일이 아닙니다")
        target = lib.get(int(parent_id)) if parent_id and parent_id.isdigit() else None
        if target and target["kind"] == "main" and not target["has_file"]:
            # PDF 없이 추가해 둔 항목 위에 놓은 PDF는 그 항목의 PDF가 된다
            try:
                status, p = lib.attach_file(target["id"], tmp, name)
            except Exception as e:
                tmp.unlink(missing_ok=True)
                return self.send_error_json(400, f"{name}: {e}")
            log(f"[{status}] {name} → {p['file_name']}")
            return self.send_json({"status": status, "paper": p})
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
            p = state["lib"].refetch(int(pid), doi=data.get("doi"), arxiv_id=data.get("arxiv_id"),
                                     isbn=data.get("isbn"), kci_id=data.get("kci_id"))
        except Exception as e:
            return self.send_error_json(400, f"정보를 가져오지 못했습니다: {e}")
        self.send_json(self.with_extras(p))

    def lookup(self, qs):
        """수정 창의 '제목으로 찾기': Crossref 와 Google Books(책) 후보 목록."""
        q = qs.get("q", "").strip()
        if not q:
            return self.send_json({"items": []})
        items, errors = [], []
        sources = [("Crossref", lambda: md.crossref_search(q, rows=6))]
        if md.KCI_KEY:
            kci = ("KCI", lambda: md.kci_search(q, rows=6))
            sources = [kci] + sources if md.is_hangul(q) else sources + [kci]
        books = [("Google Books", lambda: md.google_books_search(q, rows=4))]
        # 책으로 찾을 때는 Google Books 를 앞에
        for name, fn in (books + sources if qs.get("doc") == "book" else sources + books):
            try:
                items += fn()
            except Exception as e:
                errors.append(f"{name}: {e}")
        if not items and errors:
            return self.send_error_json(502, "검색 실패 — " + "; ".join(errors))
        for it in items:
            it["scholar_authors"] = md.scholar_authors(it["authors"])
        self.send_json({"items": items})

    def delete_paper(self, qs, pid):
        try:
            ok = state["lib"].delete(int(pid))
        except ValueError as e:
            return self.send_error_json(409, str(e))
        self.send_json({"ok": ok})

    def reveal_paper(self, qs, pid):
        lib = state["lib"]
        p = lib.get(int(pid))
        if not p or p["missing"] or not p["has_file"]:
            return self.send_error_json(404, "파일이 없습니다")
        reveal(lib.path_of(p))
        self.send_json({"ok": True})

    def open_paper(self, qs, pid):
        lib = state["lib"]
        p = lib.get(int(pid))
        if not p or p["missing"] or not p["has_file"]:
            return self.send_error_json(404, "파일이 없습니다")
        open_file(lib.path_of(p))
        self.send_json({"ok": True})

    def open_url(self, qs):
        url = str(self.read_json().get("url", ""))
        if not re.match(r"^https?://", url):
            return self.send_error_json(400, "열 수 없는 주소입니다")
        webbrowser.open(url)
        self.send_json({"ok": True})

    def show_window(self, qs):
        import desktop
        self.send_json({"ok": state["standalone"] and desktop.show()})

    def export_bib_dialog(self, qs):
        """독립 창에서는 내려받기가 없으니 저장 위치를 물어 직접 쓴다."""
        import desktop
        coll = int(qs["coll"]) if (qs.get("coll") or "").isdigit() else None
        path = desktop.save_dialog("library.bib", "BibTeX", "*.bib")
        if not path:
            return self.send_json({"saved": None})
        body = "\n\n".join(md.bibtex(p) for p in state["lib"].all_papers(coll))
        Path(path).write_text(body, encoding="utf-8")
        self.send_json({"saved": str(path)})

    def open_folder(self, qs):
        root = state["lib"].root
        system = platform.system()
        cmd = ["explorer", str(root)] if system == "Windows" else ["open" if system == "Darwin" else "xdg-open", str(root)]
        subprocess.Popen(cmd)
        self.send_json({"ok": True})

    def rescan(self, qs):
        res = state["lib"].rescan(online=state["online"], log=log)
        self.send_json(res)

    def quit(self, qs):
        self.send_json({"ok": True})
        threading.Thread(target=shutdown, daemon=True).start()

    def citations_refresh(self, qs):
        data = self.read_json()
        if not state["online"]:
            return self.send_error_json(400, "오프라인 모드에서는 인용 수를 받아올 수 없습니다")
        started = start_citation_job(only_stale=not data.get("all"))
        self.send_json({"started": started, **cite_job})

    def citations_status(self, qs):
        self.send_json(cite_job)

    def add_by_id(self, qs):
        data = self.read_json()
        try:
            status, p, source, reason = state["lib"].add_by_id(str(data.get("key", "")), online=state["online"],
                                                               fetch_pdf=data.get("fetch_pdf", True), log=log)
        except (LookupError, ValueError) as e:
            return self.send_error_json(400, str(e))
        log(f"[{status}] {data.get('key')} → {p['title']}" + (f" (PDF: {source})" if source else ""))
        self.send_json({"status": status, "paper": p, "pdf_source": source, "pdf_reason": reason})

    def find_pdf(self, qs, pid):
        if not state["online"]:
            return self.send_error_json(400, "오프라인 모드입니다")
        source, reason = state["lib"].fetch_open_pdf(int(pid), log=log)
        self.send_json({"pdf_source": source, "pdf_reason": reason, "paper": state["lib"].get(int(pid))})

    def mark(self, qs, pid):
        data = self.read_json()
        try:
            p = state["lib"].mark(int(pid), read_status=data.get("read_status"), rating=data.get("rating"))
        except ValueError as e:
            return self.send_error_json(400, str(e))
        if not p:
            return self.send_error_json(404, "없는 논문입니다")
        self.send_json({"id": p["id"], "read_status": p["read_status"], "rating": p["rating"]})

    def list_collections(self, qs):
        self.send_json({"items": state["lib"].collections()})

    def create_collection(self, qs):
        try:
            self.send_json(state["lib"].create_collection(self.read_json().get("name")))
        except ValueError as e:
            self.send_error_json(400, str(e))

    def update_collection(self, qs, cid):
        try:
            state["lib"].rename_collection(int(cid), self.read_json().get("name"))
        except ValueError as e:
            return self.send_error_json(400, str(e))
        self.send_json({"ok": True})

    def delete_collection(self, qs, cid):
        state["lib"].delete_collection(int(cid))
        self.send_json({"ok": True})

    def set_collection(self, qs, pid):
        data = self.read_json()
        try:
            ids = state["lib"].set_in_collection(int(pid), int(data.get("collection_id") or 0), bool(data.get("on", True)))
        except LookupError as e:
            return self.send_error_json(404, str(e))
        self.send_json({"collections": ids})

    def kci_test(self, qs):
        key = str(self.read_json().get("key", "")).strip() or md.KCI_KEY  # 비워 두면 저장된 키를 확인
        old = md.KCI_KEY
        md.KCI_KEY = key
        try:
            n = len(md.kci_search("인공지능", rows=3))
        except Exception as e:
            return self.send_error_json(400, f"확인하지 못했습니다: {e}")
        finally:
            md.KCI_KEY = old
        self.send_json({"ok": True, "found": n})

    def export_bib(self, qs):
        coll = int(qs["coll"]) if (qs.get("coll") or "").isdigit() else None
        body = "\n\n".join(md.bibtex(p) for p in state["lib"].all_papers(coll)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-bibtex; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="library.bib"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ROUTES = [
    ("GET", r"/", Handler.index),
    ("GET", r"/static/([\w\-./]+)", Handler.static_file),
    ("GET", r"/(?:pdf|file)/(\d+)(?:/.*)?", Handler.pdf),
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
    ("GET", r"/api/match-parent", Handler.match_parent),
    ("GET", r"/api/lookup", Handler.lookup),
    ("POST", r"/api/open-folder", Handler.open_folder),
    ("POST", r"/api/rescan", Handler.rescan),
    ("GET", r"/api/export\.bib", Handler.export_bib),
    ("POST", r"/api/quit", Handler.quit),
    ("POST", r"/api/papers/(\d+)/open", Handler.open_paper),
    ("POST", r"/api/open-url", Handler.open_url),
    ("POST", r"/api/show", Handler.show_window),
    ("POST", r"/api/export-bib-dialog", Handler.export_bib_dialog),
    ("POST", r"/api/citations/refresh", Handler.citations_refresh),
    ("GET", r"/api/citations/status", Handler.citations_status),
    ("POST", r"/api/papers/by-id", Handler.add_by_id),
    ("POST", r"/api/papers/(\d+)/find-pdf", Handler.find_pdf),
    ("PUT", r"/api/papers/(\d+)/mark", Handler.mark),
    ("PUT", r"/api/papers/(\d+)/collection", Handler.set_collection),
    ("GET", r"/api/collections", Handler.list_collections),
    ("POST", r"/api/collections", Handler.create_collection),
    ("PUT", r"/api/collections/(\d+)", Handler.update_collection),
    ("DELETE", r"/api/collections/(\d+)", Handler.delete_collection),
    ("POST", r"/api/kci-test", Handler.kci_test),
]


def shutdown():
    if state["server"]:
        state["server"].shutdown()
    if state["on_quit"]:
        state["on_quit"]()


def open_library_folder():
    root = state["lib"].root
    system = platform.system()
    cmd = ["explorer", str(root)] if system == "Windows" else ["open" if system == "Darwin" else "xdg-open", str(root)]
    subprocess.Popen(cmd)


def already_running(port):
    """같은 포트에 논문 서재가 이미 떠 있으면 True."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=2) as r:
            return json.loads(r.read()).get("app") == "papershelf"
    except Exception:
        return False


def main():
    setup_logging()
    ap = argparse.ArgumentParser(description="논문 서재")
    ap.add_argument("--library", help="논문을 보관할 폴더 (기본: 지난번 폴더 또는 ~/Papers)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--offline", action="store_true", help="Crossref·arXiv 조회를 하지 않음")
    ap.add_argument("--browser", action="store_true", help="자체 창 대신 웹 브라우저로 연다")
    ap.add_argument("--no-browser", action="store_true", help="(브라우저 모드) 브라우저를 자동으로 열지 않음")
    ap.add_argument("--no-tray", action="store_true", help="(브라우저 모드) 알림 영역 아이콘을 띄우지 않음")
    ap.add_argument("--minimized", action="store_true", help="(창 모드) 최소화한 채로 시작")
    ap.add_argument("--selftest", action="store_true", help="창 엔진을 불러올 수 있는지 점검하고 끝냄")
    args, _ = ap.parse_known_args()  # macOS 가 붙이는 -psn_… 인자 무시

    if args.selftest:
        import desktop
        desktop.selftest()
        log("selftest ok")
        return

    import desktop
    use_window = not args.browser and desktop.available()

    url = f"http://127.0.0.1:{args.port}/"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        if already_running(args.port):
            # 이미 켜져 있으면 그 창을 앞으로 부르고(안 되면 브라우저로) 끝낸다
            try:
                req = urllib.request.Request(url + "api/show", data=b"{}", method="POST")
                with urllib.request.urlopen(req, timeout=3) as r:
                    shown = json.loads(r.read()).get("ok")
            except Exception:
                shown = False
            if not shown and not args.no_browser and not args.minimized:
                webbrowser.open(url)
            return
        raise

    cfg = load_config()
    root = args.library or cfg.get("library") or str(DEFAULT_LIBRARY)
    state["lib"] = Library(root)
    state["lib"].my_names = parse_my_names(cfg.get("my_names", ""))
    md.KCI_KEY = cfg.get("kci_key", "")
    state["online"] = not args.offline
    state["server"] = server
    cfg["library"] = str(state["lib"].root)
    save_config(cfg)

    log(f"논문 서재 {APP_VERSION}: {url}")
    log(f"논문 폴더: {state['lib'].root}")
    # 한 달 넘게 지난 인용 수는 켤 때마다 뒤에서 조용히 갱신
    threading.Timer(3, start_citation_job).start()
    # 열려 있어서 이름을 못 바꾼 PDF는 1분마다 다시 시도
    def retry_loop():
        while True:
            try:
                n = state["lib"].retry_renames()
                if n:
                    log(f"미뤄 둔 파일 이름 {n}개를 바꿨습니다")
            except Exception as e:
                log("파일 이름 다시 바꾸기 실패:", e)
            time.sleep(60)
    threading.Thread(target=retry_loop, daemon=True).start()

    if use_window:
        # 자체 창: 서버는 뒤에서, 창은 메인 스레드에서. 창을 닫으면 프로그램도 끝난다.
        threading.Thread(target=server.serve_forever, daemon=True).start()
        state["standalone"] = True
        state["on_quit"] = desktop.close
        try:
            desktop.run(url, "논문 서재", minimized=args.minimized)
            server.shutdown()
            return
        except Exception as e:
            # WebView2 가 없는 오래된 Windows 등: 브라우저 모드로 이어서 동작
            log("자체 창을 띄우지 못해 브라우저로 엽니다:", e)
            state["standalone"] = False
            state["on_quit"] = None
            server.shutdown()
            server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
            state["server"] = server

    if not args.no_browser and not args.minimized:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    use_tray = FROZEN and not args.no_tray
    if use_tray:
        try:
            import tray
            icon = tray.make(RESOURCE_DIR / "static" / "icon.png", url,
                             open_folder=open_library_folder, quit=shutdown)
        except Exception as e:
            log("알림 영역 아이콘을 띄우지 못했습니다:", e)
            use_tray = False
    if use_tray:
        state["on_quit"] = icon.stop
        stopped = threading.Event()

        def serve():
            server.serve_forever()
            stopped.set()
        threading.Thread(target=serve, daemon=True).start()
        try:
            icon.run()  # macOS 는 아이콘이 메인 스레드에서 돌아야 한다
        except Exception as e:
            log("알림 영역 아이콘 오류:", e)
            state["on_quit"] = None
        stopped.wait()  # 아이콘이 실패해도 서버는 '앱 종료'까지 계속 돈다
        return

    log("끝내려면 이 창에서 Ctrl+C (또는 화면의 설정 → 앱 종료)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
