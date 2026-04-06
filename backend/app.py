"""
Papertrail — Flask backend
Storage: JSON files (data/cases/{id}.json, data/papers/{sha256}/meta.json + paper.pdf)
Papers are cross-case and deduplicated by SHA-256 hash.
"""
import os
import re
import time
import json
import hashlib
import difflib
import threading
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

import bibtexparser
from bibtexparser.bparser import BibTexParser
from bibtexparser.bwriter import BibTexWriter
from bibtexparser.customization import convert_to_unicode

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename

try:
    import fitz
except ImportError:
    import pymupdf as fitz

try:
    import gutenscrape as _gutenscrape
    GUTENSCRAPE_AVAILABLE = True
except ImportError:
    _gutenscrape = None
    GUTENSCRAPE_AVAILABLE = False


app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB

BASE_DIR   = Path(__file__).parent
DATA_DIR   = BASE_DIR / "data"
PAPERS_DIR = DATA_DIR / "papers"
CASES_DIR  = DATA_DIR / "cases"

DATA_DIR.mkdir(exist_ok=True)
PAPERS_DIR.mkdir(exist_ok=True)
CASES_DIR.mkdir(exist_ok=True)

COUNTERS_FILE    = DATA_DIR / "_counters.json"
PAPER_INDEX_FILE = DATA_DIR / "_paper_index.json"  # {paper_id: sha256}
SYSTEM_BIB_CACHE = BASE_DIR / "system_bibtex_cache.json"

SYSTEM_BIB_URLS = [
    "https://raw.githubusercontent.com/TUBS-ISF/BibTags/refs/heads/main/literature/MYabrv.bib",
    "https://raw.githubusercontent.com/TUBS-ISF/BibTags/refs/heads/main/literature/literature.bib",
]
_system_bib_entries: list[dict] = []
_system_bib_last_update: float | None = None

# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

