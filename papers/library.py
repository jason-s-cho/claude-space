"""논문 폴더와 그 색인(SQLite)을 관리한다.

색인은 논문 폴더 안의 .papershelf/library.db 에 있어서, 폴더째 옮기면 색인도 함께 옮겨진다.
"""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import threading
import time
import unicodedata
import urllib.parse
from pathlib import Path

import metadata as md

META_DIR = ".papershelf"
EDITABLE = ("title", "authors", "journal", "year", "volume", "issue", "pages", "publisher",
            "doi", "arxiv_id", "url", "abstract", "tags", "notes", "type", "isbn", "edition", "mine")
BOOK_TYPES = tuple(sorted(md.BOOK_TYPES))

# 왼쪽 '종류' 필터의 묶음 (Crossref 의 type 값 기준)
DOC_GROUPS = {
    "journal": ("journal-article",),
    "proceedings": ("proceedings-article", "proceedings", "proceedings-series"),
    "report": ("report", "report-component", "report-series"),
    "thesis": ("dissertation", "thesis"),
    "book": BOOK_TYPES + ("book-chapter", "book-part", "book-section"),
}
KNOWN_TYPES = tuple(t for group in DOC_GROUPS.values() for t in group)


def doc_group(kind):
    for name, types in DOC_GROUPS.items():
        if (kind or "") in types:
            return name
    return "other"


def _nk(s):
    return re.sub(r"[^\w]", "", unicodedata.normalize("NFKC", s or "").lower())


def parse_my_names(text):
    """설정의 '내 이름' 칸: 'Seungmin Cho; S. Cho; 조승민' → 이름 목록."""
    out = []
    for part in re.split(r"[;\n]+", text or ""):
        part = part.strip()
        if part:
            out.append(md.split_name(part))
    return out


def author_is(a, me):
    """저자 a 가 내 이름 me 와 같은 사람으로 보이는지."""
    a_full = _nk((a.get("family") or "") + (a.get("given") or ""))
    me_full = _nk((me.get("family") or "") + (me.get("given") or ""))
    if md.is_hangul(me_full) or not me.get("given"):
        # 한글 이름이나 한 덩어리 이름: 성·이름 순서와 상관없이 통째로 비교
        return bool(me_full) and me_full in (a_full, _nk((a.get("given") or "") + (a.get("family") or "")))
    if _nk(a.get("family")) != _nk(me.get("family")):
        return False
    me_given = [t for t in re.split(r"[\s.\-]+", me["given"]) if t]
    a_given = [t for t in re.split(r"[\s.\-]+", a.get("given") or "") if t]
    if all(len(t) == 1 for t in me_given):  # 'S. M. Cho' 처럼 머리글자로 적은 경우
        return "".join(t[0] for t in a_given).lower().startswith("".join(me_given).lower())
    return _nk(" ".join(a_given)) == _nk(" ".join(me_given))

SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    id INTEGER PRIMARY KEY,
    file_name TEXT NOT NULL,
    original_name TEXT,
    sha256 TEXT UNIQUE,
    title TEXT, authors TEXT, authors_text TEXT,
    journal TEXT, year INTEGER, volume TEXT, issue TEXT, pages TEXT, publisher TEXT,
    doi TEXT, arxiv_id TEXT, url TEXT, abstract TEXT, type TEXT,
    tags TEXT DEFAULT '', notes TEXT DEFAULT '',
    source TEXT, needs_review INTEGER DEFAULT 0,
    fulltext TEXT,
    added_at REAL, updated_at REAL,
    kind TEXT DEFAULT 'main',
    parent_id INTEGER,
    isbn TEXT DEFAULT '',
    edition TEXT DEFAULT '',
    page_count INTEGER,
    cited_by INTEGER,
    cited_by_source TEXT DEFAULT '',
    cited_by_url TEXT DEFAULT '',
    cited_by_at REAL,
    mine INTEGER,
    rename_pending INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS papers_doi ON papers(doi);
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at REAL
);
CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL,
    paper_id INTEGER NOT NULL,
    added_at REAL,
    PRIMARY KEY (collection_id, paper_id)
);
CREATE INDEX IF NOT EXISTS papers_year ON papers(year);
"""
MIGRATIONS = [
    ("kind", "ALTER TABLE papers ADD COLUMN kind TEXT DEFAULT 'main'"),
    ("parent_id", "ALTER TABLE papers ADD COLUMN parent_id INTEGER"),
    ("isbn", "ALTER TABLE papers ADD COLUMN isbn TEXT DEFAULT ''"),
    ("edition", "ALTER TABLE papers ADD COLUMN edition TEXT DEFAULT ''"),
    ("page_count", "ALTER TABLE papers ADD COLUMN page_count INTEGER"),
    ("cited_by", "ALTER TABLE papers ADD COLUMN cited_by INTEGER"),
    ("cited_by_source", "ALTER TABLE papers ADD COLUMN cited_by_source TEXT DEFAULT ''"),
    ("cited_by_url", "ALTER TABLE papers ADD COLUMN cited_by_url TEXT DEFAULT ''"),
    ("cited_by_at", "ALTER TABLE papers ADD COLUMN cited_by_at REAL"),
    ("mine", "ALTER TABLE papers ADD COLUMN mine INTEGER"),
    ("rename_pending", "ALTER TABLE papers ADD COLUMN rename_pending INTEGER DEFAULT 0"),
    ("read_status", "ALTER TABLE papers ADD COLUMN read_status TEXT DEFAULT ''"),  # '' 안 읽음, reading, read
    ("rating", "ALTER TABLE papers ADD COLUMN rating INTEGER DEFAULT 0"),  # 0~5  # 파일이 열려 있어 이름을 못 바꿈  # 1 내 저작, 0 아님, NULL 이름으로 자동 판단
]
READ_STATUSES = ("", "reading", "read")
SUPP_SUFFIX = " - Supplementary"
VIDEO_SUFFIX = " - Supplementary Video"
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".mpg", ".mpeg", ".ogv", ".3gp", ".flv"}


NOTE_MARK = " - 정리 - "
# 내 정리 자료로 받지 않는 파일(실행 파일·스크립트)
BLOCKED_EXTS = {".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf",
                ".lnk", ".reg", ".dll", ".sh", ".app", ".pkg", ".dmg", ".jar", ".command"}
CHILD_KINDS = ("supp", "note")


def is_child(p):
    """본문 논문에 딸린 보충자료·내 정리 자료."""
    return (p["kind"] or "main") in CHILD_KINDS and bool(p["parent_id"])


def is_video(name):
    return Path(name).suffix.lower() in VIDEO_EXTS


def supp_label(name):
    return VIDEO_SUFFIX if is_video(name) else SUPP_SUFFIX


def original_key(name):
    """보충자료 파일 이름에서 출판사 번호만 남긴다.
    '41586_2020_1234_MOESM2_ESM.mp4' → '41586_2020_1234', '1-s2.0-S0010-mmc3.mp4' → '1-s2.0-s0010'."""
    stem = Path(name or "").stem.lower()
    stem = re.sub(r"[_\-\s]*(moesm\d+[_\-]?esm|mmc\d+|main|supp\w*|si\d*|esi|movie\s*s?\d*|video\s*s?\d*|"
                  r"media[_\-]?\d+|s\d+)$", "", stem)
    return stem.strip("_- .")

# 검색 범위별 대상 칸과 관련도 가중치
SEARCH_FIELDS = {
    "all": [("title", 10), ("authors_text", 8), ("journal", 4), ("tags", 5), ("doi", 6), ("isbn", 6),
            ("abstract", 2), ("notes", 3), ("publisher", 1), ("fulltext", 1)],
    "meta": [("title", 10), ("authors_text", 8), ("journal", 4), ("tags", 5), ("doi", 6), ("isbn", 6),
             ("abstract", 2), ("notes", 3), ("publisher", 1)],
    "title": [("title", 10)],
    "author": [("authors_text", 10)],
    "journal": [("journal", 10), ("publisher", 3)],
    "fulltext": [("fulltext", 1), ("abstract", 2)],
}

INVALID_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def safe_component(s, limit):
    s = unicodedata.normalize("NFC", s or "")
    s = INVALID_CHARS.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    if len(s) > limit:
        s = s[:limit].rsplit(" ", 1)[0] if " " in s[:limit] else s[:limit]
    return s.strip(" .,;-")


def nice_file_name(p):
    """'Vaswani et al. - 2017 - Attention Is All You Need.pdf' 같은 이름."""
    authors = p.get("authors") or []
    who = safe_component(md.first_author_key(authors), 40) or "Unknown"
    if len(authors) == 2:
        who += " & " + safe_component(md.first_author_key(authors[1:]), 40)
    elif len(authors) > 2:
        who += " 외" if md.is_hangul(who) else " et al."
    parts = [who]
    if p.get("year"):
        parts.append(str(p["year"]))
    parts.append(safe_component(p.get("title") or "Untitled", 110) or "Untitled")
    return " - ".join(parts) + ".pdf"


def parse_terms(q):
    """공백으로 나누되 "따옴표 구절"은 하나로."""
    terms = [a or b for a, b in re.findall(r'"([^"]+)"|(\S+)', q or "")]
    return [t.strip() for t in terms if t.strip()]


def make_snippet(text, terms, width=220):
    if not text:
        return ""
    low = text.lower()
    pos = -1
    for t in terms:
        pos = low.find(t.lower())
        if pos >= 0:
            break
    if pos < 0:
        return ""
    start = max(0, pos - width // 3)
    end = min(len(text), start + width)
    s = text[start:end].strip()
    return ("…" if start > 0 else "") + s + ("…" if end < len(text) else "")


class Library:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.meta_dir = self.root / META_DIR
        self.tmp_dir = self.meta_dir / "tmp"
        self.trash_dir = self.meta_dir / "trash"
        for d in (self.meta_dir, self.tmp_dir, self.trash_dir):
            d.mkdir(exist_ok=True)
        self.db_path = self.meta_dir / "library.db"
        self.lock = threading.Lock()
        self.my_names = []  # 설정의 '내 이름' (parse_my_names 결과)
        with self.connect() as c:
            c.executescript(SCHEMA)
            cols = {r["name"] for r in c.execute("PRAGMA table_info(papers)")}
            for col, sql in MIGRATIONS:
                if col not in cols:
                    c.execute(sql)
            c.execute("CREATE INDEX IF NOT EXISTS papers_parent ON papers(parent_id)")

    def connect(self):
        c = sqlite3.connect(self.db_path, timeout=30)
        c.row_factory = sqlite3.Row
        return c

    # ------------------------------------------------------------ 변환

    def to_dict(self, row, with_text=False, check_file=True):
        p = dict(row)
        p["authors"] = json.loads(p.get("authors") or "[]")
        if not with_text:
            p.pop("fulltext", None)
        p["needs_review"] = bool(p.get("needs_review"))
        p["kind"] = p.get("kind") or "main"
        p["doc_group"] = doc_group(p.get("type"))
        p["is_mine"] = self.is_mine(p)
        p["scholar_authors"] = md.scholar_authors(p["authors"])
        # 파일이 실제로 있는지는 디스크를 봐야 해서, 목록에서는 보여 줄 쪽만 확인한다
        p["has_file"] = bool(p.get("file_name"))  # DOI·ISBN 으로만 추가해 PDF가 아직 없는 항목은 False
        p["missing"] = p["has_file"] and not (self.root / p["file_name"]).exists() if check_file else False
        p["read_status"] = p.get("read_status") or ""
        p["rating"] = p.get("rating") or 0
        return p

    def is_mine(self, p):
        """직접 표시한 값이 있으면 그대로, 없으면 저자 중에 설정의 '내 이름'이 있는지."""
        if p.get("mine") is not None:
            return bool(p["mine"])
        if not self.my_names:
            return False
        authors = p["authors"] if isinstance(p.get("authors"), list) else json.loads(p.get("authors") or "[]")
        return any(author_is(a, me) for a in authors for me in self.my_names)

    def get(self, pid, with_text=False):
        with self.connect() as c:
            row = c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()
        return self.to_dict(row, with_text) if row else None

    @staticmethod
    def _base_of(main):
        """딸린 파일 이름의 앞부분: 본문 PDF 이름(확장자 뺌). PDF가 아직 없으면 붙을 이름."""
        main = dict(main)
        if main.get("file_name"):
            return Path(main["file_name"]).stem
        if isinstance(main.get("authors"), str):
            main["authors"] = json.loads(main["authors"] or "[]")
        return nice_file_name(main)[:-4]

    def path_of(self, p):
        path = (self.root / p["file_name"]).resolve()
        if self.root not in path.parents:
            raise ValueError("library 밖의 경로")
        return path

    # ------------------------------------------------------------ 이름 정하기

    def _unique_target(self, name, current=None):
        stem, ext = Path(name).stem, Path(name).suffix
        target = self.root / name
        n = 2
        while target.exists():
            if current is not None and os.path.samefile(target, current):
                break  # 이미 그 이름(대소문자만 다른 경우 포함)
            # 보충자료는 'X - Supplementary 2.pdf', 'X - Supplementary Video 2.mp4', 그 밖에는 'X (2).pdf'
            numbered = stem.endswith(SUPP_SUFFIX) or stem.endswith(VIDEO_SUFFIX)
            target = self.root / (f"{stem} {n}{ext}" if numbered else f"{stem} ({n}){ext}")
            n += 1
        return target

    # ------------------------------------------------------------ 가져오기

    def find_duplicate(self, c, sha=None, doi=None):
        if sha:
            row = c.execute("SELECT * FROM papers WHERE sha256=?", (sha,)).fetchone()
            if row:
                return row
        if doi:
            row = c.execute("SELECT * FROM papers WHERE lower(doi)=? AND kind='main'", (doi.lower(),)).fetchone()
            if row:
                return row
        return None

    def import_pdf(self, src, original_name, online=True, in_place=False, log=None, parent_id=None):
        """src 의 PDF를 서재에 넣는다. in_place=True 면 이미 폴더 안에 있던 파일.

        보충자료로 판단되면(또는 parent_id 를 주면) 본문 논문에 묶고
        '본문 파일 이름 - Supplementary.pdf' 로 저장한다.
        반환: (상태, 논문 dict). 상태는 'added' | 'duplicate'.
        """
        src = Path(src)
        sha = sha256_file(src)
        with self.connect() as c:
            dup = self.find_duplicate(c, sha=sha)
            parent = c.execute("SELECT * FROM papers WHERE id=?", (parent_id,)).fetchone() if parent_id else None
            if parent is not None:
                parent = self._main_of(c, parent)
        if dup:
            if not in_place:
                src.unlink(missing_ok=True)
            return "duplicate", self.to_dict(dup)
        if parent_id and not parent:
            raise LookupError("묶을 본문 논문이 없습니다")

        rec = md.extract(src, original_name, online=online and not parent, log=log,
                         supplement=True if parent else None)
        is_supp = rec["is_supplement"]
        cited = None
        if online and not is_supp and not parent:
            cited = md.citation_count(rec, log)

        with self.lock, self.connect() as c:
            if parent is not None:
                parent = c.execute("SELECT * FROM papers WHERE id=?", (parent["id"],)).fetchone()
                if parent is None:
                    raise LookupError("묶을 본문 논문이 없습니다")
                rec = self._inherit(rec, parent)
            elif is_supp:
                parent = self._find_parent(c, rec)
                if parent is not None:
                    rec = self._inherit(rec, parent)
            else:
                holder = self._find_placeholder(c, rec)
                if holder is not None:
                    # DOI·ISBN 으로 먼저 추가해 둔 항목이면 그 항목의 PDF가 된다
                    self._attach_file_locked(c, holder, src, original_name, sha, rec.get("fulltext", ""),
                                             rec.get("page_count"), in_place)
                    return "attached", self.to_dict(c.execute("SELECT * FROM papers WHERE id=?",
                                                              (holder["id"],)).fetchone())
                dup = self.find_duplicate(c, sha=sha, doi=rec.get("doi"))
                if dup:
                    if not in_place:
                        src.unlink(missing_ok=True)
                    return "duplicate", self.to_dict(dup)
            if is_supp or parent is not None:
                base = self._base_of(parent) if parent is not None else nice_file_name(rec)[:-4]
                name = base + SUPP_SUFFIX + ".pdf"
            else:
                name = nice_file_name(rec)
            target = self._unique_target(name, current=src if in_place else None)
            shutil.move(str(src), str(target))
            now = time.time()
            cur = c.execute(
                """INSERT INTO papers (file_name, original_name, sha256, title, authors, authors_text,
                   journal, year, volume, issue, pages, publisher, doi, arxiv_id, url, abstract, type,
                   tags, notes, source, needs_review, fulltext, added_at, updated_at, kind, parent_id,
                   isbn, edition, page_count, cited_by, cited_by_source, cited_by_url, cited_by_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (target.name, original_name, sha, rec["title"], json.dumps(rec["authors"], ensure_ascii=False),
                 self.authors_text(rec["authors"]), rec["journal"], rec["year"], rec["volume"], rec["issue"],
                 rec["pages"], rec["publisher"], rec["doi"], rec.get("arxiv_id", ""), rec["url"],
                 rec["abstract"], rec["type"], rec.get("keywords", ""), "", rec["source"],
                 int(rec["needs_review"]), rec["fulltext"], now, now,
                 "supp" if (is_supp or parent is not None) else "main",
                 parent["id"] if parent is not None else None,
                 rec.get("isbn", ""), rec.get("edition", ""), rec.get("page_count"),
                 cited["count"] if cited else None, cited["source"] if cited else "",
                 cited["url"] if cited else "", now if online and not is_supp and not parent else None))
            pid = cur.lastrowid
            if not is_supp and parent is None:
                self._adopt_orphans(c, pid)
        return "added", self.get(pid)

    def find_parent_by_name(self, original_name):
        """출판사 번호가 같은 파일(예: 같은 논문의 MOESM1 PDF)이 딸린 본문 논문."""
        key = original_key(original_name)
        if len(key) < 6:
            return None
        with self.connect() as c:
            for row in c.execute("SELECT id, kind, parent_id, original_name FROM papers WHERE original_name IS NOT NULL"):
                if original_key(row["original_name"]) == key:
                    return row["parent_id"] if row["kind"] == "supp" and row["parent_id"] else (
                        row["id"] if row["kind"] == "main" else None)
        return None

    def import_video(self, src, original_name, parent_id=None, in_place=False):
        """보충 동영상을 본문 논문에 묶어 '본문 이름 - Supplementary Video.mp4' 로 저장한다.

        parent_id 가 없으면 파일 이름으로 본문을 찾고, 못 찾으면 LookupError('needs_parent').
        반환: (상태, 항목 dict).
        """
        src = Path(src)
        sha = sha256_file(src)
        with self.connect() as c:
            dup = self.find_duplicate(c, sha=sha)
        if dup:
            if not in_place:
                src.unlink(missing_ok=True)
            return "duplicate", self.to_dict(dup)
        if not parent_id:
            parent_id = self.find_parent_by_name(original_name)
        if not parent_id:
            raise LookupError("needs_parent")
        with self.lock, self.connect() as c:
            parent = c.execute("SELECT * FROM papers WHERE id=?", (parent_id,)).fetchone()
            if parent is None:
                raise LookupError("묶을 본문 논문이 없습니다")
            parent = self._main_of(c, parent)
            rec = self._inherit({}, parent)
            ext = Path(original_name).suffix.lower() or src.suffix.lower()
            target = self._unique_target(self._base_of(parent) + VIDEO_SUFFIX + ext,
                                         current=src if in_place else None)
            shutil.move(str(src), str(target))
            now = time.time()
            cur = c.execute(
                """INSERT INTO papers (file_name, original_name, sha256, title, authors, authors_text,
                   journal, year, volume, issue, pages, publisher, doi, arxiv_id, url, abstract, type,
                   tags, notes, source, needs_review, fulltext, added_at, updated_at, kind, parent_id,
                   isbn, edition)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (target.name, original_name, sha, rec["title"], json.dumps(rec["authors"], ensure_ascii=False),
                 parent["authors_text"], rec["journal"], rec["year"], rec["volume"], rec["issue"], rec["pages"],
                 rec["publisher"], rec["doi"], rec["arxiv_id"], rec["url"], "", rec["type"], "", "",
                 rec["source"], 0, "", now, now, "supp", parent["id"], rec["isbn"], rec["edition"]))
            pid = cur.lastrowid
        return "added", self.get(pid)

    def import_note(self, src, original_name, parent_id, in_place=False):
        """내가 만든 정리 자료(PPT·Word 등)를 논문에 붙여 '논문 이름 - 정리 - 원래 이름.pptx' 로 저장한다."""
        src = Path(src)
        ext = (Path(original_name).suffix or src.suffix).lower()
        if ext in BLOCKED_EXTS:
            raise ValueError("실행 파일은 정리 자료로 넣을 수 없습니다")
        if not parent_id:
            raise LookupError("needs_parent")
        with self.lock, self.connect() as c:
            parent = c.execute("SELECT * FROM papers WHERE id=?", (parent_id,)).fetchone()
            if parent is None:
                raise LookupError("붙일 논문이 없습니다")
            parent = self._main_of(c, parent)
            # 같은 파일을 여러 논문에 붙일 수 있도록 해시에 논문 번호를 붙여 둔다(sha256 은 UNIQUE)
            sha = f"{sha256_file(src)}#note{parent['id']}"
            dup = c.execute("SELECT * FROM papers WHERE sha256=?", (sha,)).fetchone()
            if dup:
                if not in_place:
                    src.unlink(missing_ok=True)
                return "duplicate", self.to_dict(dup)
            rec = self._inherit({}, parent)
            want = self._note_name(self._base_of(parent), original_name, ext)
            if in_place and src.name.startswith(self._base_of(parent) + NOTE_MARK.rstrip()):
                target = src  # 폴더에 이미 규칙대로 놓인 파일
            else:
                target = self._unique_target(want, current=src if in_place else None)
                shutil.move(str(src), str(target))
            text = md.extract_any_text(target)
            now = time.time()
            cur = c.execute(
                """INSERT INTO papers (file_name, original_name, sha256, title, authors, authors_text,
                   journal, year, volume, issue, pages, publisher, doi, arxiv_id, url, abstract, type,
                   tags, notes, source, needs_review, fulltext, added_at, updated_at, kind, parent_id,
                   isbn, edition)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (target.name, original_name, sha, rec["title"], json.dumps(rec["authors"], ensure_ascii=False),
                 parent["authors_text"], rec["journal"], rec["year"], rec["volume"], rec["issue"], rec["pages"],
                 rec["publisher"], rec["doi"], rec["arxiv_id"], rec["url"], "", rec["type"], "", "",
                 rec["source"], 0, text, now, now, "note", parent["id"], rec["isbn"], rec["edition"]))
            pid = cur.lastrowid
        return "added", self.get(pid)

    @staticmethod
    def _note_name(base, original_name, ext):
        stem = safe_component(Path(original_name).stem, 60) or "자료"
        return base + NOTE_MARK + stem + ext

    # ------------------------------------------------------------ 보충자료 묶기

    def _main_of(self, c, row):
        """보충자료 위에 놓아도 그 본문 논문에 묶이도록."""
        if (row["kind"] or "main") in CHILD_KINDS:
            main = c.execute("SELECT * FROM papers WHERE id=?", (row["parent_id"],)).fetchone() if row["parent_id"] else None
            if main is None:
                raise ValueError("본문이 없는 보충자료에는 묶을 수 없습니다. 본문 논문을 골라 주세요.")
            return main
        return row

    @staticmethod
    def _inherit(rec, parent):
        """보충자료는 본문 논문의 서지 정보를 따른다(본문 검색용 글은 자기 것)."""
        rec = dict(rec)
        for k in ("title", "journal", "volume", "issue", "pages", "publisher", "doi",
                  "arxiv_id", "url", "type", "source", "isbn", "edition"):
            rec[k] = parent[k] or ""
        rec["year"] = parent["year"]
        rec["authors"] = json.loads(parent["authors"] or "[]")
        rec["abstract"] = ""
        rec["needs_review"] = False
        return rec

    def _find_parent(self, c, rec):
        """같은 DOI, 또는 본문 논문 제목이 보충자료 앞부분에 나오는 논문."""
        if rec.get("doi"):
            row = c.execute("SELECT * FROM papers WHERE lower(doi)=? AND kind='main'",
                            (rec["doi"].lower(),)).fetchone()
            if row:
                return row
        text_key = md.norm_key((rec.get("fulltext") or "")[:6000])
        best, best_score = None, None
        for row in c.execute("SELECT * FROM papers WHERE kind='main'"):
            t = md.norm_key(row["title"])
            # 긴 제목은 앞부분 어디든, 짧은 제목은 첫머리(머리말 바로 아래)에 있어야 인정
            if not (len(t) >= 15 and t in text_key or len(t) >= 6 and t in text_key[:120]):
                continue
            # 같은 제목이 여럿이면(예: 논문 'Deep learning'과 책 'Deep Learning') 저자 이름이 맞는 쪽
            authors = json.loads(row["authors"] or "[]")
            fam = md.norm_key(authors[0].get("family", "")) if authors else ""
            score = (bool(fam) and fam in text_key[:3000], len(t), row["type"] not in BOOK_TYPES)
            if best_score is None or score > best_score:
                best, best_score = row, score
        return best

    def _adopt_orphans(self, c, pid):
        """본문보다 먼저 들어온 보충자료가 있으면 새 본문 논문에 묶는다."""
        main = c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()
        key = md.norm_key(main["title"])
        for row in c.execute("SELECT * FROM papers WHERE kind='supp' AND parent_id IS NULL").fetchall():
            same_doi = main["doi"] and (row["doi"] or "").lower() == main["doi"].lower()
            text_key = md.norm_key((row["fulltext"] or "")[:6000])
            in_text = len(key) >= 15 and key in text_key or len(key) >= 6 and key in text_key[:120]
            if same_doi or in_text:
                self._attach_locked(c, row["id"], main)

    def _attach_locked(self, c, sid, main):
        rec = self._inherit({}, main)
        rec["authors"] = json.dumps(rec["authors"], ensure_ascii=False)
        rec["authors_text"] = main["authors_text"]
        row = c.execute("SELECT kind, sha256 FROM papers WHERE id=?", (sid,)).fetchone()
        rec["kind"] = "note" if row and row["kind"] == "note" else "supp"
        if rec["kind"] == "note":
            rec["sha256"] = (row["sha256"] or "").split("#")[0] + f"#note{main['id']}"
        rec["parent_id"] = main["id"]
        rec["updated_at"] = time.time()
        sets = ", ".join(f"{k}=?" for k in rec)
        c.execute(f"UPDATE papers SET {sets} WHERE id=?", (*rec.values(), sid))
        # 이 논문에 딸려 있던 보충자료도 함께 옮긴다
        c.execute("UPDATE papers SET parent_id=? WHERE parent_id=?", (main["id"], sid))
        self._rename_supps_locked(c, main["id"])

    def _move_locked(self, c, pid, src, dst):
        """파일 이름 바꾸기. 다른 프로그램이 파일을 열고 있으면(Windows) 실패를 기록하고 나중에 다시 한다."""
        try:
            os.replace(src, dst)
        except OSError as e:
            c.execute("UPDATE papers SET rename_pending=1 WHERE id=?", (pid,))
            self.last_rename_error = str(e)
            return False
        c.execute("UPDATE papers SET file_name=?, rename_pending=0 WHERE id=?", (Path(dst).name, pid))
        return True

    def retry_renames(self):
        """이름 바꾸기를 미뤄 둔 파일들을 다시 시도한다. 바꾼 개수를 돌려준다."""
        with self.connect() as c:
            ids = [r[0] for r in c.execute("SELECT id FROM papers WHERE rename_pending=1")]
        done = 0
        for pid in ids:
            with self.lock, self.connect() as c:
                c.execute("UPDATE papers SET rename_pending=0 WHERE id=?", (pid,))
                self._rename_locked(c, pid)
                done += not c.execute("SELECT rename_pending FROM papers WHERE id=?", (pid,)).fetchone()[0]
        return done

    def _rename_supps_locked(self, c, main_id):
        main = c.execute("SELECT * FROM papers WHERE id=?", (main_id,)).fetchone()
        base = self._base_of(main)
        for row in c.execute("SELECT * FROM papers WHERE parent_id=? ORDER BY added_at, id", (main_id,)).fetchall():
            p = self.to_dict(row)
            if p["missing"]:
                continue
            current = self.path_of(p)
            if p["kind"] == "note":
                if current.name.startswith(base + NOTE_MARK):
                    continue
                want = self._note_name(base, p.get("original_name") or current.name, current.suffix.lower())
                target = self._unique_target(want, current=current)
                if target.name != current.name:
                    self._move_locked(c, row["id"], current, target)
                continue
            label = supp_label(current.name)
            # 이미 'base - Supplementary[ Video][ 2].ext' 꼴이면 그대로 둔다
            if current.name.startswith(base + label) and re.fullmatch(r"( \d+)?\.\w+", current.name[len(base + label):]):
                continue
            target = self._unique_target(base + label + current.suffix.lower(), current=current)
            if target.name != current.name:
                self._move_locked(c, row["id"], current, target)

    def set_parent(self, pid, parent_id):
        """보충자료로 지정(parent_id) 하거나, None 이면 본문 논문으로 되돌린다."""
        with self.lock, self.connect() as c:
            row = c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()
            if not row:
                return None
            if parent_id:
                main = c.execute("SELECT * FROM papers WHERE id=?", (parent_id,)).fetchone()
                if not main:
                    raise LookupError("본문 논문이 없습니다")
                main = self._main_of(c, main)
                if main["id"] == pid:
                    raise ValueError("자기 자신에 묶을 수 없습니다")
                self._attach_locked(c, pid, main)
            else:
                if row["kind"] == "note":
                    raise ValueError("정리 자료는 본문이 될 수 없습니다. 다른 논문에 붙이거나 빼 주세요.")
                if is_video(row["file_name"]):
                    raise ValueError("동영상은 본문이 될 수 없습니다. 다른 논문에 묶거나 삭제해 주세요.")
                c.execute("UPDATE papers SET kind='main', parent_id=NULL, needs_review=1, updated_at=? WHERE id=?",
                          (time.time(), pid))
                self._rename_locked(c, pid)
        return self.get(pid)

    @staticmethod
    def authors_text(authors):
        out = []
        for a in authors:
            g, f = a.get("given", ""), a.get("family", "")
            out.append(f"{f}{g}" if md.is_hangul(f + g) else f"{g} {f}".strip())
            out.append(md.author_display(a, scholar=True))
        return "; ".join(out)

    # ------------------------------------------------------------ 수정·삭제

    def update(self, pid, data, rename=True):
        p = self.get(pid)
        if not p:
            return None
        fields = {k: data[k] for k in EDITABLE if k in data}
        if is_child(p):
            fields = {k: v for k, v in fields.items() if k in ("tags", "notes")}
        if "authors" in fields:
            if isinstance(fields["authors"], str):
                fields["authors"] = md.parse_author_string(fields["authors"])
            fields["authors_text"] = self.authors_text(fields["authors"])
            fields["authors"] = json.dumps(fields["authors"], ensure_ascii=False)
        if "year" in fields:
            y = str(fields["year"] or "").strip()
            fields["year"] = int(y) if y.isdigit() else None
        if "doi" in fields:
            fields["doi"] = md.clean_doi(fields["doi"] or "").lower()
        if "isbn" in fields:
            fields["isbn"] = md.format_isbn(fields["isbn"]) or str(fields["isbn"] or "").strip()
        if "mine" in fields:
            # True: 내 저작, False: 아님, None: 설정의 내 이름으로 자동 판단
            fields["mine"] = None if fields["mine"] is None else int(bool(fields["mine"]))
        if "source" in data:
            fields["source"] = data["source"]
        fields["needs_review"] = int(bool(data.get("needs_review", False)))
        fields["updated_at"] = time.time()

        with self.lock, self.connect() as c:
            sets = ", ".join(f"{k}=?" for k in fields)
            c.execute(f"UPDATE papers SET {sets} WHERE id=?", (*fields.values(), pid))
            if rename:
                self._rename_locked(c, pid)
            if p["kind"] == "main":
                self._sync_supps_locked(c, pid)
        return self.get(pid)

    def _rename_locked(self, c, pid):
        p = self.to_dict(c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone())
        if is_child(p):
            return self._rename_supps_locked(c, p["parent_id"])
        if not p["has_file"]:
            return self._rename_supps_locked(c, pid)  # PDF는 없어도 딸린 자료 이름은 맞춘다
        if p["missing"]:
            return
        current = self.path_of(p)
        want = nice_file_name(p)
        if p["kind"] == "supp":
            want = want[:-4] + SUPP_SUFFIX + ".pdf"
            if current.name.startswith(want[:-4]):
                return
        if current.name != want:
            target = self._unique_target(want, current=current)
            if target.name != current.name and not self._move_locked(c, pid, current, target):
                return  # 본문 이름을 못 바꿨으면 보충자료도 그대로 두었다가 함께 다시 한다
        if p["kind"] == "main":
            # 본문 이름이 바뀌면 보충자료도 새 이름을 따라간다
            self._rename_supps_locked(c, pid)

    def _sync_supps_locked(self, c, pid):
        """본문 논문의 서지 정보를 딸린 보충자료에도 반영."""
        main = c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()
        for row in c.execute("SELECT id FROM papers WHERE parent_id=?", (pid,)).fetchall():
            rec = self._inherit({}, main)
            rec["authors"] = json.dumps(rec["authors"], ensure_ascii=False)
            rec["authors_text"] = main["authors_text"]
            rec.pop("abstract")
            sets = ", ".join(f"{k}=?" for k in rec)
            c.execute(f"UPDATE papers SET {sets} WHERE id=?", (*rec.values(), row["id"]))

    def refetch(self, pid, doi=None, arxiv_id=None, isbn=None, kci_id=None):
        """DOI·arXiv ID·ISBN·KCI 논문 ID 로 정보를 다시 받아 덮어쓴다(태그·메모는 유지)."""
        if kci_id:
            rec = md.kci_by_id(kci_id.strip())
            if rec is None:
                raise LookupError("KCI에서 찾지 못했습니다")
        elif isbn:
            code = md.format_isbn(isbn)
            if not code:
                raise ValueError("올바른 ISBN이 아닙니다")
            rec = md.book_by_isbn(code)
            if rec is None:
                raise LookupError("이 ISBN의 책을 찾지 못했습니다")
        elif doi:
            rec = md.crossref_by_doi(md.clean_doi(doi))
        elif arxiv_id:
            rec = md.arxiv_by_id(arxiv_id.strip())
            if rec is None:
                raise LookupError("arXiv에서 찾지 못했습니다")
        else:
            raise ValueError("DOI, arXiv ID, ISBN 또는 KCI 논문 ID가 필요합니다")
        rec["needs_review"] = False
        p = self.update(pid, rec)
        self.refresh_citations([pid])
        return self.get(pid)

    def delete(self, pid):
        """서재에서 뺀다(PDF는 trash 로). 본문 논문이면 딸린 보충자료도 함께."""
        p = self.get(pid)
        if not p:
            return False
        with self.lock, self.connect() as c:
            rows = [p] + [self.to_dict(r) for r in c.execute("SELECT * FROM papers WHERE parent_id=?", (pid,))]
            moved = []
            try:
                for x in rows:
                    if x["has_file"] and not x["missing"]:
                        src = self.path_of(x)
                        dest = self.trash_dir / src.name
                        if dest.exists():
                            dest = self.trash_dir / f"{int(time.time())} {src.name}"
                        os.replace(src, dest)
                        moved.append((src, dest))
            except OSError:
                # 하나라도 못 옮기면(다른 프로그램이 열고 있음) 옮긴 것을 되돌리고 아무것도 지우지 않는다
                for src, dest in reversed(moved):
                    try:
                        os.replace(dest, src)
                    except OSError:
                        pass
                raise ValueError("PDF가 다른 프로그램에서 열려 있어 지울 수 없습니다. 그 창을 닫은 뒤 다시 해 주세요.")
            for x in rows:
                c.execute("DELETE FROM papers WHERE id=?", (x["id"],))
                c.execute("DELETE FROM collection_items WHERE paper_id=?", (x["id"],))
        return True

    # ------------------------------------------------------------ PDF 없이 추가 (DOI·ISBN·arXiv)

    def _find_placeholder(self, c, rec):
        """같은 DOI·arXiv ID·ISBN 으로 추가해 두었는데 아직 PDF가 없는 항목."""
        doi = (rec.get("doi") or "").lower()
        arxiv = (rec.get("arxiv_id") or "").lower()
        isbn = md.format_isbn(rec.get("isbn") or "")
        for row in c.execute("SELECT * FROM papers WHERE kind='main' AND file_name=''"):
            if doi and (row["doi"] or "").lower() == doi or arxiv and (row["arxiv_id"] or "").lower() == arxiv \
                    or isbn and md.format_isbn(row["isbn"] or "") == isbn:
                return row
        return None

    def _find_existing(self, c, rec):
        """같은 DOI·arXiv ID·ISBN 의 본문 항목(PDF가 있든 없든)."""
        doi = (rec.get("doi") or "").lower()
        if doi:
            row = c.execute("SELECT * FROM papers WHERE kind='main' AND lower(doi)=?", (doi,)).fetchone()
            if row:
                return row
        if rec.get("arxiv_id"):
            row = c.execute("SELECT * FROM papers WHERE kind='main' AND lower(arxiv_id)=?",
                            (rec["arxiv_id"].lower(),)).fetchone()
            if row:
                return row
        isbn = md.format_isbn(rec.get("isbn") or "")
        if isbn:
            for row in c.execute("SELECT * FROM papers WHERE kind='main' AND isbn<>''"):
                if md.format_isbn(row["isbn"]) == isbn:
                    return row
        # DOI가 없는 국내 논문 등: 제목과 연도가 같으면 같은 논문
        key = md.norm_key(rec.get("title"))
        if len(key) >= 10:
            for row in c.execute("SELECT * FROM papers WHERE kind='main' AND (year IS ? OR year IS NULL OR ? IS NULL)",
                                 (rec.get("year"), rec.get("year"))):
                if md.norm_key(row["title"]) == key:
                    return row
        return None

    def _attach_file_locked(self, c, row, src, original_name, sha, fulltext, page_count, in_place=False):
        p = self.to_dict(row)
        target = self._unique_target(nice_file_name(p), current=Path(src) if in_place else None)
        shutil.move(str(src), str(target))
        abstract = row["abstract"] or ("" if row["type"] in BOOK_TYPES else md.abstract_from_text((fulltext or "")[:4000]))
        c.execute("UPDATE papers SET file_name=?, original_name=?, sha256=?, fulltext=?, page_count=?, abstract=?, "
                  "updated_at=? WHERE id=?",
                  (target.name, original_name, sha, fulltext or "", page_count, abstract, time.time(), row["id"]))
        self._rename_supps_locked(c, row["id"])

    def attach_file(self, pid, src, original_name, in_place=False):
        """PDF가 없는 항목에 PDF를 붙인다. 반환: (상태, 항목 dict)."""
        src = Path(src)
        sha = sha256_file(src)
        with self.connect() as c:
            dup = c.execute("SELECT * FROM papers WHERE sha256=?", (sha,)).fetchone()
        if dup:
            if not in_place:
                src.unlink(missing_ok=True)
            return "duplicate", self.to_dict(dup)
        pdf = md.read_pdf(src)
        with self.lock, self.connect() as c:
            row = c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()
            if row is None:
                raise LookupError("없는 항목입니다")
            if row["file_name"]:
                raise ValueError("이미 PDF가 있는 항목입니다")
            self._attach_file_locked(c, row, src, original_name, sha, pdf["full"], pdf["page_count"], in_place)
        return "attached", self.get(pid)

    def add_by_id(self, key, online=True, fetch_pdf=True, log=None):
        """DOI·arXiv ID·ISBN·KCI 논문 ID 로 서지 정보만 먼저 추가한다(PDF는 무료본이 있으면 받아 온다).

        반환: (상태, 항목 dict, PDF 출처 또는 None). 상태는 'added' | 'duplicate'.
        """
        ident = md.parse_identifier(key)
        if ident is None:
            raise ValueError("DOI, arXiv ID, ISBN, KCI 논문 ID(ART…) 중 하나를 넣어 주세요")
        if not online:
            raise ValueError("오프라인 모드에서는 정보를 받아올 수 없습니다")
        kind, value = ident
        try:
            rec = {"doi": md.crossref_by_doi, "arxiv": md.arxiv_by_id, "isbn": md.book_by_isbn,
                   "kci": md.kci_by_id}[kind](value)
        except Exception as e:
            raise LookupError(f"정보를 받아오지 못했습니다 ({e})")
        if not rec or not rec.get("title"):
            raise LookupError({"doi": "Crossref", "arxiv": "arXiv", "isbn": "책 정보 서비스",
                               "kci": "KCI"}[kind] + "에서 찾지 못했습니다")
        if kind == "isbn" and not rec.get("isbn"):
            rec["isbn"] = md.format_isbn(value)
        with self.connect() as c:
            dup = self._find_existing(c, rec)
        if dup:
            return "duplicate", self.to_dict(dup), None
        cited = md.citation_count(rec, log)
        with self.lock, self.connect() as c:
            dup = self._find_existing(c, rec)
            if dup:
                return "duplicate", self.to_dict(dup), None
            now = time.time()
            cur = c.execute(
                """INSERT INTO papers (file_name, original_name, sha256, title, authors, authors_text,
                   journal, year, volume, issue, pages, publisher, doi, arxiv_id, url, abstract, type,
                   tags, notes, source, needs_review, fulltext, added_at, updated_at, kind, parent_id,
                   isbn, edition, page_count, cited_by, cited_by_source, cited_by_url, cited_by_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                ("", "", None, rec["title"], json.dumps(rec.get("authors") or [], ensure_ascii=False),
                 self.authors_text(rec.get("authors") or []), rec.get("journal", ""), rec.get("year"),
                 rec.get("volume", ""), rec.get("issue", ""), rec.get("pages", ""), rec.get("publisher", ""),
                 (rec.get("doi") or "").lower(), rec.get("arxiv_id", ""), rec.get("url", ""), rec.get("abstract", ""),
                 rec.get("type", ""), "", "", rec.get("source", kind), 0, "", now, now, "main", None,
                 rec.get("isbn", ""), rec.get("edition", ""), None,
                 cited["count"] if cited else None, cited["source"] if cited else "",
                 cited["url"] if cited else "", now if cited else None))
            pid = cur.lastrowid
        source = self.fetch_open_pdf(pid, log) if fetch_pdf else None
        return "added", self.get(pid), source

    def fetch_open_pdf(self, pid, log=None):
        """arXiv·OpenAlex 가 알려 주는 무료(오픈 액세스) PDF를 받아 붙인다. 출처 이름 또는 None."""
        log = log or (lambda *a: None)
        p = self.get(pid)
        if not p or p["has_file"]:
            return None
        try:
            urls = md.open_pdf_urls(p)
        except Exception as e:
            log(f"무료 PDF 찾기 실패: {e}")
            return None
        for url, source in urls:
            tmp = self.tmp_dir / f"{os.urandom(8).hex()}.pdf"
            try:
                if not md.download_pdf(url, tmp):
                    continue
                status, _ = self.attach_file(pid, tmp, Path(urllib.parse.urlparse(url).path).name or "download.pdf")
                if status == "attached":
                    return source
            except Exception as e:
                log(f"PDF 받기 실패 {url}: {e}")
            finally:
                tmp.unlink(missing_ok=True)
        return None

    # ------------------------------------------------------------ 읽음 상태·별점·컬렉션

    def mark(self, pid, read_status=None, rating=None):
        fields = {}
        if read_status is not None:
            if read_status not in READ_STATUSES:
                raise ValueError("읽음 상태가 올바르지 않습니다")
            fields["read_status"] = read_status
        if rating is not None:
            fields["rating"] = max(0, min(5, int(rating)))
        if fields:
            with self.lock, self.connect() as c:
                c.execute(f"UPDATE papers SET {', '.join(k + '=?' for k in fields)} WHERE id=?", (*fields.values(), pid))
        return self.get(pid)

    def collections(self):
        with self.connect() as c:
            return [dict(r) for r in c.execute(
                "SELECT k.id, k.name, count(p.id) AS n FROM collections k "
                "LEFT JOIN collection_items i ON i.collection_id=k.id "
                "LEFT JOIN papers p ON p.id=i.paper_id AND p.kind='main' "
                "GROUP BY k.id ORDER BY k.name COLLATE NOCASE")]

    @staticmethod
    def _collection_name(name):
        name = re.sub(r"\s+", " ", str(name or "")).strip()
        if not name:
            raise ValueError("컬렉션 이름을 적어 주세요")
        return name[:80]

    def create_collection(self, name):
        name = self._collection_name(name)
        with self.lock, self.connect() as c:
            try:
                cur = c.execute("INSERT INTO collections (name, created_at) VALUES (?, ?)", (name, time.time()))
            except sqlite3.IntegrityError:
                raise ValueError("같은 이름의 컬렉션이 있습니다")
            return {"id": cur.lastrowid, "name": name, "n": 0}

    def rename_collection(self, cid, name):
        name = self._collection_name(name)
        with self.lock, self.connect() as c:
            try:
                c.execute("UPDATE collections SET name=? WHERE id=?", (name, cid))
            except sqlite3.IntegrityError:
                raise ValueError("같은 이름의 컬렉션이 있습니다")

    def delete_collection(self, cid):
        """컬렉션만 지운다(논문과 파일은 그대로)."""
        with self.lock, self.connect() as c:
            c.execute("DELETE FROM collection_items WHERE collection_id=?", (cid,))
            c.execute("DELETE FROM collections WHERE id=?", (cid,))

    def set_in_collection(self, pid, cid, on=True):
        with self.lock, self.connect() as c:
            row = c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()
            if row is None:
                raise LookupError("없는 논문입니다")
            if is_child(row):
                row = self._main_of(c, row)  # 보충자료·정리 자료는 본문 논문을 넣는다
            if c.execute("SELECT 1 FROM collections WHERE id=?", (cid,)).fetchone() is None:
                raise LookupError("없는 컬렉션입니다")
            if on:
                c.execute("INSERT OR IGNORE INTO collection_items (collection_id, paper_id, added_at) VALUES (?,?,?)",
                          (cid, row["id"], time.time()))
            else:
                c.execute("DELETE FROM collection_items WHERE collection_id=? AND paper_id=?", (cid, row["id"]))
        return self.paper_collections([row["id"]]).get(row["id"], [])

    def paper_collections(self, ids):
        out = {}
        ids = list(ids)
        with self.connect() as c:
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                for r in c.execute(f"SELECT paper_id, collection_id FROM collection_items WHERE paper_id IN "
                                   f"({','.join('?' * len(chunk))})", chunk):
                    out.setdefault(r["paper_id"], []).append(r["collection_id"])
        return out

    def collection_ids(self, cid):
        with self.connect() as c:
            return {r[0] for r in c.execute("SELECT paper_id FROM collection_items WHERE collection_id=?", (cid,))}

    # ------------------------------------------------------------ 인용 수

    def stale_citation_ids(self, max_age_days=30):
        cutoff = time.time() - max_age_days * 86400
        with self.connect() as c:
            return [r[0] for r in c.execute(
                "SELECT id FROM papers WHERE kind='main' AND (cited_by_at IS NULL OR cited_by_at < ?) "
                "ORDER BY cited_by_at IS NOT NULL, cited_by_at", (cutoff,))]

    def refresh_citations(self, ids=None, log=None, progress=None, stop=None):
        """인용 수를 다시 받아 온다. 돌려주는 값은 숫자를 얻은 항목 수."""
        with self.connect() as c:
            if ids is None:
                ids = [r[0] for r in c.execute("SELECT id FROM papers WHERE kind='main'")]
        found = 0
        for i, pid in enumerate(ids):
            if stop and stop():
                break
            p = self.get(pid)
            if p and p["kind"] == "main":
                res = md.citation_count(p, log)
                with self.lock, self.connect() as c:
                    if res:
                        found += 1
                        c.execute("UPDATE papers SET cited_by=?, cited_by_source=?, cited_by_url=?, cited_by_at=? "
                                  "WHERE id=?", (res["count"], res["source"], res["url"], time.time(), pid))
                    else:
                        c.execute("UPDATE papers SET cited_by_at=? WHERE id=?", (time.time(), pid))
            if progress:
                progress(i + 1, len(ids))
        return found

    # ------------------------------------------------------------ 폴더 다시 읽기

    def rescan(self, online=True, log=None):
        """폴더에 직접 넣은 PDF를 등록하고, 사라진 파일을 정리한다."""
        added, moved, dups, removed, failed = [], 0, 0, 0, []
        with self.connect() as c:
            known = {r["file_name"]: r["id"] for r in c.execute("SELECT id, file_name FROM papers")}
        mains = None
        for path in sorted(self.root.iterdir()):
            if (path.is_file() and not path.name.startswith(".") and path.name not in known
                    and " - 정리" in path.name and path.suffix.lower() not in BLOCKED_EXTS):
                # '본문 이름 - 정리 …' 파일은 그 논문의 내 정리 자료
                if mains is None:
                    with self.connect() as c:
                        mains = [(Path(r["file_name"]).stem, r["id"]) for r in
                                 c.execute("SELECT id, file_name FROM papers WHERE kind='main'")]
                hit = max((m for m in mains if path.name.startswith(m[0] + " - 정리")), key=lambda m: len(m[0]),
                          default=None)
                if hit:
                    try:
                        status, p = self.import_note(path, path.name.split(NOTE_MARK, 1)[-1], hit[1], in_place=True)
                        (added.append(p) if status == "added" else None)
                        dups += status != "added"
                    except Exception as e:
                        failed.append({"file": path.name, "error": str(e)})
                    continue
            if path.is_file() and is_video(path.name) and not path.name.startswith(".") and path.name not in known:
                # '본문 이름 …' 으로 시작하는 동영상만 그 논문에 묶는다
                if mains is None:
                    with self.connect() as c:
                        mains = [(Path(r["file_name"]).stem, r["id"]) for r in
                                 c.execute("SELECT id, file_name FROM papers WHERE kind='main'")]
                hit = max((m for m in mains if path.name.startswith(m[0])), key=lambda m: len(m[0]), default=None)
                if hit:
                    try:
                        status, p = self.import_video(path, path.name, parent_id=hit[1], in_place=True)
                        if status == "added":
                            added.append(p)
                        else:
                            dups += 1
                    except Exception as e:
                        failed.append({"file": path.name, "error": str(e)})
                continue
            if not path.is_file() or path.suffix.lower() != ".pdf" or path.name.startswith("."):
                continue
            if path.name in known:
                continue
            sha = sha256_file(path)
            with self.connect() as c:
                row = c.execute("SELECT id, file_name FROM papers WHERE sha256=?", (sha,)).fetchone()
                if row and not (self.root / row["file_name"]).exists():
                    # 사용자가 이름을 바꾼 파일: 경로만 고친다
                    c.execute("UPDATE papers SET file_name=? WHERE id=?", (path.name, row["id"]))
                    moved += 1
                    continue
            try:
                status, p = self.import_pdf(path, path.name, online=online, in_place=True, log=log)
            except Exception as e:
                failed.append({"file": path.name, "error": str(e)})
                continue
            if status == "added":
                added.append(p)
            else:
                dups += 1
        reclassified = self.reclassify()
        with self.lock, self.connect() as c:
            for r in c.execute("SELECT id, file_name FROM papers WHERE file_name <> ''").fetchall():
                if not (self.root / r["file_name"]).exists():
                    c.execute("DELETE FROM papers WHERE id=?", (r["id"],))
                    removed += 1
        return {"added": added, "relinked": moved, "duplicates": dups, "removed": removed, "failed": failed,
                "supplements": reclassified}

    def reclassify(self):
        """이전에 본문으로 들어간 보충자료를 찾아 본문 논문에 묶는다. 묶은 개수를 돌려준다."""
        n = 0
        with self.lock, self.connect() as c:
            rows = c.execute("SELECT * FROM papers WHERE kind='main' AND id NOT IN "
                             "(SELECT parent_id FROM papers WHERE parent_id IS NOT NULL)").fetchall()
            for row in rows:
                if not md.is_supplement((row["fulltext"] or "")[:200], row["original_name"] or ""):
                    continue
                c.execute("UPDATE papers SET kind='supp' WHERE id=?", (row["id"],))
                rec = dict(row)
                rec["fulltext"] = row["fulltext"]
                parent = self._find_parent_excluding(c, rec, row["id"])
                if parent is not None:
                    self._attach_locked(c, row["id"], parent)
                else:
                    self._rename_locked(c, row["id"])
                n += 1
        return n

    def _find_parent_excluding(self, c, rec, exclude_id):
        if rec.get("doi"):
            row = c.execute("SELECT * FROM papers WHERE lower(doi)=? AND kind='main' AND id<>?",
                            (rec["doi"].lower(), exclude_id)).fetchone()
            if row:
                return row
        row = self._find_parent(c, {"fulltext": rec.get("fulltext")})
        return row if row is not None and row["id"] != exclude_id else None

    # ------------------------------------------------------------ 검색

    def _columns(self):
        if not hasattr(self, "_cols"):
            with self.connect() as c:
                self._cols = [r["name"] for r in c.execute("PRAGMA table_info(papers)")]
        return self._cols

    def search(self, q="", field="all", year_from=None, year_to=None, sort="relevance",
               review_only=False, doc="all", mine_only=False, offset=0, limit=None,
               read=None, collection=None, rating_min=0):
        """검색. 본문(fulltext)은 데이터베이스 안에서만 찾고, 걸린 대목만 꺼낸다.

        offset/limit 을 주면 그 쪽만 돌려준다(total 은 전체 개수).
        """
        terms = parse_terms(q)
        cols = SEARCH_FIELDS.get(field, SEARCH_FIELDS["all"])
        where, args = [], []
        for t in terms:
            like = "%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            where.append("(" + " OR ".join(f"{col} LIKE ? ESCAPE '\\'" for col, _ in cols) + ")")
            args += [like] * len(cols)
        if year_from:
            where.append("year >= ?")
            args.append(int(year_from))
        if year_to:
            where.append("year <= ?")
            args.append(int(year_to))
        if review_only:
            where.append("needs_review = 1")
        if doc in DOC_GROUPS or doc in ("paper", "other"):
            # paper: 책이 아닌 모든 것, other: 어느 묶음에도 들지 않는 것(프리프린트·학위논문 등)
            types = DOC_GROUPS["book"] if doc == "paper" else KNOWN_TYPES if doc == "other" else DOC_GROUPS[doc]
            marks = ",".join("?" * len(types))
            where.append(f"coalesce(type,'') {'IN' if doc in DOC_GROUPS else 'NOT IN'} ({marks})")
            args += list(types)

        # 본문 전체는 가져오지 않는다: 낱말마다 '걸렸는지'와 첫 번째 낱말 둘레 글만 계산해서 받는다
        select = [c for c in self._columns() if c != "fulltext"]
        sel_args = []
        use_ft = bool(terms) and any(col == "fulltext" for col, _ in cols)
        if use_ft:
            for i, t in enumerate(terms):
                select.append(f"instr(lower(fulltext), ?) AS ft{i}")
                sel_args.append(t.lower())
            select.append("CASE WHEN instr(lower(fulltext), ?) > 0 THEN "
                          "substr(fulltext, max(1, instr(lower(fulltext), ?) - 70), 230) END AS ft_snip")
            sel_args += [terms[0].lower()] * 2
        sql = f"SELECT {', '.join(select)} FROM papers" + (" WHERE " + " AND ".join(where) if where else "")

        with self.connect() as c:
            rows = c.execute(sql, sel_args + args).fetchall()

        results = []
        for row in rows:
            p = self.to_dict(row, check_file=False)
            score = 0.0
            matched = set()
            for i, t in enumerate(terms):
                tl = t.lower()
                for col, w in cols:
                    hit = (p.get(f"ft{i}") or 0) > 0 if col == "fulltext" else tl in (p.get(col) or "").lower()
                    if hit:
                        score += w
                        matched.add(col)
                if tl in (p.get("title") or "").lower().split():
                    score += 3  # 낱말이 통째로 맞으면 가산
            snippet = ""
            if terms:
                if "abstract" in matched:
                    snippet = make_snippet(p.get("abstract"), terms)
                if not snippet and "fulltext" in matched and p.get("ft_snip"):
                    snippet = "…" + " ".join(p["ft_snip"].split()) + "…"
                    p["in_fulltext"] = True
            if not snippet:
                snippet = (p.get("abstract") or "")[:240] + ("…" if len(p.get("abstract") or "") > 240 else "")
            for k in [k for k in p if k.startswith("ft")]:
                p.pop(k)
            p["snippet"] = snippet
            p["score"] = score
            results.append(p)

        results = self._group_supplements(results)
        if mine_only:
            results = [p for p in results if p.get("is_mine")]
        if read in ("unread", "reading", "read"):
            want = "" if read == "unread" else read
            results = [p for p in results if (p.get("read_status") or "") == want and p["kind"] == "main"]
        if collection:
            members = self.collection_ids(int(collection))
            results = [p for p in results if p["id"] in members]
        if rating_min:
            results = [p for p in results if (p.get("rating") or 0) >= int(rating_min)]

        if sort == "rating":
            results.sort(key=lambda p: (p.get("rating") or 0, p.get("year") or 0), reverse=True)
        elif sort == "cited":
            results.sort(key=lambda p: (p.get("cited_by") is not None, p.get("cited_by") or 0, p.get("year") or 0),
                         reverse=True)
        elif sort == "year":
            results.sort(key=lambda p: (p.get("year") or 0, p.get("added_at") or 0), reverse=True)
        elif sort == "title":
            results.sort(key=lambda p: md.norm_key(p.get("title")))
        elif sort == "added" or not terms:
            results.sort(key=lambda p: p.get("added_at") or 0, reverse=True)
        else:
            results.sort(key=lambda p: (p["score"], p.get("year") or 0), reverse=True)
        total = len(results)
        if limit:
            # 없는 쪽을 달라고 하면(지운 뒤 등) 마지막 쪽을 준다
            offset = max(0, min(int(offset), (total - 1) // limit * limit if total else 0))
            results = results[offset:offset + limit]
        colls = self.paper_collections(p["id"] for p in results)
        for p in results:
            p["missing"] = bool(p["file_name"]) and not (self.root / p["file_name"]).exists()
            p["has_file"] = bool(p["file_name"])
            p["collections"] = colls.get(p["id"], [])
        return {"total": total, "offset": offset, "terms": terms, "papers": results}

    def _group_supplements(self, results):
        """본문에 묶인 보충자료는 본문 논문 결과 아래로 모은다."""
        by_id = {p["id"]: p for p in results}
        out = [p for p in results if not is_child(p)]
        tops = {p["id"]: p for p in out}
        with self.connect() as c:
            for p in results:
                if not is_child(p):
                    continue
                parent = tops.get(p["parent_id"])
                if parent is None:
                    row = c.execute("SELECT * FROM papers WHERE id=?", (p["parent_id"],)).fetchone()
                    if row is None:
                        out.append(p)  # 본문이 사라진 보충자료
                        tops[p["id"]] = p
                        continue
                    parent = self.to_dict(row)
                    parent.update(score=0.0, snippet="")
                    out.append(parent)
                    tops[parent["id"]] = parent
                    if p.get("in_fulltext"):
                        parent["snippet"] = p["snippet"]
                        parent["in_note" if p["kind"] == "note" else "in_supplement"] = True
                    else:
                        parent["snippet"] = (parent.get("abstract") or "")[:240]
                parent["score"] = max(parent.get("score", 0), p.get("score", 0))
            ids = list(tops)
            supps = {}
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                q = f"SELECT id, kind, file_name, original_name, parent_id FROM papers WHERE parent_id IN ({','.join('?' * len(chunk))}) ORDER BY added_at, id"
                for r in c.execute(q, chunk):
                    supps.setdefault((r["parent_id"], r["kind"] == "note"), []).append(
                        {"id": r["id"], "file_name": r["file_name"], "original_name": r["original_name"],
                         "video": is_video(r["file_name"]),
                         "missing": not (self.root / r["file_name"]).exists(), "matched": r["id"] in by_id})
        for p in out:
            p["supplements"] = supps.get((p["id"], False), [])
            p["attachments"] = supps.get((p["id"], True), [])
        return out

    def stats(self):
        with self.connect() as c:
            total = c.execute("SELECT count(*) FROM papers WHERE NOT (kind IN ('supp','note') AND parent_id IS NOT NULL)").fetchone()[0]
            review = c.execute("SELECT count(*) FROM papers WHERE needs_review=1").fetchone()[0]
            years = [r[0] for r in c.execute("SELECT DISTINCT year FROM papers WHERE year IS NOT NULL ORDER BY year")]
            supps = c.execute("SELECT count(*) FROM papers WHERE kind='supp'").fetchone()[0]
            notes = c.execute("SELECT count(*) FROM papers WHERE kind='note'").fetchone()[0]
            mains = c.execute("SELECT type, authors, mine, read_status, file_name FROM papers WHERE kind='main'").fetchall()
        groups = {name: 0 for name in (*DOC_GROUPS, "other")}
        mine_groups = dict(groups)  # '내 논문·책'을 볼 때 쓰는 종류별 개수
        mine = 0
        reading = {"unread": 0, "reading": 0, "read": 0}
        no_file = 0
        for r in mains:
            reading[{"reading": "reading", "read": "read"}.get(r["read_status"] or "", "unread")] += 1
            no_file += not r["file_name"]
            g = doc_group(r["type"])
            groups[g] += 1
            if self.is_mine({"authors": r["authors"], "mine": r["mine"]}):
                mine += 1
                mine_groups[g] += 1
        return {"total": total, "needs_review": review, "years": years, "supplements": supps, "attachments": notes,
                "books": groups["book"], "groups": groups, "mine": mine, "mine_groups": mine_groups,
                "reading": reading, "no_file": no_file, "collections": self.collections()}

    def all_papers(self, collection=None):
        with self.connect() as c:
            rows = c.execute("SELECT * FROM papers WHERE kind='main' ORDER BY year, title").fetchall()
        if collection:
            members = self.collection_ids(int(collection))
            rows = [r for r in rows if r["id"] in members]
        return [self.to_dict(r) for r in rows]
