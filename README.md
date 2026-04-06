# Papertrail

An academic paper investigation board. Upload PDFs, explore their references, connect related works on an infinite canvas, and sync metadata from a shared BibTeX library.

## Features

- **Canvas** — drag-and-drop paper nodes and post-its, draw connections between them
- **Reference panel** — parsed references enriched against your BibTeX store; direct download via DOI or ACM DL search (gutenscrape)
- **BibTeX integration** — upload `.bib` files, link entries to papers, sync metadata across the case
- **DAG layout** — auto-arrange papers top-to-bottom following citation direction (Sugiyama / dagre)
- **PDF viewer** — inline PDF viewer tab per paper

## Project structure

```
backend/    Flask API, JSON file storage, Playwright-based paper fetching
frontend/   Vite + vanilla JS + D3 canvas, CodeMirror BibTeX editor
```

## Setup

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Requires a [gutenscrape](https://github.com/TUBS-ISF/gutenscrape) installation available on the Python path.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` to `http://localhost:5000` by default.

## Data

All data lives in `backend/data/`:

```
data/
  cases/        one JSON file per case
  papers/       one directory per paper (SHA-256 hash), contains meta.json + paper.pdf
  system_bibtex_cache.json   cached BibTeX entries fetched from the configured .bib URLs
```
