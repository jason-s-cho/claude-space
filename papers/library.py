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
    added_at REAL, updated_at REAL,
    kind TEXT DEFAULT 'main',
    parent_id INTEGER
);
CREATE INDEX IF NOT EXISTS papers_doi ON papers(doi);
CREATE INDEX IF NOT EXISTS papers_year ON papers(year);
"""
MIGRATIONS = [
    ("kind", "ALTER TABLE papers ADD COLUMN kind TEXT DEFAULT 'main'"),
    ("parent_id", "ALTER TABLE papers ADD COLUMN parent_id INTEGER"),
]
SUPP_SUFFIX = " - Supplementary"

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

    def to_dict(self, row, with_text=False):
        p = dict(row)
        p["authors"] = json.loads(p.get("authors") or "[]")
        if not with_text:
            p.pop("fulltext", None)
        p["needs_review"] = bool(p.get("needs_review"))
        p["kind"] = p.get("kind") or "main"
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
            # 보충자료는 'X - Supplementary 2.pdf', 그 밖에는 'X (2).pdf'
            target = self.root / (f"{stem} {n}.pdf" if stem.endswith(SUPP_SUFFIX) else f"{stem} ({n}).pdf")
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
                dup = self.find_duplicate(c, sha=sha, doi=rec.get("doi"))
                if dup:
                    if not in_place:
                        src.unlink(missing_ok=True)
                    return "duplicate", self.to_dict(dup)
            if is_supp or parent is not None:
                base = parent["file_name"][:-4] if parent is not None else nice_file_name(rec)[:-4]
                name = base + SUPP_SUFFIX + ".pdf"
            else:
                name = nice_file_name(rec)
            target = self._unique_target(name, current=src if in_place else None)
            shutil.move(str(src), str(target))
            now = time.time()
            cur = c.execute(
                """INSERT INTO papers (file_name, original_name, sha256, title, authors, authors_text,
                   journal, year, volume, issue, pages, publisher, doi, arxiv_id, url, abstract, type,
                   tags, notes, source, needs_review, fulltext, added_at, updated_at, kind, parent_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (target.name, original_name, sha, rec["title"], json.dumps(rec["authors"], ensure_ascii=False),
                 self.authors_text(rec["authors"]), rec["journal"], rec["year"], rec["volume"], rec["issue"],
                 rec["pages"], rec["publisher"], rec["doi"], rec.get("arxiv_id", ""), rec["url"],
                 rec["abstract"], rec["type"], rec.get("keywords", ""), "", rec["source"],
                 int(rec["needs_review"]), rec["fulltext"], now, now,
                 "supp" if (is_supp or parent is not None) else "main",
                 parent["id"] if parent is not None else None))
            pid = cur.lastrowid
            if not is_supp and parent is None:
                self._adopt_orphans(c, pid)
        return "added", self.get(pid)

    # ------------------------------------------------------------ 보충자료 묶기

    def _main_of(self, c, row):
        """보충자료 위에 놓아도 그 본문 논문에 묶이도록."""
        if (row["kind"] or "main") == "supp":
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
                  "arxiv_id", "url", "type", "source"):
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
        best = None
        for row in c.execute("SELECT * FROM papers WHERE kind='main'"):
            t = md.norm_key(row["title"])
            # 긴 제목은 앞부분 어디든, 짧은 제목은 첫머리(머리말 바로 아래)에 있어야 인정
            if (len(t) >= 15 and t in text_key or len(t) >= 6 and t in text_key[:120]) and (best is None or len(t) > len(md.norm_key(best["title"]))):
                best = row
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
        rec["kind"] = "supp"
        rec["parent_id"] = main["id"]
        rec["updated_at"] = time.time()
        sets = ", ".join(f"{k}=?" for k in rec)
        c.execute(f"UPDATE papers SET {sets} WHERE id=?", (*rec.values(), sid))
        # 이 논문에 딸려 있던 보충자료도 함께 옮긴다
        c.execute("UPDATE papers SET parent_id=? WHERE parent_id=?", (main["id"], sid))
        self._rename_supps_locked(c, main["id"])

    def _rename_supps_locked(self, c, main_id):
        main = c.execute("SELECT * FROM papers WHERE id=?", (main_id,)).fetchone()
        base = main["file_name"][:-4]
        for row in c.execute("SELECT * FROM papers WHERE parent_id=? ORDER BY added_at, id", (main_id,)).fetchall():
            p = self.to_dict(row)
            if p["missing"]:
                continue
            current = self.path_of(p)
            if current.name.startswith(base + SUPP_SUFFIX):
                continue
            target = self._unique_target(base + SUPP_SUFFIX + ".pdf", current=current)
            if target.name != current.name:
                os.replace(current, target)
                c.execute("UPDATE papers SET file_name=? WHERE id=?", (target.name, row["id"]))

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
        if p["kind"] == "supp" and p.get("parent_id"):
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
        if p["kind"] == "supp" and p["parent_id"]:
            return self._rename_supps_locked(c, p["parent_id"])
        if p["missing"]:
            return
        current = self.path_of(p)
        want = nice_file_name(p)
        if p["kind"] == "supp":
            want = want[:-4] + SUPP_SUFFIX + ".pdf"
            if current.name.startswith(want[:-4]):
                return
        if current.name == want:
            return
        target = self._unique_target(want, current=current)
        if target.name != current.name:
            os.replace(current, target)
            c.execute("UPDATE papers SET file_name=? WHERE id=?", (target.name, pid))
        if p["kind"] == "main":
            # 본문 이름이 바뀌면 보충자료도 새 이름을 따라간다
            new_base = target.name[:-4]
            for row in c.execute("SELECT * FROM papers WHERE parent_id=? ORDER BY added_at, id", (pid,)).fetchall():
                sp = self.to_dict(row)
                if sp["missing"]:
                    continue
                cur = self.path_of(sp)
                suffix = cur.name[len(current.stem):] if cur.name.startswith(current.stem) else SUPP_SUFFIX + ".pdf"
                t = self._unique_target(new_base + suffix, current=cur)
                if t.name != cur.name:
                    os.replace(cur, t)
                    c.execute("UPDATE papers SET file_name=? WHERE id=?", (t.name, row["id"]))

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
        """서재에서 뺀다(PDF는 trash 로). 본문 논문이면 딸린 보충자료도 함께."""
        p = self.get(pid)
        if not p:
            return False
        with self.lock, self.connect() as c:
            rows = [p] + [self.to_dict(r) for r in c.execute("SELECT * FROM papers WHERE parent_id=?", (pid,))]
            for x in rows:
                if not x["missing"]:
                    src = self.path_of(x)
                    dest = self.trash_dir / src.name
                    if dest.exists():
                        dest = self.trash_dir / f"{int(time.time())} {src.name}"
                    shutil.move(str(src), str(dest))
                c.execute("DELETE FROM papers WHERE id=?", (x["id"],))
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
        reclassified = self.reclassify()
        with self.lock, self.connect() as c:
            for r in c.execute("SELECT id, file_name FROM papers").fetchall():
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

        results = self._group_supplements(results)

        if sort == "year":
            results.sort(key=lambda p: (p.get("year") or 0, p.get("added_at") or 0), reverse=True)
        elif sort == "title":
            results.sort(key=lambda p: md.norm_key(p.get("title")))
        elif sort == "added" or not terms:
            results.sort(key=lambda p: p.get("added_at") or 0, reverse=True)
        else:
            results.sort(key=lambda p: (p["score"], p.get("year") or 0), reverse=True)
        return {"total": len(results), "terms": terms, "papers": results[:limit]}

    def _group_supplements(self, results):
        """본문에 묶인 보충자료는 본문 논문 결과 아래로 모은다."""
        by_id = {p["id"]: p for p in results}
        out = [p for p in results if not (p["kind"] == "supp" and p.get("parent_id"))]
        tops = {p["id"]: p for p in out}
        with self.connect() as c:
            for p in results:
                if not (p["kind"] == "supp" and p.get("parent_id")):
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
                        parent["snippet"], parent["in_supplement"] = p["snippet"], True
                    else:
                        parent["snippet"] = (parent.get("abstract") or "")[:240]
                parent["score"] = max(parent.get("score", 0), p.get("score", 0))
            ids = list(tops)
            supps = {}
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                q = f"SELECT id, file_name, original_name, parent_id FROM papers WHERE parent_id IN ({','.join('?' * len(chunk))}) ORDER BY added_at, id"
                for r in c.execute(q, chunk):
                    supps.setdefault(r["parent_id"], []).append(
                        {"id": r["id"], "file_name": r["file_name"], "original_name": r["original_name"],
                         "missing": not (self.root / r["file_name"]).exists(), "matched": r["id"] in by_id})
        for p in out:
            p["supplements"] = supps.get(p["id"], [])
        return out

    def stats(self):
        with self.connect() as c:
            total = c.execute("SELECT count(*) FROM papers WHERE NOT (kind='supp' AND parent_id IS NOT NULL)").fetchone()[0]
            review = c.execute("SELECT count(*) FROM papers WHERE needs_review=1").fetchone()[0]
            years = [r[0] for r in c.execute("SELECT DISTINCT year FROM papers WHERE year IS NOT NULL ORDER BY year")]
            supps = c.execute("SELECT count(*) FROM papers WHERE kind='supp'").fetchone()[0]
        return {"total": total, "needs_review": review, "years": years, "supplements": supps}

    def all_papers(self):
        with self.connect() as c:
            rows = c.execute("SELECT * FROM papers WHERE kind='main' ORDER BY year, title").fetchall()
        return [self.to_dict(r) for r in rows]
