import * as d3 from "d3";

// ── Constants ──────────────────────────────────────────────────────────────
const PAPER_W  = 270;
const PAPER_H  = 150;
const FOLD     = 22;
const POSTIT_W = 155;
const POSTIT_H = 135;

// ── Module state ───────────────────────────────────────────────────────────
let svg, zoomGroup, linksGroup, nodesGroup;
let callbacks = {};

// Map<id, {id, type, x, y, ...}>
const nodes = new Map();
// Map<id, {id, source_id, target_id, color, thickness, annotation}>
const connections = new Map();

let drawMode = false;
let drawSourceId = null;

// (author tooltip removed — authors toggle inline)

// ── Helpers ────────────────────────────────────────────────────────────────
function trunc(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseAuthors(authorsStr) {
  if (!authorsStr) return [];
  const byAnd = authorsStr.split(/\s+and\s+/i).map((a) => a.trim()).filter(Boolean);
  if (byAnd.length > 1) return byAnd;
  return authorsStr.split(/\s*;\s*/).map((a) => a.trim()).filter(Boolean);
}

/** Format a single author as "F. Last" */
function shortAuthorName(author) {
  const s = author.trim();
  // BibTeX "Last, First Middle" format
  if (s.includes(",")) {
    const [last, rest] = s.split(",", 2);
    const firstWord = (rest || "").trim().split(/\s+/)[0];
    const initial = firstWord ? firstWord[0].toUpperCase() + "." : "";
    return initial ? `${initial} ${last.trim()}` : last.trim();
  }
  // "First Last" format
  const parts = s.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const initial = parts[0][0].toUpperCase() + ".";
  return `${initial} ${parts[parts.length - 1]}`;
}


function nodeCenter(id) {
  const n = nodes.get(id);
  if (!n) return { x: 0, y: 0 };
  return n.type === "paper"
    ? { x: n.x + PAPER_W / 2, y: n.y + (n._h || PAPER_H) / 2 }
    : { x: n.x + POSTIT_W / 2, y: n.y + POSTIT_H / 2 };
}

/** Point on the boundary of the target node facing the source. */
function nodeEdgePoint(fromId, toId) {
  const from = nodeCenter(fromId);
  const to   = nodeCenter(toId);
  const n    = nodes.get(toId);
  if (!n) return to;

  const dx  = from.x - to.x;
  const dy  = from.y - to.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return to;

  const hw = (n.type === "paper" ? PAPER_W : POSTIT_W) / 2;
  const hh = (n.type === "paper" ? (n._h || PAPER_H) : POSTIT_H) / 2;
  const nx  = dx / len;
  const ny  = dy / len;

  const tx = nx !== 0 ? hw / Math.abs(nx) : Infinity;
  const ty = ny !== 0 ? hh / Math.abs(ny) : Infinity;
  const t  = Math.min(tx, ty);

  return { x: to.x + nx * t, y: to.y + ny * t };
}

function curvePath(conn) {
  const s    = nodeCenter(conn.source_id);
  const t    = nodeCenter(conn.target_id);
  const dx   = t.x - s.x;
  const dy   = t.y - s.y;
  const cx   = (s.x + t.x) / 2 - dy * 0.18;
  const cy   = (s.y + t.y) / 2 + dx * 0.18;
  // End the path at the target node's edge so the arrowhead sits on the border
  const edge = nodeEdgePoint(conn.source_id, conn.target_id);
  return `M ${s.x} ${s.y} Q ${cx} ${cy} ${edge.x} ${edge.y}`;
}

function midPoint(conn) {
  const s  = nodeCenter(conn.source_id);
  const t  = nodeCenter(conn.target_id);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const cx = (s.x + t.x) / 2 - dy * 0.18;
  const cy = (s.y + t.y) / 2 + dx * 0.18;
  return {
    x: (s.x + 2 * cx + t.x) / 4,
    y: (s.y + 2 * cy + t.y) / 4,
  };
}

function refreshConnections() {
  linksGroup.selectAll(".link-group").each(function () {
    const g    = d3.select(this);
    const d    = g.datum();
    const path = curvePath(d);
    g.selectAll("path").attr("d", path);
    const mid = midPoint(d);
    g.select("text.link-label").attr("x", mid.x).attr("y", mid.y - 6);
  });
}

// ── Drag ──────────────────────────────────────────────────────────────────
function makeDrag() {
  return d3
    .drag()
    .on("start", function () {
      if (drawMode) return;
      d3.select(this).raise();
    })
    .on("drag", function (event, d) {
      if (drawMode) return;
      d.x += event.dx;
      d.y += event.dy;
      d3.select(this).attr("transform", `translate(${d.x},${d.y})`);
      refreshConnections();
    })
    .on("end", function (event, d) {
      if (drawMode) return;
      callbacks.onNodeDragEnd?.(d.id, d.type, d.x, d.y);
    });
}

// ── Draw mode ──────────────────────────────────────────────────────────────
function handleNodeClickInDrawMode(nodeId) {
  if (!drawSourceId) {
    drawSourceId = nodeId;
    nodesGroup
      .selectAll(".node-paper, .node-postit")
      .filter((d) => d.id === nodeId)
      .classed("draw-source", true);
  } else if (drawSourceId !== nodeId) {
    callbacks.onDrawComplete?.(drawSourceId, nodeId);
    cancelDrawMode();
  }
}

function cancelDrawMode() {
  drawMode = false;
  drawSourceId = null;
  svg.classed("draw-mode", false);
  nodesGroup.selectAll(".draw-source").classed("draw-source", false);
  callbacks.onDrawModeChange?.(false);
}

// ── Init ───────────────────────────────────────────────────────────────────
export function init(selector, caseData, cbs) {
  callbacks = cbs;
  nodes.clear();
  connections.clear();
  drawMode = false;
  drawSourceId = null;

  const container = document.querySelector(selector);
  container.innerHTML = "";

  svg = d3
    .select(selector)
    .attr("width", "100%")
    .attr("height", "100%");

  // ── Arrowhead marker ──────────────────────────────────────────────────
  svg.append("defs")
    .append("marker")
    .attr("id", "arrowhead")
    .attr("viewBox", "0 0 10 10")
    .attr("refX", 9)
    .attr("refY", 5)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M 0,0 L 10,5 L 0,10 Z")
    .attr("fill", "context-stroke");

  const zoom = d3
    .zoom()
    .scaleExtent([0.08, 5])
    .on("zoom", (e) => zoomGroup.attr("transform", e.transform));

  svg.call(zoom);
  svg.on("click.canvas", (event) => {
    if (drawMode && event.target === svg.node()) cancelDrawMode();
  });

  d3.select(document).on("keydown.canvas", (e) => {
    if (e.key === "Escape" && drawMode) cancelDrawMode();
  });

  zoomGroup  = svg.append("g").attr("id", "zoom-group");
  linksGroup = zoomGroup.append("g").attr("id", "links-group");
  nodesGroup = zoomGroup.append("g").attr("id", "nodes-group");

  caseData.papers.forEach((p) => addPaper(p));
  caseData.postits.forEach((p) => addPostit(p));
  caseData.connections.forEach((c) => addConnection(c));
}

// ── Paper layout engine ────────────────────────────────────────────────────
// All measurements in px. Returns positions and computed card height.
const TITLE_LH  = 15;   // title line height
const META_LH   = 13;   // author / venue line height
const BTN_H     = 22;
const CHARS_TITLE  = 38;
const CHARS_META   = 44;  // ~10px font, 270px wide node

function computePaperLayout(paper, expanded) {
  const allAuthors = parseAuthors(paper.authors || "");
  const hasMore    = allAuthors.length > 3;
  const authorStr  = (expanded || !hasMore)
    ? allAuthors.map(shortAuthorName).join(", ")
    : allAuthors.slice(0, 3).map(shortAuthorName).join(", ");

  const titleLines  = wrapText(paper.title || "", CHARS_TITLE).slice(0, 2);
  const authorLines = wrapText(authorStr, CHARS_META);
  const venueLines  = wrapText(paper.venue || "", CHARS_META);

  // y=0..22: header (bibkey, year, separator)
  let y = 22 + 10;                            // first title baseline

  const titleY = y + TITLE_LH - 2;           // baseline of first title line
  y += titleLines.length * TITLE_LH + 6;

  const authorsY = y + META_LH - 2;
  y += Math.max(1, authorLines.length) * META_LH + 4;

  const venueY = y + META_LH - 2;
  y += (venueLines.length > 0 ? venueLines.length * META_LH : 0) + 8;

  const btnsY  = y;
  const totalH = btnsY + BTN_H + 6;

  return { titleLines, authorLines, venueLines, hasMore, allAuthors, titleY, authorsY, venueY, btnsY, totalH };
}

// Draws (or redraws) all children of g for a paper node.
// g must already have datum(d) set.
function drawPaperContent(g, d, expanded) {
  g.selectAll("*").remove();

  const lay = computePaperLayout(d, expanded);
  const H   = lay.totalH;
  d._h = H;  // store for nodeCenter / nodeEdgePoint

  // ── card shape ────────────────────────────────────────────────────────────
  g.append("path")
    .attr("class", "card-bg")
    .attr("d", `M 0,0 L ${PAPER_W - FOLD},0 L ${PAPER_W},${FOLD} L ${PAPER_W},${H} L 0,${H} Z`);
  g.append("path")
    .attr("class", "card-fold")
    .attr("d", `M ${PAPER_W - FOLD},0 L ${PAPER_W},${FOLD} L ${PAPER_W - FOLD},${FOLD} Z`);

  // ── warning strip ─────────────────────────────────────────────────────────
  if (!d.bibtex_key) {
    g.append("rect").attr("class", "card-warn-strip")
      .attr("x", 0).attr("y", 0).attr("width", 4).attr("height", H).attr("rx", 2);
  }

  // ── delete button (fold kink circle) ──────────────────────────────────────
  const DEL_CX = PAPER_W - FOLD * 0.5;
  const DEL_CY = FOLD * 0.5;
  const delG = g.append("g").attr("class", "del-btn");
  delG.append("circle").attr("cx", DEL_CX).attr("cy", DEL_CY).attr("r", 8);
  delG.append("text").attr("x", DEL_CX).attr("y", DEL_CY + 4.5)
    .attr("text-anchor", "middle").text("×");
  delG.style("cursor", "pointer").on("click", (event) => {
    event.stopPropagation();
    callbacks.onDeleteNode?.(d.id, "paper");
  });

  // ── header ────────────────────────────────────────────────────────────────
  g.append("text").attr("class", "paper-bibkey")
    .attr("x", 8).attr("y", 15).attr("text-anchor", "start")
    .text(d.bibtex_key || "");
  g.append("text").attr("class", "paper-year")
    .attr("x", PAPER_W - FOLD - 5).attr("y", 15).attr("text-anchor", "end")
    .text(d.year || "");
  g.append("line").attr("class", "paper-sep")
    .attr("x1", 0).attr("y1", 22).attr("x2", PAPER_W).attr("y2", 22);

  // ── title ─────────────────────────────────────────────────────────────────
  lay.titleLines.forEach((line, i) => {
    g.append("text").attr("class", "paper-title")
      .attr("x", 8).attr("y", lay.titleY + i * TITLE_LH).text(line);
  });

  // ── authors ───────────────────────────────────────────────────────────────
  lay.authorLines.forEach((line, i) => {
    const isLast = i === lay.authorLines.length - 1;
    const txt = g.append("text").attr("class", "paper-meta")
      .attr("x", 8).attr("y", lay.authorsY + i * META_LH);

    if (isLast && lay.hasMore) {
      txt.append("tspan").text(line);
      txt.append("tspan").attr("class", "paper-authors-more")
        .style("cursor", "pointer")
        .text(expanded ? " ↑" : " et al.")
        .on("click", (event) => {
          event.stopPropagation();
          drawPaperContent(g, d, !expanded);
          refreshConnections();
        });
    } else {
      txt.text(line);
    }
  });

  // ── venue ─────────────────────────────────────────────────────────────────
  lay.venueLines.forEach((line, i) => {
    g.append("text").attr("class", "paper-venue")
      .attr("x", 8).attr("y", lay.venueY + i * META_LH).text(line);
  });

  // ── buttons (flush to bottom) ─────────────────────────────────────────────
  const viewG = g.append("g").attr("class", "view-btn")
    .attr("transform", `translate(8,${lay.btnsY})`);
  viewG.append("rect").attr("width", 100).attr("height", BTN_H).attr("rx", 3);
  viewG.append("text").attr("x", 50).attr("y", 15).attr("text-anchor", "middle").text("View Paper");
  viewG.style("cursor", "pointer").on("click", (event) => {
    event.stopPropagation();
    callbacks.onPaperClick?.(d.id);
  });

  const bibCls = d.bibtex_key ? "bib-btn" : "bib-btn bib-btn-missing";
  const bibG   = g.append("g").attr("class", bibCls)
    .attr("transform", `translate(116,${lay.btnsY})`);
  bibG.append("rect").attr("width", 52).attr("height", BTN_H).attr("rx", 3);
  bibG.append("text").attr("x", 26).attr("y", 15).attr("text-anchor", "middle")
    .text(d.bibtex_key ? "BIB" : "? BIB");
  bibG.style("cursor", "pointer").on("click", (event) => {
    event.stopPropagation();
    callbacks.onBibtexClick?.(d.id);
  });

  const refsG = g.append("g").attr("class", "refs-btn")
    .attr("transform", `translate(176,${lay.btnsY})`);
  refsG.append("rect").attr("width", 82).attr("height", BTN_H).attr("rx", 3);
  refsG.append("text").attr("x", 41).attr("y", 15).attr("text-anchor", "middle").text("References");
  refsG.style("cursor", "pointer").on("click", (event) => {
    event.stopPropagation();
    callbacks.onRefsClick?.(d.id);
  });
}

// ── Paper node (file-shaped) ───────────────────────────────────────────────
export function addPaper(paper) {
  const d = { ...paper, type: "paper" };
  nodes.set(d.id, d);

  const g = nodesGroup
    .append("g")
    .attr("class", "node-group node-paper")
    .attr("data-id", d.id)
    .attr("transform", `translate(${d.x},${d.y})`)
    .datum(d)
    .call(makeDrag());

  drawPaperContent(g, d, false);

  g.on("click.draw", (event) => {
    if (!drawMode) return;
    event.stopPropagation();
    handleNodeClickInDrawMode(d.id);
  });
}

// ── Post-it node ───────────────────────────────────────────────────────────
export function addPostit(postit) {
  const d = { ...postit, type: "postit" };
  nodes.set(d.id, d);

  const g = nodesGroup
    .append("g")
    .attr("class", "node-group node-postit")
    .attr("data-id", d.id)
    .attr("transform", `translate(${d.x},${d.y})`)
    .datum(d)
    .call(makeDrag());

  g.append("rect")
    .attr("class", "postit-bg")
    .attr("width", POSTIT_W)
    .attr("height", POSTIT_H)
    .attr("rx", 3)
    .attr("fill", d.color);

  const lines = wrapText(d.content || "Double-click to edit", 22);
  lines.slice(0, 7).forEach((line, i) => {
    g.append("text")
      .attr("class", "postit-text")
      .attr("x", 10)
      .attr("y", 20 + i * 16)
      .attr("fill", "#1a1a1a")
      .attr("font-size", "12px")
      .text(line);
  });

  const delG = g.append("g").attr("class", "del-btn").attr("transform", `translate(${POSTIT_W - 24},4)`);
  delG.append("rect").attr("width", 20).attr("height", 20).attr("rx", 3);
  delG.append("text").attr("x", 10).attr("y", 15).attr("text-anchor", "middle").text("×");
  delG.style("cursor", "pointer").on("click", (event) => {
    event.stopPropagation();
    callbacks.onDeleteNode?.(d.id, "postit");
  });

  g.on("dblclick.edit", (event) => {
    event.stopPropagation();
    callbacks.onPostitEdit?.(d.id, d.x, d.y, d.content, d.color);
  });

  g.on("click.draw", (event) => {
    if (!drawMode) return;
    event.stopPropagation();
    handleNodeClickInDrawMode(d.id);
  });
}

function wrapText(text, charsPerLine) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length > charsPerLine) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = (current + " " + w).trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Update post-it content ─────────────────────────────────────────────────
export function updatePostitContent(id, content, color) {
  const d = nodes.get(id);
  if (!d) return;
  d.content = content;
  if (color) d.color = color;

  const g = nodesGroup.select(`[data-id="${id}"]`);
  g.selectAll("text.postit-text").remove();
  if (color) g.select(".postit-bg").attr("fill", color);

  const lines = wrapText(content || "Double-click to edit", 22);
  lines.slice(0, 7).forEach((line, i) => {
    g.append("text")
      .attr("class", "postit-text")
      .attr("x", 10)
      .attr("y", 20 + i * 16)
      .attr("fill", "#1a1a1a")
      .attr("font-size", "12px")
      .text(line);
  });
}

