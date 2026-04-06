import $ from "jquery";
import { api } from "./api.js";
import dagre from "@dagrejs/dagre";
import {
  init as initCanvas,
  addPaper as canvasAddPaper,
  addPostit as canvasAddPostit,
  addConnection as canvasAddConnection,
  updateConnection as canvasUpdateConnection,
  updatePaperNode as canvasUpdatePaper,
  removeNode as canvasRemoveNode,
  removeConnection as canvasRemoveConnection,
  setDrawMode,
  updatePostitContent,
  applyPositions,
} from "./canvas.js";
import {
  initViewer,
  openPaper,
  openBibtexFile,
  openRefsPanel,
  closeAllTabs,
  closePaperTabs,
  refreshAllRefsTabs,
  expandViewer,
} from "./viewer.js";

// ── App state ─────────────────────────────────────────────────────────────
let currentCase = null;
let selectedConnId = null;

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, type = "info", duration = 3500) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── Home view ─────────────────────────────────────────────────────────────
async function showHome() {
  $("#case-view").hide();
  $("#home-view").show();
  currentCase = null;
  closeAllTabs();
  await renderCaseList();
}

async function renderCaseList() {
  const cases = await api.getCases().catch(() => []);
  const $list = $("#cases-list").empty();
  if (!cases.length) {
    $list.html('<p class="empty-hint">No cases yet — create one above.</p>');
    return;
  }
  cases.forEach((c) => {
    const date = new Date(c.created_at).toLocaleDateString();
    $list.append(`
      <div class="case-item" data-id="${c.id}">
        <span class="case-name">${escHtml(c.name)}</span>
        <span class="case-date">${date}</span>
        <button class="case-del" title="Delete case">×</button>
      </div>
    `);
  });
}