_store_lock = threading.RLock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _atomic_write(path: Path, text: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _json_write(path: Path, obj):
    _atomic_write(path, json.dumps(obj, indent=2, ensure_ascii=False))


def _json_read(path: Path) -> dict | list | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


# ── Counters ──────────────────────────────────────────────────────────────

def _load_counters() -> dict:
    c = _json_read(COUNTERS_FILE) or {}
    for k in ("case", "paper", "connection", "postit", "bib_file", "bib_entry"):
        c.setdefault(k, 0)
    return c


def _next_id(key: str) -> int:
    with _store_lock:
        c = _load_counters()
        c[key] += 1
        _json_write(COUNTERS_FILE, c)
        return c[key]


# ── Paper index (paper_id → sha256) ──────────────────────────────────────

def _load_paper_index() -> dict:
    return _json_read(PAPER_INDEX_FILE) or {}


def _register_paper(paper_id: int, sha: str):
    with _store_lock:
        idx = _load_paper_index()
        idx[str(paper_id)] = sha
        _json_write(PAPER_INDEX_FILE, idx)


def _hash_for_id(paper_id: int) -> str | None:
    return _load_paper_index().get(str(paper_id))


# ── Paper file storage ────────────────────────────────────────────────────

def _paper_dir(sha: str) -> Path:
    return PAPERS_DIR / sha


def _paper_pdf_path(sha: str) -> Path:
    return _paper_dir(sha) / "paper.pdf"


def _paper_meta_path(sha: str) -> Path:
    return _paper_dir(sha) / "meta.json"


def _load_paper_meta(sha: str) -> dict | None:
    return _json_read(_paper_meta_path(sha))


def _save_paper_meta(meta: dict):
    d = _paper_dir(meta["hash"])
    d.mkdir(exist_ok=True)
    _json_write(_paper_meta_path(meta["hash"]), meta)


def _sha256_path(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ── Case storage ──────────────────────────────────────────────────────────

def _case_path(case_id: int) -> Path:
    return CASES_DIR / f"{case_id}.json"


def _load_case(case_id: int) -> dict | None:
    return _json_read(_case_path(case_id))


def _save_case(case: dict):
    with _store_lock:
        _json_write(_case_path(case["id"]), case)


def _list_cases() -> list[dict]:
    cases = []
    for p in CASES_DIR.glob("*.json"):
        try:
            c = json.loads(p.read_text(encoding="utf-8"))
            cases.append({"id": c["id"], "name": c["name"], "created_at": c["created_at"]})
        except Exception:
            pass
    cases.sort(key=lambda c: c.get("created_at", ""), reverse=True)
    return cases


# ── Response builders ─────────────────────────────────────────────────────

def _paper_response(case_paper: dict) -> dict:
    """Merge global paper meta with case-local x/y/id."""
    sha  = case_paper["hash"]
    meta = _load_paper_meta(sha) or {}
    return {
        "id":         case_paper["id"],
        "case_id":    case_paper.get("case_id"),
        "hash":       sha,
        "title":      meta.get("title", ""),
        "authors":    meta.get("authors", ""),
        "year":       meta.get("year", ""),
        "abstract":   meta.get("abstract", ""),
        "bibtex_key": meta.get("bibtex_key", ""),
        "venue":      meta.get("venue", ""),
        "bibtex_raw": meta.get("bibtex_raw", ""),
        "x":          case_paper.get("x", 150),
        "y":          case_paper.get("y", 150),
        "created_at": case_paper.get("created_at", ""),
    }


def _case_response(case: dict) -> dict:
    result = {k: v for k, v in case.items() if k != "papers"}
    result["papers"] = [_paper_response(cp) for cp in case.get("papers", [])]
    return result


def _find_case_paper(case: dict, paper_id: int) -> dict | None:
    return next((p for p in case.get("papers", []) if p["id"] == paper_id), None)


# ---------------------------------------------------------------------------
# SQLite migration (runs once if old DB exists)
# ---------------------------------------------------------------------------

def _migrate_from_sqlite():
    old_db = BASE_DIR / "charlies_thread.db"
    done_flag = DATA_DIR / "_migrated.flag"
    if done_flag.exists() or not old_db.exists():
        return

    print("[migrate] Migrating from SQLite → JSON files…")
    import sqlite3
    conn = sqlite3.connect(str(old_db))
    conn.row_factory = sqlite3.Row

    def rows(sql, *args):
        return [dict(r) for r in conn.execute(sql, args).fetchall()]

    # Track highest IDs for counters
    max_case = max_paper = max_conn = max_postit = max_bib_file = max_bib_entry = 0

    for case_row in rows("SELECT * FROM cases ORDER BY id"):
        case_id = case_row["id"]
        max_case = max(max_case, case_id)

        old_papers = rows("SELECT * FROM papers WHERE case_id=?", case_id)
        old_conns  = rows("SELECT * FROM connections WHERE case_id=?", case_id)
        old_posts  = rows("SELECT * FROM postits WHERE case_id=?", case_id)
        old_bibs   = rows("SELECT * FROM bibtex_files WHERE case_id=?", case_id)

        case_papers = []
        for p in old_papers:
            max_paper = max(max_paper, p["id"])
            old_path = BASE_DIR / "papers" / p["filename"]
            if old_path.exists():
                sha = _sha256_path(old_path)
            else:
                sha = hashlib.sha256(p["filename"].encode()).hexdigest()

            # Save PDF to new location
            new_pdf = _paper_pdf_path(sha)
            if not new_pdf.exists():
                _paper_dir(sha).mkdir(exist_ok=True)
                if old_path.exists():
                    import shutil
                    shutil.copy2(str(old_path), str(new_pdf))

            # Load/create meta
            meta = _load_paper_meta(sha)
            if meta is None:
                # Extract refs from old table
                refs = [r["ref_text"] for r in rows(
                    "SELECT ref_text FROM paper_refs WHERE paper_id=?", p["id"]
                )]
                meta = {
                    "id":         p["id"],
                    "hash":       sha,
                    "title":      p.get("title", ""),
                    "authors":    p.get("authors", ""),
                    "year":       p.get("year", ""),
                    "abstract":   p.get("abstract", ""),
                    "bibtex_key": p.get("bibtex_key", ""),
                    "venue":      p.get("venue", ""),
                    "bibtex_raw": p.get("bibtex_raw", ""),
                    "refs":       refs,
                }
                _save_paper_meta(meta)
            _register_paper(p["id"], sha)

            case_papers.append({
                "id":         p["id"],
                "hash":       sha,
                "case_id":    case_id,
                "x":          p.get("x", 150),
                "y":          p.get("y", 150),
                "created_at": p.get("created_at", _now_iso()),
            })

        for c in old_conns:
            max_conn = max(max_conn, c["id"])
        for po in old_posts:
            max_postit = max(max_postit, po["id"])

        # Build bibtex files with embedded entries
        bib_files = []
        for bf in old_bibs:
            max_bib_file = max(max_bib_file, bf["id"])
            entries = rows("SELECT * FROM bibtex_entries WHERE file_id=?", bf["id"])
            for e in entries:
                max_bib_entry = max(max_bib_entry, e["id"])
            bib_files.append({
                "id":         bf["id"],
                "case_id":    case_id,
                "filename":   bf["filename"],
                "raw_text":   bf.get("raw_text", ""),
                "created_at": bf.get("created_at", _now_iso()),
                "entries":    [dict(e) for e in entries],
            })

        case_json = {
            "id":           case_id,
            "name":         case_row["name"],
            "created_at":   case_row.get("created_at", _now_iso()),
            "papers":       case_papers,
            "connections":  [dict(c) for c in old_conns],
            "postits":      [dict(po) for po in old_posts],
            "bibtex_files": bib_files,
        }
        _save_case(case_json)
        print(f"[migrate]  Case {case_id}: {len(case_papers)} papers, {len(old_conns)} connections")

    conn.close()

    # Write counters based on migrated data
    c = _load_counters()
    c["case"]      = max(c.get("case", 0), max_case)
    c["paper"]     = max(c.get("paper", 0), max_paper)
    c["connection"]= max(c.get("connection", 0), max_conn)
    c["postit"]    = max(c.get("postit", 0), max_postit)
    c["bib_file"]  = max(c.get("bib_file", 0), max_bib_file)
    c["bib_entry"] = max(c.get("bib_entry", 0), max_bib_entry)
    _json_write(COUNTERS_FILE, c)

    done_flag.write_text("migrated")
    print("[migrate] Done.")


_migrate_from_sqlite()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize(text: str) -> str:
    return re.sub(r"[^\w\s]", "", text.lower()).strip()



# ---------------------------------------------------------------------------
# PDF utilities
# ---------------------------------------------------------------------------

def extract_metadata(pdf_path: Path) -> dict:
    doc  = fitz.open(str(pdf_path))
    meta = doc.metadata or {}

    title   = meta.get("title", "").strip()
    authors = meta.get("author", "").strip()

    if len(doc) == 0:
        doc.close()
        return {"title": pdf_path.stem, "authors": "", "year": "", "abstract": ""}

    # Always run visual extraction — PDF metadata titles often truncate at
    # punctuation (e.g. "?" or ":"), dropping the subtitle entirely.
    visual_title = ""
    try:
        page_dict = doc[0].get_text("dict", flags=0)
        page_h    = doc[0].rect.height
        spans = []
        for block in page_dict.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    t = span.get("text", "").strip()
                    if len(t) < 3:
                        continue
                    spans.append({
                        "text": t,
                        "size": span.get("size", 0),
                        "y":    span["bbox"][1],
                        "x":    span["bbox"][0],
                    })
        top_spans = [s for s in spans if s["y"] < page_h * 0.55]
        if top_spans:
            max_size = max(s["size"] for s in top_spans)
            title_spans = sorted(
                [s for s in top_spans if s["size"] >= max_size * 0.88],
                key=lambda s: (round(s["y"] / 4), s["x"]),
            )
            if title_spans:
                visual_title = " ".join(s["text"] for s in title_spans)
                visual_title = re.sub(r"\s+", " ", visual_title).strip()[:250]
    except Exception:
        pass

    if not title:
        title = visual_title
    elif visual_title and visual_title.startswith(title) and len(visual_title) > len(title):
        # Visual extraction found the subtitle that metadata dropped
        title = visual_title

    full_text = "".join(doc[i].get_text() for i in range(min(5, len(doc))))
    year_m    = re.search(r"\b(19|20)\d{2}\b", full_text)
    year      = year_m.group(0) if year_m else ""

    abstract = ""
    for pattern in [
        r"(?i)\bAbstract\b[\s\n:—\-]+\s*(.*?)(?:\n\s*\n|\n[ \t]*(?:1[\s.]|Introduction\b|Keywords\b))",
        r"(?i)\bAbstract\b[\s\n:—\-]+\s*(.*?)(?:\n{2,})",
        r"(?i)\bAbstract\b[.\s]+(.*)",
    ]:
        m = re.search(pattern, full_text, re.DOTALL)
        if m:
            abstract = re.sub(r"\s+", " ", m.group(1)).strip()[:2000]
            break

    doc.close()
    return {"title": title or pdf_path.stem, "authors": authors, "year": year, "abstract": abstract}


def extract_references(pdf_path: Path) -> list[str]:
    doc       = fitz.open(str(pdf_path))
    full_text = "".join(page.get_text() for page in doc)
    doc.close()

    ref_m = re.search(
        r"(?im)^[ \t]*(?:references|bibliography|works cited)[ \t]*$(.*)$",
        full_text, re.DOTALL,
    )
    if not ref_m:
        return []

    ref_text = ref_m.group(1)
    parts    = re.split(r"\n[ \t]*(?:\[\d+\]|\d{1,3}\.|\(\d+\))[ \t]+", ref_text)
    return [p.strip().replace("\n", " ") for p in parts if len(p.strip()) > 20][:200]


def _match_refs_to_papers(refs: list, candidates: list[dict]) -> list[tuple[int, str]]:
    """
    Match refs against candidate papers (papers already in case/store).
    Returns [(paper_id, 'strong'|'weak'), …], deduped (strongest wins).

    With enriched refs (dict with bibtex_key/doi) uses O(1) index lookups.
    Falls back to title SequenceMatcher for legacy string refs.
    """
    # Build candidate indices
    cand_doi_idx: dict[str, int] = {
        cp["doi"].strip().lower(): cp["id"] for cp in candidates if cp.get("doi")
    }
    cand_bib_idx: dict[str, int] = {
        cp["bibtex_key"]: cp["id"] for cp in candidates if cp.get("bibtex_key")
    }

    best: dict[int, str] = {}

    def _record(pid, strength):
        if pid is not None and best.get(pid) != "strong":
            best[pid] = strength

    for ref in refs:
        r = _ref_as_dict(ref)

        # 1. DOI match
        doi = (r.get("doi") or "").strip().lower()
        if doi and doi in cand_doi_idx:
            _record(cand_doi_idx[doi], "strong")
            continue

        # 2. Bibtex key match
        bk = r.get("bibtex_key")
        if bk and bk in cand_bib_idx:
            _record(cand_bib_idx[bk], "strong")
            continue

        # 3. Title similarity fallback
        t_norm = _normalize(r.get("title") or "")
        if len(t_norm) < 8:
            continue
        best_s, best_id = 0.0, None
        t_tokens = set(t_norm.split())
        for cp in candidates:
            pt = _normalize(cp.get("title", ""))
            if len(pt) < 8:
                continue
            if len(t_tokens & set(pt.split())) / max(len(t_tokens), 1) < 0.4:
                continue
            if pt == t_norm:
                best_s, best_id = 1.0, cp["id"]
                break
            s = difflib.SequenceMatcher(None, t_norm, pt).ratio()
            if s > best_s:
                best_s, best_id = s, cp["id"]
        if best_id and best_s >= 0.88:
            _record(best_id, "weak")

    return list(best.items())


_DOI_IN_REF_RE = re.compile(r"\b(10\.\d{4,}/[^\s,;>\"']+)")


def _ref_as_dict(r) -> dict:
    """Normalise a ref that may be either a legacy string or an enriched dict."""
    if isinstance(r, str):
        return {"text": r, "title": _extract_search_term(r)}
    return r


def _enrich_refs(raw_refs: list[str]) -> list[dict]:
    """
    Enrich raw reference strings with bibtex metadata (one-time cost at upload).

    For each ref, attempts in order:
      1. DOI extracted from ref text  → bib doi lookup   (exact, strong)
      2. Exact normalised title match → bib title lookup  (exact, strong)
      3. Fuzzy title match            → SequenceMatcher ≥ 0.85 (fuzzy, strong)

    Returns list[dict] with keys: text, title, bibtex_key, doi, authors, year.
    Unmatched refs carry only text/title (and doi if found in raw text).
    """
    # Build lookup indices once
    bib_doi_idx:   dict[str, dict] = {}
    bib_title_idx: dict[str, dict] = {}
    for e in _system_bib_entries:
        if e.get("doi"):
            bib_doi_idx[e["doi"].strip().lower()] = e
        t = _normalize(e.get("title", ""))
        if t:
            bib_title_idx[t] = e

    result = []
    for raw in raw_refs:
        raw_norm = _normalize(raw)

        # DOI in raw text
        doi_m         = _DOI_IN_REF_RE.search(raw)
        extracted_doi = doi_m.group(1).rstrip(".") if doi_m else None

        matched: dict | None = None

        # 1. DOI → bib (exact)
        if extracted_doi:
            matched = bib_doi_idx.get(extracted_doi.lower())

        # 2. Bib title as substring of ref text — robust against any author/year format
        if matched is None:
            best_len = 0
            for e in _system_bib_entries:
                et = _normalize(e.get("title", ""))
                if len(et) < 8:
                    continue
                if et in raw_norm and len(et) > best_len:
                    best_len = len(et)
                    matched = e

        # 3. Fuzzy fallback — catches OCR noise or slight title deviations
        if matched is None:
            extracted_title = _extract_search_term(raw)
            t_norm = _normalize(extracted_title)
            if len(t_norm) >= 8:
                best_s, best_e = 0.0, None
                t_tokens = set(t_norm.split())
                for e in _system_bib_entries:
                    et = _normalize(e.get("title", ""))
                    if len(et) < 8:
                        continue
                    if len(t_tokens & set(et.split())) / max(len(t_tokens), 1) < 0.5:
                        continue
                    s = difflib.SequenceMatcher(None, t_norm, et).ratio()
                    if s > best_s:
                        best_s, best_e = s, e
                if best_e and best_s >= 0.85:
                    matched = best_e

        if matched:
            bib_doi = (matched.get("doi") or "").strip() or None
            result.append({
                "text":       raw,
                "title":      matched.get("title") or _extract_search_term(raw),
                "bibtex_key": matched.get("key") or None,
                "doi":        bib_doi or extracted_doi,
                "authors":    matched.get("authors", ""),
                "year":       matched.get("year", ""),
            })
        else:
            result.append({
                "text":  raw,
                "title": _extract_search_term(raw),
                "doi":   extracted_doi,
            })

    return result


def _compute_refs_matched(refs: list) -> list[dict]:
    """
    Match refs against the global paper store. Always computed fresh.

    With enriched refs (dict with bibtex_key/doi) matching is O(1) via index
    lookup. Falls back to title similarity only for legacy string refs or refs
    that didn't hit the bibtex store at upload time.
    """
    store: list[dict] = []
    for d in PAPERS_DIR.iterdir():
        if not d.is_dir():
            continue
        m = _json_read(d / "meta.json")
        if m and m.get("hash"):
            store.append(m)

    # O(1) store indices
    store_doi_idx: dict[str, dict] = {
        sp["doi"].strip().lower(): sp for sp in store if sp.get("doi")
    }
    store_bib_idx: dict[str, dict] = {
        sp["bibtex_key"]: sp for sp in store if sp.get("bibtex_key")
    }

    result = []
    for ref in refs:
        r           = _ref_as_dict(ref)
        matched_sha: str | None = None
        strength:    str | None = None

        # 1. DOI exact match
        doi = (r.get("doi") or "").strip().lower()
        if doi:
            sp = store_doi_idx.get(doi)
            if sp:
                matched_sha = sp["hash"]
                strength    = "strong"

        # 2. Bibtex key match
        if matched_sha is None and r.get("bibtex_key"):
            sp = store_bib_idx.get(r["bibtex_key"])
            if sp:
                matched_sha = sp["hash"]
                strength    = "strong"

        # 3. Title similarity fallback (legacy refs or unmatched)
        if matched_sha is None:
            t_norm = _normalize(r.get("title") or "")
            if len(t_norm) >= 8:
                best_s, best_sp = 0.0, None
                t_tokens = set(t_norm.split())
                for sp in store:
                    pt = _normalize(sp.get("title", ""))
                    if len(pt) < 8:
                        continue
                    if len(t_tokens & set(pt.split())) / max(len(t_tokens), 1) < 0.4:
                        continue
                    if pt == t_norm:
                        best_s, best_sp = 1.0, sp
                        break
                    s = difflib.SequenceMatcher(None, t_norm, pt).ratio()
                    if s > best_s:
                        best_s, best_sp = s, sp
                if best_sp and best_s >= 0.88:
                    matched_sha = best_sp["hash"]
                    strength    = "weak"

        result.append({
            "text":        r.get("text", ""),
            "title":       r.get("title"),
            "doi":         r.get("doi"),
            # extract: bibtex title when matched (authoritative), else raw extraction
            "extract":     r.get("title") or (_extract_search_term(r.get("text", "")) if r.get("text") else None),
            "matched_sha": matched_sha,
            "strength":    strength,
        })
    return result


# ---------------------------------------------------------------------------
# Reference → search term extraction
# ---------------------------------------------------------------------------

def _extract_search_term(ref: str) -> str:
    """
    Extract the shortest clean search term (ideally just the title) from a
    full reference string so that gutenscrape / ACM search doesn't time out.

    Handles the three most common reference formats:
      IEEE:  A. Author et al., "Title of Paper," Venue, Year, pp. …
      ACM:   Authors. Year. Title of Paper. In Venue …
      Plain: [N] Authors. Title. Venue, Year.
    """
    # ── IEEE: title in double-quotes ──────────────────────────────────────
    m = re.search(r'"([^"]{8,150})"', ref)
    if m:
        return m.group(1).strip().rstrip(",.")

    # ── ACM / numbered style: "…year[.,] Title. In/Proc/ACM/IEEE …" ──────
    # Match: optional bracket/number prefix, authors, year, TITLE, venue-start
    m = re.search(
        r'\b(?:19|20)\d{2}[.,]\s+'          # year followed by separator
        r'(.+?)'                              # TITLE (captured)
        r'(?:\.\s+(?:In\b|Proc\.?\b|ACM\b|IEEE\b|Journal\b|Chapter\b|'
        r'Springer\b|LNCS\b|Lecture\b|arXiv\b)|'
        r'\.\s*$)',                           # or end of string after period
        ref
    )
    if m:
        title = m.group(1).strip().rstrip(".,")
        if 8 < len(title) < 200:
            return title

    # ── Fallback: strip leading author block (up to first ". ") and take ──
    # the next sentence as the title, capped at 120 chars.
    # Many refs look like: "Authors. Title. Venue." or "[N] Authors, Title, venue"
    parts = re.split(r'\.\s+', ref, maxsplit=2)
    # parts[0] is usually authors, parts[1] could be year or title
    for part in parts[1:]:
        part = part.strip()
        if 8 < len(part) < 200 and not re.match(r'^(?:19|20)\d{2}$', part):
            return part[:120]

    # Last resort: just cap the raw ref
    return ref[:100]


# ---------------------------------------------------------------------------
# BibTeX parser (bibtexparser v1)
# ---------------------------------------------------------------------------

def _make_parser(common_strings: dict | None = None) -> BibTexParser:
    parser = BibTexParser(common_strings=True)
    parser.customization = convert_to_unicode
    parser.ignore_nonstandard_types = False
    if common_strings:
        parser.bib_database.strings.update(common_strings)
    return parser


_bib_writer = BibTexWriter()
_bib_writer.indent = "  "
_bib_writer.display_order = ["title", "author", "year", "booktitle", "journal", "doi"]

def parse_bibtex(text: str, common_strings: dict | None = None) -> list[dict]:
    parser = _make_parser(common_strings)
    db     = bibtexparser.loads(text, parser)
    results = []
    for e in db.entries:
        single = bibtexparser.bibdatabase.BibDatabase()
        single.entries = [e]
        raw = _bib_writer.write(single).strip()
        results.append({
            "key":      e.get("ID", ""),
            "type":     e.get("ENTRYTYPE", "article"),
            "title":    e.get("title", ""),
            "authors":  e.get("author", ""),
            "year":     e.get("year", ""),
            "abstract": e.get("abstract", "")[:2000],
            "doi":      e.get("doi", ""),
            "journal":  e.get("journal", e.get("booktitle", "")),
            "raw":      raw,
        })
    return results


def auto_match_bibtex_entries(entries: list[dict], papers: list[dict]) -> dict[str, int]:
    result = {}
    for entry in entries:
        t = _normalize(entry.get("title", ""))
        if len(t) < 10:
            continue
        best_score = 0.0
        best_id    = None
        for paper in papers:
            pt = _normalize(paper["title"])
            if t == pt:
                best_id    = paper["id"]
                best_score = 1.0
                break
            score = difflib.SequenceMatcher(None, t, pt).ratio()
            if score > best_score:
                best_score = score
                best_id    = paper["id"]
        if best_id and best_score >= 0.82:
            result[entry["key"]] = best_id
    return result


# ---------------------------------------------------------------------------
# System BibTeX (TUBS-ISF/BibTags)
# ---------------------------------------------------------------------------

def _load_system_bibtex_cache():
    global _system_bib_entries, _system_bib_last_update
    if not SYSTEM_BIB_CACHE.exists():
        return
    try:
        data = json.loads(SYSTEM_BIB_CACHE.read_text(encoding="utf-8"))
        _system_bib_entries   = data.get("entries", [])
        _system_bib_last_update = data.get("ts")
        print(f"[bibtex] Loaded {len(_system_bib_entries)} entries from cache")
    except Exception as e:
        print(f"[bibtex] Cache load failed: {e}")


def _fetch_url(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "papertrail/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def _reenrich_case_papers(case_id: int):
    """Re-enrich refs and re-apply bibtex metadata for papers in a case.

    Runs in background on case load so papers uploaded before bibtex was
    available get their refs and doi/bibtex_key fixed without global scans.
    """
    case = _load_case(case_id)
    if not case:
        return
    updated = 0
    for cp in case.get("papers", []):
        sha = cp.get("hash")
        if not sha:
            continue
        meta = _load_paper_meta(sha)
        if not meta:
            continue
        changed = False
        # Re-apply bibtex to the paper itself if bibtex_key not yet set
        if meta.get("title") and not meta.get("bibtex_key"):
            enriched = _apply_system_bib_to_paper(sha, meta["id"], meta["title"])
            if enriched:
                meta = enriched
                changed = True
        # Re-enrich refs (always, to pick up new bibtex entries)
        refs = meta.get("refs", [])
        if refs:
            raw_refs = [r if isinstance(r, str) else r.get("text", "") for r in refs]
            raw_refs = [r for r in raw_refs if r]
            meta["refs"] = _enrich_refs(raw_refs)
            changed = True
        if changed:
            _save_paper_meta(meta)
            updated += 1
    if updated:
        print(f"[bibtex] Re-enriched {updated} papers in case {case_id}")


def _fetch_system_bibtex():
    global _system_bib_entries, _system_bib_last_update
    all_entries   = []
    abrv_strings: dict = {}

    try:
        abrv_text   = _fetch_url(SYSTEM_BIB_URLS[0])
        abrv_parser = _make_parser()
        abrv_db     = bibtexparser.loads(abrv_text, abrv_parser)
        abrv_strings = abrv_db.strings
        print(f"[bibtex] {len(abrv_strings)} @string macros from MYabrv.bib")
    except Exception as e:
        print(f"[bibtex] MYabrv fetch failed: {e}")

    try:
        lit_text = _fetch_url(SYSTEM_BIB_URLS[1])
        parsed   = parse_bibtex(lit_text, common_strings=abrv_strings)
        all_entries.extend(parsed)
        print(f"[bibtex] {len(parsed)} entries from literature.bib")
    except Exception as e:
        print(f"[bibtex] literature.bib fetch failed: {e}")

    if all_entries:
        _system_bib_entries   = all_entries
        _system_bib_last_update = time.time()
        try:
            SYSTEM_BIB_CACHE.write_text(
                json.dumps({"ts": _system_bib_last_update, "entries": all_entries}, ensure_ascii=False),
                encoding="utf-8",
            )
            print(f"[bibtex] Cache saved ({len(all_entries)} entries)")
        except Exception as e:
            print(f"[bibtex] Cache write failed: {e}")


def _apply_system_bib_to_paper(sha: str, paper_id: int, paper_title: str) -> dict | None:
    if not _system_bib_entries:
        return None
    matches = auto_match_bibtex_entries(_system_bib_entries, [{"id": paper_id, "title": paper_title}])
    if not matches:
        return None
    entry_key = next(iter(matches))
    entry     = next((e for e in _system_bib_entries if e["key"] == entry_key), None)
    if not entry:
        return None

    meta = _load_paper_meta(sha) or {}
    if entry.get("title"):    meta["title"]      = entry["title"]
    if entry.get("authors"):  meta["authors"]    = entry["authors"]
    if entry.get("year"):     meta["year"]       = entry["year"]
    if entry.get("journal"):  meta["venue"]      = entry["journal"]
    if entry.get("abstract"): meta["abstract"]   = entry["abstract"]
    if entry.get("raw"):      meta["bibtex_raw"] = entry["raw"]
    if entry.get("doi"):      meta["doi"]        = entry["doi"]
    meta["bibtex_key"] = entry_key
    _save_paper_meta(meta)
    return meta


_load_system_bibtex_cache()
_BIBTEX_CACHE_MAX_AGE = 24 * 3600  # refresh if older than 1 day
_cache_age = (time.time() - _system_bib_last_update) if _system_bib_last_update else float("inf")
if not _system_bib_entries or _cache_age > _BIBTEX_CACHE_MAX_AGE:
    threading.Thread(target=_fetch_system_bibtex, daemon=True).start()


# ---------------------------------------------------------------------------
# Cases API
# ---------------------------------------------------------------------------

@app.get("/api/cases")
def list_cases():
    return jsonify(_list_cases())


@app.post("/api/cases")
def create_case():
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    if any(c["name"] == name for c in _list_cases()):
        return jsonify({"error": "case name already exists"}), 409

    case_id = _next_id("case")
    case    = {
        "id":           case_id,
        "name":         name,
        "created_at":   _now_iso(),
        "papers":       [],
        "connections":  [],
        "postits":      [],
        "bibtex_files": [],
    }
    _save_case(case)
    return jsonify({"id": case_id, "name": name, "created_at": case["created_at"]}), 201


@app.get("/api/cases/<int:case_id>")
def get_case(case_id):
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "not found"}), 404
    if _system_bib_entries:
        threading.Thread(target=_reenrich_case_papers, args=(case_id,),
                         daemon=True, name=f"reenrich-{case_id}").start()
    return jsonify(_case_response(case))


@app.delete("/api/cases/<int:case_id>")
def delete_case(case_id):
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "not found"}), 404
    # Remove PDFs only if no other case references the same hash
    all_hashes = set()
    for other_id_str in [p.stem for p in CASES_DIR.glob("*.json")]:
        try:
            oid = int(other_id_str)
        except ValueError:
            continue
        if oid == case_id:
            continue
        other = _load_case(oid)
        if other:
            all_hashes.update(cp["hash"] for cp in other.get("papers", []))

    for cp in case.get("papers", []):
        sha = cp["hash"]
        if sha not in all_hashes:
            pdf = _paper_pdf_path(sha)
            if pdf.exists():
                pdf.unlink()
            meta_p = _paper_meta_path(sha)
            if meta_p.exists():
                meta_p.unlink()
            d = _paper_dir(sha)
            try:
                d.rmdir()
            except OSError:
                pass

    _case_path(case_id).unlink(missing_ok=True)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Papers API
