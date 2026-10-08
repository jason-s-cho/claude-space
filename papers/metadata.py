"""PDF에서 논문 서지 정보를 뽑아낸다.

순서: PDF 안의 DOI → Crossref, arXiv ID → arXiv API, 제목 추정 → Crossref 검색.
온라인 조회가 모두 실패하면 PDF 자체 정보로 채우고 needs_review 를 켠다.
"""

import html
import http.cookiejar
import json
import math
import os
import re
import unicodedata
import urllib.error
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
        "cr_citations": m.get("is-referenced-by-count"),
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


# ---------------------------------------------------------------- 인용 수

def openalex_get(path):
    return json.loads(http_get("https://api.openalex.org/" + path))


def _openalex_result(w):
    wid = (w.get("id") or "").rsplit("/", 1)[-1]
    return {"count": int(w.get("cited_by_count") or 0), "source": "OpenAlex",
            "url": f"https://openalex.org/works?filter=cites:{wid}" if wid else ""}


def _title_ok(found, rec):
    if similarity(found.get("title") or found.get("display_name") or "", rec.get("title", "")) < 0.92:
        return False
    y1, y2 = found.get("year") or found.get("publication_year"), rec.get("year")
    return not (y1 and y2 and abs(int(y1) - int(y2)) > 1)


def citations_openalex(rec):
    doi = rec.get("doi") or (f"10.48550/arxiv.{rec['arxiv_id']}" if rec.get("arxiv_id") else "")
    if doi:
        try:
            return _openalex_result(openalex_get("works/https://doi.org/" + urllib.parse.quote(doi, safe="/:;()")))
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
    if not rec.get("title"):
        return None
    params = {"search": rec["title"][:250], "per-page": 5}
    if rec.get("type") in BOOK_TYPES:
        params["filter"] = "type:book"
    data = openalex_get("works?" + urllib.parse.urlencode(params))
    for w in data.get("results") or []:
        if _title_ok(w, rec):
            return _openalex_result(w)
    return None


def citations_semantic_scholar(rec):
    base = "https://api.semanticscholar.org/graph/v1/paper/"
    key = f"DOI:{rec['doi']}" if rec.get("doi") else (f"ARXIV:{rec['arxiv_id']}" if rec.get("arxiv_id") else "")
    if key:
        try:
            p = json.loads(http_get(base + urllib.parse.quote(key, safe=":/") + "?fields=citationCount,url"))
            return {"count": int(p.get("citationCount") or 0), "source": "Semantic Scholar", "url": p.get("url", "")}
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
    if not rec.get("title"):
        return None
    q = urllib.parse.urlencode({"query": rec["title"][:250], "fields": "title,year,citationCount,url"})
    data = json.loads(http_get(base + "search/match?" + q))
    for p in data.get("data") or []:
        if _title_ok(p, rec):
            return {"count": int(p.get("citationCount") or 0), "source": "Semantic Scholar", "url": p.get("url", "")}
    return None


def citations_crossref(rec):
    if not rec.get("doi"):
        return None
    n = rec.get("cr_citations")
    if n is None:
        data = json.loads(http_get("https://api.crossref.org/works/" + urllib.parse.quote(rec["doi"], safe="/:;()")))
        n = data["message"].get("is-referenced-by-count")
    return None if n is None else {"count": int(n), "source": "Crossref", "url": ""}


def citation_count(rec, log=None):
    """이 논문·책이 인용된 횟수. OpenAlex → Semantic Scholar → Crossref 순서로 처음 답을 쓴다.

    반환: {"count", "source", "url"} 또는 None(어디서도 못 찾음).
    """
    log = log or (lambda *a: None)
    for name, fn in (("OpenAlex", citations_openalex), ("Semantic Scholar", citations_semantic_scholar),
                     ("Crossref", citations_crossref)):
        try:
            res = fn(rec)
        except Exception as e:
            log(f"{name} 인용 수 조회 실패: {e}")
            continue
        if res is not None:
            return res
    return None


# ---------------------------------------------------------------- KCI (한국학술지인용색인)

