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
from pathlib import Path

import metadata as md

META_DIR = ".papershelf"
EDITABLE = ("title", "authors", "journal", "year", "volume", "issue", "pages", "publisher",
            "doi", "arxiv_id", "url", "abstract", "tags", "notes", "type")

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
    added_at REAL, updated_at REAL
);
CREATE INDEX IF NOT EXISTS papers_doi ON papers(doi);
CREATE INDEX IF NOT EXISTS papers_year ON papers(year);
"""

# 검색 범위별 대상 칸과 관련도 가중치
SEARCH_FIELDS = {
    "all": [("title", 10), ("authors_text", 8), ("journal", 4), ("tags", 5), ("doi", 6),
            ("abstract", 2), ("notes", 3), ("publisher", 1), ("fulltext", 1)],
    "meta": [("title", 10), ("authors_text", 8), ("journal", 4), ("tags", 5), ("doi", 6),
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
        with self.connect() as c:
            c.executescript(SCHEMA)

    def connect(self):
        c = sqlite3.connect(self.db_path, timeout=30)
        c.row_factory = sqlite3.Row
        return c

    # ------------------------------------------------------------ 변환

    def to_dict(self, row, with_text=False):
        p = dict(row)
        p["authors"] = json.loads(p.get("authors") or "[]")
        if not with_text:
            p.pop("fulltext", None)
        p["needs_review"] = bool(p.get("needs_review"))
        p["scholar_authors"] = md.scholar_authors(p["authors"])
        p["missing"] = not (self.root / p["file_name"]).exists()
        return p

    def get(self, pid, with_text=False):
        with self.connect() as c:
            row = c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()
        return self.to_dict(row, with_text) if row else None

    def path_of(self, p):
        path = (self.root / p["file_name"]).resolve()
        if self.root not in path.parents:
            raise ValueError("library 밖의 경로")
        return path

    # ------------------------------------------------------------ 이름 정하기

    def _unique_target(self, name, current=None):
        stem = name[:-4]
        target = self.root / name
        n = 2
        while target.exists():
            if current is not None and os.path.samefile(target, current):
                break  # 이미 그 이름(대소문자만 다른 경우 포함)
            target = self.root / f"{stem} ({n}).pdf"
            n += 1
        return target

    # ------------------------------------------------------------ 가져오기

    def find_duplicate(self, c, sha=None, doi=None):
        if sha:
            row = c.execute("SELECT * FROM papers WHERE sha256=?", (sha,)).fetchone()
            if row:
                return row
        if doi:
            row = c.execute("SELECT * FROM papers WHERE lower(doi)=?", (doi.lower(),)).fetchone()
            if row:
                return row
        return None

    def import_pdf(self, src, original_name, online=True, in_place=False, log=None):
        """src 의 PDF를 서재에 넣는다. in_place=True 면 이미 폴더 안에 있던 파일.

        반환: (상태, 논문 dict). 상태는 'added' | 'duplicate'.
        """
        src = Path(src)
        sha = sha256_file(src)
        with self.connect() as c:
            dup = self.find_duplicate(c, sha=sha)
        if dup:
            if not in_place:
                src.unlink(missing_ok=True)
            return "duplicate", self.to_dict(dup)

        rec = md.extract(src, original_name, online=online, log=log)

        with self.lock, self.connect() as c:
            dup = self.find_duplicate(c, sha=sha, doi=rec.get("doi"))
            if dup:
                if not in_place:
                    src.unlink(missing_ok=True)
                return "duplicate", self.to_dict(dup)
            target = self._unique_target(nice_file_name(rec), current=src if in_place else None)
            shutil.move(str(src), str(target))
            now = time.time()
            cur = c.execute(
                """INSERT INTO papers (file_name, original_name, sha256, title, authors, authors_text,
                   journal, year, volume, issue, pages, publisher, doi, arxiv_id, url, abstract, type,
                   tags, notes, source, needs_review, fulltext, added_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (target.name, original_name, sha, rec["title"], json.dumps(rec["authors"], ensure_ascii=False),
                 self.authors_text(rec["authors"]), rec["journal"], rec["year"], rec["volume"], rec["issue"],
                 rec["pages"], rec["publisher"], rec["doi"], rec.get("arxiv_id", ""), rec["url"],
                 rec["abstract"], rec["type"], rec.get("keywords", ""), "", rec["source"],
                 int(rec["needs_review"]), rec["fulltext"], now, now))
            pid = cur.lastrowid
        return "added", self.get(pid)

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
        if "source" in data:
            fields["source"] = data["source"]
        fields["needs_review"] = int(bool(data.get("needs_review", False)))
        fields["updated_at"] = time.time()

        with self.lock, self.connect() as c:
            sets = ", ".join(f"{k}=?" for k in fields)
            c.execute(f"UPDATE papers SET {sets} WHERE id=?", (*fields.values(), pid))
            if rename:
                self._rename_locked(c, pid)
        return self.get(pid)

    def _rename_locked(self, c, pid):
        p = self.to_dict(c.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone())
        if p["missing"]:
            return
        current = self.path_of(p)
        want = nice_file_name(p)
        if current.name == want:
            return
        target = self._unique_target(want, current=current)
        if target.name != current.name:
            os.replace(current, target)
            c.execute("UPDATE papers SET file_name=? WHERE id=?", (target.name, pid))

    def refetch(self, pid, doi=None, arxiv_id=None):
        """DOI·arXiv ID 로 정보를 다시 받아 덮어쓴다(태그·메모는 유지)."""
        if doi:
            rec = md.crossref_by_doi(md.clean_doi(doi))
        elif arxiv_id:
            rec = md.arxiv_by_id(arxiv_id.strip())
            if rec is None:
                raise LookupError("arXiv에서 찾지 못했습니다")
        else:
            raise ValueError("DOI 또는 arXiv ID가 필요합니다")
        rec["needs_review"] = False
        return self.update(pid, rec)

    def delete(self, pid):
        p = self.get(pid)
        if not p:
            return False
        with self.lock, self.connect() as c:
            if not p["missing"]:
                src = self.path_of(p)
                dest = self.trash_dir / src.name
                if dest.exists():
                    dest = self.trash_dir / f"{int(time.time())} {src.name}"
                shutil.move(str(src), str(dest))
            c.execute("DELETE FROM papers WHERE id=?", (pid,))
        return True

    # ------------------------------------------------------------ 폴더 다시 읽기

    def rescan(self, online=True, log=None):
        """폴더에 직접 넣은 PDF를 등록하고, 사라진 파일을 정리한다."""
        added, moved, dups, removed, failed = [], 0, 0, 0, []
        with self.connect() as c:
            known = {r["file_name"]: r["id"] for r in c.execute("SELECT id, file_name FROM papers")}
        for path in sorted(self.root.iterdir()):
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
        with self.lock, self.connect() as c:
            for r in c.execute("SELECT id, file_name FROM papers").fetchall():
                if not (self.root / r["file_name"]).exists():
                    c.execute("DELETE FROM papers WHERE id=?", (r["id"],))
                    removed += 1
        return {"added": added, "relinked": moved, "duplicates": dups, "removed": removed, "failed": failed}

    # ------------------------------------------------------------ 검색

    def search(self, q="", field="all", year_from=None, year_to=None, sort="relevance",
               review_only=False, limit=1000):
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
        sql = "SELECT * FROM papers" + (" WHERE " + " AND ".join(where) if where else "")

        with self.connect() as c:
            rows = c.execute(sql, args).fetchall()

        results = []
        for row in rows:
            p = self.to_dict(row, with_text=True)
            score = 0.0
            matched = set()
            for t in terms:
                tl = t.lower()
                for col, w in cols:
                    val = (p.get(col) or "").lower()
                    if tl in val:
                        score += w * (1 + min(val.count(tl), 20) / 20 if col == "fulltext" else 1)
                        matched.add(col)
                if tl in (p.get("title") or "").lower().split():
                    score += 3  # 낱말이 통째로 맞으면 가산
            snippet = ""
            if terms:
                if "abstract" in matched:
                    snippet = make_snippet(p.get("abstract"), terms)
                if not snippet and "fulltext" in matched:
                    snippet = make_snippet(p.get("fulltext"), terms)
                    p["in_fulltext"] = True
            if not snippet:
                snippet = (p.get("abstract") or "")[:240] + ("…" if len(p.get("abstract") or "") > 240 else "")
            p["snippet"] = snippet
            p["score"] = score
            p.pop("fulltext", None)
            results.append(p)

        if sort == "year":
            results.sort(key=lambda p: (p.get("year") or 0, p.get("added_at") or 0), reverse=True)
        elif sort == "title":
            results.sort(key=lambda p: md.norm_key(p.get("title")))
        elif sort == "added" or not terms:
            results.sort(key=lambda p: p.get("added_at") or 0, reverse=True)
        else:
            results.sort(key=lambda p: (p["score"], p.get("year") or 0), reverse=True)
        return {"total": len(results), "terms": terms, "papers": results[:limit]}

    def stats(self):
        with self.connect() as c:
            total = c.execute("SELECT count(*) FROM papers").fetchone()[0]
            review = c.execute("SELECT count(*) FROM papers WHERE needs_review=1").fetchone()[0]
            years = [r[0] for r in c.execute("SELECT DISTINCT year FROM papers WHERE year IS NOT NULL ORDER BY year")]
        return {"total": total, "needs_review": review, "years": years}

    def all_papers(self):
        with self.connect() as c:
            rows = c.execute("SELECT * FROM papers ORDER BY year, title").fetchall()
        return [self.to_dict(r) for r in rows]
