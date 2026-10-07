"""PDF에서 논문 서지 정보를 뽑아낸다.

순서: PDF 안의 DOI → Crossref, arXiv ID → arXiv API, 제목 추정 → Crossref 검색.
온라인 조회가 모두 실패하면 PDF 자체 정보로 채우고 needs_review 를 켠다.
"""

import html
import json
import math
import re
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from difflib import SequenceMatcher

from pypdf import PdfReader

USER_AGENT = "PaperShelf/1.0 (personal paper library; https://github.com/jason-s-cho/claude-space)"
TIMEOUT = 15
MAX_FULLTEXT_PAGES = 300
MAX_FULLTEXT_CHARS = 400_000

DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>{}]+)", re.I)
ARXIV_NEW_RE = re.compile(r"arxiv[:\s/.]*(?:abs/)?(\d{4}\.\d{4,5})(v\d+)?", re.I)
ARXIV_FILE_RE = re.compile(r"^(\d{4}\.\d{4,5})(v\d+)?(\.pdf)?$", re.I)
ARXIV_OLD_RE = re.compile(r"arxiv[:\s/.]*(?:abs/)?([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", re.I)
HANGUL_RE = re.compile(r"[가-힣]")


# ---------------------------------------------------------------- 텍스트 유틸

def norm_key(s):
    """비교용: 소문자, 글자·숫자만 남김(한글 포함)."""
    s = unicodedata.normalize("NFKC", s or "").lower()
    return "".join(ch for ch in s if ch.isalnum())