# ---------------------------------------------------------------------------

@app.post("/api/cases/<int:case_id>/papers")
def upload_paper(case_id):
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "case not found"}), 404
    if "file" not in request.files:
        return jsonify({"error": "file required"}), 400

    f = request.files["file"]
    if not f.filename.lower().endswith(".pdf"):
        return jsonify({"error": "PDF files only"}), 400

    # Save to temp, compute hash
    tmp_path = DATA_DIR / f"_upload_{int(time.time()*1000)}.pdf"
    f.save(str(tmp_path))
    sha = _sha256_path(tmp_path)

    # Check if this paper already exists globally
    existing_meta = _load_paper_meta(sha)

    if existing_meta is None:
        # New paper — move PDF and extract metadata
        _paper_dir(sha).mkdir(exist_ok=True)
        tmp_path.rename(_paper_pdf_path(sha))
        meta_raw  = extract_metadata(_paper_pdf_path(sha))
        paper_id  = _next_id("paper")
        paper_meta = {
            "id":         paper_id,
            "hash":       sha,
            "title":      meta_raw["title"],
            "authors":    meta_raw["authors"],
            "year":       meta_raw["year"],
            "abstract":   meta_raw["abstract"],
            "bibtex_key": "",
            "venue":      "",
            "bibtex_raw": "",
            "refs":       [],
        }
        _save_paper_meta(paper_meta)
        _register_paper(paper_id, sha)

        # Try auto-match bibtex
        enriched = _apply_system_bib_to_paper(sha, paper_id, meta_raw["title"])
        if enriched:
            paper_meta = enriched

        # Extract and bibtex-enrich references (one-time cost; enriched refs enable
        # O(1) store/connection matching and direct DOI downloads from the refs panel)
        raw_refs = extract_references(_paper_pdf_path(sha))
        if raw_refs:
            paper_meta["refs"] = _enrich_refs(raw_refs)
            _save_paper_meta(paper_meta)
    else:
        # Duplicate PDF — reuse existing paper
        tmp_path.unlink(missing_ok=True)
        paper_id   = existing_meta["id"]
        paper_meta = existing_meta

    # Add paper to case (even if paper already exists globally)
    # Place check-and-append inside lock to avoid duplicate nodes from races
    with _store_lock:
        # reload case to be safe
        case = _load_case(case_id) or case
        count = len(case.get("papers", []))
        x     = 160 + (count % 5) * 230
        y     = 140 + (count // 5) * 170

        # Check if this paper is already in this case
        if any(cp["hash"] == sha for cp in case.get("papers", [])):
            # Return the existing case-paper entry
            cp   = next(cp for cp in case["papers"] if cp["hash"] == sha)
            resp = _paper_response(cp)
            return jsonify({"paper": resp, "new_connections": []}), 200

        case_paper = {
            "id":         paper_id,
            "hash":       sha,
            "case_id":    case_id,
            "x":          x,
            "y":          y,
            "created_at": _now_iso(),
        }
        case.setdefault("papers", []).append(case_paper)
        _save_case(case)

    existing_papers = [_paper_response(cp) for cp in case["papers"] if cp["id"] != paper_id]
    new_connections = []

    def _make_conn(src, tgt, strength):
        return {
            "id":         _next_id("connection"),
            "case_id":    case_id,
            "source_id":  src,
            "target_id":  tgt,
            "color":      "#e63946" if strength == "strong" else "#9b59b6",
            "thickness":  2.0       if strength == "strong" else 1.5,
            "annotation": "",
            "created_at": _now_iso(),
        }

    def _try_add(src, tgt, strength):
        if any(c["source_id"] == src and c["target_id"] == tgt
               for c in case.get("connections", [])):
            return
        conn = _make_conn(src, tgt, strength)
        case.setdefault("connections", []).append(conn)
        new_connections.append(conn)

    # New paper's refs → cited existing papers
    for cited_id, strength in _match_refs_to_papers(paper_meta.get("refs", []), existing_papers):
        _try_add(paper_id, cited_id, strength)

    # Existing papers' refs → new paper
    for ep in existing_papers:
        ep_meta = _load_paper_meta(ep["hash"]) if ep.get("hash") else None
        if not ep_meta or not ep_meta.get("refs"):
            continue
        for _, strength in _match_refs_to_papers(ep_meta["refs"], [{"id": paper_id, **paper_meta}]):
            _try_add(ep["id"], paper_id, strength)

    _save_case(case)
    return jsonify({"paper": _paper_response(case_paper), "new_connections": new_connections}), 201


@app.get("/api/papers/<int:paper_id>/file")
def serve_paper(paper_id):
    sha = _hash_for_id(paper_id)
    if not sha:
        return jsonify({"error": "not found"}), 404
    pdf = _paper_pdf_path(sha)
    if not pdf.exists():
        return jsonify({"error": "file not found"}), 404
    response = send_file(str(pdf), mimetype="application/pdf")
    response.headers["Content-Disposition"] = "inline"
    return response


@app.get("/api/papers/<int:paper_id>/bibtex")
def get_paper_bibtex(paper_id):
    sha = _hash_for_id(paper_id)
    if not sha:
        return jsonify({"error": "not found"}), 404
    meta = _load_paper_meta(sha)
    if not meta:
        return jsonify({"error": "not found"}), 404
    raw = meta.get("bibtex_raw") or ""
    if not raw and meta.get("bibtex_key") and _system_bib_entries:
        entry = next((e for e in _system_bib_entries if e["key"] == meta["bibtex_key"]), None)
        if entry:
            raw = entry.get("raw", "")
    return jsonify({"bibtex_key": meta.get("bibtex_key", ""), "raw": raw})


@app.get("/api/papers/<int:paper_id>/refs")
def get_paper_refs(paper_id):
    sha = _hash_for_id(paper_id)
    if not sha:
        return jsonify({"error": "not found"}), 404
    meta = _load_paper_meta(sha) or {}
    return jsonify(meta.get("refs", []))


@app.patch("/api/papers/<int:paper_id>")
def update_paper(paper_id):
    data     = request.json or {}
    case_id  = data.get("case_id")
    meta_fields = {k: v for k, v in data.items()
                   if k in {"title", "authors", "year", "abstract", "bibtex_key", "venue", "bibtex_raw"}}
    pos_fields  = {k: v for k, v in data.items() if k in {"x", "y"}}

    sha = _hash_for_id(paper_id)
    if not sha:
        return jsonify({"error": "not found"}), 404

    # Update global metadata
    if meta_fields:
        meta = _load_paper_meta(sha) or {}
        meta.update(meta_fields)
        _save_paper_meta(meta)

    # Update case-local position
    if pos_fields and case_id:
        case = _load_case(case_id)
        if case:
            cp = _find_case_paper(case, paper_id)
            if cp:
                cp.update(pos_fields)
                _save_case(case)

    # Build response — need to find the case paper for x/y
    # Use case_id from request if available, else scan
    if case_id:
        case = _load_case(case_id)
        cp   = _find_case_paper(case, paper_id) if case else None
    else:
        cp = {"id": paper_id, "hash": sha, "x": 0, "y": 0, "case_id": None}

    if cp:
        return jsonify(_paper_response(cp))
    return jsonify({"error": "not found"}), 404


@app.delete("/api/cases/<int:case_id>/papers/<int:paper_id>")
def delete_paper(case_id, paper_id):
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "case not found"}), 404

    sha = next((cp["hash"] for cp in case.get("papers", []) if cp["id"] == paper_id), None)
    if not sha:
        return jsonify({"error": "paper not found in case"}), 404

    # Remove paper from this case
    case["papers"]      = [cp for cp in case["papers"] if cp["id"] != paper_id]
    case["connections"] = [c  for c  in case.get("connections", [])
                           if c["source_id"] != paper_id and c["target_id"] != paper_id]
    _save_case(case)

    # Remove PDF/meta if no other case references it
    still_used = any(
        any(cp["hash"] == sha for cp in (_load_case(int(p.stem)) or {}).get("papers", []))
        for p in CASES_DIR.glob("*.json")
        if p.stem.isdigit() and int(p.stem) != case_id
    )
    if not still_used:
        pdf = _paper_pdf_path(sha)
        if pdf.exists():
            pdf.unlink()
        meta_p = _paper_meta_path(sha)
        if meta_p.exists():
            meta_p.unlink()
        try:
            _paper_dir(sha).rmdir()
        except OSError:
            pass

    return jsonify({"ok": True})