KCI_KEY = ""  # 설정의 KCI Open API 키 (open.kci.go.kr 에서 무료 발급)
KCI_API = "https://open.kci.go.kr/po/openapi/openApiSearch.kci"
KCI_VIEW = "https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId="


def _local(tag):
    return str(tag).rsplit("}", 1)[-1].lower()


def _descendants(el, name):
    return [e for e in el.iter() if _local(e.tag) == name]


def _text_of(el, *names):
    for name in names:
        for e in _descendants(el, name):
            t = clean_text("".join(e.itertext()))
            if t:
                return t
    return ""


def _kci_author(name):
    name = re.sub(r"\s*[(\[（].*?[)\]）]\s*", " ", name or "").strip(" ,;")
    return split_name(name) if name else None


def from_kci(rec_el):
    """KCI 응답의 <record> 하나 → 서지 정보 dict."""
    titles = _descendants(rec_el, "article-title")
    original = next((t for t in titles if (t.get("lang") or "").lower() in ("original", "kor", "ko")), titles[0] if titles else None)
    title = clean_text("".join(original.itertext())) if original is not None else ""
    others = [clean_text("".join(t.itertext())) for t in titles if t is not original]
    abstracts = _descendants(rec_el, "abstract")
    abstract = ""
    for a in sorted(abstracts, key=lambda a: (a.get("lang") or "").lower() not in ("original", "kor", "ko")):
        abstract = clean_text("".join(a.itertext()))
        if abstract:
            break
    authors = []
    for a in _descendants(rec_el, "author"):
        for part in re.split(r"\s*;\s*", clean_text("".join(a.itertext()))):
            au = _kci_author(part)
            if au:
                authors.append(au)
    art_id = ""
    for e in rec_el.iter():
        art_id = e.get("article-id") or e.get("articleId") or art_id
        if art_id:
            break
    art_id = art_id or _text_of(rec_el, "article-id")
    fpage, lpage = _text_of(rec_el, "fpage"), _text_of(rec_el, "lpage")
    year = _year(_text_of(rec_el, "pub-year", "year"))
    doi = clean_doi(_text_of(rec_el, "doi")).lower()
    return {
        "title": title, "title_alt": others[0] if others else "", "authors": authors,
        "journal": _text_of(rec_el, "journal-name"), "year": year,
        "volume": _text_of(rec_el, "volume"), "issue": _text_of(rec_el, "issue"),
        "pages": f"{fpage}-{lpage}" if fpage and lpage and fpage != lpage else fpage,
        "publisher": _text_of(rec_el, "publisher-name"), "doi": doi if doi.startswith("10.") else "",
        "url": _text_of(rec_el, "url") or (KCI_VIEW + art_id if art_id else ""),
        "abstract": abstract, "type": "journal-article", "isbn": "", "edition": "", "arxiv_id": "",
        "kci_id": art_id, "source": "kci",
    }


def _kci_call(params):
    if not KCI_KEY:
        raise RuntimeError("KCI API 키가 설정되지 않았습니다")
    url = KCI_API + "?" + urllib.parse.urlencode({**params, "key": KCI_KEY})
    root = ET.fromstring(http_get(url, accept="application/xml"))
    records = [e for e in root.iter() if _local(e.tag) == "record"]
    if not records:
        # 키가 틀렸거나 한도를 넘으면 오류 문구가 온다
        msg = _text_of(root, "resultmsg", "message", "error", "errmsg")
        if msg and not re.search(r"(?i)success|정상", msg):
            raise RuntimeError(f"KCI: {msg}")
    return [from_kci(r) for r in records]


def kci_search(query, rows=5):
    return [r for r in _kci_call({"apiCode": "articleSearch", "title": query[:200], "displayCount": rows})
            if r["title"]]


def kci_by_id(art_id):
    found = _kci_call({"apiCode": "articleDetail", "id": art_id.upper()})
    return found[0] if found and found[0]["title"] else None


# ---------------------------------------------------------------- DOI·ISBN 으로 추가, 무료 PDF