def similarity(a, b):
    a, b = norm_key(a), norm_key(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def clean_text(s):
    s = s or ""
    s = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", s)  # 줄바꿈 하이픈 이어붙이기
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def strip_tags(s):
    s = re.sub(r"<jats:title>.*?</jats:title>", " ", s or "", flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return clean_text(html.unescape(s))


def clean_doi(doi):
    doi = doi.strip().rstrip(".,;:)]}>'\"")
    doi = re.sub(r"^(https?://)?(dx\.)?doi\.org/", "", doi, flags=re.I)
    # 참고문헌처럼 DOI 뒤에 붙어버린 꼬리 자르기
    doi = re.split(r"(?i)(?:\.pdf|/full|/abstract|\?)", doi)[0] if "/" in doi else doi
    return doi


def is_hangul(s):
    return bool(HANGUL_RE.search(s or ""))


# ---------------------------------------------------------------- PDF 읽기

def read_pdf(path):
    """PDF에서 (첫 페이지 글, 앞쪽 글, 전체 글, info 메타, 제목 후보)를 얻는다."""
    reader = PdfReader(str(path), strict=False)
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            pass

    info = {}
    try:
        meta = reader.metadata or {}
        for k in ("/Title", "/Author", "/Subject", "/Keywords", "/doi", "/DOI"):
            v = meta.get(k)
            if v:
                info[k.strip("/").lower()] = str(v)
    except Exception:
        pass
    try:
        xmp = reader.xmp_metadata
        if xmp is not None:
            raw = ET.tostring(xmp.rdf_root, encoding="unicode") if hasattr(xmp, "rdf_root") else ""
            m = DOI_RE.search(raw)
            if m and "xmp_doi" not in info:
                info["xmp_doi"] = m.group(1)
    except Exception:
        pass

    pages = []
    title_guess = ""
    first_chunks = []
    for i, page in enumerate(reader.pages):
        if i >= MAX_FULLTEXT_PAGES:
            break
        chunks = []

        def visitor(text, cm, tm, font_dict, font_size, _chunks=chunks):
            if text and text.strip():
                try:
                    scale = math.hypot(tm[2], tm[3]) * math.hypot(cm[2], cm[3])
                except Exception:
                    scale = 1
                _chunks.append((round((font_size or 0) * (scale or 1), 1), text))

        try:
            text = page.extract_text(visitor_text=visitor if i == 0 else None) or ""
        except Exception:
            text = ""
        pages.append(text)
        if i == 0:
            title_guess = guess_title_from_chunks(chunks)
            first_chunks = chunks

    first = pages[0] if pages else ""
    head = "\n".join(pages[:2])
    front = "\n".join(pages[:12])  # 책의 표제지·판권 면(ISBN)이 있는 앞부분
    full = clean_text("\n".join(pages))[:MAX_FULLTEXT_CHARS]
    return {"first": first, "head": head, "front": front, "full": full, "info": info,
            "title_guess": title_guess, "chunks": first_chunks, "page_count": len(reader.pages)}


BAD_TITLE_WORDS = {"article", "research article", "original article", "review", "letter",
                   "open access", "contents lists available at sciencedirect", "abstract",
                   "research paper", "original research", "journal of", "proceedings"}


def guess_title_from_chunks(chunks, skip=None):
    """첫 페이지에서 가장 큰 글씨로 쓰인 문장을 제목으로 본다."""
    sizes = {}
    order = {}
    for idx, (size, text) in enumerate(chunks):
        if size <= 0 or (skip and skip(text)):
            continue
        sizes.setdefault(size, []).append(text)
        order.setdefault(size, idx)
    for size in sorted(sizes, reverse=True):
        text = clean_text(" ".join(sizes[size]))
        letters = sum(ch.isalpha() for ch in text)
        if letters < 8 or len(text) > 350:
            continue
        if text.lower().strip(" .:") in BAD_TITLE_WORDS:
            continue
        return text
    return ""


def plausible_title(s):
    if not s:
        return False
    s = s.strip()
    low = s.lower()
    if len(s) < 8 or len(s) > 400:
        return False
    if low.startswith(("microsoft word", "untitled")) or re.search(r"\.(docx?|pdf|tex|dvi)$", low):
        return False
    if re.fullmatch(r"[\w\-]+", s) and not is_hangul(s):  # 파일명 같은 한 단어
        return False
    return True


# ---------------------------------------------------------------- 온라인 조회

def http_get(url, accept="application/json"):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def crossref_by_doi(doi):
    url = "https://api.crossref.org/works/" + urllib.parse.quote(doi, safe="/:;()")
    data = json.loads(http_get(url))
    return from_crossref(data["message"])


def crossref_search(query, rows=5):
    q = urllib.parse.urlencode({"query.bibliographic": query[:400], "rows": rows})
    data = json.loads(http_get("https://api.crossref.org/works?" + q))
    return [from_crossref(item) for item in data["message"].get("items", [])]


def from_crossref(m):
    def first(key):
        v = m.get(key) or []
        return v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else "")

    authors = []
    people = m.get("author") or m.get("editor") or []  # 편저는 저자 대신 편집자
    for a in people:
        if a.get("family") or a.get("given"):
            authors.append({"given": a.get("given", ""), "family": a.get("family", "")})
        elif a.get("name"):
            authors.append({"given": "", "family": a["name"]})

    year = None
    for key in ("published-print", "published-online", "issued", "published", "created"):
        parts = (m.get(key) or {}).get("date-parts") or []
        if parts and parts[0] and parts[0][0]:
            year = int(parts[0][0])
            break

    title = clean_text(strip_tags(first("title")))
    subtitle = clean_text(strip_tags(first("subtitle")))
    if subtitle and subtitle.lower() not in title.lower():
        title = f"{title}: {subtitle}"

    journal = first("container-title")
    kind = m.get("type", "")
    if not journal and kind == "posted-content":
        journal = m.get("institution", [{}])[0].get("name", "") if m.get("institution") else ""

    return {
        "title": title,
        "authors": authors,
        "journal": clean_text(html.unescape(journal)),
        "year": year,
        "volume": m.get("volume", ""),
        "issue": m.get("issue", ""),
        "pages": m.get("page", ""),
        "publisher": m.get("publisher", ""),
        "doi": (m.get("DOI") or "").lower(),
        "url": m.get("URL", ""),
        "abstract": strip_tags(m.get("abstract", "")),
        "type": "edited-book" if kind == "book" and not m.get("author") and m.get("editor") else kind,
        "isbn": format_isbn((m.get("ISBN") or [""])[0]) if kind in BOOK_TYPES else "",
        "edition": str(m.get("edition-number") or ""),
        "source": "crossref",
    }


# ---------------------------------------------------------------- 책 (ISBN)

BOOK_TYPES = {"book", "monograph", "edited-book", "reference-book", "book-set", "book-series"}
ISBN_LABEL_RE = re.compile(r"ISBN(?:-?1[03])?[\s:：]*((?:97[89][\s\-‐–]?)?[0-9][0-9\s\-‐–]{7,16}[0-9Xx])", re.I)
ISBN_BARE_RE = re.compile(r"\b(97[89][\-‐–\s]?\d{1,5}[\-‐–\s]?\d{1,7}[\-‐–\s]?\d{1,7}[\-‐–\s]?\d)\b")


def isbn_valid(d):
    if len(d) == 10:
        if not re.fullmatch(r"\d{9}[\dX]", d):
            return False
        total = sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(d))
        return total % 11 == 0
    if len(d) == 13 and d.isdigit() and d[:3] in ("978", "979"):
        total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(d[:12]))
        return (10 - total % 10) % 10 == int(d[12])
    return False