# Keep old endpoint for compatibility (requires case_id in body or just delete globally)
@app.delete("/api/papers/<int:paper_id>")
def delete_paper_legacy(paper_id):
    """Legacy endpoint — requires ?case_id=N query param."""
    case_id_str = request.args.get("case_id")
    if case_id_str:
        return delete_paper(int(case_id_str), paper_id)
    # Global delete: remove from all cases
    for p in CASES_DIR.glob("*.json"):
        if not p.stem.isdigit():
            continue
        c = _load_case(int(p.stem))
        if c and any(cp["id"] == paper_id for cp in c.get("papers", [])):
            return delete_paper(c["id"], paper_id)
    return jsonify({"error": "not found"}), 404


# ---------------------------------------------------------------------------
# Connections API
# ---------------------------------------------------------------------------

@app.post("/api/cases/<int:case_id>/connections")
def create_connection(case_id):
    data = request.json or {}
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "case not found"}), 404

    src, tgt = data.get("source_id"), data.get("target_id")
    if any(c["source_id"] == src and c["target_id"] == tgt
           for c in case.get("connections", [])):
        return jsonify({"error": "connection already exists"}), 409

    conn_id = _next_id("connection")
    conn    = {
        "id":         conn_id,
        "case_id":    case_id,
        "source_id":  src,
        "target_id":  tgt,
        "color":      data.get("color", "#e63946"),
        "thickness":  data.get("thickness", 2.0),
        "annotation": data.get("annotation", ""),
        "created_at": _now_iso(),
    }
    case.setdefault("connections", []).append(conn)
    _save_case(case)
    return jsonify(conn), 201