def parse_identifier(text):
    """('doi'|'arxiv'|'isbn'|'kci', 값) 또는 None."""
    t = (text or "").strip()
    if not t:
        return None
    m = re.search(r"\bART\d{9}\b", t, re.I)
    if m:
        return "kci", m.group(0).upper()
    m = re.search(r"10\.\d{4,9}/\S+", t)
    if m:
        doi = clean_doi(m.group(0)).lower()
        a = re.fullmatch(r"10\.48550/arxiv\.(\d{4}\.\d{4,5})(v\d+)?", doi)
        return ("arxiv", a.group(1)) if a else ("doi", doi)
    m = re.fullmatch(r"(?:arxiv:\s*|https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/)?"
                     r"(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?(?:\.pdf)?", t, re.I)
    if m:
        return "arxiv", m.group(1)
    isbn = format_isbn(re.sub(r"(?i)^isbn(?:-1[03])?[:\s]*", "", t))
    if isbn:
        return "isbn", isbn
    return None


def open_pdf_urls(p, log=None):
    """이 논문의 무료(오픈 액세스) PDF 주소 후보: [(주소, 출처 이름)].

    PDF 주소가 아니라 논문 안내 페이지여도 된다(download_pdf 가 페이지의 citation_pdf_url 을 따라간다).
    """
    log = log or (lambda *a: None)
    out, seen = [], set()

    def add(url, source):
        if url and url.startswith(("http://", "https://")) and url not in seen:
            seen.add(url)
            out.append((url, source))

    doi = (p.get("doi") or "").lower()
    arxiv = p.get("arxiv_id") or ""
    if not arxiv and doi.startswith("10.48550/arxiv."):
        arxiv = doi.split("arxiv.", 1)[1]
    if arxiv:
        add(f"https://arxiv.org/pdf/{arxiv}", "arXiv")
    if doi and not doi.startswith("10.48550/"):
        try:
            w = openalex_get("works/https://doi.org/" + urllib.parse.quote(doi, safe="/:;()"))
        except Exception as e:
            log(f"OpenAlex 조회 실패 {doi}: {e}")
            w = {}
        locs = [w.get("best_oa_location") or {}, w.get("primary_location") or {}] + list(w.get("locations") or [])
        oa = [loc for loc in locs if loc.get("is_oa")]
        for loc in oa:
            add(loc.get("pdf_url"), (loc.get("source") or {}).get("display_name") or "OpenAlex")
        add((w.get("open_access") or {}).get("oa_url"), "OpenAlex")
        # Europe PMC: 오픈 액세스 논문 사본(출판 후 며칠~몇 주 뒤 올라옴). 출판사가 자동 내려받기를 막아도 여기서 받을 수 있다
        try:
            for url in europepmc_pdf_urls(doi):
                add(url, "Europe PMC")
        except Exception as e:
            log(f"Europe PMC 조회 실패 {doi}: {e}")
        # 오픈 액세스 출판사는 DOI만으로 PDF 주소를 안다 (OpenAlex 에 아직 없는 새 논문도)
        for pattern, template, name in PUBLISHER_PDF:
            m = re.match(pattern, doi)
            if m:
                add(template.format(m.group(1)), name)
        for loc in oa:
            add(loc.get("landing_page_url"), (loc.get("source") or {}).get("display_name") or "출판사 누리집")
        # 마지막으로 출판사 논문 페이지(DOI). 무료 공개본이면 페이지에 PDF 주소가 적혀 있다
        add("https://doi.org/" + doi, "출판사 누리집")
    return out