def normalize_isbn(s):
    d = re.sub(r"[^0-9Xx]", "", s or "").upper()
    return d if isbn_valid(d) else ""


def isbn10_to_13(d):
    if len(d) != 10:
        return d
    core = "978" + d[:9]
    total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(core))
    return core + str((10 - total % 10) % 10)


def format_isbn(s):
    return isbn10_to_13(normalize_isbn(s)) or ""


def find_isbns(text):
    """앞부분에서 ISBN을 찾는다. 'ISBN' 표시가 붙은 것을 먼저."""
    seen, out = set(), []
    for regex in (ISBN_LABEL_RE, ISBN_BARE_RE):
        for m in regex.finditer(text or ""):
            d = normalize_isbn(m.group(1))
            if d:
                d = isbn10_to_13(d)
                if d not in seen:
                    seen.add(d)
                    out.append(d)
    return out[:4]


def split_name(name):
    name = clean_text(name)
    if is_hangul(name) or " " not in name:
        return {"given": "", "family": name}
    if "," in name:
        family, _, given = name.partition(",")
        return {"given": given.strip(), "family": family.strip()}
    given, _, family = name.rpartition(" ")
    return {"given": given, "family": family}


def book_record(**kw):
    rec = {"title": "", "authors": [], "journal": "", "year": None, "volume": "", "issue": "", "pages": "",
           "publisher": "", "doi": "", "url": "", "abstract": "", "type": "book", "isbn": "", "edition": "",
           "arxiv_id": ""}
    rec.update(kw)
    return rec


def crossref_by_isbn(isbn):
    q = urllib.parse.urlencode({"filter": f"isbn:{isbn}", "rows": 20})
    data = json.loads(http_get("https://api.crossref.org/works?" + q))
    items = [from_crossref(it) for it in data["message"].get("items", [])]
    books = [it for it in items if it["type"] in BOOK_TYPES]
    if books:
        rec = books[0]
        rec["isbn"] = rec["isbn"] or isbn
        return rec
    return None


def _year(s):
    m = re.search(r"\b(1[5-9]\d\d|20\d\d)\b", str(s or ""))
    return int(m.group(1)) if m else None


def from_google_books(item):
    v = item.get("volumeInfo", {})
    title = clean_text(v.get("title", ""))
    if v.get("subtitle"):
        title = f"{title}: {clean_text(v['subtitle'])}"
    isbn = ""
    for ident in v.get("industryIdentifiers", []) or []:
        if ident.get("type") in ("ISBN_13", "ISBN_10"):
            isbn = format_isbn(ident.get("identifier"))
            if ident.get("type") == "ISBN_13":
                break
    return book_record(
        title=title,
        authors=[split_name(a) for a in v.get("authors", []) or []],
        year=_year(v.get("publishedDate")),
        publisher=clean_text(v.get("publisher", "")),
        url=v.get("infoLink") or v.get("canonicalVolumeLink") or "",
        abstract=strip_tags(v.get("description", ""))[:2000],
        isbn=isbn,
        source="googlebooks",
    )


