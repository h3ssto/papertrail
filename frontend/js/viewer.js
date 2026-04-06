/**
 * Viewer — right-side panel with collapsible, horizontal resize,
 * PDF iframe tabs, and CodeMirror 6 BibTeX editor tabs.
 */
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { api } from "./api.js";

// ── DOM refs ──────────────────────────────────────────────────────────────
let panelEl, bodyEl, tabBarEl, contentEl, resizeHandleEl, toggleBtn;

// ── Tab registry ──────────────────────────────────────────────────────────
// key: `pdf-{paperId}` | `bib-{fileId}`
// value: { type, title, contentEl, editorView? }
const tabs = new Map();
let activeKey = null;

// ── Callbacks (set by main) ───────────────────────────────────────────────
let onBibSave = null;       // (fileId, rawText) => Promise
let onBibEntryLink = null;  // (entryId, paperId, apply) => Promise
let getCasePapers = null;   // () => paper[]
let onFetchPaper = null;    // (term) => Promise<{paper, new_connections}>

// ── Init ──────────────────────────────────────────────────────────────────
export function initViewer(callbacks) {
  panelEl       = document.getElementById("viewer-panel");
  bodyEl        = document.getElementById("viewer-body");
  tabBarEl      = document.getElementById("viewer-tabs");
  contentEl     = document.getElementById("viewer-content");
  resizeHandleEl = document.getElementById("viewer-resize-handle");
  toggleBtn     = document.getElementById("viewer-toggle-btn");

  onBibSave       = callbacks.onBibSave;
  onBibEntryLink  = callbacks.onBibEntryLink;
  getCasePapers   = callbacks.getCasePapers;
  onFetchPaper    = callbacks.onFetchPaper;

  // Collapse / expand
  document.getElementById("viewer-collapse-strip").addEventListener("click", toggleCollapse);

  // Start collapsed — no tabs open yet
  panelEl.classList.add("collapsed");
  panelEl.style.width = "28px";
  toggleBtn.textContent = "‹";
  toggleBtn.title = "Expand viewer";

  // Horizontal resize
  let resizing = false, startX, startW;
  resizeHandleEl.addEventListener("mousedown", (e) => {
    if (panelEl.classList.contains("collapsed")) return;
    resizing = true;
    startX = e.clientX;
    startW = panelEl.offsetWidth;
    resizeHandleEl.classList.add("active");
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const delta = startX - e.clientX;
    const newW = Math.max(260, Math.min(window.innerWidth * 0.7, startW + delta));
    panelEl.style.width = newW + "px";
    panelEl.dataset.expandedW = newW + "px";
  });
  document.addEventListener("mouseup", () => {
    resizing = false;
    resizeHandleEl.classList.remove("active");
  });
}

function toggleCollapse() {
  const collapsed = panelEl.classList.toggle("collapsed");
  // Inline width set by the resize handle overrides CSS class rules,
  // so we must drive the width via inline style in both states.
  panelEl.style.width = collapsed ? "28px" : (panelEl.dataset.expandedW || "440px");
  toggleBtn.textContent = collapsed ? "‹" : "›";
  toggleBtn.title = collapsed ? "Expand viewer" : "Collapse viewer";
}

export function expandViewer() {
  if (panelEl.classList.contains("collapsed")) {
    panelEl.classList.remove("collapsed");
    panelEl.style.width = panelEl.dataset.expandedW || "440px";
    toggleBtn.textContent = "›";
    toggleBtn.title = "Collapse viewer";
  }
}

// ── Generic tab management ─────────────────────────────────────────────────
function addTab(key, title, icon, buildContent) {
  if (tabs.has(key)) {
    activateTab(key);
    return;
  }

  // Content pane
  const pane = document.createElement("div");
  pane.style.cssText = "display:none; width:100%; height:100%; overflow:hidden; flex-direction:column;";
  pane.style.display = "none";
  contentEl.appendChild(pane);

  const info = { title, pane };
  buildContent(pane, info);
  tabs.set(key, info);

  // Tab element
  const tabEl = document.createElement("div");
  tabEl.className = "viewer-tab";
  tabEl.dataset.key = key;
  tabEl.innerHTML = `
    <span class="tab-icon">${icon}</span>
    <span class="tab-title" title="${title}">${title}</span>
    <button class="tab-close" title="Close">×</button>
  `;
  tabEl.addEventListener("click", () => activateTab(key));
  tabEl.querySelector(".tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(key);
  });
  tabBarEl.appendChild(tabEl);

  expandViewer();
  activateTab(key);
}