def europepmc_pdf_urls(doi):
    q = urllib.parse.urlencode({"query": f'DOI:"{doi}"', "resultType": "core", "format": "json", "pageSize": 1})
    data = json.loads(http_get("https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + q))
    out = []
    for r in (data.get("resultList") or {}).get("result") or []:
        if (r.get("doi") or "").lower() != doi.lower():
            continue
        for u in ((r.get("fullTextUrlList") or {}).get("fullTextUrl") or []):
            if (u.get("documentStyle") or "").lower() == "pdf" and (u.get("availabilityCode") or "") in ("OA", "F"):
                out.append(u.get("url"))
        if r.get("pmcid") and r.get("isOpenAccess") == "Y":
            out.append(f"https://europepmc.org/articles/{r['pmcid']}?pdf=render")
    return [u for u in out if u]


PUBLISHER_PDF = [
    (r"^10\.1038/(.+)$", "https://www.nature.com/articles/{0}.pdf", "Nature"),
    (r"^(10\.(?:1007|1186)/.+)$", "https://link.springer.com/content/pdf/{0}.pdf", "Springer"),
    (r"^(10\.3389/.+)$", "https://www.frontiersin.org/articles/{0}/pdf", "Frontiers"),
    (r"^(10\.1371/journal\.p[a-z]+\.\d+)$", "https://journals.plos.org/plosone/article/file?id={0}&type=printable", "PLOS"),
]

# 출판사 누리집은 처음 접속 때 쿠키를 주고받는 확인을 거치는 곳이 있어(nature.com 등) 쿠키를 기억한다
_COOKIES = http.cookiejar.CookieJar()
_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_COOKIES))

# 일부 출판사는 브라우저가 아닌 요청을 막으므로, 브라우저 형식을 앞에 둔 이름으로 묻는다
DOWNLOAD_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
               "PaperShelf/1.0 (+https://github.com/jason-s-cho/claude-space)")
CITATION_PDF_RE = re.compile(r"<meta\b[^>]*?\bname\s*=\s*[\"']citation_pdf_url[\"'][^>]*>", re.I)
CONTENT_RE = re.compile(r"\bcontent\s*=\s*[\"']([^\"']+)[\"']", re.I)


def citation_pdf_url(page, base):
    """논문 페이지 HTML 의 <meta name="citation_pdf_url" content="…"> (대부분의 출판사가 씀)."""
    m = CITATION_PDF_RE.search(page)
    if not m:
        return ""
    c = CONTENT_RE.search(m.group(0))
    return urllib.parse.urljoin(base, html.unescape(c.group(1)).strip()) if c else ""


def _open_url(url, accept):
    req = urllib.request.Request(url, headers={"User-Agent": DOWNLOAD_UA, "Accept": accept,
                                               "Accept-Language": "en-US,en;q=0.8,ko;q=0.6"})
    return _OPENER.open(req, timeout=60)


class NotPdf(Exception):
    """받은 것이 PDF가 아님(안내·로그인 페이지 등)."""


def download_pdf(url, dest, max_bytes=300 * 1024 * 1024, _follow=True):
    """주소의 PDF를 dest 에 저장하고 True. 논문 안내 페이지면 그 페이지의 PDF 주소를 한 번 따라간다.

    PDF를 못 받으면 NotPdf 나 urllib 오류를 낸다.
    """
    if not url.startswith(("http://", "https://")):
        raise NotPdf("http 주소가 아닙니다")
    with _open_url(url, "application/pdf,text/html;q=0.9,*/*;q=0.5") as r:
        head = r.read(1024)
        if head.lstrip().startswith(b"%PDF"):
            total = len(head)
            with open(dest, "wb") as f:
                f.write(head)
                while chunk := r.read(1 << 16):
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("PDF가 너무 큽니다")
                    f.write(chunk)
            return True
        final = r.geturl()
        page = (head + r.read(3_000_000 if _follow else 300_000)).decode("utf-8", "replace")
    title = page_title(page)
    if looks_blocked(page):
        raise Blocked(f"사람 확인 페이지가 왔습니다 — {final}" + (f" ‘{title}’" if title else ""))
    if not _follow:
        raise NotPdf(f"PDF 대신 웹페이지가 왔습니다 — {final}" + (f" ‘{title}’" if title else ""))
    pdf = citation_pdf_url(page, final)
    if not pdf or pdf == url:
        raise NotPdf(f"페이지에 PDF 주소가 없습니다 — {final}" + (f" ‘{title}’" if title else ""))
    return download_pdf(pdf, dest, max_bytes, _follow=False)