def google_books_by_isbn(isbn):
    data = json.loads(http_get("https://www.googleapis.com/books/v1/volumes?q=isbn:" + isbn))
    items = data.get("items") or []
    return from_google_books(items[0]) if items else None


def google_books_search(query, rows=5):
    q = urllib.parse.urlencode({"q": query[:300], "maxResults": rows, "printType": "books"})
    data = json.loads(http_get("https://www.googleapis.com/books/v1/volumes?" + q))
    return [from_google_books(it) for it in data.get("items") or []]


def openlibrary_by_isbn(isbn):
    q = urllib.parse.urlencode({"bibkeys": f"ISBN:{isbn}", "format": "json", "jscmd": "data"})
    data = json.loads(http_get("https://openlibrary.org/api/books?" + q))
    b = data.get(f"ISBN:{isbn}")
    if not b:
        return None
    title = clean_text(b.get("title", ""))
    if b.get("subtitle"):
        title = f"{title}: {clean_text(b['subtitle'])}"
    return book_record(
        title=title,
        authors=[split_name(a.get("name", "")) for a in b.get("authors", []) or []],
        year=_year(b.get("publish_date")),
        publisher=", ".join(p.get("name", "") for p in b.get("publishers", []) or []),
        url=b.get("url", ""),
        isbn=isbn,
        source="openlibrary",
    )


def book_by_isbn(isbn, log=None):
    """Crossref(학술서, DOI 있음) → Google Books → Open Library 순서."""
    log = log or (lambda *a: None)
    for name, fn in (("Crossref", crossref_by_isbn), ("Google Books", google_books_by_isbn),
                     ("Open Library", openlibrary_by_isbn)):
        try:
            rec = fn(isbn)
        except Exception as e:
            log(f"{name} ISBN 조회 실패 {isbn}: {e}")
            continue
        if rec and rec.get("title"):
            rec["isbn"] = rec.get("isbn") or isbn
            if not rec.get("abstract") and name == "Crossref":
                # 학술서는 Crossref 에 소개글이 없으니 Google Books 에서 채운다
                try:
                    g = google_books_by_isbn(isbn)
                    if g:
                        rec["abstract"] = g["abstract"]
                except Exception:
                    pass
            return rec
    return None


ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"


def arxiv_by_id(arxiv_id):
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode({"id_list": arxiv_id})
    root = ET.fromstring(http_get(url, accept="application/atom+xml"))
    entry = root.find(f"{ATOM}entry")
    if entry is None or entry.find(f"{ATOM}title") is None:
        return None
    title = clean_text(entry.findtext(f"{ATOM}title", ""))
    if not title or title.lower() == "error":
        return None
    authors = []
    for a in entry.findall(f"{ATOM}author"):
        name = clean_text(a.findtext(f"{ATOM}name", ""))
        if name:
            given, _, family = name.rpartition(" ")
            authors.append({"given": given, "family": family or name})
    published = entry.findtext(f"{ATOM}published", "")
    journal_ref = clean_text(entry.findtext(f"{ARXIV_NS}journal_ref", ""))
    doi = clean_text(entry.findtext(f"{ARXIV_NS}doi", "")).lower()
    return {
        "title": title,
        "authors": authors,
        "journal": journal_ref or f"arXiv preprint arXiv:{arxiv_id}",
        "year": int(published[:4]) if published[:4].isdigit() else None,
        "volume": "", "issue": "", "pages": "",
        "publisher": "arXiv",
        "doi": doi,
        "url": f"https://arxiv.org/abs/{arxiv_id}",
        "abstract": clean_text(entry.findtext(f"{ATOM}summary", "")),
        "type": "preprint",
        "arxiv_id": arxiv_id,
        "source": "arxiv",
    }


# ---------------------------------------------------------------- 보충자료

SUPP_PHRASE = (r"(?:supplementary|supplemental|supporting|electronic supplementary|online supplementary)\s+"
               r"(?:information|materials?|data|notes?|text|methods|figures?|tables?|appendix|appendices|files?)"
               r"|extended\s+data|online\s+(?:appendix|methods|supplement)|\bappendix\b|보충\s*자료|부록")