function activateTab(key) {
  activeKey = key;
  contentEl.querySelectorAll(":scope > div").forEach((p) => (p.style.display = "none"));
  const info = tabs.get(key);
  if (info) info.pane.style.display = "flex";

  tabBarEl.querySelectorAll(".viewer-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.key === key);
  });
}

function closeTab(key) {
  const info = tabs.get(key);
  if (!info) return;
  info.editorView?.destroy();
  info.pane.remove();
  tabBarEl.querySelector(`[data-key="${key}"]`)?.remove();
  tabs.delete(key);

  if (tabs.size === 0) {
    activeKey = null;
    panelEl.classList.add("collapsed");
    panelEl.style.width = "28px";
    toggleBtn.textContent = "‹";
    toggleBtn.title = "Expand viewer";
  } else if (activeKey === key) {
    activateTab(tabs.keys().next().value);
  }
}

export function closeAllTabs() {
  [...tabs.keys()].forEach(closeTab);
  activeKey = null;
}

export function closePaperTabs(paperId) {
  closeTab(`pdf-${paperId}`);
  closeTab(`refs-${paperId}`);
}

export async function refreshAllRefsTabs() {
  for (const [key, info] of tabs) {
    if (key.startsWith("refs-") && info.refresh) {
      try { await info.refresh(); } catch (_) { /* ignore per-tab errors */ }
    }
  }
}

// ── PDF tab ────────────────────────────────────────────────────────────────
const PDFJS_VIEWER = "https://mozilla.github.io/pdf.js/web/viewer.html";

export function openPaper(paperId, pdfUrl, title) {
  const key = `pdf-${paperId}`;
  addTab(key, title, "📄", (pane) => {
    const iframe = document.createElement("iframe");
    // Absolute URL needed by pdf.js viewer
    const abs = new URL(pdfUrl, window.location.href).href;
    iframe.src = `${PDFJS_VIEWER}?file=${encodeURIComponent(abs)}`;
    iframe.style.cssText = "flex:1; border:none; width:100%; min-height:0;";
    pane.appendChild(iframe);
  });
}

// ── BibTeX tab ─────────────────────────────────────────────────────────────
export function openBibtexFile(bibFile) {
  const key = `bib-${bibFile.id}`;

  if (tabs.has(key)) {
    // Refresh entries list in case it changed
    const info = tabs.get(key);
    if (info.refreshEntries) info.refreshEntries(bibFile.entries);
    activateTab(key);
    return;
  }

  addTab(key, bibFile.filename, "📚", (pane, info) => {
    buildBibPane(pane, info, bibFile);
  });
}