@app.patch("/api/connections/<int:conn_id>")
def update_connection(conn_id):
    data   = request.json or {}
    fields = {k: v for k, v in data.items() if k in {"color", "thickness", "annotation"}}
    if not fields:
        return jsonify({"error": "no valid fields"}), 400

    for p in CASES_DIR.glob("*.json"):
        if not p.stem.isdigit():
            continue
        case = _load_case(int(p.stem))
        if not case:
            continue
        for c in case.get("connections", []):
            if c["id"] == conn_id:
                c.update(fields)
                _save_case(case)
                return jsonify(c)
    return jsonify({"error": "not found"}), 404


@app.delete("/api/connections/<int:conn_id>")
def delete_connection(conn_id):
    for p in CASES_DIR.glob("*.json"):
        if not p.stem.isdigit():
            continue
        case = _load_case(int(p.stem))
        if not case:
            continue
        orig = len(case.get("connections", []))
        case["connections"] = [c for c in case["connections"] if c["id"] != conn_id]
        if len(case["connections"]) < orig:
            _save_case(case)
            return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


# ---------------------------------------------------------------------------
# Post-its API
# ---------------------------------------------------------------------------

@app.post("/api/cases/<int:case_id>/postits")
def create_postit(case_id):
    data = request.json or {}
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "case not found"}), 404

    count    = len(case.get("postits", []))
    postit_id = _next_id("postit")
    postit   = {
        "id":         postit_id,
        "case_id":    case_id,
        "content":    data.get("content", ""),
        "color":      data.get("color", "#ffd166"),
        "x":          data.get("x", 350 + (count % 4) * 40),
        "y":          data.get("y", 350 + (count % 4) * 40),
        "created_at": _now_iso(),
    }
    case.setdefault("postits", []).append(postit)
    _save_case(case)
    return jsonify(postit), 201