SUPP_TEXT_RE = re.compile(SUPP_PHRASE, re.I)
SUPP_FILE_RE = re.compile(r"(?<![a-z])(?:supp|suppl|supplement\w*|si|esi|moesm\d*|mmc\d+|appendix|"
                          r"supporting|sup)(?![a-z])|보충|부록", re.I)
SUPP_STRIP_RE = re.compile(r"^\s*(?:" + SUPP_PHRASE + r")\s*(?:\d+|[A-Z](?![a-z]))?(?:\s*(?:for|to|of|:|-|—|–))*\s*", re.I)
SUPP_LINE_RE = re.compile(r"^\W*(?:" + SUPP_PHRASE + r")(?!\s+(?:is|are|for this|accompan|can|may|available|linked))", re.I)


def is_supplement(first_text, filename=""):
    """첫 페이지 머리말이나 파일 이름으로 보충자료인지 판단."""
    stem = re.sub(r"\.pdf$", "", (filename or "").rsplit("/", 1)[-1], flags=re.I)
    if SUPP_FILE_RE.search(stem.replace("_", " ").replace("-", " ")):
        return True
    # 첫 페이지 맨 앞 몇 줄 중 하나가 'Supplementary Information …' 으로 시작하면 보충자료.
    # 본문 논문에 흔한 'Supplementary information is available …' 같은 안내 문장은 제외.
    lines = [ln.strip() for ln in (first_text or "").splitlines() if ln.strip()][:6]
    return any(len(ln) < 200 and SUPP_LINE_RE.match(ln) for ln in lines)


def strip_supp_heading(title):
    """'Supplementary Information for: 제목' → '제목'."""
    out = SUPP_STRIP_RE.sub("", title or "", count=1).strip(" :.-—–")
    return out if len(out) >= 8 else ""


# ---------------------------------------------------------------- 판별

def title_in_text(title, text_key):
    """Crossref 결과의 제목이 PDF 첫 페이지에 실제로 있는지."""
    t = norm_key(title)
    if len(t) < 10:
        return False
    if t in text_key:
        return True
    # 부제/구두점 차이 허용: 앞 40자만 확인
    return len(t) > 40 and t[:40] in text_key


def find_dois(pdf):
    seen, out = set(), []
    for src in (pdf["info"].get("doi"), pdf["info"].get("xmp_doi"), pdf["info"].get("subject"), pdf["head"]):
        for m in DOI_RE.finditer(src or ""):
            d = clean_doi(m.group(1)).lower()
            if d not in seen and len(d) > 7:
                seen.add(d)
                out.append(d)
    return out[:6]


def find_arxiv_id(pdf, filename):
    stem = (filename or "").rsplit("/", 1)[-1]
    m = ARXIV_FILE_RE.match(stem)
    if m:
        return m.group(1)
    for text in (pdf["first"], pdf["head"]):
        m = ARXIV_NEW_RE.search(text or "") or ARXIV_OLD_RE.search(text or "")
        if m:
            return m.group(1)
    return None


def empty_record():
    return {"title": "", "authors": [], "journal": "", "year": None, "volume": "", "issue": "",
            "pages": "", "publisher": "", "doi": "", "url": "", "abstract": "", "type": "",
            "arxiv_id": "", "isbn": "", "edition": "", "source": "pdf"}


def parse_author_string(s):
    authors = []
    for part in re.split(r"\s*(?:;|,| and |&)\s*", s or ""):
        part = part.strip()
        if not part or len(part) > 60 or part.lower() in ("anonymous", "unknown", "admin", "user"):
            continue
        if is_hangul(part) or " " not in part:
            authors.append({"given": "", "family": part})
        else:
            given, _, family = part.rpartition(" ")
            authors.append({"given": given, "family": family})
    return authors


def year_from_text(text):
    years = [int(y) for y in re.findall(r"\b(19[5-9]\d|20[0-4]\d)\b", text or "")]
    return max(years) if years else None