function buildBibPane(pane, info, bibFile) {
  // ── Toolbar ──────────────────────────────────────────────────────
  const toolbar = document.createElement("div");
  toolbar.className = "bib-toolbar";
  const statsEl = document.createElement("span");
  statsEl.className = "bib-stats";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn sm";
  saveBtn.textContent = "Save";
  const delBtn = document.createElement("button");
  delBtn.className = "btn danger sm";
  delBtn.textContent = "Delete file";
  toolbar.appendChild(statsEl);
  toolbar.appendChild(saveBtn);
  toolbar.appendChild(delBtn);
  pane.appendChild(toolbar);

  // ── CodeMirror editor ─────────────────────────────────────────────
  const editorWrap = document.createElement("div");
  editorWrap.className = "bib-editor-wrap";
  pane.appendChild(editorWrap);

  let saveTimer = null;
  const editorView = new EditorView({
    state: EditorState.create({
      doc: bibFile.raw_text || "",
      extensions: [basicSetup, oneDark],
    }),
    parent: editorWrap,
  });
  info.editorView = editorView;

  // ── Entries resize handle ─────────────────────────────────────────
  const entriesResizeHandle = document.createElement("div");
  entriesResizeHandle.className = "bib-entries-resize";
  pane.appendChild(entriesResizeHandle);

  // ── Entries list ──────────────────────────────────────────────────
  const entriesList = document.createElement("div");
  entriesList.className = "bib-entries-list";
  pane.appendChild(entriesList);

  // Resize entries list vertically
  let resizingEntries = false, startY, startH;
  entriesResizeHandle.addEventListener("mousedown", (e) => {
    resizingEntries = true;
    startY = e.clientY;
    startH = entriesList.offsetHeight;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!resizingEntries) return;
    const delta = startY - e.clientY;
    entriesList.style.height = Math.max(60, Math.min(600, startH + delta)) + "px";
  });
  document.addEventListener("mouseup", () => { resizingEntries = false; });

  // ── Render entries ────────────────────────────────────────────────
  function renderEntries(entries) {
    const linked = entries.filter((e) => e.paper_id).length;
    statsEl.textContent = `${entries.length} entries · ${linked} linked`;
    entriesList.innerHTML = "";

    if (!entries.length) {
      entriesList.innerHTML = '<div style="padding:1rem;color:var(--muted);font-size:0.8rem;">No entries parsed.</div>';
      return;
    }

    const papers = getCasePapers ? getCasePapers() : [];

    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "bib-entry-row";

      const header = document.createElement("div");
      header.className = "bib-entry-header";
      const titleEl = document.createElement("span");
      titleEl.className = "bib-entry-title";
      titleEl.textContent = entry.title || entry.entry_key;
      titleEl.title = entry.title || "";
      const yearEl = document.createElement("span");
      yearEl.className = "bib-entry-year";
      yearEl.textContent = entry.year || "";
      header.appendChild(titleEl);
      header.appendChild(yearEl);

      const linkRow = document.createElement("div");
      linkRow.className = "bib-link-row";

      const badge = document.createElement("span");
      badge.className = `bib-link-badge ${entry.paper_id ? "linked" : "unlinked"}`;
      badge.textContent = entry.paper_id ? "linked" : "unlinked";

      const select = document.createElement("select");
      select.className = "bib-link-select";
      select.innerHTML = `<option value="">— link to paper —</option>` +
        papers.map((p) => `<option value="${p.id}" ${p.id === entry.paper_id ? "selected" : ""}>${truncate(p.title, 38)}</option>`).join("");

      const applyBtn = document.createElement("button");
      applyBtn.className = "btn sm bib-apply-btn";
      applyBtn.textContent = "Apply";
      applyBtn.title = "Link and apply BibTeX metadata to paper";
      applyBtn.addEventListener("click", async () => {
        const paperId = select.value ? parseInt(select.value) : null;
        if (!paperId) return;
        const result = await onBibEntryLink?.(entry.id, paperId, true);
        if (result) {
          entry.paper_id = paperId;
          badge.className = "bib-link-badge linked";
          badge.textContent = "linked";
        }
      });

      select.addEventListener("change", async () => {
        const paperId = select.value ? parseInt(select.value) : null;
        await onBibEntryLink?.(entry.id, paperId, false);
        entry.paper_id = paperId;
        badge.className = `bib-link-badge ${paperId ? "linked" : "unlinked"}`;
        badge.textContent = paperId ? "linked" : "unlinked";
      });

      linkRow.appendChild(badge);
      linkRow.appendChild(select);
      linkRow.appendChild(applyBtn);

      row.appendChild(header);
      row.appendChild(linkRow);
      entriesList.appendChild(row);
    });
  }

  renderEntries(bibFile.entries || []);
  info.refreshEntries = renderEntries;

  // ── Save ──────────────────────────────────────────────────────────
  saveBtn.addEventListener("click", async () => {
    const rawText = editorView.state.doc.toString();
    const updated = await onBibSave?.(bibFile.id, rawText);
    if (updated) {
      bibFile.raw_text = rawText;
      renderEntries(updated.entries || []);
    }
  });

  // ── Delete ────────────────────────────────────────────────────────
  delBtn.addEventListener("click", async () => {
    if (!confirm(`Delete "${bibFile.filename}" and all its entries?`)) return;
    await api.deleteBibtexFile(bibFile.id);
    closeTab(`bib-${bibFile.id}`);
  });
}

// ── References / Gutenscrape tab ──────────────────────────────────────────

// callbacks: { onSearch(term)→results[], onAddExisting(paperId)→paper }
export function openRefsPanel(paperId, paperTitle, refs, callbacks) {
  const key = `refs-${paperId}`;

  if (tabs.has(key)) {
    activateTab(key);
    return;
  }

  addTab(key, `Refs: ${truncate(paperTitle, 22)}`, "🔗", (pane, info) => {
    buildRefsPane(pane, refs, callbacks);
    if (callbacks.onRefresh) {
      info.refresh = async () => {
        const fresh = await callbacks.onRefresh();
        pane.innerHTML = "";
        buildRefsPane(pane, fresh, callbacks);
      };
    }
  });
}