// ── Open case ─────────────────────────────────────────────────────────────
async function openCase(caseId) {
  let caseData;
  try {
    caseData = await api.getCase(caseId);
  } catch (e) {
    toast("Failed to load case: " + e.message, "error");
    return;
  }

  currentCase = caseData;
  $("#home-view").hide();
  $("#case-view").show();
  $("#case-title").text(caseData.name);
  hideConnEditor();

  initCanvas("#canvas", caseData, {
    onPaperClick(paperId) {
      const paper = currentCase.papers.find((p) => p.id === paperId);
      if (paper) openPaper(paperId, api.paperFileUrl(paperId), paper.title);
    },
    onConnectionClick(connId) {
      showConnEditor(connId);
    },
    onNodeDragEnd(id, type, x, y) {
      if (type === "paper") {
        api.updatePaper(id, { x, y, case_id: currentCase.id });
        const p = currentCase.papers.find((p) => p.id === id);
        if (p) { p.x = x; p.y = y; }
      } else {
        api.updatePostit(id, { x, y });
        const po = currentCase.postits.find((p) => p.id === id);
        if (po) { po.x = x; po.y = y; }
      }
    },
    async onDrawComplete(sourceId, targetId) {
      try {
        const conn = await api.createConnection(currentCase.id, { source_id: sourceId, target_id: targetId });
        currentCase.connections.push(conn);
        canvasAddConnection(conn);
        toast("Connection created", "success");
      } catch (e) {
        toast(e.message, "error");
      }
    },
    onDrawModeChange(active) {
      $("#draw-conn-btn").toggleClass("active", active);
      $("#draw-hint").toggle(active);
    },
    async onDeleteNode(id, type) {
      if (!confirm(`Delete this ${type}?`)) return;
      try {
        if (type === "paper") {
          await api.deletePaper(id, currentCase.id);
          currentCase.papers = currentCase.papers.filter((p) => p.id !== id);
          currentCase.connections = currentCase.connections.filter(
            (c) => c.source_id !== id && c.target_id !== id
          );
          closePaperTabs(id);
          await refreshAllRefsTabs();
        } else {
          await api.deletePostit(id);
          currentCase.postits = currentCase.postits.filter((p) => p.id !== id);
        }
        canvasRemoveNode(id);
        toast("Deleted", "info");
      } catch (e) {
        toast(e.message, "error");
      }
    },
    onPostitEdit(id, x, y, content, color) {
      openPostitEditor(id, content, color);
    },
    async onBibtexClick(paperId) {
      const paper = currentCase.papers.find((p) => p.id === paperId);
      if (paper?.bibtex_key) {
        try {
          const { bibtex_key, raw } = await api.getPaperBibtex(paperId);
          openBibtexModal(bibtex_key, raw);
        } catch (e) {
          toast(e.message, "error");
        }
      } else {
        openBibtexKeyModal(paperId);
      }
    },
    async onRefsClick(paperId) {
      const paper = currentCase.papers.find((p) => p.id === paperId);
      if (!paper) return;
      try {
        const refs = await api.getRefsEnriched(currentCase.id, paperId);
        openRefsPanel(paperId, paper.title, refs, {
          onRefresh: () => api.getRefsEnriched(currentCase.id, paperId),
          onReload: async () => {
            await api.reenrichRefs(paperId);
            return api.getRefsEnriched(currentCase.id, paperId);
          },
          onSearch: (term) => api.gutenscrapeSearch(term),
          async onAddExisting(refPaperId) {
            const { paper: p, new_connections } = await api.addExistingPaper(currentCase.id, refPaperId);
            currentCase.papers.push(p);
            canvasAddPaper(p);
            new_connections.forEach((c) => {
              currentCase.connections.push(c);
              canvasAddConnection(c);
            });
            toast(`Added: ${p.title}`, "success", 4000);
            return p;
          },
        });
        expandViewer();
      } catch (e) {
        toast(e.message, "error");
      }
    },
  });

  initViewer({
    getCasePapers: () => currentCase?.papers ?? [],
    async onFetchPaper(term, doi) {
      const { paper, new_connections } = await api.fetchPaper(currentCase.id, term, doi);
      if (!currentCase.papers.some((p) => p.id === paper.id)) {
        currentCase.papers.push(paper);
        canvasAddPaper(paper);
      } else {
        // update existing node instead of duplicating
        const existing = currentCase.papers.find((p) => p.id === paper.id);
        Object.assign(existing, paper);
        canvasUpdatePaper(paper);
      }
      new_connections.forEach((c) => {
        if (!currentCase.connections.some((cc) => cc.id === c.id)) {
          currentCase.connections.push(c);
          canvasAddConnection(c);
        }
      });
      toast(`Added: ${paper.title}`, "success", 5000);
      return paper;
    },
    async onBibSave(fileId, rawText) {
      try {
        const updated = await api.updateBibtexFile(fileId, rawText);
        const idx = currentCase.bibtex_files.findIndex((f) => f.id === fileId);
        if (idx !== -1) currentCase.bibtex_files[idx] = updated;
        toast("BibTeX saved & re-parsed", "success");
        return updated;
      } catch (e) {
        toast("Save failed: " + e.message, "error");
        return null;
      }
    },
    async onBibEntryLink(entryId, paperId, apply) {
      try {
        const { entry, updated_paper } = await api.updateBibtexEntry(entryId, { paper_id: paperId, apply });
        if (updated_paper) {
          const p = currentCase.papers.find((p) => p.id === updated_paper.id);
          if (p) Object.assign(p, updated_paper);
          canvasUpdatePaper(updated_paper);
          toast("Metadata applied to paper", "success");
        }
        return entry;
      } catch (e) {
        toast(e.message, "error");
        return null;
      }
    },
  });

  // Open any existing bibtex files as viewer tabs
  (caseData.bibtex_files || []).forEach((bf) => openBibtexFile(bf));
}

// ── Post-it inline editor ─────────────────────────────────────────────────
let postitEditorEl = null;

