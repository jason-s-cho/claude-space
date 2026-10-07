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

    first = pages[0] if pages else ""
    head = "\n".join(pages[:2])
    full = clean_text("\n".join(pages))[:MAX_FULLTEXT_CHARS]
    return {"first": first, "head": head, "full": full, "info": info,
            "title_guess": title_guess, "page_count": len(reader.pages)}


BAD_TITLE_WORDS = {"article", "research article", "original article", "review", "letter",
                   "open access", "contents lists available at sciencedirect", "abstract",
                   "research paper", "original research", "journal of", "proceedings"}


def guess_title_from_chunks(chunks):
    """첫 페이지에서 가장 큰 글씨로 쓰인 문장을 제목으로 본다."""
    sizes = {}
    order = {}
    for idx, (size, text) in enumerate(chunks):
        if size <= 0:
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
    for a in m.get("author", []) or []:
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
        "type": kind,
        "source": "crossref",
    }


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
            "arxiv_id": "", "source": "pdf"}


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


def extract(path, filename="", online=True, log=None):
    """경로의 PDF를 읽어 서지 정보 dict 를 돌려준다. 'fulltext', 'needs_review' 포함."""
    log = log or (lambda *a: None)
    pdf = read_pdf(path)
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

        # 2) arXiv
        if record is None:
            arxiv_id = find_arxiv_id(pdf, filename)
            if arxiv_id:
                try:
                    record = arxiv_by_id(arxiv_id)
                except Exception as e:
                    log(f"arXiv 조회 실패 {arxiv_id}: {e}")

        # 3) 제목으로 Crossref 검색
        if record is None:
            queries = []
            for cand in (pdf["title_guess"], pdf["info"].get("title", "")):
                if plausible_title(cand) and cand not in queries:
                    queries.append(cand)
            if not queries and pdf["first"]:
                queries.append(clean_text(pdf["first"])[:300])
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

    record.setdefault("arxiv_id", "")
    record["fulltext"] = pdf["full"]
    record["needs_review"] = needs_review
    if not record.get("abstract"):
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
    apa = f"{apa_authors} ({year}). {title}."
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
    mla = (f"{mla_auth}. " if mla_auth else "") + f"“{title}.”"
    parts = [journal] if journal else []
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
    elif t in ("book", "monograph"):
        kind = "book"
    elif t in ("book-chapter",):
        kind = "incollection"
    elif t in ("preprint", "posted-content"):
        kind = "misc"
    fields = [("title", "{" + esc(p.get("title", "")) + "}")]
    authors = " and ".join(
        ", ".join(x for x in (a.get("family"), a.get("given")) if x) for a in (p.get("authors") or []))
    if authors:
        fields.append(("author", esc(authors)))
    venue_key = "booktitle" if kind in ("inproceedings", "incollection") else "journal"
    for key, val in ((venue_key, p.get("journal")), ("year", p.get("year")), ("volume", p.get("volume")),
                     ("number", p.get("issue")), ("pages", (p.get("pages") or "").replace("-", "--")),
                     ("publisher", p.get("publisher")), ("doi", p.get("doi")),
                     ("eprint", p.get("arxiv_id")), ("url", p.get("url"))):
        if val:
            fields.append((key, esc(val)))
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields)
    return f"@{kind}{{{bibtex_key(p)},\n{body}\n}}"