function _spinBtn(btn, label) {
  btn.disabled = true; btn.classList.add("busy"); btn.innerHTML = "";
  const sp = document.createElement("span"); sp.className = "btn-spinner";
  btn.appendChild(sp); btn.appendChild(document.createTextNode(" " + label));
}
function _restoreBtn(btn, label) {
  btn.disabled = false; btn.classList.remove("busy"); btn.textContent = label;
}

function buildRefsPane(pane, refs, callbacks) {
  const { onSearch, onAddExisting, onReload } = callbacks;

  const unknown = refs.filter((r) => !r.in_case && !r.in_store);
  const inStore = refs.filter((r) =>  r.in_store);
  const inCase  = refs.filter((r) =>  r.in_case);

  const header = document.createElement("div");
  header.className = "refs-header";
  header.innerHTML =
    `<span class="refs-count">${refs.length} ref${refs.length !== 1 ? "s" : ""}</span>` +
    (inStore.length ? ` · <span class="refs-count-store">${inStore.length} in store</span>` : "") +
    (inCase.length  ? ` · <span class="refs-count-case">${inCase.length} in case</span>`   : "");

  if (onReload) {
    const reloadBtn = document.createElement("button");
    reloadBtn.className = "btn sm refs-reload-btn";
    reloadBtn.title = "Re-check references against bibtex";
    reloadBtn.textContent = "↺ Reload";
    reloadBtn.addEventListener("click", async () => {
      _spinBtn(reloadBtn, "Reloading…");
      try {
        const fresh = await onReload();
        pane.innerHTML = "";
        buildRefsPane(pane, fresh, callbacks);
      } catch (e) {
        _restoreBtn(reloadBtn, "↺ Reload");
        pane.insertAdjacentHTML("afterbegin",
          `<div class="refs-no-results" style="color:#e63946">${escHtml(e.message)}</div>`);
      }
    });
    header.appendChild(reloadBtn);
  }

  pane.appendChild(header);

  if (!refs.length) {
    const empty = document.createElement("div");
    empty.className = "refs-empty";
    empty.textContent = "No references could be extracted.";
    pane.appendChild(empty);
    return;
  }

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Filter references…";
  searchInput.className = "refs-search";
  pane.appendChild(searchInput);

  const list = document.createElement("div");
  list.className = "refs-list";
  pane.appendChild(list);

  function _scoreRef(ref, tokens) {
    if (!tokens.length) return 0;
    const haystack = (ref.text || "").toLowerCase();
    return tokens.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
  }

  function _highlightText(text, tokens) {
    if (!tokens.length) return escHtml(text);
    const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(${escaped.join("|")})`, "gi");
    return escHtml(text).replace(re, "<mark>$1</mark>");
  }

  function renderList(query) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    let ordered;
    if (!tokens.length) {
      ordered = [...unknown, ...inStore, ...inCase];
    } else {
      ordered = refs
        .map(r => ({ r, s: _scoreRef(r, tokens) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s)
        .map(({ r }) => r);
    }
    list.innerHTML = "";
    ordered.forEach(r => list.appendChild(buildItem(r, tokens)));
  }

  searchInput.addEventListener("input", () => renderList(searchInput.value));

  function buildItem(ref, tokens = []) {
    const item = document.createElement("div");
    item.className = "refs-item" + (ref.in_case ? " refs-item-in-case" : "");

    const textEl = document.createElement("div");
    textEl.className = "refs-text";
    textEl.innerHTML = _highlightText(ref.text, tokens);
    item.appendChild(textEl);

    if (ref.in_case) {
      const badge = document.createElement("div");
      badge.className = "refs-actions";
      badge.innerHTML = `<span class="refs-badge-incase">✓ In case</span>`;
      item.appendChild(badge);
      return item;
    }

    const actions = document.createElement("div");
    actions.className = "refs-actions";
    item.appendChild(actions);

    if (ref.in_store && ref.paper_id != null) {
      // Known paper not yet in case — one-click add, no download needed
      const addBtn = document.createElement("button");
      addBtn.className = "btn sm refs-dl-btn";
      addBtn.title = ref.paper_title || "";
      addBtn.textContent = "＋ Add to case";
      addBtn.addEventListener("click", async () => {
        _spinBtn(addBtn, "Adding…");
        try {
          await onAddExisting(ref.paper_id);
          addBtn.textContent = "✓ Added";
          addBtn.className = "btn sm refs-dl-btn added";
          addBtn.disabled = true; addBtn.classList.remove("busy");
          item.classList.add("refs-item-in-case");
        } catch (e) {
          _restoreBtn(addBtn, "＋ Add to case");
          item.insertAdjacentHTML("beforeend",
            `<div class="refs-no-results" style="color:#e63946">${escHtml(e.message)}</div>`);
        }
      });
      actions.appendChild(addBtn);
      return item;
    }

    // DOI known from bibtex enrichment — skip search entirely
    if (ref.doi) {
      const dlBtn = document.createElement("button");
      dlBtn.className = "btn sm refs-dl-btn";
      dlBtn.textContent = "↓ Add";
      dlBtn.addEventListener("click", async () => {
        _spinBtn(dlBtn, "Downloading…");
        try {
          await onFetchPaper?.(ref.title || ref.text, ref.doi);
          dlBtn.textContent = "✓ Added";
          dlBtn.className = "btn sm refs-dl-btn added";
          dlBtn.disabled = true; dlBtn.classList.remove("busy");
        } catch (e) {
          _restoreBtn(dlBtn, "↓ Add");
          actions.insertAdjacentHTML("afterend",
            `<div class="refs-no-results" style="color:#e63946">${escHtml(e.message)}</div>`);
        }
      });
      actions.appendChild(dlBtn);
      return item;
    }

    // DOI unknown — Search → results → ↓ Add
    const searchBtn = document.createElement("button");
    searchBtn.className = "btn sm refs-search-btn";
    searchBtn.textContent = "Search";
    const resultsEl = document.createElement("div");
    resultsEl.className = "refs-results";
    resultsEl.style.display = "none";

    searchBtn.addEventListener("click", async () => {
      _spinBtn(searchBtn, "Searching…");
      resultsEl.style.display = "none"; resultsEl.innerHTML = "";
      try {
        const results = await onSearch(ref.extract || ref.text);
        if (!results || !results.length) {
          resultsEl.innerHTML = '<div class="refs-no-results">No results found.</div>';
        } else {
          results.forEach((r) => {
            const row = document.createElement("div");
            row.className = "refs-result-row";
            row.innerHTML =
              `<div class="refs-result-info">` +
              `<span class="refs-result-title">${escHtml(r.title || "")}</span>` +
              `<span class="refs-result-meta">${escHtml(r.authors || "")}` +
              `${r.year ? " · " + r.year : ""}${r.venue ? " · " + r.venue : ""}</span></div>`;
            const dlBtn = document.createElement("button");
            dlBtn.className = "btn sm refs-dl-btn";
            dlBtn.textContent = "↓ Add";
            dlBtn.addEventListener("click", async () => {
              _spinBtn(dlBtn, "Downloading…");
              try {
                await onFetchPaper?.(r.title, r.doi || undefined);
                dlBtn.textContent = "✓ Added";
                dlBtn.className = "btn sm refs-dl-btn added";
                dlBtn.disabled = true; dlBtn.classList.remove("busy");
              } catch (e) {
                _restoreBtn(dlBtn, "↓ Add");
                resultsEl.insertAdjacentHTML("afterbegin",
                  `<div class="refs-no-results" style="color:#e63946">${escHtml(e.message)}</div>`);
              }
            });
            row.appendChild(dlBtn);
            resultsEl.appendChild(row);
          });
        }
        resultsEl.style.display = "block";
      } catch (e) {
        resultsEl.innerHTML =
          `<div class="refs-no-results" style="color:#e63946">Search error: ${escHtml(e.message)}</div>`;
        resultsEl.style.display = "block";
      } finally {
        _restoreBtn(searchBtn, "Search");
      }
    });

    actions.appendChild(searchBtn);
    item.appendChild(resultsEl);
    return item;
  }

  // Render: unknown → store-known → in-case
  renderList("");
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Helpers ───────────────────────────────────────────────────────────────
function truncate(str, max) {
  return str && str.length > max ? str.slice(0, max - 1) + "…" : (str || "");
}