def extract(path, filename="", online=True, log=None, supplement=None):
    """경로의 PDF를 읽어 서지 정보 dict 를 돌려준다. 'fulltext', 'needs_review', 'is_supplement' 포함.

    보충자료면 그 보충자료가 딸린 본문 논문의 서지 정보를 찾는다.
    """
    log = log or (lambda *a: None)
    pdf = read_pdf(path)
    if supplement is None:
        supplement = is_supplement(pdf["first"], filename)
    if supplement:
        # 'Supplementary Information' 같은 머리말 글씨는 빼고 본문 논문 제목을 찾는다
        pdf["title_guess"] = (strip_supp_heading(pdf["title_guess"])
                              or guess_title_from_chunks(pdf["chunks"], skip=lambda t: bool(SUPP_TEXT_RE.search(t))
                                                         and not strip_supp_heading(clean_text(t)))
                              or pdf["title_guess"])
    text_key = norm_key(pdf["head"])
    record = None

    if online:
        # 1) DOI
        for doi in find_dois(pdf):
            try:
                rec = crossref_by_doi(doi)
            except Exception as e:
                log(f"Crossref DOI 조회 실패 {doi}: {e}")
                continue
            if title_in_text(rec["title"], text_key) or doi in (pdf["info"].get("doi", "").lower(),
                                                                pdf["info"].get("xmp_doi", "").lower()):
                record = rec
                break
            log(f"DOI {doi} 의 제목이 본문과 맞지 않아 건너뜀")

        # 2) 책: 판권 면의 ISBN
        isbns = find_isbns(pdf["front"])
        if record is None and isbns:
            front_key = norm_key(pdf["front"])
            for isbn in isbns:
                rec = book_by_isbn(isbn, log)
                if rec is None:
                    continue
                # 논문에 찍힌 학술대회 논문집 ISBN 등을 책으로 오인하지 않도록:
                # 두꺼운 PDF이거나 책 제목이 앞부분에 실제로 있어야 한다
                if pdf["page_count"] >= 40 or title_in_text(rec["title"], front_key) \
                        or title_in_text(rec["title"].split(":")[0], front_key):
                    record = rec
                    break
                log(f"ISBN {isbn} 의 책({rec['title']})이 이 PDF와 맞지 않아 건너뜀")
        if record is not None and record.get("type") in BOOK_TYPES and not record.get("isbn") and isbns:
            record["isbn"] = isbns[0]

        # 3) arXiv
        if record is None:
            arxiv_id = find_arxiv_id(pdf, filename)
            if arxiv_id:
                try:
                    record = arxiv_by_id(arxiv_id)
                except Exception as e:
                    log(f"arXiv 조회 실패 {arxiv_id}: {e}")

        # 4) 제목으로 Crossref 검색
        if record is None:
            queries = []
            for cand in (pdf["title_guess"], pdf["info"].get("title", "")):
                if supplement:
                    cand = strip_supp_heading(cand) if SUPP_TEXT_RE.match(cand or "") else cand
                if plausible_title(cand) and cand not in queries:
                    queries.append(cand)
            if (not queries or supplement) and pdf["first"]:
                queries.append(SUPP_TEXT_RE.sub(" ", clean_text(pdf["first"])[:300]) if supplement
                               else clean_text(pdf["first"])[:300])
            for q in queries:
                try:
                    results = crossref_search(q)
                except Exception as e:
                    log(f"Crossref 검색 실패: {e}")
                    break
                for rec in results:
                    if title_in_text(rec["title"], text_key) or similarity(rec["title"], q) >= 0.9:
                        record = rec
                        break
                if record:
                    break

    needs_review = record is None
    if record is None:
        record = empty_record()
        info = pdf["info"]
        title = pdf["title_guess"] if plausible_title(pdf["title_guess"]) else ""
        if not title and plausible_title(info.get("title")):
            title = clean_text(info["title"])
        if supplement:
            title = strip_supp_heading(title)
        if not title:
            title = re.sub(r"\.pdf$", "", filename or "", flags=re.I) or "제목 없음"
        record["title"] = title
        record["authors"] = parse_author_string(info.get("author", ""))
        record["year"] = year_from_text(pdf["first"])
        dois = find_dois(pdf)
        if dois:
            record["doi"] = dois[0]
        arxiv_id = find_arxiv_id(pdf, filename)
        if arxiv_id:
            record["arxiv_id"] = arxiv_id
            record["url"] = f"https://arxiv.org/abs/{arxiv_id}"
        record["keywords"] = info.get("keywords", "")
        isbns = find_isbns(pdf["front"])
        if isbns:
            record["isbn"] = isbns[0]
        if isbns or pdf["page_count"] >= 120:
            record["type"] = "book"

    record.setdefault("arxiv_id", "")
    record.setdefault("isbn", "")
    record.setdefault("edition", "")
    record["page_count"] = pdf["page_count"]
    record["fulltext"] = pdf["full"]
    record["needs_review"] = needs_review
    record["is_supplement"] = bool(supplement)
    if not record.get("abstract") and record.get("type") not in BOOK_TYPES:
        record["abstract"] = abstract_from_text(pdf["first"])
    return record