@app.patch("/api/postits/<int:postit_id>")
def update_postit(postit_id):
    data   = request.json or {}
    fields = {k: v for k, v in data.items() if k in {"content", "color", "x", "y"}}
    if not fields:
        return jsonify({"error": "no valid fields"}), 400

    for p in CASES_DIR.glob("*.json"):
        if not p.stem.isdigit():
            continue
        case = _load_case(int(p.stem))
        if not case:
            continue
        for po in case.get("postits", []):
            if po["id"] == postit_id:
                po.update(fields)
                _save_case(case)
                return jsonify(po)
    return jsonify({"error": "not found"}), 404


@app.delete("/api/postits/<int:postit_id>")
def delete_postit(postit_id):
    for p in CASES_DIR.glob("*.json"):
        if not p.stem.isdigit():
            continue
        case = _load_case(int(p.stem))
        if not case:
            continue
        orig = len(case.get("postits", []))
        case["postits"] = [po for po in case["postits"] if po["id"] != postit_id]
        if len(case["postits"]) < orig:
            _save_case(case)
            return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


# ---------------------------------------------------------------------------
# BibTeX files API
# ---------------------------------------------------------------------------

@app.post("/api/cases/<int:case_id>/bibtex")
def upload_bibtex(case_id):
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "case not found"}), 404
    if "file" not in request.files:
        return jsonify({"error": "file required"}), 400

    f = request.files["file"]
    if not f.filename.lower().endswith(".bib"):
        return jsonify({"error": ".bib files only"}), 400

    raw_text  = f.read().decode("utf-8", errors="replace")
    filename  = secure_filename(f.filename)
    file_id   = _next_id("bib_file")
    papers    = [_paper_response(cp) for cp in case.get("papers", [])]
    entries   = parse_bibtex(raw_text)
    matches   = auto_match_bibtex_entries(entries, papers)

    inserted = []
    for e in entries:
        entry_id = _next_id("bib_entry")
        inserted.append({
            "id":         entry_id,
            "file_id":    file_id,
            "case_id":    case_id,
            "entry_key":  e["key"],
            "entry_type": e["type"],
            "title":      e["title"],
            "authors":    e["authors"],
            "year":       e["year"],
            "abstract":   e["abstract"],
            "doi":        e["doi"],
            "journal":    e["journal"],
            "paper_id":   matches.get(e["key"]),
        })

    bib_file = {
        "id":         file_id,
        "case_id":    case_id,
        "filename":   filename,
        "raw_text":   raw_text,
        "created_at": _now_iso(),
        "entries":    inserted,
    }
    case.setdefault("bibtex_files", []).append(bib_file)
    _save_case(case)
    return jsonify(bib_file), 201


@app.patch("/api/bibtex-files/<int:file_id>")
def update_bibtex_file(file_id):
    data     = request.json or {}
    raw_text = data.get("raw_text", "")

    for p in CASES_DIR.glob("*.json"):
        if not p.stem.isdigit():
            continue
        case = _load_case(int(p.stem))
        if not case:
            continue
        bf = next((b for b in case.get("bibtex_files", []) if b["id"] == file_id), None)
        if not bf:
            continue

        bf["raw_text"] = raw_text
        papers  = [_paper_response(cp) for cp in case.get("papers", [])]
        entries = parse_bibtex(raw_text)
        matches = auto_match_bibtex_entries(entries, papers)

        bf["entries"] = []
        for e in entries:
            entry_id = _next_id("bib_entry")
            bf["entries"].append({
                "id":         entry_id,
                "file_id":    file_id,
                "case_id":    bf["case_id"],
                "entry_key":  e["key"],
                "entry_type": e["type"],
                "title":      e["title"],
                "authors":    e["authors"],
                "year":       e["year"],
                "abstract":   e["abstract"],
                "doi":        e["doi"],
                "journal":    e["journal"],
                "paper_id":   matches.get(e["key"]),
            })

        _save_case(case)
        return jsonify(bf)

    return jsonify({"error": "not found"}), 404


@app.delete("/api/bibtex-files/<int:file_id>")
def delete_bibtex_file(file_id):
    for p in CASES_DIR.glob("*.json"):
        if not p.stem.isdigit():
            continue
        case = _load_case(int(p.stem))
        if not case:
            continue
        orig = len(case.get("bibtex_files", []))
        case["bibtex_files"] = [b for b in case["bibtex_files"] if b["id"] != file_id]
        if len(case["bibtex_files"]) < orig:
            _save_case(case)
            return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


@app.patch("/api/bibtex-entries/<int:entry_id>")
def update_bibtex_entry(entry_id):
    data    = request.json or {}
    paper_id = data.get("paper_id")

    for p in CASES_DIR.glob("*.json"):
        if not p.stem.isdigit():
            continue
        case = _load_case(int(p.stem))
        if not case:
            continue
        for bf in case.get("bibtex_files", []):
            entry = next((e for e in bf.get("entries", []) if e["id"] == entry_id), None)
            if not entry:
                continue

            entry["paper_id"] = paper_id
            updated_paper     = None

            if data.get("apply") and paper_id:
                sha = _hash_for_id(paper_id)
                if sha:
                    meta = _load_paper_meta(sha) or {}
                    if entry.get("entry_key"): meta["bibtex_key"] = entry["entry_key"]
                    if entry.get("title"):     meta["title"]      = entry["title"]
                    if entry.get("authors"):   meta["authors"]    = entry["authors"]
                    if entry.get("year"):      meta["year"]       = entry["year"]
                    if entry.get("abstract"):  meta["abstract"]   = entry["abstract"]
                    if entry.get("journal"):   meta["venue"]      = entry["journal"]
                    _save_paper_meta(meta)

                    cp = _find_case_paper(case, paper_id)
                    if cp:
                        updated_paper = _paper_response(cp)

            _save_case(case)
            return jsonify({"entry": entry, "updated_paper": updated_paper})

    return jsonify({"error": "not found"}), 404


# ---------------------------------------------------------------------------
# System BibTeX
# ---------------------------------------------------------------------------

@app.get("/api/system/bibtex-search")
def system_bibtex_search():
    raw_q  = request.args.get("q", "").strip()
    if len(raw_q) < 2:
        return jsonify([])
    q_lower = raw_q.lower()
    q_norm  = _normalize(raw_q)

    scored = []
    for e in _system_bib_entries:
        key    = e.get("key", "")
        title  = e.get("title", "")
        t_norm = _normalize(title)

        if q_lower in key.lower():
            score = 1.0
        elif q_norm and q_norm in t_norm:
            score = 0.95
        elif q_norm and len(q_norm) >= 4:
            score = difflib.SequenceMatcher(None, q_norm, t_norm).ratio()
            if score < 0.45:
                continue
        else:
            continue

        scored.append((score, {"key": key, "title": title, "year": e.get("year", "")}))

    scored.sort(key=lambda x: -x[0])
    return jsonify([r for _, r in scored[:25]])