// ── Connection ─────────────────────────────────────────────────────────────
export function addConnection(conn) {
  if (connections.has(conn.id)) return;
  connections.set(conn.id, conn);

  const path = curvePath(conn);
  const mid  = midPoint(conn);

  const g = linksGroup
    .append("g")
    .attr("class", "link-group")
    .attr("data-conn-id", conn.id)
    .datum(conn);

  // Wide invisible hitbox
  g.append("path")
    .attr("class", "link-hitbox")
    .attr("d", path)
    .attr("stroke", "transparent")
    .attr("stroke-width", 22)
    .attr("fill", "none")
    .on("click", (event) => {
      event.stopPropagation();
      if (!drawMode) callbacks.onConnectionClick?.(conn.id);
    });

  // Visible thread with arrowhead
  g.append("path")
    .attr("class", "link-path")
    .attr("d", path)
    .attr("stroke", conn.color)
    .attr("stroke-width", conn.thickness)
    .attr("fill", "none")
    .attr("marker-end", "url(#arrowhead)");

  // Annotation label
  g.append("text")
    .attr("class", "link-label")
    .attr("x", mid.x)
    .attr("y", mid.y - 6)
    .attr("text-anchor", "middle")
    .text(conn.annotation || "");
}

export function updateConnection(conn) {
  const existing = connections.get(conn.id);
  if (!existing) return;
  Object.assign(existing, conn);

  const g = linksGroup.select(`[data-conn-id="${conn.id}"]`).datum(existing);
  g.select(".link-path")
    .attr("stroke", conn.color)
    .attr("stroke-width", conn.thickness);
  g.select(".link-label").text(conn.annotation || "");
}