def abstract_from_text(text):
    m = re.search(r"(?is)\b(?:abstract|요\s*약|초\s*록)\b[\s.:—\-]*(.{80,1800}?)"
                  r"(?:\n\s*(?:keywords?|key words|index terms|1\.?\s+introduction|introduction|주제어|핵심어)\b|$)",
                  text or "")
    return clean_text(m.group(1))[:1200] if m else ""


# ---------------------------------------------------------------- 표기 형식

def author_display(a, scholar=False):
    given, family = (a.get("given") or "").strip(), (a.get("family") or "").strip()
    if is_hangul(family + given):
        return family + given
    if scholar:
        initials = "".join(p[0] for p in re.split(r"[\s\-.]+", given) if p)
        return f"{initials} {family}".strip()
    return f"{given} {family}".strip()


def scholar_authors(authors, limit=4):
    names = [author_display(a, scholar=True) for a in authors[:limit]]
    s = ", ".join(n for n in names if n)
    return s + "…" if len(authors) > limit else s


def first_author_key(authors):
    if not authors:
        return "Unknown"
    a = authors[0]
    if is_hangul((a.get("family") or "") + (a.get("given") or "")):
        return (a.get("family") or "") + (a.get("given") or "")
    return a.get("family") or a.get("given") or "Unknown"


def _apa_name(a):
    given, family = (a.get("given") or "").strip(), (a.get("family") or "").strip()
    if is_hangul(family + given):
        return family + given
    initials = " ".join(p[0] + "." for p in re.split(r"[\s.]+", given) if p and p[0].isalpha())
    return f"{family}, {initials}".strip(", ")