@app.post("/api/papers/<int:paper_id>/apply-bibtex")
def apply_bibtex_to_paper(paper_id):
    data = request.json or {}
    key  = data.get("bibtex_key", "").strip()
    if not key:
        return jsonify({"error": "bibtex_key required"}), 400

    sha = _hash_for_id(paper_id)
    if not sha:
        return jsonify({"error": "not found"}), 404

    entry = next((e for e in _system_bib_entries if e["key"] == key), None)
    if not entry:
        return jsonify({"error": f"Key '{key}' not found in system BibTeX ({len(_system_bib_entries)} entries)"}), 404

    meta = _load_paper_meta(sha) or {}
    if entry.get("title"):    meta["title"]      = entry["title"]
    if entry.get("authors"):  meta["authors"]    = entry["authors"]
    if entry.get("year"):     meta["year"]       = entry["year"]
    if entry.get("journal"):  meta["venue"]      = entry["journal"]
    if entry.get("abstract"): meta["abstract"]   = entry["abstract"]
    if entry.get("raw"):      meta["bibtex_raw"] = entry["raw"]
    meta["bibtex_key"] = key
    _save_paper_meta(meta)

    # Find the case_id to return a proper response
    case_id = data.get("case_id")
    if case_id:
        case = _load_case(case_id)
        cp   = _find_case_paper(case, paper_id) if case else None
    else:
        cp = None
        for p in CASES_DIR.glob("*.json"):
            if not p.stem.isdigit():
                continue
            c = _load_case(int(p.stem))
            if c:
                found = _find_case_paper(c, paper_id)
                if found:
                    cp = found
                    break

    if cp:
        return jsonify(_paper_response(cp))
    return jsonify(meta)


@app.get("/api/system/bibtex-status")
def system_bibtex_status():
    return jsonify({
        "entry_count": len(_system_bib_entries),
        "last_update": _system_bib_last_update,
        "cached":      SYSTEM_BIB_CACHE.exists(),
    })


@app.post("/api/system/bibtex-refresh")
def system_bibtex_refresh():
    threading.Thread(target=_fetch_system_bibtex, daemon=True).start()
    return jsonify({"ok": True, "message": "Refresh started in background"})


@app.post("/api/cases/<int:case_id>/sync-bibtex")
def sync_case_bibtex(case_id):
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "not found"}), 404

    matched, updated = 0, []
    newly_keyed: list[dict] = []  # papers that gained a bibtex_key in this sync

    for cp in case.get("papers", []):
        sha    = cp["hash"]
        meta   = _load_paper_meta(sha) or {}
        had_key = bool(meta.get("bibtex_key"))
        result = _apply_system_bib_to_paper(sha, cp["id"], meta.get("title", ""))
        if result:
            matched += 1
            updated.append(_paper_response(cp))
            if not had_key:
                newly_keyed.append({"id": cp["id"], "hash": sha, **result})

    # Always re-run connection matching — second sync (no newly_keyed) still needs
    # to catch connections that were missed on the first pass.
    with _store_lock:
        case = _load_case(case_id)
        all_case_papers = case.get("papers", [])

        def _make_conn(src, tgt, strength):
            return {
                "id":         _next_id("connection"),
                "case_id":    case_id,
                "source_id":  src,
                "target_id":  tgt,
                "color":      "#e63946" if strength == "strong" else "#9b59b6",
                "thickness":  2.0       if strength == "strong" else 1.5,
                "annotation": "",
                "created_at": _now_iso(),
            }

        def _try_add(src, tgt, strength):
            if src == tgt:
                return
            already = any(
                c["source_id"] == src and c["target_id"] == tgt
                for c in case.get("connections", [])
            )
            if not already:
                case.setdefault("connections", []).append(_make_conn(src, tgt, strength))

        all_metas = {
            cp["hash"]: (_load_paper_meta(cp["hash"]) or {})
            for cp in all_case_papers
            if cp.get("hash")
        }

        for cp in all_case_papers:
            cp_meta = all_metas.get(cp["hash"], {})
            refs = cp_meta.get("refs", [])
            if not refs:
                continue
            candidates = [
                {"id": other["id"], **all_metas.get(other["hash"], {})}
                for other in all_case_papers
                if other["id"] != cp["id"]
            ]
            for cited_id, strength in _match_refs_to_papers(refs, candidates):
                _try_add(cp["id"], cited_id, strength)

        _save_case(case)

    return jsonify({"matched": matched, "total": len(case.get("papers", [])), "updated_papers": updated})


# ---------------------------------------------------------------------------
# Gutenscrape API
# ---------------------------------------------------------------------------

@app.post("/api/gutenscrape/search")
def gutenscrape_search():
    if not GUTENSCRAPE_AVAILABLE:
        return jsonify({"error": "gutenscrape not available"}), 503
    raw_term = (request.json or {}).get("term", "").strip()
    if not raw_term:
        return jsonify({"error": "term required"}), 400
    term = _extract_search_term(raw_term)
    try:
        papers = _gutenscrape.search(term, n=8)
        results = [
            {
                "title":     p.title,
                "authors":   p.authors,
                "year":      p.year,
                "doi":       p.doi,
                "arxiv_id":  p.arxiv_id,
                "pdf_url":   p.pdf_url,
                "venue":     p.venue,
                "source":    p.source,
            }
            for p in papers
        ]
        return jsonify(results)
    except Exception as e:
        msg = str(e)
        if "timed out" in msg.lower() or "timeout" in msg.lower():
            return jsonify({"error": "Search timed out — try a shorter title fragment"}), 504
        return jsonify({"error": str(e)}), 500


@app.get("/api/cases/<int:case_id>/papers/<int:paper_id>/refs-enriched")
def get_refs_enriched(case_id, paper_id):
    """Refs annotated with in_case / in_store / paper_id status, sorted unknown-first."""
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "case not found"}), 404
    sha = _hash_for_id(paper_id)
    if not sha:
        return jsonify({"error": "not found"}), 404
    meta = _load_paper_meta(sha) or {}
    refs = meta.get("refs", [])

    # Migrate legacy string refs to enriched dicts on first access
    if refs and isinstance(refs[0], str):
        refs = _enrich_refs(refs)
        meta["refs"] = refs
        _save_paper_meta(meta)

    # Always compute fresh — no caching to avoid staleness when store changes
    matched: list[dict] = _compute_refs_matched(refs) if refs else []

    # Fast lookups from the current case (no disk scan needed)
    case_hashes: set[str] = {cp["hash"] for cp in case.get("papers", []) if cp.get("hash")}
    case_sha_to_id: dict[str, int] = {cp["hash"]: cp["id"] for cp in case.get("papers", []) if cp.get("hash")}

    # Inverted paper index: sha → global paper_id (built from _paper_index.json in memory)
    global_sha_to_id: dict[str, int] = {v: int(k) for k, v in _load_paper_index().items()}

    # For each matched sha, load its meta only once (lazy, only for matched refs)
    _meta_cache: dict[str, dict] = {}
    def _get_matched_meta(sha: str) -> dict:
        if sha not in _meta_cache:
            _meta_cache[sha] = _load_paper_meta(sha) or {}
        return _meta_cache[sha]

    enriched = []
    for item in matched:
        p_sha    = item.get("matched_sha")
        strength = item.get("strength")
        in_case  = (p_sha in case_hashes) if p_sha else False
        # in_store: sha exists in global store and not already in case
        in_store = (p_sha is not None and not in_case and _paper_meta_path(p_sha).exists())
        # paper_id: prefer case-local id, fall back to global id
        pid = case_sha_to_id.get(p_sha) or global_sha_to_id.get(p_sha) if p_sha else None
        paper_title = _get_matched_meta(p_sha).get("title") if (p_sha and (in_case or in_store)) else None
        enriched.append({
            "text":        item["text"],
            "extract":     item.get("extract"),  # for ACM search — derived from raw text
            "title":       item.get("title"),    # clean title from bibtex (display + direct-add)
            "doi":         item.get("doi"),      # doi for direct download (may be None)
            "paper_id":    pid,
            "paper_title": paper_title,
            "in_case":     in_case,
            "in_store":    in_store,
            "strength":    strength,
        })

    # unknown → store-known → in-case
    enriched.sort(key=lambda r: (2 if r["in_case"] else (1 if r["in_store"] else 0)))
    return jsonify(enriched)