function openPostitEditor(id, content, color) {
  closePostitEditor();
  const svgEl = document.getElementById("canvas");
  const rect = svgEl.getBoundingClientRect();

  const wrap = document.createElement("div");
  wrap.id = "postit-editor-wrap";
  wrap.style.cssText = `
    position:fixed; left:${rect.left + 20}px; top:${rect.top + 60}px;
    z-index:500; background:#2a2a36; border:1px solid #444;
    border-radius:8px; padding:0.75rem; display:flex;
    flex-direction:column; gap:0.5rem; min-width:240px;
    box-shadow: 0 8px 32px rgba(0,0,0,.6);
  `;

  const colors = ["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#adb5bd"];
  let selectedColor = color || "#ffd166";

  const swatchRow = document.createElement("div");
  swatchRow.style.cssText = "display:flex; gap:6px;";
  colors.forEach((c) => {
    const s = document.createElement("button");
    s.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c};border:2px solid ${c === selectedColor ? "#fff" : "transparent"};cursor:pointer;`;
    s.addEventListener("click", () => {
      selectedColor = c;
      swatchRow.querySelectorAll("button").forEach((b) => (b.style.borderColor = "transparent"));
      s.style.borderColor = "#fff";
    });
    swatchRow.appendChild(s);
  });

  const ta = document.createElement("textarea");
  ta.value = content || "";
  ta.rows = 5;
  ta.placeholder = "Post-it content…";
  ta.style.cssText = `background:#1a1a24; border:1px solid #444; border-radius:4px; color:#eee; padding:0.4rem; font-size:12px; resize:vertical; width:100%;`;

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex; gap:0.5rem; justify-content:flex-end;";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "btn secondary";
  cancelBtn.style.fontSize = "0.8rem";
  cancelBtn.addEventListener("click", closePostitEditor);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.className = "btn";
  saveBtn.style.fontSize = "0.8rem";
  saveBtn.addEventListener("click", async () => {
    const newContent = ta.value;
    try {
      await api.updatePostit(id, { content: newContent, color: selectedColor });
      const po = currentCase.postits.find((p) => p.id === id);
      if (po) { po.content = newContent; po.color = selectedColor; }
      updatePostitContent(id, newContent, selectedColor);
      closePostitEditor();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);
  wrap.appendChild(swatchRow);
  wrap.appendChild(ta);
  wrap.appendChild(btnRow);
  document.body.appendChild(wrap);
  ta.focus();
  postitEditorEl = wrap;
}

function closePostitEditor() {
  postitEditorEl?.remove();
  postitEditorEl = null;
}

// ── BibTeX modal ──────────────────────────────────────────────────────────
let bibtexModalEl = null;

function openBibtexModal(bibKey, rawText) {
  bibtexModalEl?.remove();

  const wrap = document.createElement("div");
  wrap.id = "bibtex-modal";

  const header = document.createElement("div");
  header.className = "bibtex-modal-header";
  const title = document.createElement("span");
  title.textContent = bibKey || "BibTeX Entry";
  title.className = "bibtex-modal-title";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn sm";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(rawText || "").then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
  });
  const closeBtn = document.createElement("button");
  closeBtn.className = "icon-btn";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => { bibtexModalEl?.remove(); bibtexModalEl = null; });
  header.appendChild(title);
  header.appendChild(copyBtn);
  header.appendChild(closeBtn);

  const pre = document.createElement("pre");
  pre.className = "bibtex-modal-pre";
  if (rawText) {
    pre.innerHTML = highlightBibtex(rawText);
  } else {
    pre.textContent = "(no BibTeX entry found)";
  }

  wrap.appendChild(header);
  wrap.appendChild(pre);
  document.body.appendChild(wrap);
  bibtexModalEl = wrap;
}