def looks_blocked(page):
    """자동 접속을 막는 사람 확인·차단 페이지인지 (논문 페이지라면 있어야 할 서지 표시가 없음)."""
    title = page_title(page).lower()
    if re.search(r"just a moment|attention required|captcha|robot|access denied|are you human|verify|security check|"
                 r"cookies? (?:not supported|required)|bot", title):
        return True
    # 제목으로 알 수 없으면: 서지 표시가 하나도 없고, 작은 페이지가 자바스크립트·쿠키를 요구하면 확인 페이지로 본다
    low = page.lower()
    return ("citation_" not in low and "dc.title" not in low and len(page) < 40_000
            and bool(re.search(r"enable javascript|javascript is (?:disabled|required)|enable cookies|challenge", low)))


class Blocked(Exception):
    """출판사가 사람 확인 페이지로 자동 내려받기를 막음."""


def page_title(page):
    m = re.search(r"<title[^>]*>(.*?)</title>", page or "", re.I | re.S)
    return clean_text(html.unescape(m.group(1)))[:80] if m else ""


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
            # 한글 제목은 KCI(키가 있을 때)를 먼저, 그다음 Crossref
            searchers = [("Crossref", crossref_search)]
            if KCI_KEY:
                kci = ("KCI", kci_search)
                searchers = [kci] + searchers if any(is_hangul(q) for q in queries) else searchers + [kci]
            for name, search in searchers:
                for q in queries:
                    try:
                        results = search(q)
                    except Exception as e:
                        log(f"{name} 검색 실패: {e}")
                        break
                    for rec in results:
                        if any(t and (title_in_text(t, text_key) or similarity(t, q) >= 0.9)
                               for t in (rec["title"], rec.get("title_alt"))):
                            record = rec
                            break
                    if record:
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
        head = clean_text(pdf["head"])[:3000]
        if re.search(r"(?i)\b(dissertation|doctoral thesis|master'?s thesis|ph\.?\s?d\.? thesis|thesis submitted|"
                     r"in partial fulfil+ment)\b|학위\s*논문|석사\s*학위|박사\s*학위", head):
            record["type"] = "dissertation"
        elif isbns or pdf["page_count"] >= 120:
            record["type"] = "book"
        else:
            # 첫 페이지 표현으로 학술대회 논문·보고서를 짐작
            if re.search(r"(?i)\b(proceedings of|conference on|symposium on|workshop on)\b|학술대회|학술발표", head):
                record["type"] = "proceedings-article"
            elif re.search(r"(?i)\b(technical report|tech\. rep\.|research report|working paper|white paper)\b"
                           r"|연구\s*보고서|보고서", head):
                record["type"] = "report"

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


# ---------------------------------------------------------------- 내 정리 자료의 글

OFFICE_PARTS = {
    ".docx": [r"word/document\.xml", r"word/(footnotes|endnotes|comments)\.xml"],
    ".pptx": [r"ppt/slides/slide\d+\.xml", r"ppt/notesSlides/notesSlide\d+\.xml"],
    ".xlsx": [r"xl/sharedStrings\.xml"],
    ".hwpx": [r"Contents/section\d+\.xml"],
    ".odt": [r"content\.xml"], ".odp": [r"content\.xml"], ".ods": [r"content\.xml"],
}
PLAIN_EXTS = {".txt", ".md", ".markdown", ".csv", ".tex", ".bib", ".rtf", ".json"}