def citations(p):
    authors = p.get("authors") or []
    year = p.get("year") or "n.d."
    title = p.get("title", "")
    journal = p.get("journal", "")
    vol, issue, pages, doi = p.get("volume", ""), p.get("issue", ""), p.get("pages", ""), p.get("doi", "")
    doi_url = f"https://doi.org/{doi}" if doi else (p.get("url") or "")

    names = [_apa_name(a) for a in authors]
    if len(names) > 20:
        apa_authors = ", ".join(names[:19]) + ", … " + names[-1]
    elif len(names) > 1:
        apa_authors = ", ".join(names[:-1]) + ", & " + names[-1]
    else:
        apa_authors = names[0] if names else ""
    t = (p.get("type") or "").lower()
    is_book = t in BOOK_TYPES
    is_chapter = t == "book-chapter"
    edition = str(p.get("edition") or "").strip()
    ed_txt = ""
    if edition:
        ed_txt = edition if not edition.isdigit() else {"1": "1st", "2": "2nd", "3": "3rd"}.get(edition, f"{edition}th")
        ed_txt = ed_txt if "ed" in ed_txt.lower() or not edition.isdigit() else f"{ed_txt} ed."
    if t == "edited-book" and apa_authors:
        apa_authors += " (Eds.)." if len(names) > 1 else " (Ed.)."
    publisher = p.get("publisher", "")

    apa = f"{apa_authors} ({year}). {title}."
    if is_book:
        apa = f"{apa_authors} ({year}). {title}" + (f" ({ed_txt})" if ed_txt else "") + "."
        if publisher:
            apa += f" {publisher}."
        if doi_url and doi:
            apa += f" {doi_url}"
        journal = vol = ""  # 아래 학술지 형식은 건너뛴다
        doi_url = ""
    elif is_chapter:
        apa = f"{apa_authors} ({year}). {title}. In {journal}" + (f" (pp. {pages})" if pages else "") + "."
        if publisher:
            apa += f" {publisher}."
        journal = ""
    if journal:
        apa += f" {journal}"
        if vol:
            apa += f", {vol}"
            if issue:
                apa += f"({issue})"
        if pages:
            apa += f", {pages}"
        apa += "."
    if doi_url:
        apa += f" {doi_url}"

    if authors:
        a0 = authors[0]
        if is_hangul((a0.get("family") or "") + (a0.get("given") or "")):
            first = author_display(a0)
        else:
            first = ", ".join(x for x in (a0.get("family"), a0.get("given")) if x)
        if len(authors) == 2:
            mla_auth = f"{first}, and {author_display(authors[1])}"
        elif len(authors) > 2:
            mla_auth = f"{first}, et al"
        else:
            mla_auth = first
    else:
        mla_auth = ""
    if t == "edited-book" and mla_auth:
        mla_auth += ", editors" if len(authors) > 1 else ", editor"
    if is_book:
        mla = (f"{mla_auth}. " if mla_auth else "") + f"{title}."
        if ed_txt:
            mla += f" {ed_txt[0].upper() + ed_txt[1:]},"
        mla += " " + ", ".join(x for x in (publisher, str(year)) if x) + "."
    else:
        mla = (f"{mla_auth}. " if mla_auth else "") + f"\u201c{title}.\u201d"
        parts = [p.get("journal")] if p.get("journal") else []
        if is_chapter and publisher:
            parts.append(publisher)
        if vol:
            parts.append(f"vol. {vol}")
        if issue:
            parts.append(f"no. {issue}")
        parts.append(str(year))
        if pages:
            parts.append(f"pp. {pages}")
        mla += " " + ", ".join(parts) + "."

    return {"APA": apa, "MLA": mla, "BibTeX": bibtex(p)}


def bibtex_key(p):
    fam = norm_key(first_author_key(p.get("authors") or [])) or "paper"
    word = next((norm_key(w) for w in (p.get("title") or "").split() if len(norm_key(w)) > 3), "")
    return f"{fam}{p.get('year') or ''}{word}"


def bibtex(p):
    def esc(s):
        return str(s).replace("{", "\\{").replace("}", "\\}")

    kind = "article"
    t = (p.get("type") or "").lower()
    if "proceedings" in t:
        kind = "inproceedings"
    elif t in BOOK_TYPES:
        kind = "book"
    elif t in ("book-chapter",):
        kind = "incollection"
    elif t in ("preprint", "posted-content"):
        kind = "misc"
    fields = [("title", "{" + esc(p.get("title", "")) + "}")]
    authors = " and ".join(
        ", ".join(x for x in (a.get("family"), a.get("given")) if x) for a in (p.get("authors") or []))
    if authors:
        fields.append(("editor" if t == "edited-book" else "author", esc(authors)))
    venue_key = "booktitle" if kind in ("inproceedings", "incollection") else "journal"
    for key, val in ((venue_key, p.get("journal")), ("year", p.get("year")), ("volume", p.get("volume")),
                     ("number", p.get("issue")), ("pages", (p.get("pages") or "").replace("-", "--")),
                     ("publisher", p.get("publisher")), ("edition", p.get("edition")),
                     ("isbn", p.get("isbn")), ("doi", p.get("doi")),
                     ("eprint", p.get("arxiv_id")), ("url", p.get("url"))):
        if val:
            fields.append((key, esc(val)))
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields)
    return f"@{kind}{{{bibtex_key(p)},\n{body}\n}}"