function openBibtexKeyModal(paperId) {
  bibtexModalEl?.remove();

  const wrap = document.createElement("div");
  wrap.id = "bibtex-modal";

  // Header
  const header = document.createElement("div");
  header.className = "bibtex-modal-header";
  const title = document.createElement("span");
  title.className = "bibtex-modal-title";
  title.textContent = "Link BibTeX entry";
  const closeBtn = document.createElement("button");
  closeBtn.className = "icon-btn";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => { wrap.remove(); bibtexModalEl = null; });
  header.appendChild(title);
  header.appendChild(closeBtn);

  // Search body
  const body = document.createElement("div");
  body.className = "bibtex-modal-search-body";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "bibtex-modal-input";
  input.placeholder = "Type BibTeX key or title fragment…";

  const resultsList = document.createElement("div");
  resultsList.className = "bibtex-modal-results";

  body.appendChild(input);
  body.appendChild(resultsList);

  // Footer
  const footer = document.createElement("div");
  footer.className = "bibtex-modal-footer";
  const selectedLabel = document.createElement("span");
  selectedLabel.className = "bibtex-modal-selected";
  selectedLabel.textContent = "Nothing selected";
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn sm";
  applyBtn.textContent = "Apply";
  footer.appendChild(selectedLabel);
  footer.appendChild(applyBtn);

  wrap.appendChild(header);
  wrap.appendChild(body);
  wrap.appendChild(footer);
  document.body.appendChild(wrap);
  bibtexModalEl = wrap;
  input.focus();

  let selectedKey = null;

  // Debounced search
  let debounce = null;
  input.addEventListener("input", () => {
    selectedKey = null;
    selectedLabel.textContent = "Nothing selected";
    resultsList.querySelectorAll(".bibtex-result-row").forEach((r) => r.classList.remove("selected"));
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = input.value.trim();
      resultsList.innerHTML = "";
      if (q.length < 2) return;
      const list = await api.searchSystemBibtex(q).catch(() => []);
      if (!list.length) {
        resultsList.innerHTML = '<div class="bibtex-no-results">No matches in system library</div>';
        return;
      }
      list.forEach((entry) => {
        const row = document.createElement("div");
        row.className = "bibtex-result-row";
        row.innerHTML =
          `<span class="bibtex-result-key">${escHtml(entry.key)}</span>` +
          `<span class="bibtex-result-title">${escHtml(entry.title || "")}</span>` +
          `<span class="bibtex-result-year">${escHtml(entry.year || "")}</span>`;
        row.addEventListener("click", () => {
          selectedKey = entry.key;
          input.value = entry.key;
          selectedLabel.textContent = entry.key;
          resultsList.querySelectorAll(".bibtex-result-row").forEach((r) => r.classList.remove("selected"));
          row.classList.add("selected");
        });
        resultsList.appendChild(row);
      });
    }, 240);
  });

  applyBtn.addEventListener("click", async () => {
    const key = selectedKey || input.value.trim();
    if (!key) return;
    try {
      const updated = await api.applyBibtex(paperId, key, currentCase.id);
      const idx = currentCase.papers.findIndex((p) => p.id === paperId);
      if (idx !== -1) currentCase.papers[idx] = updated;
      canvasUpdatePaper(updated);
      wrap.remove();
      bibtexModalEl = null;
      toast("BibTeX applied", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  });
}

// ── Connection editor ─────────────────────────────────────────────────────
function showConnEditor(connId) {
  selectedConnId = connId;
  const conn = currentCase.connections.find((c) => c.id === connId);
  if (!conn) return;
  $("#conn-color").val(conn.color || "#e63946");
  $("#conn-thickness").val(conn.thickness ?? 2);
  $("#conn-thickness-val").text(conn.thickness ?? 2);
  $("#conn-annotation").val(conn.annotation || "");
  $("#conn-editor").show();
}

function hideConnEditor() {
  selectedConnId = null;
  $("#conn-editor").hide();
}

async function saveConnection() {
  if (!selectedConnId) return;
  const data = {
    color: $("#conn-color").val(),
    thickness: parseFloat($("#conn-thickness").val()),
    annotation: $("#conn-annotation").val(),
  };
  try {
    const updated = await api.updateConnection(selectedConnId, data);
    const idx = currentCase.connections.findIndex((c) => c.id === selectedConnId);
    if (idx !== -1) currentCase.connections[idx] = updated;
    canvasUpdateConnection(updated);
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Paper upload (multiple) ────────────────────────────────────────────────
async function uploadPapers(files) {
  if (!currentCase || !files.length) return;
  toast(`Uploading ${files.length} paper(s)…`, "info", 10000);
  let added = 0, threads = 0;

  for (const file of files) {
    try {
      const { paper, new_connections } = await api.uploadPaper(currentCase.id, file);
      currentCase.papers.push(paper);
      canvasAddPaper(paper);
      new_connections.forEach((c) => {
        currentCase.connections.push(c);
        canvasAddConnection(c);
      });
      added++;
      threads += new_connections.length;
    } catch (e) {
      toast(`Failed: ${file.name} — ${e.message}`, "error");
    }
  }
  if (added > 0) {
    toast(
      `${added} paper(s) added${threads ? `, ${threads} thread(s) auto-connected` : ""}.`,
      "success", 5000
    );
  }
}

// ── BibTeX upload ──────────────────────────────────────────────────────────
async function uploadBibtex(files) {
  if (!currentCase || !files.length) return;
  for (const file of files) {
    try {
      const bibFile = await api.uploadBibtex(currentCase.id, file);
      currentCase.bibtex_files = currentCase.bibtex_files || [];
      currentCase.bibtex_files.push(bibFile);
      openBibtexFile(bibFile);
      expandViewer();
      toast(`${bibFile.filename}: ${bibFile.entries.length} entries imported`, "success");
    } catch (e) {
      toast(`BibTeX import failed: ${e.message}`, "error");
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function highlightBibtex(text) {
  return text.split("\n").map(line => {
    const e = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    // @type{ or @type(
    let m;
    if ((m = line.match(/^(@\w+)(\s*\{?\s*)(.*)$/))) {
      return `<span class="bib-hl-type">${e(m[1])}</span>${e(m[2])}<span class="bib-hl-key">${e(m[3])}</span>`;
    }
    // fieldname = value
    if ((m = line.match(/^(\s*)(\w+)(\s*=\s*)(.*)$/))) {
      const val = e(m[4])
        .replace(/(\{[^}]*\})/g, '<span class="bib-hl-val">$1</span>')
        .replace(/(&quot;[^&]*&quot;)/g, '<span class="bib-hl-val">$1</span>');
      return `${e(m[1])}<span class="bib-hl-field">${e(m[2])}</span>${e(m[3])}${val}`;
    }
    // closing brace
    if (line.trim() === "}" || line.trim() === "},") {
      return `<span class="bib-hl-brace">${e(line)}</span>`;
    }
    return e(line);
  }).join("\n");
}

// ── Event wiring ──────────────────────────────────────────────────────────
$(document).on("keydown", (e) => {
  if (e.key === "Escape") {
    closePostitEditor();
    bibtexModalEl?.remove();
    bibtexModalEl = null;
  }
});

$(document).on("click", ".case-item", function (e) {
  if ($(e.target).hasClass("case-del")) return;
  openCase(parseInt($(this).data("id")));
});

$(document).on("click", ".case-del", async function (e) {
  e.stopPropagation();
  const id = parseInt($(this).closest(".case-item").data("id"));
  if (!confirm("Delete this case and all its papers?")) return;
  try {
    await api.deleteCase(id);
    await renderCaseList();
    toast("Case deleted", "info");
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#new-case-form").on("submit", async (e) => {
  e.preventDefault();
  const name = $("#case-name-input").val().trim();
  if (!name) return;
  try {
    await api.createCase(name);
    $("#case-name-input").val("");
    await renderCaseList();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#back-btn").on("click", showHome);

// PDF upload
$("#upload-btn").on("click", () => { if (currentCase) $("#file-input").val("").trigger("click"); });
$("#file-input").on("change", function () { uploadPapers([...this.files]); });

// Paper search & download
(function () {
  const input    = document.getElementById("paper-search-input");
  const dropdown = document.getElementById("paper-search-dropdown");
  let searchId = 0; // incremented on each search to cancel stale ones

  function closeDropdown() {
    dropdown.style.display = "none";
    dropdown.innerHTML = "";
  }

  function showMsg(text, isError = false) {
    dropdown.innerHTML = `<div class="toolbar-search-msg" style="${isError ? "color:#e63946" : ""}">${escHtml(text)}</div>`;
    dropdown.style.display = "block";
  }

  async function doSearch(term) {
    if (!term || !currentCase) return;
    const myId = ++searchId;
    input.classList.add("busy");
    showMsg("Searching…");
    try {
      const results = await api.gutenscrapeSearch(term);
      if (myId !== searchId) return; // superseded by a newer search
      dropdown.innerHTML = "";
      if (!results || !results.length) {
        showMsg("No results found.");
        return;
      }
      results.forEach((r) => {
        const row = document.createElement("div");
        row.className = "toolbar-search-result";
        const info = document.createElement("div");
        info.className = "toolbar-search-result-info";
        info.innerHTML =
          `<span class="toolbar-search-result-title">${escHtml(r.title || "")}</span>` +
          `<span class="toolbar-search-result-meta">${escHtml(r.authors || "")}${r.year ? " · " + r.year : ""}${r.venue ? " · " + r.venue : ""}</span>`;
        const dlBtn = document.createElement("button");
        dlBtn.className = "btn sm refs-dl-btn";
        dlBtn.textContent = "↓ Add";
        dlBtn.addEventListener("click", async () => {
          dlBtn.disabled = true; dlBtn.classList.add("busy");
          dlBtn.innerHTML = '<span class="btn-spinner"></span> Downloading…';
          try {
            const { paper, new_connections } = await api.fetchPaper(currentCase.id, r.title, r.doi || undefined);
            if (!currentCase.papers.some((p) => p.id === paper.id)) {
              currentCase.papers.push(paper);
              canvasAddPaper(paper);
            } else {
              const existing = currentCase.papers.find((p) => p.id === paper.id);
              Object.assign(existing, paper);
              canvasUpdatePaper(paper);
            }
            new_connections.forEach((c) => {
              if (!currentCase.connections.some((cc) => cc.id === c.id)) {
                currentCase.connections.push(c);
                canvasAddConnection(c);
              }
            });
            dlBtn.classList.remove("busy");
            dlBtn.textContent = "✓ Added";
            dlBtn.className = "btn sm refs-dl-btn added";
            toast(`Added: ${paper.title}`, "success", 5000);
          } catch (e) {
            dlBtn.disabled = false; dlBtn.classList.remove("busy");
            dlBtn.textContent = "↓ Add";
            toast("Download failed: " + e.message, "error");
          }
        });
        row.appendChild(info);
        row.appendChild(dlBtn);
        dropdown.appendChild(row);
      });
      dropdown.style.display = "block";
    } catch (e) {
      if (myId !== searchId) return;
      showMsg("Search error: " + e.message, true);
    } finally {
      if (myId === searchId) input.classList.remove("busy");
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const term = input.value.trim();
      if (term) doSearch(term); else closeDropdown();
    } else if (e.key === "Escape") {
      ++searchId; // cancel any in-flight search
      input.classList.remove("busy");
      closeDropdown();
      input.blur();
    }
  });

  input.addEventListener("input", () => {
    if (!input.value.trim()) { ++searchId; input.classList.remove("busy"); closeDropdown(); }
  });

  document.addEventListener("click", (e) => {
    if (!document.getElementById("paper-search-wrap").contains(e.target)) closeDropdown();
  });
})();

// BibTeX upload
$("#upload-bib-btn").on("click", () => { if (currentCase) $("#bib-file-input").val("").trigger("click"); });
$("#bib-file-input").on("change", function () { uploadBibtex([...this.files]); });

// Post-it
$("#add-postit-btn").on("click", async () => {
  if (!currentCase) return;
  try {
    const postit = await api.createPostit(currentCase.id, {});
    currentCase.postits.push(postit);
    canvasAddPostit(postit);
  } catch (err) { toast(err.message, "error"); }
});

// Sync BibTeX for all papers in the case
$("#match-bibtex-btn").on("click", async () => {
  if (!currentCase) return;
  const btn = $("#match-bibtex-btn");
  btn.prop("disabled", true).text("Syncing…");
  try {
    const { matched, total, updated_papers } = await api.syncCaseBibtex(currentCase.id);
    updated_papers.forEach((p) => {
      const idx = currentCase.papers.findIndex((cp) => cp.id === p.id);
      if (idx !== -1) currentCase.papers[idx] = p;
      canvasUpdatePaper(p);
    });
    toast(
      `Synced ${matched} / ${total} paper(s)`,
      matched ? "success" : "info",
    );
  } catch (e) {
    toast(e.message, "error");
  } finally {
    btn.prop("disabled", false).text("⟳ Sync BibTeX");
  }
});

// DAG auto-layout
$("#order-dag-btn").on("click", () => {
  if (!currentCase || !currentCase.papers.length) return;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 80, nodesep: 50, marginx: 60, marginy: 60 });
  g.setDefaultEdgeLabel(() => ({}));

  const PAPER_W = 270, PAPER_H = 150;
  currentCase.papers.forEach((p) => g.setNode(p.id, { width: PAPER_W, height: PAPER_H }));
  currentCase.connections.forEach((c) => {
    if (g.hasNode(c.source_id) && g.hasNode(c.target_id))
      g.setEdge(c.source_id, c.target_id);
  });

  dagre.layout(g);

  const positions = new Map();
  g.nodes().forEach((id) => {
    const n = g.node(id);
    // dagre returns center coords; canvas uses top-left
    positions.set(parseInt(id), { x: n.x - PAPER_W / 2, y: n.y - PAPER_H / 2 });
  });

  applyPositions(positions);

  // Persist new positions
  positions.forEach((pos, id) => {
    api.updatePaper(id, { x: pos.x, y: pos.y, case_id: currentCase.id });
    const p = currentCase.papers.find((p) => p.id === id);
    if (p) { p.x = pos.x; p.y = pos.y; }
  });
});

// Draw connection toggle
let drawActive = false;
$("#draw-conn-btn").on("click", () => {
  drawActive = !drawActive;
  setDrawMode(drawActive);
  $("#draw-conn-btn").toggleClass("active", drawActive);
  $("#draw-hint").toggle(drawActive);
});

// Connection editor inputs → live save
$("#conn-color, #conn-thickness, #conn-annotation").on("input change", () => {
  $("#conn-thickness-val").text($("#conn-thickness").val());
  saveConnection();
});
$("#conn-editor-close").on("click", hideConnEditor);
$("#conn-delete-btn").on("click", async () => {
  if (!selectedConnId) return;
  try {
    await api.deleteConnection(selectedConnId);
    currentCase.connections = currentCase.connections.filter((c) => c.id !== selectedConnId);
    canvasRemoveConnection(selectedConnId);
    hideConnEditor();
    toast("Connection deleted", "info");
  } catch (err) { toast(err.message, "error"); }
});

// ── Boot ──────────────────────────────────────────────────────────────────
showHome();