export function removeConnection(id) {
  connections.delete(id);
  linksGroup.select(`[data-conn-id="${id}"]`).remove();
}

// ── Update paper node metadata (re-renders in place) ──────────────────────
export function updatePaperNode(paper) {
  const d = nodes.get(paper.id);
  if (!d) return;
  nodesGroup.select(`[data-id="${paper.id}"]`).remove();
  nodes.delete(paper.id);
  addPaper({ ...paper, x: d.x, y: d.y });
}

// ── Remove node ────────────────────────────────────────────────────────────
export function removeNode(id) {
  nodes.delete(id);
  nodesGroup.select(`[data-id="${id}"]`).remove();
  const toRemove = [];
  connections.forEach((c, cid) => {
    if (c.source_id === id || c.target_id === id) toRemove.push(cid);
  });
  toRemove.forEach((cid) => removeConnection(cid));
}

// ── Apply layout positions ─────────────────────────────────────────────────
// positions: Map<id, {x, y}>  (top-left corner coordinates)
export function applyPositions(positions) {
  positions.forEach((pos, id) => {
    const d = nodes.get(id);
    if (!d) return;
    d.x = pos.x;
    d.y = pos.y;
    nodesGroup.select(`[data-id="${id}"]`).attr("transform", `translate(${d.x},${d.y})`);
  });
  refreshConnections();
}

// ── Draw mode toggle ───────────────────────────────────────────────────────
export function setDrawMode(enabled) {
  drawMode = enabled;
  if (!enabled) {
    drawSourceId = null;
    nodesGroup.selectAll(".draw-source").classed("draw-source", false);
  }
  svg.classed("draw-mode", enabled);
}
