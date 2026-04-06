const BASE = "/api";

async function req(url, opts = {}) {
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const errMsg = (data && data.error) ? data.error : (text || res.statusText);
    throw new Error(errMsg);
  }
  return data;
}

function json(method, url, body) {
  return req(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  // Cases
  getCases:    ()       => req("/cases"),
  createCase:  (name)   => json("POST", "/cases", { name }),
  getCase:     (id)     => req(`/cases/${id}`),
  deleteCase:  (id)     => req(`/cases/${id}`, { method: "DELETE" }),

  // Papers
  uploadPaper(caseId, file) {
    const fd = new FormData();
    fd.append("file", file);
    return req(`/cases/${caseId}/papers`, { method: "POST", body: fd });
  },
  updatePaper:    (id, data)         => json("PATCH", `/papers/${id}`, data),
  deletePaper:    (id, caseId)       => req(`/cases/${caseId}/papers/${id}`, { method: "DELETE" }),
  paperFileUrl:   (id)               => `${BASE}/papers/${id}/file`,
  getPaperBibtex:     (id)           => req(`/papers/${id}/bibtex`),
  getPaperRefs:         (id)                => req(`/papers/${id}/refs`),
  getRefsEnriched:      (caseId, paperId)   => req(`/cases/${caseId}/papers/${paperId}/refs-enriched`),
  reenrichRefs:         (paperId)           => json("POST", `/papers/${paperId}/reenrich-refs`, {}),
  addExistingPaper:     (caseId, paperId)   => json("POST", `/cases/${caseId}/add-paper/${paperId}`, {}),
  applyBibtex:        (id, key, caseId) => json("POST", `/papers/${id}/apply-bibtex`, { bibtex_key: key, case_id: caseId }),
  searchSystemBibtex: (q)            => req(`/system/bibtex-search?q=${encodeURIComponent(q)}`),
  syncCaseBibtex:     (caseId)       => json("POST", `/cases/${caseId}/sync-bibtex`, {}),

  // Gutenscrape
  gutenscrapeSearch: (term)          => json("POST", "/gutenscrape/search", { term }),
  fetchPaper:        (caseId, term, doi) => json("POST", `/cases/${caseId}/fetch-paper`, { term, ...(doi ? { doi } : {}) }),

  // Connections
  createConnection: (caseId, data) => json("POST",  `/cases/${caseId}/connections`, data),
  updateConnection: (id, data)     => json("PATCH", `/connections/${id}`, data),
  deleteConnection: (id)           => req(`/connections/${id}`, { method: "DELETE" }),

  // Post-its
  createPostit: (caseId, data) => json("POST",  `/cases/${caseId}/postits`, data),
  updatePostit: (id, data)     => json("PATCH", `/postits/${id}`, data),
  deletePostit: (id)           => req(`/postits/${id}`, { method: "DELETE" }),

  // BibTeX files
  uploadBibtex(caseId, file) {
    const fd = new FormData();
    fd.append("file", file);
    return req(`/cases/${caseId}/bibtex`, { method: "POST", body: fd });
  },
  updateBibtexFile: (id, raw_text) => json("PATCH", `/bibtex-files/${id}`, { raw_text }),
  deleteBibtexFile: (id)           => req(`/bibtex-files/${id}`, { method: "DELETE" }),

  // BibTeX entries
  updateBibtexEntry: (id, data)    => json("PATCH", `/bibtex-entries/${id}`, data),
};