def extract_any_text(path, limit=MAX_FULLTEXT_CHARS):
    """정리 파일(Word·PowerPoint·Excel·한글 hwpx·텍스트·PDF)에서 검색용 글을 뽑는다. 못 읽으면 빈 글."""
    import zipfile
    p = str(path)
    ext = os.path.splitext(p)[1].lower()
    try:
        if ext == ".pdf":
            return read_pdf(p)["full"][:limit]
        if ext in PLAIN_EXTS:
            raw = open(p, "rb").read(limit * 4)
            for enc in ("utf-8", "cp949", "latin-1"):
                try:
                    return clean_text(raw.decode(enc))[:limit]
                except UnicodeDecodeError:
                    continue
        if ext in OFFICE_PARTS:
            out = []
            with zipfile.ZipFile(p) as z:
                names = sorted(z.namelist(), key=lambda n: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", n)])
                for name in names:
                    if any(re.fullmatch(pat, name) for pat in OFFICE_PARTS[ext]):
                        xml = z.read(name).decode("utf-8", "ignore")
                        xml = re.sub(r"</(a:p|w:p|hp:p|text:p|si)>", "\n", xml)  # 문단 끝은 줄바꿈
                        out.append(html.unescape(re.sub(r"<[^>]+>", " ", xml)))
                        if sum(map(len, out)) > limit:
                            break
            return clean_text("\n".join(out))[:limit]
    except Exception:
        return ""
    return ""


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
    is_report = t.startswith("report")
    is_thesis = t in ("dissertation", "thesis")
    school = p.get("journal") or p.get("publisher") or ""  # 학위논문의 학교
    # 학술대회 논문은 '책의 장'과 같은 꼴: In 논문집 이름 (pp.)
    is_chapter = t == "book-chapter" or t.startswith("proceedings")
    report_no = p.get("issue") or p.get("volume") or ""
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
    elif is_thesis:
        # Author (Year). Title [Doctoral dissertation, School]. URL
        apa = f"{apa_authors} ({year}). {title}" + (f" [Doctoral dissertation, {school}]" if school else " [Doctoral dissertation]") + "."
        journal = vol = ""
    elif is_report:
        # Author (Year). Title (Report No. 12). 발행 기관. URL
        institution = publisher or journal
        apa = f"{apa_authors} ({year}). {title}" + (f" (Report No. {report_no})" if report_no else "") + "."
        if institution:
            apa += f" {institution}."
        journal = vol = ""
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
    elif is_thesis:
        mla = (f"{mla_auth}. " if mla_auth else "") + f"{title}. {year}."
        mla += f" {school}, PhD dissertation." if school else " PhD dissertation."
    elif is_report:
        mla = (f"{mla_auth}. " if mla_auth else "") + f"{title}."
        mla += " " + ", ".join(x for x in (publisher or p.get("journal"), str(year)) if x) + "."
        if report_no:
            mla += f" Report no. {report_no}."
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
    elif t.startswith("report"):
        kind = "techreport"
    elif t in ("dissertation", "thesis"):
        kind = "phdthesis"
    fields = [("title", "{" + esc(p.get("title", "")) + "}")]
    authors = " and ".join(
        ", ".join(x for x in (a.get("family"), a.get("given")) if x) for a in (p.get("authors") or []))
    if authors:
        fields.append(("editor" if t == "edited-book" else "author", esc(authors)))
    venue_key = "booktitle" if kind in ("inproceedings", "incollection") else "journal"
    publisher_key = "publisher"
    if kind in ("techreport", "phdthesis"):
        # 보고서·학위논문은 발행 기관(institution / school)
        venue_key = "type" if kind == "techreport" else "school"
        publisher_key = "institution" if kind == "techreport" else "publisher"
    venue, publisher = p.get("journal"), p.get("publisher")
    if kind == "phdthesis" and not venue:
        venue, publisher = publisher, None  # 학교를 출판사 칸에 적은 경우
    for key, val in ((venue_key, venue), ("year", p.get("year")), ("volume", p.get("volume")),
                     ("number", p.get("issue")), ("pages", (p.get("pages") or "").replace("-", "--")),
                     (publisher_key, publisher), ("edition", p.get("edition")),
                     ("isbn", p.get("isbn")), ("doi", p.get("doi")),
                     ("eprint", p.get("arxiv_id")), ("url", p.get("url"))):
        if val:
            fields.append((key, esc(val)))
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields)
    return f"@{kind}{{{bibtex_key(p)},\n{body}\n}}"