@app.post("/api/papers/<int:paper_id>/reenrich-refs")
def reenrich_refs(paper_id):
    """Re-run bibtex enrichment on a paper's refs and return the updated enriched refs."""
    sha = _hash_for_id(paper_id)
    if not sha:
        return jsonify({"error": "not found"}), 404
    meta = _load_paper_meta(sha) or {}
    refs = meta.get("refs", [])
    if not refs:
        return jsonify([])

    # Extract raw text from whatever format refs are currently in
    raw_refs = [r if isinstance(r, str) else r.get("text", "") for r in refs]
    raw_refs = [r for r in raw_refs if r]

    enriched = _enrich_refs(raw_refs)
    meta["refs"] = enriched
    _save_paper_meta(meta)
    return jsonify({"ok": True, "count": len(enriched)})


@app.post("/api/cases/<int:case_id>/add-paper/<int:paper_id>")
def add_existing_paper(case_id, paper_id):
    """Add a globally-known paper to a case without re-downloading."""
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "case not found"}), 404
    sha = _hash_for_id(paper_id)
    if not sha:
        return jsonify({"error": "paper not found in store"}), 404
    paper_meta = _load_paper_meta(sha)
    if not paper_meta:
        return jsonify({"error": "paper metadata missing"}), 404

    if any(cp["hash"] == sha for cp in case.get("papers", [])):
        cp = next(cp for cp in case["papers"] if cp["hash"] == sha)
        return jsonify({"paper": _paper_response(cp), "new_connections": []}), 200

    count      = len(case.get("papers", []))
    case_paper = {
        "id":         paper_id,
        "hash":       sha,
        "case_id":    case_id,
        "x":          160 + (count % 5) * 230,
        "y":          140 + (count // 5) * 170,
        "created_at": _now_iso(),
    }
    case.setdefault("papers", []).append(case_paper)

    existing_papers = [_paper_response(cp) for cp in case["papers"] if cp["id"] != paper_id]
    new_connections = []

    def _try_c(src, tgt, strength):
        if any(c["source_id"] == src and c["target_id"] == tgt
               for c in case.get("connections", [])):
            return
        conn = {
            "id":         _next_id("connection"),
            "case_id":    case_id,
            "source_id":  src,
            "target_id":  tgt,
            "color":      "#e63946" if strength == "strong" else "#9b59b6",
            "thickness":  2.0       if strength == "strong" else 1.5,
            "annotation": "",
            "created_at": _now_iso(),
        }
        case.setdefault("connections", []).append(conn)
        new_connections.append(conn)

    for cited_id, strength in _match_refs_to_papers(paper_meta.get("refs", []), existing_papers):
        _try_c(paper_id, cited_id, strength)
    for ep in existing_papers:
        ep_meta = _load_paper_meta(ep["hash"]) if ep.get("hash") else None
        if ep_meta and ep_meta.get("refs"):
            for _, strength in _match_refs_to_papers(ep_meta["refs"], [{"id": paper_id, **paper_meta}]):
                _try_c(ep["id"], paper_id, strength)

    _save_case(case)
    return jsonify({"paper": _paper_response(case_paper), "new_connections": new_connections}), 201


@app.post("/api/cases/<int:case_id>/fetch-paper")
def fetch_paper(case_id):
    if not GUTENSCRAPE_AVAILABLE:
        return jsonify({"error": "gutenscrape not available"}), 503
    case = _load_case(case_id)
    if not case:
        return jsonify({"error": "case not found"}), 404

    body = request.json or {}
    term = body.get("term", "").strip()
    doi  = body.get("doi", "").strip()
    if not term and not doi:
        return jsonify({"error": "term or doi required"}), 400

    # Prefer DOI for direct bypass; fall back to title search term
    dl_term = doi if doi else _extract_search_term(term)

    import tempfile, shutil
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            dl_path = _gutenscrape.download(dl_term, path=tmpdir, timeout_ms=90_000)
        except Exception as e:
            msg = str(e)
            if "timed out" in msg.lower() or "timeout" in msg.lower():
                return jsonify({"error": "Download timed out — ACM was too slow"}), 504
            return jsonify({"error": f"Download failed: {e}"}), 500

        if not dl_path:
            return jsonify({"error": "No PDF found for this search term"}), 404

        pdf_src = Path(dl_path)
        if not pdf_src.exists():
            return jsonify({"error": "Downloaded file not found"}), 500

        sha = _sha256_path(pdf_src)

        # Primary dedup: exact SHA match (same bytes)
        existing_meta = _load_paper_meta(sha)

        # Secondary dedup: ACM sometimes embeds a per-download timestamp, making
        # the same paper produce different SHA hashes on every download. Fall back
        # to title matching if we know the DOI or title we're looking for.
        if existing_meta is None:
            lookup_title = _normalize(doi or _extract_search_term(term))
            if lookup_title:
                for d in PAPERS_DIR.iterdir():
                    if not d.is_dir():
                        continue
                    m = _json_read(d / "meta.json")
                    if not m:
                        continue
                    if (doi and m.get("doi") == doi) or \
                       (m.get("bibtex_key") and doi and m.get("doi") == doi):
                        existing_meta = m
                        sha = m["hash"]  # use the stored hash
                        break
                    stored_title = _normalize(m.get("title", ""))
                    if stored_title and difflib.SequenceMatcher(None, lookup_title, stored_title).ratio() >= 0.95:
                        existing_meta = m
                        sha = m["hash"]
                        break

        if existing_meta is None:
            _paper_dir(sha).mkdir(exist_ok=True)
            shutil.copy2(str(pdf_src), str(_paper_pdf_path(sha)))

            meta_raw  = extract_metadata(_paper_pdf_path(sha))
            paper_id  = _next_id("paper")
            paper_meta = {
                "id":         paper_id,
                "hash":       sha,
                "title":      meta_raw["title"],
                "authors":    meta_raw["authors"],
                "year":       meta_raw["year"],
                "abstract":   meta_raw["abstract"],
                "bibtex_key": "",
                "venue":      "",
                "bibtex_raw": "",
                "refs":       [],
            }
            _save_paper_meta(paper_meta)
            _register_paper(paper_id, sha)

            enriched = _apply_system_bib_to_paper(sha, paper_id, meta_raw["title"])
            if enriched:
                paper_meta = enriched

            raw_refs = extract_references(_paper_pdf_path(sha))
            if raw_refs:
                paper_meta["refs"] = _enrich_refs(raw_refs)
                _save_paper_meta(paper_meta)
        else:
            paper_id   = existing_meta["id"]
            paper_meta = existing_meta

    # Add to case (same logic as upload_paper) — do this under lock to avoid races
    with _store_lock:
        case = _load_case(case_id) or case
        if any(cp["hash"] == sha for cp in case.get("papers", [])):
            cp   = next(cp for cp in case["papers"] if cp["hash"] == sha)
            return jsonify({"paper": _paper_response(cp), "new_connections": []}), 200

        count      = len(case.get("papers", []))
        case_paper = {
            "id":         paper_id,
            "hash":       sha,
            "case_id":    case_id,
            "x":          160 + (count % 5) * 230,
            "y":          140 + (count // 5) * 170,
            "created_at": _now_iso(),
        }
        case.setdefault("papers", []).append(case_paper)
        _save_case(case)

    existing_papers = [_paper_response(cp) for cp in case["papers"] if cp["id"] != paper_id]
    new_connections = []

    def _make_conn2(src, tgt, strength):
        return {
            "id":         _next_id("connection"),
            "case_id":    case_id,
            "source_id":  src,
            "target_id":  tgt,
            "color":      "#e63946" if strength == "strong" else "#9b59b6",
            "thickness":  2.0       if strength == "strong" else 1.5,
            "annotation": "",
            "created_at": _now_iso(),
        }

    def _try_add2(src, tgt, strength):
        if any(c["source_id"] == src and c["target_id"] == tgt
               for c in case.get("connections", [])):
            return
        conn = _make_conn2(src, tgt, strength)
        case.setdefault("connections", []).append(conn)
        new_connections.append(conn)

    for cited_id, strength in _match_refs_to_papers(paper_meta.get("refs", []), existing_papers):
        _try_add2(paper_id, cited_id, strength)

    for ep in existing_papers:
        ep_meta = _load_paper_meta(ep["hash"]) if ep.get("hash") else None
        if not ep_meta or not ep_meta.get("refs"):
            continue
        for _, strength in _match_refs_to_papers(ep_meta["refs"], [{"id": paper_id, **paper_meta}]):
            _try_add2(ep["id"], paper_id, strength)

    _save_case(case)
    return jsonify({"paper": _paper_response(case_paper), "new_connections": new_connections}), 201


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)
