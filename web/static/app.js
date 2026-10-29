// ihatepdf web UI — dependency-free vanilla JavaScript.
// PDF work happens right here in the browser with the bundled pdf-lib
// (create/modify PDFs) and pdf.js (render pages); files only go to the
// server when they are saved to "My files".
(() => {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const I18N = window.IhatepdfI18n;
  const t = I18N.t;
  const tn = I18N.tn;
  const loc = () => I18N.locale();
  const PDFLib = window.PDFLib;

  const state = {
    user: null,
    signupEnabled: false,
    authMode: "login",
    maxFileBytes: 50 * 1024 * 1024,
    quotaBytes: 0,
    view: "home", // home | files | tool | editor
    tool: null, // current tool session (see openTool)
    files: { documents: [], used_bytes: 0, quota_bytes: 0 },
  };

  // ---------- utilities ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function fmtSize(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const n = new Intl.NumberFormat(loc(), { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v);
    return `${n}\u00a0${units[i]}`;
  }

  function fmtWhen(unix) {
    const d = new Date(unix * 1000);
    return d.toLocaleString(loc(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // "contract.pdf" -> "contract"
  function baseName(name) {
    return String(name || "document").replace(/\.[a-z0-9]{1,5}$/i, "") || "document";
  }

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("leaving");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add("leaving");
      toastTimer = setTimeout(() => { el.hidden = true; el.classList.remove("leaving"); }, reducedMotion() ? 0 : 200);
    }, 3200);
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function showError(el, msg) { if (!el) return; el.textContent = msg || ""; el.hidden = !msg; }

  // Dialogs fade/slide out before they actually close.
  function enhanceDialog(d) {
    const nativeClose = d.close.bind(d);
    const nativeShow = d.showModal.bind(d);
    let timer = null;
    d.close = (ret) => {
      if (!d.open || timer) return;
      if (reducedMotion()) { nativeClose(ret); return; }
      d.classList.add("closing");
      timer = setTimeout(() => { timer = null; d.classList.remove("closing"); nativeClose(ret); }, 160);
    };
    d.showModal = () => {
      if (timer) { clearTimeout(timer); timer = null; d.classList.remove("closing"); return; }
      nativeShow();
    };
    d.addEventListener("cancel", (e) => { e.preventDefault(); d.close(); });
  }

  function localGet(k) { try { return localStorage.getItem(`ihatepdf.${k}`); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem(`ihatepdf.${k}`, v); } catch { /* ignore */ } }

  // Busy overlay with progress text for long operations.
  let busyDepth = 0;
  function busy(on, text) {
    busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
    const el = $("#busy");
    el.hidden = busyDepth === 0;
    if (on) $("#busy-text").textContent = text || t("busy.working");
  }
  function busyText(text) { $("#busy-text").textContent = text; }
  // Lets the browser paint (progress text) during long loops.
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function api(method, path, body) {
    const opts = { method, credentials: "same-origin", headers: { "X-Requested-With": "ihatepdf" } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return handle(await fetch(`/api${path}`, opts), path);
  }

  // Raw PDF upload (POST/PUT with an application/pdf body).
  async function apiPdf(method, path, bytes) {
    const res = await fetch(`/api${path}`, {
      method, credentials: "same-origin",
      headers: { "X-Requested-With": "ihatepdf", "Content-Type": "application/pdf" },
      body: new Blob([bytes], { type: "application/pdf" }),
    });
    return handle(res, path);
  }

  async function handle(res, path) {
    if (res.status === 401 && !path.startsWith("/auth/")) {
      state.user = null;
      showAuth();
      throw new Error(t("auth.signInAgain"));
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
      if (res.status === 413 && !(data && data.error)) throw new Error(t("files.tooLarge", { max: fmtSize(state.maxFileBytes) }));
      throw new Error((data && data.error && I18N.serverError(data.error)) || t("common.requestFailed", { status: res.status }));
    }
    return data;
  }

  async function fetchDocumentBytes(id) {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}/file`, { credentials: "same-origin", headers: { "X-Requested-With": "ihatepdf" } });
    if (!res.ok) await handle(res, "/documents");
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---------- files: download, share, zip ----------

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function canShareFiles() {
    if (!navigator.share || !navigator.canShare || typeof File !== "function") return false;
    try { return navigator.canShare({ files: [new File(["%PDF-"], "t.pdf", { type: "application/pdf" })] }); } catch { return false; }
  }

  async function shareBlob(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    try {
      if (!canShareFiles() || !navigator.canShare({ files: [file] })) { downloadBlob(blob, name); toast(t("out.downloaded")); return; }
      await navigator.share({ files: [file], title: name });
    } catch (e) {
      if (e && e.name === "AbortError") return;
      downloadBlob(blob, name);
      toast(t("out.downloaded"));
    }
  }

  // Minimal ZIP writer (stored, no compression: PDFs and JPEGs are already compressed).
  const CRC_TABLE = (() => {
    const tbl = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tbl[n] = c >>> 0;
    }
    return tbl;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(entries) { // [{name, bytes: Uint8Array}]
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const used = new Set();
    for (const e of entries) {
      let name = e.name, i = 2;
      while (used.has(name)) name = e.name.replace(/(\.[^.]+)?$/, ` (${i++})$1`);
      used.add(name);
      const nameBytes = enc.encode(name);
      const crc = crc32(e.bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true); local.setUint32(18, e.bytes.length, true); local.setUint32(22, e.bytes.length, true);
      local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, e.bytes);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, e.bytes.length, true); cen.setUint32(24, e.bytes.length, true);
      cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameBytes);
      offset += 30 + nameBytes.length + e.bytes.length;
    }
    const cenSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }

  // ---------- PDF libraries ----------

  let pdfjsPromise = null;
  function pdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import("./vendor/pdfjs/pdf.min.js").then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.js", location.href).href;
        return lib;
      }).catch((e) => { pdfjsPromise = null; throw e; });
    }
    return pdfjsPromise;
  }

  async function openPdfjs(bytes) {
    const lib = await pdfjs();
    const base = new URL("vendor/pdfjs/", location.href).href;
    // pdf.js transfers (detaches) the buffer it gets: always pass a copy.
    const task = lib.getDocument({
      data: bytes.slice(),
      cMapUrl: base + "cmaps/", cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/",
      wasmUrl: base + "wasm/", iccUrl: base + "iccs/",
      isEvalSupported: false,
      enableXfa: false,
    });
    try {
      return await task.promise;
    } catch (e) {
      if (e && e.name === "PasswordException") throw new Error(t("pdf.encrypted"));
      throw new Error(t("pdf.unreadable"));
    }
  }

  async function loadPdf(bytes) {
    try {
      return await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      if (e && /encrypt/i.test(String(e.message || e))) throw new Error(t("pdf.encrypted"));
      throw new Error(t("pdf.unreadable"));
    }
  }

  async function savePdf(doc) {
    return doc.save({ useObjectStreams: true });
  }

  // Text and images are placed in "displayed" page coordinates (what you see,
  // with the page's /Rotate applied, origin bottom-left). This maps a point to
  // the unrotated PDF user space and returns the extra rotation for drawing.
  function displayedBox(page) {
    const box = page.getCropBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    return { box, rot, width: swap ? box.height : box.width, height: swap ? box.width : box.height };
  }
  function toUserSpace(page, u, v) {
    const { box, rot } = displayedBox(page);
    const W = box.width, H = box.height;
    let x = u, y = v;
    if (rot === 90) { x = W - v; y = u; }
    else if (rot === 180) { x = W - u; y = H - v; }
    else if (rot === 270) { x = v; y = H - u; }
    return { x: box.x + x, y: box.y + y, rotate: rot };
  }

  // Renders text to a PNG with the system fonts, for scripts the built-in PDF
  // font (Helvetica, Latin only) cannot show (Cyrillic, Greek, CJK, ...).
  async function textToPng(text, sizePt, color) {
    const k = 4; // 4 px per point: sharp when printed
    const font = `${sizePt * k}px Helvetica, Arial, "Segoe UI", system-ui, sans-serif`;
    const c = document.createElement("canvas");
    let ctx = c.getContext("2d");
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 4;
    const hgt = Math.ceil(sizePt * k * 1.3);
    c.width = Math.max(1, w); c.height = Math.max(1, hgt);
    ctx = c.getContext("2d");
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, 2, Math.round(sizePt * k * 1.0));
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width / k, height: c.height / k, baseline: sizePt * 0.3 };
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) || [0, "00", "00", "00"];
    return PDFLib.rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
  }

  // Draws text at displayed point (u, v) (baseline start), rotated by angle
  // degrees (counter-clockwise, displayed). Uses Helvetica when it can encode
  // the text, otherwise a rendered image of it.
  async function drawTextDisplayed(doc, page, font, text, u, v, opts) {
    const { size, color, angle = 0, opacity = 1 } = opts;
    const p = toUserSpace(page, u, v);
    const rotate = PDFLib.degrees(p.rotate + angle);
    let encodable = true;
    try { font.encodeText(text); } catch { encodable = false; }
    if (encodable) {
      page.drawText(text, { x: p.x, y: p.y, size, font, color: hexToRgb(color), rotate, opacity });
      return;
    }
    const img = await textToPng(text, size, color);
    const png = await doc.embedPng(img.bytes);
    // The image's bottom edge sits below the baseline: shift it down along the text normal.
    const rad = ((p.rotate + angle) * Math.PI) / 180;
    const dx = Math.sin(rad) * img.baseline, dy = -Math.cos(rad) * img.baseline;
    page.drawImage(png, { x: p.x + dx, y: p.y + dy, width: img.width, height: img.height, rotate, opacity });
  }

  function textWidth(font, text, size) {
    try { return font.widthOfTextAtSize(text, size); } catch {
      const c = document.createElement("canvas").getContext("2d");
      c.font = `${size}px Helvetica, Arial, sans-serif`;
      return c.measureText(text).width;
    }
  }

  // "1-3, 5, 8-" -> [[1,3],[5,5],[8,total]] (1-based, inclusive).
  function parseRanges(raw, total) {
    const out = [];
    const parts = String(raw || "").split(/[,;\s]+/).filter(Boolean);
    if (!parts.length) throw new Error(t("range.empty"));
    for (const part of parts) {
      const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) || /^(\d+)$/.exec(part);
      if (!m) throw new Error(t("range.invalid", { part }));
      let a, b;
      if (m.length === 2) { a = b = Number(m[1]); } else {
        a = m[1] === "" ? 1 : Number(m[1]);
        b = m[2] === "" ? total : Number(m[2]);
      }
      if (!a || !b || a > b || b > total) throw new Error(t("range.outOf", { part, total }));
      out.push([a, b]);
    }
    return out;
  }
  function rangePages(ranges) {
    const pages = [];
    for (const [a, b] of ranges) for (let i = a; i <= b; i++) pages.push(i - 1);
    return pages;
  }

  // ---------- auth ----------

  function setPasswordVisible(visible) {
    const input = $("#auth-form").password;
    const btn = $("#password-toggle");
    input.type = visible ? "text" : "password";
    $("#auth-form").password_confirm.type = visible ? "text" : "password";
    btn.setAttribute("aria-pressed", String(visible));
    const label = t(visible ? "auth.hidePassword" : "auth.showPassword");
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }

  function togglePasswordVisible() {
    const input = $("#auth-form").password;
    const pos = [input.selectionStart, input.selectionEnd];
    setPasswordVisible(input.type === "password");
    input.focus();
    try { input.setSelectionRange(pos[0], pos[1]); } catch { /* ignore */ }
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const signup = mode === "signup";
    $("#tab-login").classList.toggle("active", !signup);
    $("#tab-signup").classList.toggle("active", signup);
    $("#tab-login").setAttribute("aria-selected", String(!signup));
    $("#tab-signup").setAttribute("aria-selected", String(signup));
    $("#name-field").hidden = !signup;
    $("#confirm-field").hidden = !signup;
    $("#auth-form").password_confirm.disabled = !signup;
    $("#auth-form").password_confirm.required = signup;
    if (!signup) $("#auth-form").password_confirm.value = "";
    $("#auth-submit").textContent = t(signup ? "auth.createAccount" : "auth.signIn");
    $("#auth-form").password.autocomplete = signup ? "new-password" : "current-password";
    setPasswordVisible(false);
    showError($("#auth-error"), "");
  }

  function showAuth() {
    $("#app-view").hidden = true;
    $("#auth-view").hidden = false;
    $("#tab-signup").hidden = !state.signupEnabled;
    $("#signup-disabled").hidden = state.signupEnabled;
    if (!state.signupEnabled) setAuthMode("login");
    setPasswordVisible(false);
    $("#auth-form").email.focus();
  }

  async function onAuthSubmit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const btn = $("#auth-submit");
    btn.disabled = true;
    showError($("#auth-error"), "");
    try {
      const body = { email: f.email.value, password: f.password.value };
      if (state.authMode === "signup") { body.display_name = f.display_name.value; body.password_confirm = f.password_confirm.value; }
      if (state.authMode === "signup" && body.password.length < 8) throw new Error(t("auth.passwordShort"));
      if (state.authMode === "signup" && body.password !== f.password_confirm.value) throw new Error(t("auth.passwordMismatch"));
      state.user = await api("POST", `/auth/${state.authMode}`, body);
      f.reset();
      setPasswordVisible(false);
      enterApp();
    } catch (e) {
      showError($("#auth-error"), e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function logout() {
    if (editorDirty() && !confirm(t("ed.confirmLeave"))) return;
    try { await api("POST", "/auth/logout"); } catch { /* ignore */ }
    closeEditor(true);
    state.user = null;
    showAuth();
  }

  function enterApp() {
    $("#auth-view").hidden = true;
    $("#app-view").hidden = false;
    $("#me-name").textContent = state.user.display_name;
    route();
  }

  // ---------- navigation ----------
  // #/ (home), #/files, #/tool/<id>, #/edit (editor; needs an open document)

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route() {
    if (!state.user) return;
    const hash = location.hash.replace(/^#\/?/, "");
    const [section, arg] = hash.split("/");
    if (section !== "edit" && state.view === "editor") {
      if (editorDirty() && !confirm(t("ed.confirmLeave"))) { history.replaceState(null, "", "#/edit"); return; }
      closeEditor(true);
    }
    closeSidebar();
    if (section === "files") return showFiles();
    if (section === "tool" && TOOLS[arg]) return showTool(arg);
    if (section === "edit" && editor) return showView("editor");
    showHome();
  }

  function showView(name) {
    state.view = name;
    for (const v of ["home", "files", "tool", "editor"]) $(`#view-${v}`).hidden = v !== name;
    $("#app-view").classList.toggle("editing", name === "editor");
    document.querySelectorAll("#tool-nav button").forEach((b) => {
      const active = (name === "tool" && state.tool && b.dataset.tool === state.tool.id) ||
        (name === "files" && b.dataset.tool === "files") || (name === "home" && b.dataset.tool === "home") ||
        (name === "editor" && editor && b.dataset.tool === editor.toolId);
      b.classList.toggle("active", !!active);
    });
    const main = $("#main-scroll");
    if (main) main.scrollTop = 0;
  }

  function setTitle(text) { $("#view-title").textContent = text; }

  // ---------- sidebar ----------

  const narrowScreen = window.matchMedia ? window.matchMedia("(max-width: 820px)") : null;
  function isNarrow() { return !!(narrowScreen && narrowScreen.matches); }
  function setSidebar(open) {
    $("#sidebar").classList.toggle("open", open);
    syncMenuToggle();
  }
  function desktopSidebarHidden() { return $("#app-view").classList.contains("sidebar-hidden"); }
  function setDesktopSidebar(hidden) {
    $("#app-view").classList.toggle("sidebar-hidden", hidden);
    localSet("sidebar", hidden ? "hidden" : "shown");
    syncMenuToggle();
  }
  function syncMenuToggle() {
    const open = isNarrow() ? $("#sidebar").classList.contains("open") : !desktopSidebarHidden();
    $("#menu-toggle").setAttribute("aria-expanded", String(open));
  }
  function toggleSidebar() {
    if (isNarrow()) setSidebar(!$("#sidebar").classList.contains("open"));
    else setDesktopSidebar(!desktopSidebarHidden());
  }
  function closeSidebar() {
    const open = $("#sidebar").classList.contains("open");
    if (open) setSidebar(false);
    return open && isNarrow();
  }

  function renderNav() {
    const item = (id, icon, label) => h("li", null, h("button", {
      type: "button", "data-tool": id,
      onclick: () => go(id === "home" ? "#/" : id === "files" ? "#/files" : `#/tool/${id}`),
    }, h("span", { class: `nav-ico ico-${id}`, "aria-hidden": "true" }, icon), h("span", { class: "nav-label" }, label)));
    $("#tool-nav").replaceChildren(
      item("home", "⌂", t("nav.allTools")),
      item("files", "▤", t("nav.myFiles")),
      ...TOOL_ORDER.map((id) => item(id, TOOLS[id].icon, t(`tool.${id}.title`))),
    );
    showView(state.view);
  }

  // ---------- home ----------

  function showHome() {
    state.tool = null;
    setTitle(t("home.title"));
    const pending = state.pendingDoc;
    $("#home-pending").hidden = !pending;
    if (pending) $("#home-pending-text").textContent = t("files.pickTool", { name: pending.name });
    $("#home-grid").replaceChildren(...TOOL_ORDER.map((id) => h("li", null,
      h("button", { type: "button", class: `tool-card tc-${id}`, onclick: () => go(`#/tool/${id}`) },
        h("span", { class: `tool-ico ico-${id}`, "aria-hidden": "true" }, TOOLS[id].icon),
        h("span", { class: "tool-name" }, t(`tool.${id}.title`)),
        h("span", { class: "tool-desc" }, t(`tool.${id}.desc`))))));
    showView("home");
  }

  // ---------- My files ----------

  async function loadFiles() {
    state.files = await api("GET", "/documents");
    state.maxFileBytes = state.files.max_file_bytes || state.maxFileBytes;
    return state.files;
  }

  async function showFiles() {
    state.tool = null;
    setTitle(t("nav.myFiles"));
    showView("files");
    $("#files-list").replaceChildren(h("li", { class: "muted" }, t("common.loading")));
    try {
      await loadFiles();
      renderFiles();
    } catch (e) {
      $("#files-list").replaceChildren(h("li", { class: "error" }, e.message));
    }
  }

  function renderFiles() {
    const { documents, used_bytes: used, quota_bytes: quota } = state.files;
    $("#files-usage").textContent = quota > 0
      ? t("files.usage", { used: fmtSize(used), quota: fmtSize(quota) })
      : t("files.usageNoQuota", { used: fmtSize(used) });
    const bar = $("#files-quota-bar");
    bar.hidden = !(quota > 0);
    if (quota > 0) bar.value = Math.min(100, (used / quota) * 100);
    if (!documents.length) {
      $("#files-list").replaceChildren(h("li", { class: "files-empty muted" }, t("files.empty")));
      return;
    }
    $("#files-list").replaceChildren(...documents.map((d) => h("li", { class: "file-row" },
      h("button", { type: "button", class: "file-main", title: t("files.open"), onclick: () => openDocumentInEditor(d) },
        h("span", { class: "file-ico", "aria-hidden": "true" }, "PDF"),
        h("span", { class: "file-text" },
          h("span", { class: "file-name" }, d.name),
          h("span", { class: "muted small" }, [
            d.pages ? tn("common.pages", d.pages) : null, fmtSize(d.size), fmtWhen(d.updated_at),
          ].filter(Boolean).join(" · ")))),
      h("div", { class: "file-actions" },
        h("button", { type: "button", class: "btn ghost small", onclick: () => useInTool(d) }, t("files.use")),
        h("button", { type: "button", class: "btn ghost small", onclick: () => downloadDocument(d) }, t("files.download")),
        h("button", { type: "button", class: "btn ghost small", onclick: () => renameDocument(d) }, t("files.rename")),
        h("button", { type: "button", class: "btn ghost small danger", onclick: () => deleteDocument(d) }, t("files.delete"))))));
  }

  async function downloadDocument(d) {
    busy(true, t("busy.loading"));
    try {
      const bytes = await fetchDocumentBytes(d.id);
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), d.name);
    } catch (e) { toast(e.message); } finally { busy(false); }
  }

  async function renameDocument(d) {
    const name = await promptText(t("files.renameTitle"), d.name);
    if (name === null) return;
    try {
      await api("PATCH", `/documents/${d.id}`, { name });
      toast(t("files.renamed"));
      await loadFiles();
      renderFiles();
    } catch (e) { toast(e.message); }
  }

  async function deleteDocument(d) {
    if (!confirm(t("files.confirmDelete", { name: d.name }))) return;
    try {
      await api("DELETE", `/documents/${d.id}`);
      toast(t("files.deleted"));
      await loadFiles();
      renderFiles();
    } catch (e) { toast(e.message); }
  }

  // Upload PDFs from the device straight into My files.
  async function uploadToFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    busy(true, t("busy.uploading"));
    let ok = 0;
    try {
      for (const f of files) {
        busyText(t("busy.uploadingName", { name: f.name }));
        if (!isPdfFile(f)) { toast(t("input.notPdf", { name: f.name })); continue; }
        if (f.size > state.maxFileBytes) { toast(t("files.tooLarge", { max: fmtSize(state.maxFileBytes) })); continue; }
        const bytes = new Uint8Array(await f.arrayBuffer());
        let pages = 0;
        try { pages = (await loadPdf(bytes)).getPageCount(); } catch (e) { toast(`${f.name}: ${e.message}`); continue; }
        await apiPdf("POST", `/documents?name=${encodeURIComponent(f.name)}&pages=${pages}`, bytes);
        ok++;
      }
      if (ok) toast(tn("files.uploaded", ok));
    } catch (e) {
      toast(e.message);
    } finally {
      busy(false);
      if (state.view === "files") { await loadFiles().catch(() => {}); renderFiles(); }
    }
  }

  async function saveToFiles(bytes, name, pages, docId) {
    if (bytes.length > state.maxFileBytes) throw new Error(t("files.tooLarge", { max: fmtSize(state.maxFileBytes) }));
    const q = `name=${encodeURIComponent(name)}&pages=${pages || 0}`;
    if (docId) return apiPdf("PUT", `/documents/${docId}/file?${q}`, bytes);
    return apiPdf("POST", `/documents?${q}`, bytes);
  }

  function isPdfFile(f) { return f.type === "application/pdf" || /\.pdf$/i.test(f.name); }
  function isImageFile(f) { return /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i.test(f.name); }

  // Small text prompt dialog (rename, file name on save).
  function promptText(title, value) {
    return new Promise((resolve) => {
      const d = $("#prompt-dialog");
      const f = $("#prompt-form");
      $("#prompt-title").textContent = title;
      f.value.value = value || "";
      let result = null;
      const onSubmit = (e) => { e.preventDefault(); result = f.value.value.trim() || value; d.close(); };
      const onClose = () => { f.removeEventListener("submit", onSubmit); d.removeEventListener("close", onClose); resolve(result); };
      f.addEventListener("submit", onSubmit);
      d.addEventListener("close", onClose);
      d.showModal();
      f.value.focus();
      f.value.select();
    });
  }

  // Pick files from My files (for tools). Resolves to [{id, name, pages, size}] or null.
  async function pickFromFiles(multiple) {
    const d = $("#picker-dialog");
    const list = $("#picker-list");
    list.replaceChildren(h("li", { class: "muted" }, t("common.loading")));
    showError($("#picker-error"), "");
    d.showModal();
    try {
      await loadFiles();
    } catch (e) {
      showError($("#picker-error"), e.message);
      list.replaceChildren();
    }
    const docs = state.files.documents;
    const chosen = new Set();
    $("#picker-hint").textContent = t(multiple ? "picker.hintMany" : "picker.hintOne");
    $("#picker-ok").disabled = true;
    list.replaceChildren(...(docs.length ? docs.map((doc) => {
      const input = h("input", { type: multiple ? "checkbox" : "radio", name: "picker-doc", value: doc.id });
      input.addEventListener("change", () => {
        if (!multiple) chosen.clear();
        if (input.checked) chosen.add(doc.id); else chosen.delete(doc.id);
        $("#picker-ok").disabled = chosen.size === 0;
      });
      return h("li", null, h("label", { class: "picker-row" }, input,
        h("span", { class: "file-text" }, h("span", { class: "file-name" }, doc.name),
          h("span", { class: "muted small" }, [doc.pages ? tn("common.pages", doc.pages) : null, fmtSize(doc.size)].filter(Boolean).join(" · ")))));
    }) : [h("li", { class: "muted" }, t("files.empty"))]));
    return new Promise((resolve) => {
      let result = null;
      const ok = () => { result = docs.filter((x) => chosen.has(x.id)); d.close(); };
      const onClose = () => { $("#picker-ok").removeEventListener("click", ok); d.removeEventListener("close", onClose); resolve(result); };
      $("#picker-ok").addEventListener("click", ok);
      d.addEventListener("close", onClose);
    });
  }

  // ---------- tools ----------
  // Each tool: icon, what it takes (accept/multi/min), option controls and a
  // run() that returns output files [{name, bytes, mime, pages}]. "sign" and
  // "edit" open the page editor instead.

  const PDF_MIME = "application/pdf";

  const TOOLS = {
    merge: {
      icon: "⊞", accept: "pdf", multi: true, min: 2, reorder: true,
      async run(st) {
        const out = await PDFLib.PDFDocument.create();
        for (let i = 0; i < st.inputs.length; i++) {
          const inp = st.inputs[i];
          busyText(t("busy.fileOf", { n: i + 1, total: st.inputs.length }));
          const src = await loadPdf(inp.bytes);
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((p) => out.addPage(p));
          await tick();
        }
        const bytes = await savePdf(out);
        return [{ name: `${baseName(st.inputs[0].name)}-merged.pdf`, bytes, mime: PDF_MIME, pages: out.getPageCount() }];
      },
    },

    split: {
      icon: "✂", accept: "pdf", multi: false, min: 1,
      defaults: { mode: "ranges", ranges: "", mergeRanges: false, every: 1 },
      options(st) {
        const o = st.opts;
        const total = st.inputs[0] ? st.inputs[0].pages : 0;
        return [
          radioGroup("split-mode", t("split.mode"), [
            ["ranges", t("split.byRanges")], ["every", t("split.everyN")], ["all", t("split.allPages")],
          ], o.mode, (v) => { o.mode = v; renderOptions(); }),
          o.mode === "ranges" ? [
            field(t("split.ranges"), h("input", { type: "text", value: o.ranges, placeholder: total > 2 ? `1-2, 3-${total}` : "1-2", oninput: (e) => { o.ranges = e.target.value; } }),
              t("split.rangesHelp")),
            check(t("split.mergeRanges"), o.mergeRanges, (v) => { o.mergeRanges = v; }),
          ] : null,
          o.mode === "every" ? field(t("split.everyLabel"), number(o.every, 1, Math.max(1, total), (v) => { o.every = v; })) : null,
        ];
      },
      async run(st) {
        const inp = st.inputs[0];
        const src = await loadPdf(inp.bytes);
        const total = src.getPageCount();
        const o = st.opts;
        let groups;
        if (o.mode === "all") groups = src.getPageIndices().map((i) => [[i + 1, i + 1]]);
        else if (o.mode === "every") {
          const n = Math.max(1, Math.floor(o.every) || 1);
          groups = [];
          for (let a = 1; a <= total; a += n) groups.push([[a, Math.min(total, a + n - 1)]]);
        } else {
          const ranges = parseRanges(o.ranges, total);
          groups = o.mergeRanges ? [ranges] : ranges.map((r) => [r]);
        }
        const outs = [];
        for (let g = 0; g < groups.length; g++) {
          busyText(t("busy.fileOf", { n: g + 1, total: groups.length }));
          const doc = await PDFLib.PDFDocument.create();
          const pages = await doc.copyPages(src, rangePages(groups[g]));
          pages.forEach((p) => doc.addPage(p));
          const label = groups[g].map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join("_");
          outs.push({ name: `${baseName(inp.name)}-${label}.pdf`, bytes: await savePdf(doc), mime: PDF_MIME, pages: doc.getPageCount() });
          await tick();
        }
        return outs;
      },
    },

    remove: {
      icon: "⌫", accept: "pdf", multi: false, min: 1,
      defaults: { pages: "" },
      options(st) {
        return field(t("remove.pages"), h("input", { type: "text", value: st.opts.pages, placeholder: "2, 5-7", oninput: (e) => { st.opts.pages = e.target.value; } }),
          t("remove.help"));
      },
      async run(st) {
        const inp = st.inputs[0];
        const src = await loadPdf(inp.bytes);
        const drop = new Set(rangePages(parseRanges(st.opts.pages, src.getPageCount())));
        const keep = src.getPageIndices().filter((i) => !drop.has(i));
        if (!keep.length) throw new Error(t("remove.allPages"));
        const doc = await PDFLib.PDFDocument.create();
        (await doc.copyPages(src, keep)).forEach((p) => doc.addPage(p));
        return [{ name: `${baseName(inp.name)}-edited.pdf`, bytes: await savePdf(doc), mime: PDF_MIME, pages: doc.getPageCount() }];
      },
    },

    organize: {
      icon: "▦", accept: "pdf", multi: false, min: 1, pageGrid: true,
      async run(st) {
        const inp = st.inputs[0];
        const src = await loadPdf(inp.bytes);
        const order = st.grid.filter((p) => !p.deleted);
        if (!order.length) throw new Error(t("remove.allPages"));
        const doc = await PDFLib.PDFDocument.create();
        const pages = await doc.copyPages(src, order.map((p) => p.index));
        pages.forEach((p, i) => {
          const rot = (((p.getRotation().angle + order[i].rotate) % 360) + 360) % 360;
          p.setRotation(PDFLib.degrees(rot));
          doc.addPage(p);
        });
        return [{ name: `${baseName(inp.name)}-organized.pdf`, bytes: await savePdf(doc), mime: PDF_MIME, pages: doc.getPageCount() }];
      },
    },

    rotate: {
      icon: "↻", accept: "pdf", multi: false, min: 1,
      defaults: { angle: 90, which: "all", pages: "" },
      options(st) {
        const o = st.opts;
        return [
          radioGroup("rotate-angle", t("rotate.angle"), [["90", t("rotate.right")], ["180", t("rotate.half")], ["270", t("rotate.left")]],
            String(o.angle), (v) => { o.angle = Number(v); }),
          radioGroup("rotate-which", t("rotate.which"), [["all", t("common.allPages")], ["some", t("common.somePages")]],
            o.which, (v) => { o.which = v; renderOptions(); }),
          o.which === "some" ? field(t("common.pagesLabel"), h("input", { type: "text", value: o.pages, placeholder: "1, 3-4", oninput: (e) => { o.pages = e.target.value; } })) : null,
        ];
      },
      async run(st) {
        const inp = st.inputs[0];
        const doc = await loadPdf(inp.bytes);
        const idx = st.opts.which === "some" ? rangePages(parseRanges(st.opts.pages, doc.getPageCount())) : doc.getPageIndices();
        for (const i of new Set(idx)) {
          const p = doc.getPage(i);
          p.setRotation(PDFLib.degrees((p.getRotation().angle + st.opts.angle) % 360));
        }
        return [{ name: `${baseName(inp.name)}-rotated.pdf`, bytes: await savePdf(doc), mime: PDF_MIME, pages: doc.getPageCount() }];
      },
    },

    compress: {
      icon: "⇲", accept: "pdf", multi: false, min: 1,
      defaults: { level: "recommended" },
      options(st) {
        return [
          radioGroup("compress-level", t("compress.level"), [
            ["lossless", t("compress.lossless")], ["recommended", t("compress.recommended")], ["extreme", t("compress.extreme")],
          ], st.opts.level, (v) => { st.opts.level = v; renderOptions(); }),
          h("p", { class: "muted small" }, t(st.opts.level === "lossless" ? "compress.losslessHelp" : "compress.rasterHelp")),
        ];
      },
      async run(st) {
        const inp = st.inputs[0];
        let bytes, pages;
        if (st.opts.level === "lossless") {
          const doc = await loadPdf(inp.bytes);
          bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
          pages = doc.getPageCount();
        } else {
          const [dpi, quality] = st.opts.level === "extreme" ? [72, 0.5] : [120, 0.72];
          const pdf = await openPdfjs(inp.bytes);
          const doc = await PDFLib.PDFDocument.create();
          for (let i = 1; i <= pdf.numPages; i++) {
            busyText(t("busy.pageOf", { n: i, total: pdf.numPages }));
            const page = await pdf.getPage(i);
            const vp1 = page.getViewport({ scale: 1 });
            const jpg = await renderPageImage(page, dpi / 72, "image/jpeg", quality);
            const img = await doc.embedJpg(jpg);
            const out = doc.addPage([vp1.width, vp1.height]);
            out.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
            page.cleanup();
          }
          await pdf.destroy();
          bytes = await savePdf(doc);
          pages = doc.getPageCount();
        }
        const before = inp.bytes.length, after = bytes.length;
        const note = after < before
          ? t("compress.saved", { before: fmtSize(before), after: fmtSize(after), pct: Math.round((1 - after / before) * 100) })
          : t("compress.noGain", { before: fmtSize(before), after: fmtSize(after) });
        return [{ name: `${baseName(inp.name)}-compressed.pdf`, bytes, mime: PDF_MIME, pages, note }];
      },
    },

    numbers: {
      icon: "#", accept: "pdf", multi: false, min: 1,
      defaults: { position: "bc", start: 1, from: 1, format: "{n}", size: 11, margin: 28, color: "#000000" },
      options(st) {
        const o = st.opts;
        const formats = [["{n}", "1"], ["{n} / {total}", "1 / 9"], [t("numbers.fmtPage"), t("numbers.fmtPageExample")], [t("numbers.fmtPageOf"), t("numbers.fmtPageOfExample")]];
        return [
          positionPicker(o.position, (v) => { o.position = v; }),
          field(t("numbers.format"), select(formats.map(([v, l]) => [v, l]), o.format, (v) => { o.format = v; })),
          h("div", { class: "row" },
            field(t("numbers.start"), number(o.start, 0, 99999, (v) => { o.start = v; })),
            field(t("numbers.fromPage"), number(o.from, 1, 99999, (v) => { o.from = v; }))),
          h("div", { class: "row" },
            field(t("common.fontSize"), number(o.size, 6, 72, (v) => { o.size = v; })),
            field(t("common.color"), h("input", { type: "color", value: o.color, oninput: (e) => { o.color = e.target.value; } }))),
        ];
      },
      async run(st) {
        const inp = st.inputs[0];
        const o = st.opts;
        const doc = await loadPdf(inp.bytes);
        const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        const total = doc.getPageCount();
        const from = Math.max(1, Math.min(total, Math.floor(o.from) || 1));
        const numbered = total - from + 1;
        for (let i = from - 1; i < total; i++) {
          const page = doc.getPage(i);
          const n = Math.floor(o.start) + (i - (from - 1));
          const text = o.format.replace("{n}", n).replace("{total}", Math.floor(o.start) + numbered - 1);
          const { width, height } = displayedBox(page);
          const w = textWidth(font, text, o.size);
          const m = o.margin;
          const u = o.position[1] === "l" ? m : o.position[1] === "r" ? width - m - w : (width - w) / 2;
          const v = o.position[0] === "t" ? height - m - o.size * 0.75 : m;
          await drawTextDisplayed(doc, page, font, text, u, v, { size: o.size, color: o.color });
        }
        return [{ name: `${baseName(inp.name)}-numbered.pdf`, bytes: await savePdf(doc), mime: PDF_MIME, pages: total }];
      },
    },

    watermark: {
      icon: "≋", accept: "pdf", multi: false, min: 1,
      defaults: { text: "CONFIDENTIAL", size: 60, opacity: 25, angle: 45, color: "#d90f5a" },
      options(st) {
        const o = st.opts;
        return [
          field(t("watermark.text"), h("input", { type: "text", value: o.text, maxlength: "200", oninput: (e) => { o.text = e.target.value; } })),
          h("div", { class: "row" },
            field(t("common.fontSize"), number(o.size, 8, 300, (v) => { o.size = v; })),
            field(t("watermark.opacity"), number(o.opacity, 5, 100, (v) => { o.opacity = v; }))),
          h("div", { class: "row" },
            field(t("watermark.angle"), select([["45", "45°"], ["0", "0°"], ["-45", "−45°"], ["90", "90°"]], String(o.angle), (v) => { o.angle = Number(v); })),
            field(t("common.color"), h("input", { type: "color", value: o.color, oninput: (e) => { o.color = e.target.value; } }))),
        ];
      },
      async run(st) {
        const inp = st.inputs[0];
        const o = st.opts;
        const text = o.text.trim();
        if (!text) throw new Error(t("watermark.empty"));
        const doc = await loadPdf(inp.bytes);
        const font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
        const rad = (o.angle * Math.PI) / 180;
        for (const page of doc.getPages()) {
          const { width, height } = displayedBox(page);
          // Fit the text inside the page diagonal if it is too long.
          let size = o.size;
          const maxW = Math.abs(o.angle) === 45 ? Math.hypot(width, height) * 0.8 : (o.angle === 90 ? height : width) * 0.9;
          const w0 = textWidth(font, text, size);
          if (w0 > maxW) size = (size * maxW) / w0;
          const w = textWidth(font, text, size);
          const capH = size * 0.36;
          const cx = width / 2, cy = height / 2;
          const u = cx - Math.cos(rad) * (w / 2) + Math.sin(rad) * capH;
          const v = cy - Math.sin(rad) * (w / 2) - Math.cos(rad) * capH;
          await drawTextDisplayed(doc, page, font, text, u, v, { size, color: o.color, angle: o.angle, opacity: o.opacity / 100 });
        }
        return [{ name: `${baseName(inp.name)}-watermarked.pdf`, bytes: await savePdf(doc), mime: PDF_MIME, pages: doc.getPageCount() }];
      },
    },

    jpg2pdf: {
      icon: "▣", accept: "image", multi: true, min: 1, reorder: true,
      defaults: { size: "fit", orientation: "auto", margin: 0 },
      options(st) {
        const o = st.opts;
        return [
          h("div", { class: "row" },
            field(t("img.pageSize"), select([["fit", t("img.fit")], ["a4", "A4"], ["letter", "Letter"]], o.size, (v) => { o.size = v; renderOptions(); })),
            o.size !== "fit" ? field(t("img.orientation"), select([["auto", t("img.auto")], ["portrait", t("img.portrait")], ["landscape", t("img.landscape")]], o.orientation, (v) => { o.orientation = v; })) : null),
          field(t("img.margin"), select([["0", t("img.none")], ["20", t("img.small")], ["40", t("img.big")]], String(o.margin), (v) => { o.margin = Number(v); })),
        ];
      },
      async run(st) {
        const o = st.opts;
        const doc = await PDFLib.PDFDocument.create();
        for (let i = 0; i < st.inputs.length; i++) {
          busyText(t("busy.fileOf", { n: i + 1, total: st.inputs.length }));
          const { bytes, png, width, height } = await normalizeImage(st.inputs[i]);
          const img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          // Image size in points at 96 dpi for "fit".
          const iw = width * 0.75, ih = height * 0.75;
          let pw, ph;
          if (o.size === "fit") { pw = iw + 2 * o.margin; ph = ih + 2 * o.margin; } else {
            [pw, ph] = o.size === "a4" ? [595.28, 841.89] : [612, 792];
            const landscape = o.orientation === "landscape" || (o.orientation === "auto" && iw > ih);
            if (landscape) [pw, ph] = [ph, pw];
          }
          const page = doc.addPage([pw, ph]);
          const s = Math.min((pw - 2 * o.margin) / iw, (ph - 2 * o.margin) / ih, o.size === "fit" ? 1 : Infinity);
          const w = iw * s, hh = ih * s;
          page.drawImage(img, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
          await tick();
        }
        const name = st.inputs.length === 1 ? `${baseName(st.inputs[0].name)}.pdf` : "images.pdf";
        return [{ name, bytes: await savePdf(doc), mime: PDF_MIME, pages: doc.getPageCount() }];
      },
    },

    pdf2jpg: {
      icon: "◩", accept: "pdf", multi: false, min: 1,
      defaults: { dpi: 150, format: "jpeg" },
      options(st) {
        const o = st.opts;
        return h("div", { class: "row" },
          field(t("pdf2jpg.quality"), select([["72", t("pdf2jpg.low")], ["150", t("pdf2jpg.normal")], ["300", t("pdf2jpg.high")]], String(o.dpi), (v) => { o.dpi = Number(v); })),
          field(t("pdf2jpg.format"), select([["jpeg", "JPG"], ["png", "PNG"]], o.format, (v) => { o.format = v; })));
      },
      async run(st) {
        const inp = st.inputs[0];
        const pdf = await openPdfjs(inp.bytes);
        const outs = [];
        const ext = st.opts.format === "png" ? "png" : "jpg";
        const mime = st.opts.format === "png" ? "image/png" : "image/jpeg";
        for (let i = 1; i <= pdf.numPages; i++) {
          busyText(t("busy.pageOf", { n: i, total: pdf.numPages }));
          const page = await pdf.getPage(i);
          const bytes = await renderPageImage(page, st.opts.dpi / 72, mime, 0.9);
          outs.push({ name: `${baseName(inp.name)}-${String(i).padStart(String(pdf.numPages).length, "0")}.${ext}`, bytes, mime });
          page.cleanup();
        }
        await pdf.destroy();
        return outs;
      },
    },

    sign: { icon: "✍", accept: "pdf", multi: false, min: 1, editor: "signature" },
    edit: { icon: "✎", accept: "pdf", multi: false, min: 1, editor: "pen" },
  };

  const TOOL_ORDER = ["edit", "sign", "merge", "split", "organize", "remove", "rotate", "compress", "numbers", "watermark", "jpg2pdf", "pdf2jpg"];

  // Renders a pdf.js page into an image (JPEG/PNG bytes). The canvas is kept
  // under ~16 megapixels (iPad/iPhone canvas limit).
  async function renderPageImage(page, scale, mime, quality) {
    let vp = page.getViewport({ scale });
    const maxPx = 16e6;
    if (vp.width * vp.height > maxPx) vp = page.getViewport({ scale: scale * Math.sqrt(maxPx / (vp.width * vp.height)) });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, mime, quality));
    c.width = c.height = 0; // free memory right away (iOS)
    return new Uint8Array(await blob.arrayBuffer());
  }

  // Any browser-readable image (JPEG with EXIF rotation, PNG, HEIC on Apple
  // devices, WebP, ...) -> upright JPEG or PNG bytes for pdf-lib.
  async function normalizeImage(inp) {
    const blob = new Blob([inp.bytes], { type: inp.type || "" });
    let src;
    try {
      src = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      src = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t("img.unreadable", { name: inp.name }))); };
        img.src = url;
      });
    }
    let w = src.width, hh = src.height;
    const maxPx = 16e6;
    if (w * hh > maxPx) { const k = Math.sqrt(maxPx / (w * hh)); w = Math.floor(w * k); hh = Math.floor(hh * k); }
    const c = document.createElement("canvas");
    c.width = w; c.height = hh;
    const ctx = c.getContext("2d");
    const png = /png|gif|webp/i.test(inp.type || inp.name);
    if (!png) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, hh); }
    ctx.drawImage(src, 0, 0, w, hh);
    if (src.close) src.close();
    const out = await new Promise((r) => c.toBlob(r, png ? "image/png" : "image/jpeg", 0.92));
    c.width = c.height = 0;
    return { bytes: new Uint8Array(await out.arrayBuffer()), png, width: w, height: hh };
  }

  // ---------- tool page ----------

  function showTool(id) {
    const def = TOOLS[id];
    if (!state.tool || state.tool.id !== id) {
      state.tool = { id, def, inputs: [], opts: { ...(def.defaults || {}) }, outputs: null, grid: null };
    }
    setTitle(t(`tool.${id}.title`));
    $("#tool-title").textContent = t(`tool.${id}.title`);
    $("#tool-desc").textContent = t(`tool.${id}.desc`);
    $("#tool-ico").textContent = def.icon;
    $("#tool-ico").className = `tool-ico big ico-${id}`;
    showView("tool");
    renderTool();
    // A file chosen in My files ("Use in a tool…") goes straight into the tool.
    const pending = state.pendingDoc;
    if (pending && def.accept === "pdf") {
      state.pendingDoc = null;
      addDocs([pending]).catch((e) => toast(e.message));
    }
  }

  function renderTool() {
    const st = state.tool;
    if (!st) return;
    const def = st.def;
    const pick = $("#tool-pick");
    const needMore = def.multi || st.inputs.length === 0;
    pick.hidden = !needMore || !!st.outputs;
    $("#tool-pick-label").textContent = t(def.accept === "image" ? (def.multi ? "input.selectImages" : "input.selectImage") : (def.multi ? "input.selectPdfs" : "input.selectPdf"));
    $("#tool-from-files").hidden = def.accept !== "pdf";
    $("#tool-file").accept = def.accept === "image" ? "image/*" : "application/pdf,.pdf";
    $("#tool-file").multiple = !!def.multi;
    renderInputs();
    renderOptions();
    const enough = st.inputs.length >= def.min;
    $("#tool-run").hidden = !enough || !!st.outputs || !!def.editor;
    $("#tool-run").textContent = t(`tool.${st.id}.run`);
    $("#tool-hint").hidden = enough || !!st.outputs;
    $("#tool-hint").textContent = def.min > 1 ? tn("input.needAtLeast", def.min) : "";
    showError($("#tool-error"), "");
    renderOutputs();
  }

  function renderInputs() {
    const st = state.tool;
    const list = $("#tool-inputs");
    list.hidden = !st.inputs.length || !!st.outputs;
    if (st.def.pageGrid && st.inputs.length) {
      list.replaceChildren(inputRow(st.inputs[0], 0));
      renderPageGrid();
      return;
    }
    $("#tool-grid").hidden = true;
    list.replaceChildren(...st.inputs.map((inp, i) => inputRow(inp, i)));
  }

  function inputRow(inp, i) {
    const st = state.tool;
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= st.inputs.length) return;
      [st.inputs[i], st.inputs[j]] = [st.inputs[j], st.inputs[i]];
      renderInputs();
    };
    return h("li", { class: "input-row" },
      h("span", { class: "file-ico", "aria-hidden": "true" }, inp.kind === "image" ? "IMG" : "PDF"),
      h("span", { class: "file-text" },
        h("span", { class: "file-name" }, inp.name),
        h("span", { class: "muted small" }, [inp.pages ? tn("common.pages", inp.pages) : null, fmtSize(inp.bytes.length)].filter(Boolean).join(" · "))),
      st.def.reorder && st.inputs.length > 1 ? [
        h("button", { type: "button", class: "icon-btn small", title: t("input.moveUp"), "aria-label": t("input.moveUp"), disabled: i === 0, onclick: () => move(-1) }, "▲"),
        h("button", { type: "button", class: "icon-btn small", title: t("input.moveDown"), "aria-label": t("input.moveDown"), disabled: i === st.inputs.length - 1, onclick: () => move(1) }, "▼"),
      ] : null,
      h("button", { type: "button", class: "icon-btn small danger", title: t("input.remove"), "aria-label": t("input.remove"), onclick: () => { st.inputs.splice(i, 1); st.grid = null; renderTool(); } }, "✕"));
  }

  function renderOptions() {
    const st = state.tool;
    const box = $("#tool-options");
    const show = st.def.options && st.inputs.length >= st.def.min && !st.outputs;
    box.hidden = !show;
    box.replaceChildren(...(show ? [st.def.options(st)].flat(3).filter(Boolean) : []));
  }

  // --- small form builders ---
  function field(label, control, help) {
    return h("label", { class: "field" }, h("span", null, label), control, help ? h("span", { class: "muted small help" }, help) : null);
  }
  function number(value, min, max, onChange) {
    return h("input", { type: "number", inputmode: "numeric", value: String(value), min: String(min), max: String(max), step: "1",
      oninput: (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); } });
  }
  function select(options, value, onChange) {
    const s = h("select", { onchange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h("option", { value: v }, l)));
    s.value = value;
    return s;
  }
  function check(label, value, onChange) {
    return h("label", { class: "check" }, h("input", { type: "checkbox", checked: value, onchange: (e) => onChange(e.target.checked) }), h("span", null, label));
  }
  function radioGroup(name, label, options, value, onChange) {
    return h("fieldset", { class: "radio-group" }, h("legend", null, label),
      h("div", { class: "seg" }, options.map(([v, l]) => h("label", null,
        h("input", { type: "radio", name, value: v, checked: v === value, onchange: () => onChange(v) }), h("span", null, l)))));
  }
  function positionPicker(value, onChange) {
    const cells = ["tl", "tc", "tr", "bl", "bc", "br"];
    const grid = h("div", { class: "pos-grid", role: "radiogroup", "aria-label": t("numbers.position") }, cells.map((c) =>
      h("button", { type: "button", role: "radio", class: c === value ? "active" : "", "aria-checked": String(c === value), title: t(`pos.${c}`), "aria-label": t(`pos.${c}`),
        onclick: (e) => {
          grid.querySelectorAll("button").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-checked", "false"); });
          e.currentTarget.classList.add("active");
          e.currentTarget.setAttribute("aria-checked", "true");
          onChange(c);
        } }, h("span", { class: "dot" }))));
    return h("div", { class: "field" }, h("span", null, t("numbers.position")), grid);
  }

  // --- adding inputs ---
  async function addLocalFiles(fileList) {
    const st = state.tool;
    if (!st) return;
    const files = [...fileList];
    const wantImg = st.def.accept === "image";
    busy(true, t("busy.reading"));
    try {
      for (const f of files) {
        if (!st.def.multi && st.inputs.length >= 1) break;
        if (wantImg ? !isImageFile(f) : !isPdfFile(f)) { toast(t(wantImg ? "input.notImage" : "input.notPdf", { name: f.name })); continue; }
        const bytes = new Uint8Array(await f.arrayBuffer());
        await addInput({ name: f.name, bytes, type: f.type, kind: wantImg ? "image" : "pdf" });
      }
    } catch (e) {
      toast(e.message);
    } finally {
      busy(false);
      afterInputsChanged();
    }
  }

  async function addFromFiles() {
    const docs = await pickFromFiles(!!state.tool.def.multi);
    if (docs && docs.length) await addDocs(docs);
  }

  async function addDocs(docs) {
    const st = state.tool;
    busy(true, t("busy.loading"));
    try {
      for (const d of docs) {
        if (!st.def.multi && st.inputs.length >= 1) break;
        const bytes = await fetchDocumentBytes(d.id);
        await addInput({ name: d.name, bytes, type: PDF_MIME, kind: "pdf", docId: d.id });
      }
    } catch (e) {
      toast(e.message);
    } finally {
      busy(false);
      afterInputsChanged();
    }
  }

  async function addInput(inp) {
    if (inp.kind === "pdf") {
      try {
        inp.pages = (await loadPdf(inp.bytes)).getPageCount();
      } catch (e) {
        throw new Error(`${inp.name}: ${e.message}`);
      }
    }
    state.tool.inputs.push(inp);
    state.tool.grid = null;
  }

  function afterInputsChanged() {
    const st = state.tool;
    if (!st) return;
    if (st.def.editor && st.inputs.length) {
      const inp = st.inputs[0];
      st.inputs = [];
      openEditor({ name: inp.name, bytes: inp.bytes, docId: inp.docId || null, pages: inp.pages }, st.def.editor, st.id);
      return;
    }
    renderTool();
  }

  async function runTool() {
    const st = state.tool;
    showError($("#tool-error"), "");
    busy(true, t("busy.working"));
    await tick();
    try {
      st.outputs = await st.def.run(st);
      renderTool();
      $("#tool-result").scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    } catch (e) {
      console.error(e);
      showError($("#tool-error"), e.message || t("common.failed"));
    } finally {
      busy(false);
    }
  }

  function resetTool() {
    const id = state.tool.id;
    state.tool = null;
    showTool(id);
  }

  // --- results ---
  function renderOutputs() {
    const st = state.tool;
    const box = $("#tool-result");
    box.hidden = !st.outputs;
    if (!st.outputs) { box.replaceChildren(); return; }
    const outs = st.outputs;
    const share = canShareFiles();
    const rows = outs.map((o) => {
      const blob = new Blob([o.bytes], { type: o.mime });
      const isPdf = o.mime === PDF_MIME;
      const saveBtn = isPdf ? h("button", { type: "button", class: "btn small", onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await saveToFiles(o.bytes, o.name, o.pages);
          btn.textContent = t("out.savedShort");
          toast(t("out.saved", { name: o.name }));
        } catch (err) { btn.disabled = false; toast(err.message); }
      } }, t("out.save")) : null;
      return h("li", { class: "output-row" },
        h("span", { class: "file-ico", "aria-hidden": "true" }, isPdf ? "PDF" : o.mime === "image/png" ? "PNG" : "JPG"),
        h("span", { class: "file-text" },
          h("span", { class: "file-name" }, o.name),
          h("span", { class: "muted small" }, [o.pages ? tn("common.pages", o.pages) : null, fmtSize(o.bytes.length)].filter(Boolean).join(" · ")),
          o.note ? h("span", { class: "small note" }, o.note) : null),
        h("div", { class: "file-actions" },
          h("button", { type: "button", class: "btn primary small", onclick: () => downloadBlob(blob, o.name) }, t("out.download")),
          share ? h("button", { type: "button", class: "btn small", onclick: () => shareBlob(blob, o.name) }, t("out.share")) : null,
          saveBtn,
          isPdf ? h("button", { type: "button", class: "btn ghost small", onclick: () => openEditor({ name: o.name, bytes: o.bytes, docId: null, pages: o.pages }, "pen", "edit") }, t("out.edit")) : null));
    });
    const zipName = `${baseName(st.inputs[0] ? st.inputs[0].name : "files")}-${st.id}.zip`;
    box.replaceChildren(
      h("h2", null, tn("out.ready", outs.length)),
      outs.length > 1 ? h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "btn primary", onclick: () => downloadBlob(makeZip(outs.map((o) => ({ name: o.name, bytes: o.bytes }))), zipName) }, t("out.zip")),
        share ? h("button", { type: "button", class: "btn", onclick: () => shareBlob(makeZip(outs.map((o) => ({ name: o.name, bytes: o.bytes }))), zipName) }, t("out.shareZip")) : null) : null,
      h("ul", { class: "output-list" }, rows),
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => { st.outputs = null; renderTool(); } }, t("out.back")),
        h("button", { type: "button", class: "btn ghost", onclick: resetTool }, t("out.startOver"))));
  }

  // --- organize: page thumbnails ---
  async function renderPageGrid() {
    const st = state.tool;
    const gridEl = $("#tool-grid");
    gridEl.hidden = !!st.outputs;
    if (st.outputs) return;
    const inp = st.inputs[0];
    if (!st.grid) {
      st.grid = Array.from({ length: inp.pages }, (_, i) => ({ index: i, rotate: 0, deleted: false, thumb: null }));
      st.thumbsFor = null;
    }
    const draw = () => {
      gridEl.replaceChildren(...st.grid.map((p, pos) => {
        const swap = (d) => {
          const j = pos + d;
          if (j < 0 || j >= st.grid.length) return;
          [st.grid[pos], st.grid[j]] = [st.grid[j], st.grid[pos]];
          draw();
        };
        const thumbBox = h("div", { class: "thumb-box" });
        if (p.thumb) {
          const img = h("img", { src: p.thumb, alt: "" });
          img.style.transform = `rotate(${p.rotate}deg)`;
          thumbBox.append(img);
        } else thumbBox.append(h("span", { class: "muted small" }, "…"));
        return h("li", { class: `thumb${p.deleted ? " deleted" : ""}` },
          thumbBox,
          h("div", { class: "thumb-bar" },
            h("span", { class: "thumb-num" }, p.index + 1),
            h("button", { type: "button", class: "icon-btn small", title: t("org.left"), "aria-label": t("org.left"), disabled: pos === 0, onclick: () => swap(-1) }, "◀"),
            h("button", { type: "button", class: "icon-btn small", title: t("org.rotate"), "aria-label": t("org.rotate"), onclick: () => { p.rotate = (p.rotate + 90) % 360; draw(); } }, "↻"),
            h("button", { type: "button", class: "icon-btn small", title: t("org.right"), "aria-label": t("org.right"), disabled: pos === st.grid.length - 1, onclick: () => swap(1) }, "▶"),
            h("button", { type: "button", class: "icon-btn small danger", title: t(p.deleted ? "org.restore" : "org.delete"), "aria-label": t(p.deleted ? "org.restore" : "org.delete"), onclick: () => { p.deleted = !p.deleted; draw(); } }, p.deleted ? "↺" : "✕")));
      }));
    };
    draw();
    if (st.thumbsFor === inp) return;
    st.thumbsFor = inp;
    try {
      const pdf = await openPdfjs(inp.bytes);
      for (let i = 1; i <= pdf.numPages; i++) {
        if (state.tool !== st || st.thumbsFor !== inp) break;
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const bytes = await renderPageImage(page, 220 / Math.max(vp.width, vp.height), "image/jpeg", 0.7);
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        const entry = st.grid.find((g) => g.index === i - 1);
        if (entry) entry.thumb = url;
        page.cleanup();
        if (i % 4 === 0 || i === pdf.numPages) draw();
      }
      await pdf.destroy();
    } catch (e) {
      showError($("#tool-error"), e.message);
    }
  }

  // ---------- page editor: fill in forms, draw, write, sign ----------
  // Pages are rendered with pdf.js. On top of each page lie the form fields of
  // the PDF (real inputs) and a notes layer (pen, highlighter, text, signatures).
  // Saving writes the field values into the PDF form and burns the notes
  // layer into the pages (one transparent image per page).

  let editor = null;
  const FONT_STACK = "Helvetica, Arial, \"Segoe UI\", system-ui, sans-serif";
  const ED_TOOLS = ["select", "pen", "highlighter", "text", "signature", "eraser"];
  const COLORS = ["#111111", "#1d4ed8", "#d90f5a", "#008a55", "#ffd400", "#ff7ac0"];
  const SIZES = { pen: [1, 2, 4], highlighter: [8, 14, 22], text: [10, 14, 20], eraser: [6, 12, 24], select: [10, 14, 20], signature: [10, 14, 20] };
  let itemSeq = 0;

  function editorDirty() { return !!(editor && editor.dirty); }

  async function openEditor(doc, startTool, toolId) {
    if (editor) closeEditor(true);
    busy(true, t("busy.opening"));
    try {
      const lib = await pdfjs();
      const pdf = await openPdfjs(doc.bytes);
      const returnTo = location.hash && location.hash !== "#/edit" ? location.hash : "#/";
      editor = {
        doc, pdf, lib, toolId, returnTo,
        pages: [], items: [], history: [], future: [],
        tool: startTool === "signature" ? "select" : startTool,
        color: { pen: COLORS[0], highlighter: COLORS[4], text: COLORS[0] },
        size: { pen: 1, highlighter: 1, text: 1, eraser: 1, select: 1, signature: 1 },
        scale: 1, fit: true,
        fields: new Map(), // name -> { kind, els: [], options }
        values: new Map(), // name -> current value
        changed: new Set(), // field names changed by the user
        sigFields: [],
        pencilOnly: localGet("pencilOnly") === "1",
        selected: null, // { page, id }
        active: null, // gesture in progress
        dirty: false,
        version: 0,
        built: null,
      };
      const pagesEl = $("#ed-pages");
      pagesEl.replaceChildren();
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const wrap = h("div", { class: "ed-page", "data-index": String(i - 1) });
        const canvas = h("canvas", { class: "ed-canvas" });
        const ink = h("canvas", { class: "ed-ink" });
        const forms = h("div", { class: "ed-forms" });
        wrap.append(canvas, ink, forms);
        pagesEl.append(wrap);
        editor.pages.push({ index: i - 1, page, vp1, view: page.view.slice(), rotate: page.rotate, wrap, canvas, ink, forms, token: 0, task: null, renderedScale: 0, formsBuilt: false, visible: false });
        editor.items.push([]);
      }
      $("#ed-name").textContent = doc.name;
      $("#ed-fields").textContent = "";
      // Visible first: fitting to the width needs the real size of the page area.
      setTitle(t(`tool.${toolId === "sign" ? "sign" : "edit"}.title`));
      showView("editor");
      location.hash = "#/edit";
      fitWidth();
      setupEditorObserver();
      renderEditorToolbar();
      scanFields();
      if (startTool === "signature") setTimeout(() => openSignatureDialog(null), 50);
    } catch (e) {
      console.error(e);
      toast(e.message || t("pdf.unreadable"));
      if (editor) closeEditor(true);
    } finally {
      busy(false);
    }
  }

  function closeEditor(force) {
    if (!editor) return;
    if (!force && editor.dirty && !confirm(t("ed.confirmLeave"))) return false;
    const ed = editor;
    editor = null;
    if (ed.observer) ed.observer.disconnect();
    for (const p of ed.pages) { if (p.task) try { p.task.cancel(); } catch { /* ignore */ } }
    ed.pdf.destroy().catch(() => {});
    $("#ed-pages").replaceChildren();
    $("#ed-text-editor").hidden = true;
    $("#app-view").classList.remove("editing");
    if (!force) go(ed.returnTo);
    return true;
  }

  // Counts the fillable fields up front (status line) without rendering pages.
  async function scanFields() {
    const ed = editor;
    const names = new Set();
    for (const p of ed.pages) {
      try {
        const annots = await p.page.getAnnotations({ intent: "display" });
        p.annots = annots;
        annots.filter((a) => a.annotationType === 20 && a.fieldName && !a.pushButton && a.fieldType !== "Sig").forEach((a) => names.add(a.fieldName));
      } catch { p.annots = []; }
      if (editor !== ed) return;
      // Pages rendered before their annotations were known get their fields now.
      if (p.renderedScale && !p.formsBuilt) buildForms(p);
    }
    const n = names.size;
    ed.fieldCount = n;
    $("#ed-fields").textContent = n ? tn("ed.fieldsFound", n) : t("ed.noFields");
    $("#save-flatten-row").hidden = !n;
  }

  // ----- layout, zoom, lazy rendering -----

  function setupEditorObserver() {
    const ed = editor;
    ed.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const p = ed.pages[Number(en.target.dataset.index)];
        p.visible = en.isIntersecting;
        if (p.visible) schedulePageRender(p);
        else releasePage(p);
      }
    }, { root: $("#ed-pages"), rootMargin: "1200px 0px" });
    ed.pages.forEach((p) => ed.observer.observe(p.wrap));
  }

  function layoutPages() {
    const ed = editor;
    const pagesEl = $("#ed-pages");
    pagesEl.style.setProperty("--scale", String(ed.scale));
    for (const p of ed.pages) {
      p.wrap.style.width = `${Math.round(p.vp1.width * ed.scale)}px`;
      p.wrap.style.height = `${Math.round(p.vp1.height * ed.scale)}px`;
    }
    $("#ed-zoom-label").textContent = `${Math.round(ed.scale * 100)}%`;
    for (const p of ed.pages) if (p.visible) schedulePageRender(p);
  }

  function fitWidth() {
    const ed = editor;
    const avail = Math.max(200, $("#ed-pages").clientWidth - (isNarrow() ? 12 : 48));
    const widest = Math.max(...ed.pages.map((p) => p.vp1.width));
    ed.scale = Math.min(3, Math.max(0.25, avail / widest));
    ed.fit = true;
    layoutPages();
  }

  function zoom(factor) {
    const ed = editor;
    const pagesEl = $("#ed-pages");
    // keep the point in the middle of the screen in place
    const midY = (pagesEl.scrollTop + pagesEl.clientHeight / 2) / Math.max(1, pagesEl.scrollHeight);
    ed.scale = Math.min(4, Math.max(0.25, ed.scale * factor));
    ed.fit = false;
    layoutPages();
    pagesEl.scrollTop = midY * pagesEl.scrollHeight - pagesEl.clientHeight / 2;
  }

  let renderQueue = Promise.resolve();
  function schedulePageRender(p) {
    const ed = editor;
    if (p.renderedScale === ed.scale || p.queued) return;
    p.queued = true;
    renderQueue = renderQueue.then(() => {
      p.queued = false;
      if (editor !== ed || !p.visible || p.renderedScale === ed.scale) return null;
      return renderPage(p);
    }).catch((e) => console.error(e));
  }

  function pixelRatio() { return Math.min(window.devicePixelRatio || 1, 3); }

  async function renderPage(p) {
    const ed = editor;
    const token = ++p.token;
    const scale = ed.scale;
    let k = scale * pixelRatio();
    const maxPx = 8e6; // per-page canvas budget (iPad Safari limits total canvas memory)
    if (p.vp1.width * p.vp1.height * k * k > maxPx) k = Math.sqrt(maxPx / (p.vp1.width * p.vp1.height));
    const vp = p.page.getViewport({ scale: k });
    const canvas = h("canvas", { class: "ed-canvas" });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (p.task) try { p.task.cancel(); } catch { /* ignore */ }
    p.task = p.page.render({ canvasContext: ctx, viewport: vp, annotationMode: ed.lib.AnnotationMode.ENABLE_FORMS });
    try {
      await p.task.promise;
    } catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      throw e;
    } finally {
      p.task = null;
    }
    if (editor !== ed || token !== p.token) return;
    p.canvas.width = p.canvas.height = 0;
    p.canvas.replaceWith(canvas);
    p.canvas = canvas;
    p.renderedScale = scale;
    sizeInk(p);
    drawPage(p);
    if (!p.formsBuilt && p.annots) buildForms(p);
  }

  function releasePage(p) {
    if (!p.renderedScale) return;
    if (p.task) try { p.task.cancel(); } catch { /* ignore */ }
    p.canvas.width = p.canvas.height = 0;
    p.ink.width = p.ink.height = 0;
    p.renderedScale = 0;
  }

  function sizeInk(p) {
    const dpr = pixelRatio();
    let w = Math.round(p.vp1.width * editor.scale * dpr), hh = Math.round(p.vp1.height * editor.scale * dpr);
    const maxPx = 8e6;
    if (w * hh > maxPx) { const f = Math.sqrt(maxPx / (w * hh)); w = Math.floor(w * f); hh = Math.floor(hh * f); }
    if (p.ink.width !== w) p.ink.width = w;
    if (p.ink.height !== hh) p.ink.height = hh;
  }

  // ----- form fields -----

  function buildForms(p) {
    p.formsBuilt = true;
    const annots = p.annots || [];
    const pct = (v, total) => `${(v / total) * 100}%`;
    for (const a of annots) {
      if (a.annotationType !== 20 || !a.fieldName || a.hidden || a.pushButton) continue;
      const r = p.vp1.convertToViewportRectangle(a.rect);
      const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]);
      const w = Math.abs(r[2] - r[0]), hh = Math.abs(r[3] - r[1]);
      let el = null;
      const name = a.fieldName;
      if (a.fieldType === "Sig") {
        el = h("button", { type: "button", class: "ed-field ed-sig", title: t("ed.signHere") }, t("ed.signHere"));
        el.addEventListener("click", () => openSignatureDialog({ page: p.index, x, y, w, h: hh }));
      } else if (a.fieldType === "Tx") {
        const value = editor.values.has(name) ? editor.values.get(name) : (typeof a.fieldValue === "string" ? a.fieldValue : "");
        el = a.multiLine ? h("textarea", { class: "ed-field" }) : h("input", { type: "text", class: "ed-field" });
        el.value = value;
        if (a.maxLen) el.maxLength = a.maxLen;
        if (a.textAlignment === 1) el.classList.add("center");
        if (a.textAlignment === 2) el.classList.add("right");
        // Font size from the field's appearance (0 = auto), kept within the box.
        const da = a.defaultAppearanceData && a.defaultAppearanceData.fontSize > 0 ? a.defaultAppearanceData.fontSize : 0;
        const fs = Math.max(5, Math.min(da || (a.multiLine ? 10 : 12), a.multiLine ? 14 : hh * 0.7));
        el.style.setProperty("--fs", String(fs));
        el.addEventListener("input", () => setFieldValue(name, el.value, el));
        registerField(name, "text", el, a);
        if (!editor.values.has(name)) editor.values.set(name, value);
      } else if (a.fieldType === "Btn" && a.checkBox) {
        el = h("input", { type: "checkbox", class: "ed-field ed-check" });
        const on = a.exportValue || "Yes";
        el.checked = editor.values.has(name) ? !!editor.values.get(name) : (!!a.fieldValue && a.fieldValue !== "Off");
        el.addEventListener("change", () => setFieldValue(name, el.checked, el));
        registerField(name, "check", el, { ...a, exportValue: on });
        if (!editor.values.has(name)) editor.values.set(name, el.checked);
      } else if (a.fieldType === "Btn" && a.radioButton) {
        el = h("input", { type: "radio", class: "ed-field ed-check", name: `ed-radio-${name}`, value: a.buttonValue });
        el.checked = editor.values.has(name) ? editor.values.get(name) === a.buttonValue : a.fieldValue === a.buttonValue;
        el.addEventListener("change", () => { if (el.checked) setFieldValue(name, a.buttonValue, el); });
        registerField(name, "radio", el, a);
        if (!editor.values.has(name)) editor.values.set(name, a.fieldValue && a.fieldValue !== "Off" ? a.fieldValue : "");
      } else if (a.fieldType === "Ch" && !a.multiSelect) {
        el = h("select", { class: "ed-field" }, h("option", { value: "" }, ""),
          (a.options || []).map((o) => h("option", { value: o.exportValue }, o.displayValue || o.exportValue)));
        const cur = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue;
        el.value = editor.values.has(name) ? editor.values.get(name) : (cur || "");
        el.style.setProperty("--fs", String(Math.max(6, Math.min(12, hh * 0.65))));
        el.addEventListener("change", () => setFieldValue(name, el.value, el));
        registerField(name, "choice", el, a);
        if (!editor.values.has(name)) editor.values.set(name, el.value);
      }
      if (!el) continue;
      if (a.readOnly) el.disabled = true;
      el.style.left = pct(x, p.vp1.width);
      el.style.top = pct(y, p.vp1.height);
      el.style.width = pct(w, p.vp1.width);
      el.style.height = pct(hh, p.vp1.height);
      el.setAttribute("aria-label", a.alternativeText || name);
      p.forms.append(el);
    }
  }

  function registerField(name, kind, el, a) {
    if (!editor.fields.has(name)) editor.fields.set(name, { kind, els: [], options: a.options || [] });
    editor.fields.get(name).els.push(el);
  }

  // Keeps every widget of the same field (e.g. a name repeated on each page) in sync.
  function setFieldValue(name, value, source) {
    editor.values.set(name, value);
    editor.changed.add(name);
    const f = editor.fields.get(name);
    if (f) for (const el of f.els) {
      if (el === source) continue;
      if (f.kind === "check") el.checked = !!value;
      else if (f.kind === "radio") el.checked = el.value === value;
      else el.value = value;
    }
    markDirty();
  }

  function markDirty() {
    editor.dirty = true;
    editor.version++;
    editor.built = null;
    updateUndoButtons();
  }

  // ----- notes layer: items and drawing -----

  const measureCtx = document.createElement("canvas").getContext("2d");
  function measureText(item) {
    measureCtx.font = `${item.size}px ${FONT_STACK}`;
    const lines = item.text.split("\n");
    const w = Math.max(4, ...lines.map((l) => measureCtx.measureText(l).width));
    return { w, h: lines.length * item.size * 1.25 };
  }

  const imageCache = new Map();
  function loadImage(src) {
    if (imageCache.has(src)) return imageCache.get(src);
    const pr = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
    pr.then((img) => { pr.img = img; }, () => {});
    imageCache.set(src, pr);
    return pr;
  }

  function itemBox(it) {
    if (it.type === "ink") {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const pt of it.points) { x1 = Math.min(x1, pt.x); y1 = Math.min(y1, pt.y); x2 = Math.max(x2, pt.x); y2 = Math.max(y2, pt.y); }
      const pad = it.width;
      return { x: x1 - pad + (it.tx || 0), y: y1 - pad + (it.ty || 0), w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad };
    }
    return { x: it.x, y: it.y, w: it.w, h: it.h };
  }

  function drawItems(ctx, items, k, opts) {
    const o = opts || {};
    for (const it of items) {
      if (o.skipId && it.id === o.skipId) continue;
      ctx.save();
      if (it.type === "ink") {
        ctx.translate((it.tx || 0) * k, (it.ty || 0) * k);
        ctx.globalAlpha = it.alpha;
        ctx.strokeStyle = it.color;
        ctx.fillStyle = it.color;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const pts = it.points;
        if (pts.length === 1) {
          ctx.beginPath();
          ctx.arc(pts[0].x * k, pts[0].y * k, (it.width * k) / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (it.alpha < 1 || !it.pressure) {
          ctx.lineWidth = it.width * k;
          ctx.beginPath();
          ctx.moveTo(pts[0].x * k, pts[0].y * k);
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
            ctx.quadraticCurveTo(pts[i].x * k, pts[i].y * k, mx * k, my * k);
          }
          const last = pts[pts.length - 1];
          ctx.lineTo(last.x * k, last.y * k);
          ctx.stroke();
        } else {
          // Apple Pencil / stylus: line width follows the pressure.
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            const pr = (a.p + b.p) / 2;
            ctx.lineWidth = Math.max(0.3, it.width * k * Math.min(1.6, Math.max(0.35, 0.4 + pr * 1.2)));
            ctx.beginPath();
            ctx.moveTo(a.x * k, a.y * k);
            ctx.lineTo(b.x * k, b.y * k);
            ctx.stroke();
          }
        }
      } else if (it.type === "text") {
        ctx.fillStyle = it.color;
        ctx.font = `${it.size * k}px ${FONT_STACK}`;
        ctx.textBaseline = "top";
        it.text.split("\n").forEach((line, i) => ctx.fillText(line, it.x * k, (it.y + i * it.size * 1.25) * k + it.size * 0.1 * k));
      } else if (it.type === "image") {
        const pr = imageCache.get(it.src);
        if (pr && pr.img) ctx.drawImage(pr.img, it.x * k, it.y * k, it.w * k, it.h * k);
      }
      ctx.restore();
      if (o.selectedId && it.id === o.selectedId) {
        const b = itemBox(it);
        ctx.save();
        ctx.strokeStyle = "#0088b0";
        ctx.lineWidth = Math.max(1, k);
        ctx.setLineDash([4 * Math.max(1, k / 2), 3 * Math.max(1, k / 2)]);
        ctx.strokeRect(b.x * k, b.y * k, b.w * k, b.h * k);
        if (it.type !== "ink") {
          ctx.setLineDash([]);
          ctx.fillStyle = "#0088b0";
          const hs = handleSize() * k;
          ctx.fillRect((b.x + b.w) * k - hs / 2, (b.y + b.h) * k - hs / 2, hs, hs);
        }
        ctx.restore();
      }
    }
  }

  // Resize handle, in page units (bigger for fingers).
  function handleSize() { return 14 / editor.scale; }

  function drawPage(p) {
    if (!p.renderedScale || !p.ink.width) return;
    const ctx = p.ink.getContext("2d");
    ctx.clearRect(0, 0, p.ink.width, p.ink.height);
    const k = p.ink.width / p.vp1.width;
    const items = editor.items[p.index];
    const act = editor.active;
    const list = act && act.kind === "draw" && act.page === p.index ? [...items, act.item] : items;
    drawItems(ctx, list, k, {
      selectedId: editor.selected && editor.selected.page === p.index ? editor.selected.id : null,
      skipId: editor.editingText && editor.editingText.page === p.index ? editor.editingText.id : null,
    });
  }

  const pendingDraw = new Set();
  function requestDraw(p) {
    if (pendingDraw.has(p)) return;
    pendingDraw.add(p);
    requestAnimationFrame(() => { pendingDraw.delete(p); if (editor) drawPage(p); });
  }

  // ----- history (undo / redo) -----

  function commitItems(pageIndex, before, after) {
    editor.items[pageIndex] = after;
    editor.history.push({ page: pageIndex, before, after });
    if (editor.history.length > 200) editor.history.shift();
    editor.future = [];
    markDirty();
    requestDraw(editor.pages[pageIndex]);
  }

  function undo() {
    const e = editor.history.pop();
    if (!e) return;
    editor.items[e.page] = e.before;
    editor.future.push(e);
    afterHistory(e.page);
  }

  function redo() {
    const e = editor.future.pop();
    if (!e) return;
    editor.items[e.page] = e.after;
    editor.history.push(e);
    afterHistory(e.page);
  }

  function afterHistory(page) {
    const sel = editor.selected;
    if (sel && !editor.items[sel.page].some((it) => it.id === sel.id)) editor.selected = null;
    markDirty();
    requestDraw(editor.pages[page]);
  }

  function updateUndoButtons() {
    if (!editor) return;
    $("#ed-undo").disabled = !editor.history.length;
    $("#ed-redo").disabled = !editor.future.length;
    $("#ed-delete").hidden = !editor.selected;
  }

  function deleteSelected() {
    const sel = editor.selected;
    if (!sel) return;
    const before = editor.items[sel.page];
    editor.selected = null;
    commitItems(sel.page, before, before.filter((it) => it.id !== sel.id));
  }

  function selectedItem() {
    const sel = editor.selected;
    return sel ? editor.items[sel.page].find((it) => it.id === sel.id) : null;
  }

  // Replaces an item (immutable update) and records it for undo.
  function updateItem(pageIndex, id, patch) {
    const before = editor.items[pageIndex];
    commitItems(pageIndex, before, before.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  // ----- pointer input (mouse, finger, Apple Pencil) -----

  function pageFromTarget(target) {
    const wrap = target && target.closest ? target.closest(".ed-page") : null;
    return wrap ? editor.pages[Number(wrap.dataset.index)] : null;
  }

  function toPage(p, clientX, clientY) {
    const r = p.wrap.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * p.vp1.width, y: ((clientY - r.top) / r.height) * p.vp1.height };
  }

  function hitTest(p, pt, types) {
    const items = editor.items[p.index];
    const slop = 6 / editor.scale;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (types && !types.includes(it.type)) continue;
      const b = itemBox(it);
      if (pt.x >= b.x - slop && pt.x <= b.x + b.w + slop && pt.y >= b.y - slop && pt.y <= b.y + b.h + slop) {
        if (it.type === "ink" && !inkNear(it, pt, it.width / 2 + slop)) continue;
        return it;
      }
    }
    return null;
  }

  function inkNear(it, pt, r) {
    const x = pt.x - (it.tx || 0), y = pt.y - (it.ty || 0);
    const pts = it.points;
    if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= r;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      if (Math.hypot(a.x + u * dx - x, a.y + u * dy - y) <= r) return true;
    }
    return false;
  }

  function onResizeHandle(it, pt) {
    if (!it || it.type === "ink") return false;
    const hs = handleSize();
    return Math.abs(pt.x - (it.x + it.w)) <= hs && Math.abs(pt.y - (it.y + it.h)) <= hs;
  }

  const DRAW_TOOLS = ["pen", "highlighter", "eraser", "text"];

  // Decides whether a pointer/touch is handled by the editor (draw, move, ...)
  // or left to the browser (scrolling). With "Pencil only", fingers always
  // scroll and only the Apple Pencil draws.
  function wantsPointer(p, kind, clientX, clientY) {
    const tool = editor.tool;
    if (kind === "pen") return tool !== "select" || !!hitTest(p, toPage(p, clientX, clientY));
    if (tool === "select") {
      const pt = toPage(p, clientX, clientY);
      const sel = selectedItem();
      return !!hitTest(p, pt) || (sel && editor.selected.page === p.index && onResizeHandle(sel, pt));
    }
    if (kind === "touch" && editor.pencilOnly) return false;
    return DRAW_TOOLS.includes(tool);
  }

  function onTouchStart(e) {
    if (!editor || state.view !== "editor") return;
    for (const touch of e.changedTouches) {
      if (!touch.target.classList || !touch.target.classList.contains("ed-ink")) continue;
      const p = pageFromTarget(touch.target);
      if (!p) continue;
      const kind = touch.touchType === "stylus" ? "pen" : "touch";
      if (kind === "pen" && !editor.pencilOnly) enablePencilOnly(true);
      if (wantsPointer(p, kind, touch.clientX, touch.clientY)) { e.preventDefault(); return; }
    }
  }

  function enablePencilOnly(auto) {
    editor.pencilOnly = true;
    localSet("pencilOnly", "1");
    renderEditorToolbar();
    if (auto) toast(t("ed.pencilDetected"));
  }

  function onPointerDown(e) {
    if (!editor || !e.target.classList.contains("ed-ink")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = pageFromTarget(e.target);
    if (!p) return;
    if (e.pointerType === "pen" && !editor.pencilOnly) enablePencilOnly(true);
    if (editor.active) return; // one gesture at a time (ignore a resting palm)
    if (!wantsPointer(p, e.pointerType, e.clientX, e.clientY)) return;
    e.preventDefault();
    try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const pt = toPage(p, e.clientX, e.clientY);
    const tool = editor.tool;
    if (tool === "pen" || tool === "highlighter") {
      const hl = tool === "highlighter";
      const pressure = e.pointerType === "pen" && e.pressure > 0;
      editor.active = {
        kind: "draw", page: p.index, pointerId: e.pointerId,
        item: { id: ++itemSeq, type: "ink", color: editor.color[tool], width: SIZES[tool][editor.size[tool]], alpha: hl ? 0.38 : 1, pressure: pressure && !hl,
          points: [{ x: pt.x, y: pt.y, p: pressure ? e.pressure : 0.5 }] },
      };
      requestDraw(p);
    } else if (tool === "eraser") {
      editor.active = { kind: "erase", page: p.index, pointerId: e.pointerId, before: editor.items[p.index] };
      eraseAt(p, pt);
    } else if (tool === "text") {
      editor.active = { kind: "tap", page: p.index, pointerId: e.pointerId, start: pt };
    } else if (tool === "select") {
      const sel = selectedItem();
      if (sel && editor.selected.page === p.index && onResizeHandle(sel, pt)) {
        editor.active = { kind: "resize", page: p.index, pointerId: e.pointerId, start: pt, orig: sel, before: editor.items[p.index] };
        return;
      }
      const hit = hitTest(p, pt);
      setSelection(hit ? { page: p.index, id: hit.id } : null);
      if (hit) editor.active = { kind: "move", page: p.index, pointerId: e.pointerId, start: pt, orig: hit, before: editor.items[p.index], moved: false, at: Date.now() };
    }
  }

  function onPointerMove(e) {
    const act = editor && editor.active;
    if (!act || act.pointerId !== e.pointerId) return;
    e.preventDefault();
    const p = editor.pages[act.page];
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    if (act.kind === "draw") {
      for (const ev of list) {
        const pt = toPage(p, ev.clientX, ev.clientY);
        const last = act.item.points[act.item.points.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 0.4 / editor.scale) continue;
        act.item.points.push({ x: pt.x, y: pt.y, p: act.item.pressure ? (ev.pressure || 0.5) : 0.5 });
      }
      requestDraw(p);
    } else if (act.kind === "erase") {
      for (const ev of list) eraseAt(p, toPage(p, ev.clientX, ev.clientY));
    } else if (act.kind === "move" || act.kind === "resize") {
      const pt = toPage(p, e.clientX, e.clientY);
      const dx = pt.x - act.start.x, dy = pt.y - act.start.y;
      const o = act.orig;
      let next;
      if (act.kind === "move") {
        if (!act.moved && Math.hypot(dx, dy) < 2 / editor.scale) return;
        act.moved = true;
        next = o.type === "ink" ? { ...o, tx: (o.tx || 0) + dx, ty: (o.ty || 0) + dy } : { ...o, x: o.x + dx, y: o.y + dy };
      } else if (o.type === "image") {
        const w = Math.max(12, o.w + dx);
        next = { ...o, w, h: (w * o.h) / o.w };
      } else {
        const size = Math.max(4, Math.min(200, o.size * Math.max(0.1, (o.w + dx) / o.w)));
        const m = measureText({ ...o, size });
        next = { ...o, size, w: m.w, h: m.h };
      }
      act.current = next;
      editor.items[act.page] = act.before.map((it) => (it.id === o.id ? next : it));
      requestDraw(p);
    }
  }

  function onPointerUp(e) {
    const act = editor && editor.active;
    if (!act || act.pointerId !== e.pointerId) return;
    editor.active = null;
    const p = editor.pages[act.page];
    if (act.kind === "draw") {
      if (e.type !== "pointercancel" || act.item.points.length > 2) {
        const before = editor.items[act.page];
        commitItems(act.page, before, [...before, act.item]);
      } else requestDraw(p);
    } else if (act.kind === "erase") {
      if (editor.items[act.page] !== act.before) {
        const after = editor.items[act.page];
        editor.items[act.page] = act.before;
        commitItems(act.page, act.before, after);
      }
    } else if (act.kind === "tap") {
      if (e.type === "pointercancel") return;
      const hit = hitTest(p, act.start, ["text"]);
      if (hit) editText(p, hit);
      else newText(p, act.start);
    } else if (act.kind === "move" || act.kind === "resize") {
      if (act.current) {
        editor.items[act.page] = act.before;
        commitItems(act.page, act.before, act.before.map((it) => (it.id === act.orig.id ? act.current : it)));
      } else if (act.kind === "move" && act.orig.type === "text" && e.type !== "pointercancel" && editor.lastTap &&
        editor.lastTap.id === act.orig.id && Date.now() - editor.lastTap.at < 450) {
        editText(p, act.orig); // double tap on a text note: edit it
      }
      editor.lastTap = act.kind === "move" ? { id: act.orig.id, at: Date.now() } : null;
    }
  }

  function eraseAt(p, pt) {
    const r = SIZES.eraser[editor.size.eraser] / 2;
    const items = editor.items[p.index];
    const keep = items.filter((it) => {
      if (it.type === "ink") return !inkNear(it, pt, r + it.width / 2);
      const b = itemBox(it);
      return !(pt.x >= b.x - r && pt.x <= b.x + b.w + r && pt.y >= b.y - r && pt.y <= b.y + b.h + r);
    });
    if (keep.length !== items.length) {
      editor.items[p.index] = keep;
      requestDraw(p);
    }
  }

  function setSelection(sel) {
    const prev = editor.selected;
    editor.selected = sel;
    if (prev) requestDraw(editor.pages[prev.page]);
    if (sel) requestDraw(editor.pages[sel.page]);
    renderEditorToolbar();
  }

  // ----- text notes -----

  function newText(p, pt) {
    const size = SIZES.text[editor.size.text];
    const item = { id: ++itemSeq, type: "text", x: pt.x, y: pt.y - size * 0.6, text: "", size, color: editor.color.text, w: 4, h: size * 1.25 };
    openTextEditor(p, item, true);
  }

  function editText(p, item) { openTextEditor(p, item, false); }

  function openTextEditor(p, item, isNew) {
    commitTextEditor();
    const ta = $("#ed-text-editor");
    editor.editingText = { page: p.index, id: item.id, item, isNew };
    p.wrap.append(ta);
    ta.hidden = false;
    ta.value = item.text;
    ta.style.left = `${(item.x / p.vp1.width) * 100}%`;
    ta.style.top = `${(item.y / p.vp1.height) * 100}%`;
    ta.style.fontSize = `${item.size * editor.scale}px`;
    ta.style.color = item.color;
    autoGrow(ta);
    requestDraw(p);
    ta.focus();
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
    ta.style.width = "auto";
    ta.style.width = `${Math.max(120, ta.scrollWidth + 8)}px`;
  }

  function commitTextEditor() {
    const ed = editor && editor.editingText;
    if (!ed) return;
    editor.editingText = null;
    const ta = $("#ed-text-editor");
    ta.hidden = true;
    $("#ed-text-holder").append(ta);
    const text = ta.value.replace(/\s+$/, "");
    const before = editor.items[ed.page];
    if (!text) {
      if (!ed.isNew) commitItems(ed.page, before, before.filter((it) => it.id !== ed.id));
      else requestDraw(editor.pages[ed.page]);
      return;
    }
    const m = measureText({ ...ed.item, text });
    const next = { ...ed.item, text, w: m.w, h: m.h };
    if (ed.isNew) commitItems(ed.page, before, [...before, next]);
    else if (text !== ed.item.text) commitItems(ed.page, before, before.map((it) => (it.id === ed.id ? next : it)));
    else requestDraw(editor.pages[ed.page]);
  }

  // ----- signatures -----

  // Places a signature image: into a signature field, or in the middle of the
  // page that is currently most visible.
  async function placeSignature(src, target) {
    const img = await loadImage(src);
    let p, x, y, w, hh;
    if (target) {
      p = editor.pages[target.page];
      const ar = img.naturalWidth / img.naturalHeight;
      w = target.w; hh = w / ar;
      if (hh > target.h) { hh = target.h; w = hh * ar; }
      x = target.x + (target.w - w) / 2; y = target.y + (target.h - hh) / 2;
    } else {
      p = mostVisiblePage();
      w = Math.min(p.vp1.width * 0.35, 220);
      hh = (w * img.naturalHeight) / img.naturalWidth;
      const pagesEl = $("#ed-pages");
      const r = p.wrap.getBoundingClientRect(), pr = pagesEl.getBoundingClientRect();
      const midY = ((pr.top + pr.height / 2 - r.top) / r.height) * p.vp1.height;
      x = (p.vp1.width - w) / 2;
      y = Math.max(0, Math.min(p.vp1.height - hh, midY - hh / 2));
    }
    const item = { id: ++itemSeq, type: "image", src, x, y, w, h: hh };
    const before = editor.items[p.index];
    commitItems(p.index, before, [...before, item]);
    setTool("select");
    setSelection({ page: p.index, id: item.id });
    toast(t("ed.sigPlaced"));
  }

  function mostVisiblePage() {
    const pr = $("#ed-pages").getBoundingClientRect();
    let best = editor.pages[0], bestArea = -1;
    for (const p of editor.pages) {
      const r = p.wrap.getBoundingClientRect();
      const vis = Math.max(0, Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top));
      if (vis > bestArea) { bestArea = vis; best = p; }
    }
    return best;
  }

  // ----- toolbar -----

  function setTool(tool) {
    commitTextEditor();
    if (tool === "signature") { openSignatureDialog(null); return; }
    editor.tool = tool;
    if (tool !== "select" && editor.selected) setSelection(null);
    renderEditorToolbar();
  }

  function renderEditorToolbar() {
    if (!editor) return;
    const tool = editor.tool;
    document.querySelectorAll("#ed-tools button").forEach((b) => {
      const on = b.dataset.edTool === tool;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    $("#ed-pages").classList.toggle("drawing", tool !== "select");
    $("#ed-pages").dataset.tool = tool;
    const colorTool = tool === "highlighter" ? "highlighter" : tool === "text" ? "text" : tool === "pen" ? "pen" : null;
    const sel = selectedItem();
    const colorBox = $("#ed-colors");
    colorBox.hidden = !colorTool && !(sel && sel.type !== "image");
    const current = colorTool ? editor.color[colorTool] : sel ? sel.color : null;
    colorBox.replaceChildren(...COLORS.map((c) => {
      const b = h("button", { type: "button", class: `swatch${c === current ? " active" : ""}`, title: c, "aria-label": t("ed.color"), "aria-pressed": String(c === current),
        onclick: () => {
          if (colorTool) editor.color[colorTool] = c;
          else if (sel) updateItem(editor.selected.page, sel.id, { color: c });
          renderEditorToolbar();
        } });
      b.style.setProperty("--swatch", c);
      return b;
    }));
    const sizeTool = SIZES[tool] && tool !== "select" && tool !== "signature" ? tool : null;
    const sizeBox = $("#ed-sizes");
    sizeBox.hidden = !sizeTool && !(sel && sel.type === "text");
    const idx = sizeTool ? editor.size[sizeTool] : sel && sel.type === "text" ? SIZES.text.indexOf(sel.size) : -1;
    sizeBox.replaceChildren(...[0, 1, 2].map((i) => h("button", {
      type: "button", class: `size-btn s${i}${i === idx ? " active" : ""}`, "aria-pressed": String(i === idx),
      title: t(`ed.size${i}`), "aria-label": t(`ed.size${i}`),
      onclick: () => {
        if (sizeTool) editor.size[sizeTool] = i;
        else if (sel && sel.type === "text") {
          const size = SIZES.text[i];
          const m = measureText({ ...sel, size });
          updateItem(editor.selected.page, sel.id, { size, w: m.w, h: m.h });
        }
        renderEditorToolbar();
      } }, h("span", { class: "dot" }))));
    const pencil = $("#ed-pencil");
    pencil.classList.toggle("active", editor.pencilOnly);
    pencil.setAttribute("aria-pressed", String(editor.pencilOnly));
    updateUndoButtons();
  }

  // ----- saving -----

  async function buildEditedPdf(flatten) {
    commitTextEditor();
    const ed = editor;
    const key = `${ed.version}:${flatten}`;
    if (ed.built && ed.built.key === key) return ed.built;
    const doc = await loadPdf(ed.doc.bytes);
    const warnings = [];
    // 1. form fields
    if (ed.changed.size || flatten) {
      try {
        const form = doc.getForm();
        const helv = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        let needAppearances = false;
        for (const name of ed.changed) {
          let field;
          try { field = form.getField(name); } catch { continue; }
          const v = ed.values.get(name);
          try {
            if (field instanceof PDFLib.PDFTextField) {
              let text = String(v || "");
              const max = field.getMaxLength();
              if (max !== undefined && text.length > max) text = text.slice(0, max);
              field.setText(text);
              // "Auto" (0) or oversized font sizes blow up the first line of
              // multi-line fields: use the same readable size as the editor.
              const daSize = /(\d+(?:\.\d+)?)\s+Tf/.exec(field.acroField.getDefaultAppearance() || "");
              const r = field.acroField.getWidgets()[0] ? field.acroField.getWidgets()[0].getRectangle() : { height: 20 };
              const cur = daSize ? Number(daSize[1]) : 0;
              const multi = field.isMultiline();
              if (!cur || (multi ? cur > 14 : cur > r.height * 0.8)) {
                try { field.setFontSize(multi ? Math.min(10, cur || 10) : Math.max(5, Math.min(12, r.height * 0.7))); } catch { /* no /DA */ }
              }
              try { field.updateAppearances(helv); } catch {
                // Helvetica cannot show this text (Cyrillic, Greek, CJK, ...):
                // draw it with the system fonts and use that as the field's look.
                try { await imageAppearance(doc, field, text); } catch (e) { console.warn(e); needAppearances = true; }
              }
            } else if (field instanceof PDFLib.PDFCheckBox) {
              if (v) field.check(); else field.uncheck();
            } else if (field instanceof PDFLib.PDFRadioGroup) {
              if (!v) field.clear();
              else selectRadio(field, v);
            } else if (field instanceof PDFLib.PDFDropdown || field instanceof PDFLib.PDFOptionList) {
              if (!v) field.clear();
              else selectChoice(field, v, (ed.fields.get(name) || {}).options || []);
              try { field.updateAppearances(helv); } catch { needAppearances = true; }
            }
          } catch (e) {
            console.warn("field", name, e);
            warnings.push(name);
          }
        }
        if (needAppearances) form.acroForm.dict.set(PDFLib.PDFName.of("NeedAppearances"), PDFLib.PDFBool.True);
        if (ed.changed.size) try { form.deleteXFA(); } catch { /* no XFA */ }
        if (flatten) {
          if (needAppearances) warnings.push(t("save.flattenSkipped"));
          else form.flatten({ updateFieldAppearances: false });
        }
      } catch (e) {
        console.warn(e);
        warnings.push(t("save.formFailed"));
      }
    }
    // 2. notes layer: one transparent PNG per page, in unrotated page space
    for (const p of ed.pages) {
      const items = ed.items[p.index];
      if (!items.length) continue;
      busyText(t("busy.pageOf", { n: p.index + 1, total: ed.pages.length }));
      for (const it of items) if (it.type === "image") await loadImage(it.src);
      const png = await overlayPng(p, items);
      const img = await doc.embedPng(png);
      const [x1, y1, x2, y2] = p.view;
      doc.getPage(p.index).drawImage(img, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
      await tick();
    }
    const bytes = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
    ed.built = { key, bytes, pages: doc.getPageCount(), warnings };
    return ed.built;
  }

  // Sets a text field's appearance to a picture of its value, rendered with
  // the device's fonts. Every PDF viewer shows it (also when flattened); the
  // value itself stays in the field and can still be edited elsewhere.
  async function imageAppearance(doc, field, text) {
    const da = field.acroField.getDefaultAppearance() || "";
    const m = /(\d+(?:\.\d+)?)\s+Tf/.exec(da);
    const multiline = field.isMultiline();
    const align = field.getAlignment();
    for (const widget of field.acroField.getWidgets()) {
      const r = widget.getRectangle();
      const w = Math.max(1, r.width), hh = Math.max(1, r.height);
      let size = m && Number(m[1]) > 0 ? Number(m[1]) : multiline ? 10 : 12;
      size = multiline ? Math.min(size, 14) : Math.min(size, hh * 0.7);
      const png = await fieldTextPng(text, w, hh, size, multiline, align);
      const img = await doc.embedPng(png);
      const ops = [PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(w, 0, 0, hh, 0, 0), PDFLib.drawObject("Im0"), PDFLib.popGraphicsState()];
      const xobj = doc.context.formXObject(ops, { BBox: doc.context.obj([0, 0, w, hh]), Resources: { XObject: { Im0: img.ref } } });
      widget.setNormalAppearance(doc.context.register(xobj));
    }
  }

  async function fieldTextPng(text, w, hh, size, multiline, align) {
    const k = Math.min(4, 4096 / Math.max(w, hh));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hh * k));
    const ctx = c.getContext("2d");
    ctx.font = `${size * k}px ${FONT_STACK}`;
    ctx.fillStyle = "#000000";
    const pad = 2 * k;
    const xFor = (lineW) => (align === 1 ? (c.width - lineW) / 2 : align === 2 ? c.width - pad - lineW : pad);
    if (!multiline) {
      const line = text.replace(/\s*\n\s*/g, " ");
      ctx.textBaseline = "middle";
      ctx.fillText(line, xFor(ctx.measureText(line).width), c.height / 2);
    } else {
      // Wrap words to the field width.
      const lines = [];
      for (const para of text.split("\n")) {
        let cur = "";
        for (const word of para.split(/(\s+)/)) {
          const next = cur + word;
          if (cur && ctx.measureText(next).width > c.width - 2 * pad) { lines.push(cur.trimEnd()); cur = word.trimStart(); } else cur = next;
        }
        lines.push(cur);
      }
      ctx.textBaseline = "top";
      lines.forEach((line, i) => ctx.fillText(line, xFor(ctx.measureText(line).width), pad + i * size * 1.15 * k));
    }
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    c.width = c.height = 0;
    return new Uint8Array(await blob.arrayBuffer());
  }

  function selectRadio(field, value) {
    const options = field.getOptions();
    if (options.includes(value)) { field.select(value); return; }
    // /Opt export values differ from the widgets' on-state names: map by widget.
    const onValues = field.acroField.getOnValues().map((n) => n.decodeText());
    const i = onValues.indexOf(value);
    if (i >= 0 && options[i] !== undefined) field.select(options[i]);
    else throw new Error(`no radio option ${value}`);
  }

  function selectChoice(field, value, options) {
    const opts = field.getOptions();
    if (opts.includes(value)) { field.select(value); return; }
    const o = options.find((x) => x.exportValue === value);
    if (o && opts.includes(o.displayValue)) { field.select(o.displayValue); return; }
    field.select(value);
  }

  async function overlayPng(p, items) {
    const W1 = p.vp1.width, H1 = p.vp1.height;
    const k = Math.min(3, 4096 / Math.max(W1, H1));
    const c = document.createElement("canvas");
    c.width = Math.round(W1 * k); c.height = Math.round(H1 * k);
    drawItems(c.getContext("2d"), items, k, {});
    let out = c;
    const rot = ((p.rotate % 360) + 360) % 360;
    if (rot) {
      const [x1, y1, x2, y2] = p.view;
      out = document.createElement("canvas");
      out.width = Math.round((x2 - x1) * k); out.height = Math.round((y2 - y1) * k);
      const ctx = out.getContext("2d");
      ctx.translate(out.width / 2, out.height / 2);
      ctx.rotate((-rot * Math.PI) / 180);
      ctx.drawImage(c, -c.width / 2, -c.height / 2);
    }
    const blob = await new Promise((r) => out.toBlob(r, "image/png"));
    c.width = c.height = 0;
    out.width = out.height = 0;
    return new Uint8Array(await blob.arrayBuffer());
  }

  function editedName() {
    const base = baseName(editor.doc.name);
    if (editor.doc.docId) return editor.doc.name;
    return `${base}${editor.toolId === "sign" ? "-signed" : "-filled"}.pdf`;
  }

  function openSaveDialog() {
    commitTextEditor();
    const f = $("#save-form");
    showError($("#save-error"), "");
    f.filename.value = editedName();
    $("#save-flatten-row").hidden = !editor.fieldCount;
    $("#save-share").hidden = !canShareFiles();
    const inLibrary = !!editor.doc.docId;
    $("#save-update").hidden = !inLibrary;
    $("#save-library").textContent = t(inLibrary ? "save.asNew" : "save.toFiles");
    $("#save-dialog").showModal();
  }

  async function doSave(action) {
    const f = $("#save-form");
    const name = (f.filename.value || "").trim() || editedName();
    const flatten = f.flatten.checked;
    showError($("#save-error"), "");
    busy(true, t("busy.saving"));
    try {
      const built = await buildEditedPdf(flatten);
      const fileName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
      const blob = new Blob([built.bytes], { type: PDF_MIME });
      if (action === "download") downloadBlob(blob, fileName);
      else if (action === "share") await shareBlob(blob, fileName);
      else if (action === "update") {
        await saveToFiles(built.bytes, fileName, built.pages, editor.doc.docId);
        if (fileName !== editor.doc.name) await api("PATCH", `/documents/${editor.doc.docId}`, { name: fileName });
        editor.doc.name = fileName;
        $("#ed-name").textContent = fileName;
        toast(t("out.saved", { name: fileName }));
      } else {
        const d = await saveToFiles(built.bytes, fileName, built.pages);
        toast(t("out.saved", { name: d.name }));
      }
      editor.dirty = false;
      if (built.warnings.length) toast(t("save.warnings", { list: built.warnings.join(", ") }));
      $("#save-dialog").close();
    } catch (e) {
      console.error(e);
      showError($("#save-error"), e.message || t("common.failed"));
    } finally {
      busy(false);
    }
  }

  async function openDocumentInEditor(d) {
    busy(true, t("busy.loading"));
    try {
      const bytes = await fetchDocumentBytes(d.id);
      busy(false);
      await openEditor({ name: d.name, bytes, docId: d.id, pages: d.pages }, "pen", "edit");
    } catch (e) {
      busy(false);
      toast(e.message);
    }
  }

  function useInTool(d) {
    // Pick a tool for this file: show the home grid; the file is preselected.
    state.pendingDoc = d;
    toast(t("files.pickTool", { name: d.name }));
    go("#/");
  }

  // ---------- signature dialog (draw, type or upload) ----------

  const sig = { target: null, tab: "draw", color: "#111111", drawn: false, upload: null, style: 0 };
  const SIG_FONTS = [
    "\"Snell Roundhand\", \"Segoe Script\", \"Brush Script MT\", \"URW Chancery L\", cursive",
    "\"Bradley Hand\", \"Segoe Print\", \"Comic Sans MS\", cursive",
    "italic 1em Georgia, \"Times New Roman\", serif",
  ];

  function savedSignatures() {
    try {
      const list = JSON.parse(localGet("signatures") || "[]");
      return Array.isArray(list) ? list.filter((s) => typeof s === "string" && s.startsWith("data:image/png")) : [];
    } catch { return []; }
  }
  function storeSignatures(list) { localSet("signatures", JSON.stringify(list.slice(0, 6))); }

  function openSignatureDialog(target) {
    if (!editor) return;
    commitTextEditor();
    sig.target = target;
    sig.upload = null;
    showError($("#sig-error"), "");
    $("#sig-name").value = state.user ? state.user.display_name : "";
    $("#sig-upload-preview").replaceChildren();
    renderSavedSignatures();
    setSigTab(savedSignatures().length ? sig.tab : "draw");
    $("#sig-dialog").showModal();
    requestAnimationFrame(() => { setupPad(); renderTypedPreview(); });
  }

  function renderSavedSignatures() {
    const list = savedSignatures();
    const box = $("#sig-saved");
    box.hidden = !list.length;
    $("#sig-saved-list").replaceChildren(...list.map((src, i) => h("li", null,
      h("button", { type: "button", class: "sig-use", title: t("sig.use"), "aria-label": t("sig.use"), onclick: () => useSignature(src, false) },
        h("img", { src, alt: t("sig.saved") })),
      h("button", { type: "button", class: "icon-btn small danger", title: t("sig.forget"), "aria-label": t("sig.forget"),
        onclick: () => { const l = savedSignatures(); l.splice(i, 1); storeSignatures(l); renderSavedSignatures(); } }, "✕"))));
  }

  function setSigTab(tab) {
    sig.tab = tab;
    for (const id of ["draw", "type", "upload"]) {
      $(`#sig-tab-${id}`).classList.toggle("active", id === tab);
      $(`#sig-tab-${id}`).setAttribute("aria-selected", String(id === tab));
      $(`#sig-panel-${id}`).hidden = id !== tab;
    }
    if (tab === "draw") requestAnimationFrame(setupPad);
    if (tab === "type") requestAnimationFrame(renderTypedPreview);
  }

  // Drawing pad.
  let padActive = null;
  function setupPad() {
    const c = $("#sig-pad");
    const r = c.getBoundingClientRect();
    if (!r.width) return;
    const dpr = pixelRatio();
    const w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; sig.drawn = false; }
  }
  function clearPad() {
    const c = $("#sig-pad");
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    sig.drawn = false;
  }
  function padPoint(e) {
    const c = $("#sig-pad");
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, p: e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5 };
  }
  function onPadDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const c = $("#sig-pad");
    try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    padActive = { id: e.pointerId, last: padPoint(e) };
    const ctx = c.getContext("2d");
    ctx.fillStyle = sig.color;
    ctx.beginPath();
    ctx.arc(padActive.last.x, padActive.last.y, padWidth(padActive.last.p) / 2, 0, Math.PI * 2);
    ctx.fill();
    sig.drawn = true;
  }
  function padWidth(p) { return Math.max(1.5, 3.2 * pixelRatio() * (0.45 + p * 1.1)); }
  function onPadMove(e) {
    if (!padActive || padActive.id !== e.pointerId) return;
    e.preventDefault();
    const ctx = $("#sig-pad").getContext("2d");
    ctx.strokeStyle = sig.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (evs.length ? evs : [e])) {
      const pt = padPoint(ev);
      ctx.lineWidth = padWidth((pt.p + padActive.last.p) / 2);
      ctx.beginPath();
      ctx.moveTo(padActive.last.x, padActive.last.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      padActive.last = pt;
    }
  }
  function onPadUp(e) { if (padActive && padActive.id === e.pointerId) padActive = null; }

  function renderTypedPreview() {
    const c = $("#sig-type-preview");
    const r = c.getBoundingClientRect();
    if (!r.width) return;
    const dpr = pixelRatio();
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    const text = $("#sig-name").value.trim();
    if (!text) return;
    let size = c.height * 0.55;
    const font = (s) => (SIG_FONTS[sig.style].startsWith("italic") ? SIG_FONTS[sig.style].replace("1em", `${s}px`) : `${s}px ${SIG_FONTS[sig.style]}`);
    ctx.font = font(size);
    const w = ctx.measureText(text).width;
    if (w > c.width * 0.92) { size *= (c.width * 0.92) / w; ctx.font = font(size); }
    ctx.fillStyle = sig.color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(text, c.width / 2, c.height / 2);
  }

  // Crops a canvas to its non-transparent pixels (+ a small margin).
  function trimmedPng(c) {
    const ctx = c.getContext("2d");
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let x1 = width, y1 = height, x2 = -1, y2 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < x1) x1 = x; if (x > x2) x2 = x;
          if (y < y1) y1 = y; if (y > y2) y2 = y;
        }
      }
    }
    if (x2 < 0) return null;
    const pad = 6;
    x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad);
    x2 = Math.min(width - 1, x2 + pad); y2 = Math.min(height - 1, y2 + pad);
    const out = document.createElement("canvas");
    out.width = x2 - x1 + 1; out.height = y2 - y1 + 1;
    out.getContext("2d").drawImage(c, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  // Uploaded photo/scan of a signature: white paper becomes transparent.
  async function onSigUpload(ev) {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    try {
      const { bytes, png } = await normalizeImage({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
      const img = await loadImageFromBytes(bytes, png ? "image/png" : "image/jpeg");
      const maxW = 1200;
      const k = Math.min(1, maxW / img.naturalWidth);
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) {
        const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
        if (lum > 215) d.data[i + 3] = 0;
        else if (lum > 160) d.data[i + 3] = Math.round(d.data[i + 3] * (215 - lum) / 55);
      }
      ctx.putImageData(d, 0, 0);
      sig.upload = trimmedPng(c);
      if (!sig.upload) throw new Error(t("sig.emptyImage"));
      $("#sig-upload-preview").replaceChildren(h("img", { src: sig.upload, alt: "" }));
      showError($("#sig-error"), "");
    } catch (e) {
      sig.upload = null;
      showError($("#sig-error"), e.message);
    }
  }

  function loadImageFromBytes(bytes, type) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t("img.unreadable", { name: "" }))); };
      img.src = url;
    });
  }

  function onSigAdd() {
    let src = null;
    if (sig.tab === "draw") src = sig.drawn ? trimmedPng($("#sig-pad")) : null;
    else if (sig.tab === "type") { renderTypedPreview(); src = $("#sig-name").value.trim() ? trimmedPng($("#sig-type-preview")) : null; }
    else src = sig.upload;
    if (!src) { showError($("#sig-error"), t(sig.tab === "draw" ? "sig.drawFirst" : sig.tab === "type" ? "sig.typeFirst" : "sig.uploadFirst")); return; }
    useSignature(src, $("#sig-remember").checked);
  }

  function useSignature(src, remember) {
    if (remember) storeSignatures([src, ...savedSignatures().filter((s) => s !== src)]);
    const target = sig.target;
    $("#sig-dialog").close();
    placeSignature(src, target).catch((e) => toast(e.message));
  }

  // ---------- colour theme & language ----------

  function initThemePicker() {
    const select = $("#theme-select");
    const themes = window.IhatepdfTheme;
    if (!select) return;
    if (!themes) { select.closest(".theme-picker").hidden = true; return; }
    fillThemePicker();
    select.addEventListener("change", () => { select.value = themes.set(select.value); });
  }

  function fillThemePicker() {
    const select = $("#theme-select");
    const themes = window.IhatepdfTheme;
    if (!select || !themes) return;
    const label = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };
    const groups = new Map();
    const nodes = [];
    for (const th of themes.list) {
      const opt = h("option", { value: th.id }, label(`theme.${th.id}`, th.label));
      if (!th.group) { nodes.push(opt); continue; }
      if (!groups.has(th.group)) {
        const g = h("optgroup", { label: label(`theme.group.${th.group}`, th.group) });
        groups.set(th.group, g);
        nodes.push(g);
      }
      groups.get(th.group).append(opt);
    }
    select.replaceChildren(...nodes);
    select.value = themes.get();
  }

  function fillLanguagePicker() {
    const select = $("#lang-select");
    if (!select) return;
    select.replaceChildren(...I18N.list().map((l) => h("option", { value: l.id }, l.label)));
    select.value = I18N.get();
  }

  function initLanguagePicker() {
    const select = $("#lang-select");
    if (!select) return;
    fillLanguagePicker();
    select.addEventListener("change", () => { I18N.set(select.value); });
    I18N.onChange(relocalize);
  }

  function relocalize() {
    I18N.applyStatic();
    $("#auth-submit").textContent = t(state.authMode === "signup" ? "auth.createAccount" : "auth.signIn");
    setPasswordVisible($("#auth-form").password.type === "text");
    fillThemePicker();
    fillLanguagePicker();
    if ($("#app-view").hidden) return;
    renderNav();
    if (state.view === "home") showHome();
    else if (state.view === "files") renderFiles();
    else if (state.view === "tool" && state.tool) showTool(state.tool.id);
    else if (state.view === "editor" && editor) {
      setTitle(t(`tool.${editor.toolId === "sign" ? "sign" : "edit"}.title`));
      if (editor.fieldCount !== undefined) $("#ed-fields").textContent = editor.fieldCount ? tn("ed.fieldsFound", editor.fieldCount) : t("ed.noFields");
      renderEditorToolbar();
    }
  }

  // ---------- wiring ----------

  function wire() {
    I18N.applyStatic();
    initThemePicker();
    initLanguagePicker();
    document.querySelectorAll("dialog").forEach(enhanceDialog);
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
    document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

    // auth
    $("#tab-login").addEventListener("click", () => setAuthMode("login"));
    $("#tab-signup").addEventListener("click", () => setAuthMode("signup"));
    $("#auth-form").addEventListener("submit", onAuthSubmit);
    $("#password-toggle").addEventListener("click", togglePasswordVisible);
    $("#password-toggle").addEventListener("pointerdown", (e) => e.preventDefault());
    setPasswordVisible(false);
    $("#logout").addEventListener("click", logout);

    // layout
    $("#menu-toggle").addEventListener("click", toggleSidebar);
    $("#app-view").classList.toggle("sidebar-hidden", localGet("sidebar") === "hidden");
    syncMenuToggle();
    if (narrowScreen) {
      const onNarrow = () => syncMenuToggle();
      if (narrowScreen.addEventListener) narrowScreen.addEventListener("change", onNarrow);
      else if (narrowScreen.addListener) narrowScreen.addListener(onNarrow);
    }
    document.addEventListener("pointerdown", (e) => {
      const sb = $("#sidebar");
      if (isNarrow() && sb.classList.contains("open") && !sb.contains(e.target) && !$("#menu-toggle").contains(e.target)) setSidebar(false);
    });
    window.addEventListener("hashchange", route);

    // My files
    $("#files-upload").addEventListener("click", () => { const i = $("#files-input"); i.value = ""; i.click(); });
    // Copy the list and clear the input, so the same file can be chosen again.
    $("#files-input").addEventListener("change", (e) => { const files = [...e.target.files]; e.target.value = ""; uploadToFiles(files); });
    $("#home-pending-cancel").addEventListener("click", () => { state.pendingDoc = null; showHome(); });

    // tool page
    $("#tool-select").addEventListener("click", () => { const i = $("#tool-file"); i.value = ""; i.click(); });
    $("#tool-file").addEventListener("change", (e) => { const files = [...e.target.files]; e.target.value = ""; addLocalFiles(files); });
    $("#tool-from-files").addEventListener("click", () => addFromFiles().catch((e) => toast(e.message)));
    $("#tool-run").addEventListener("click", runTool);
    const drop = $("#tool-pick");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      if (e.dataTransfer && e.dataTransfer.files.length) addLocalFiles(e.dataTransfer.files);
    });

    // editor
    const pages = $("#ed-pages");
    pages.addEventListener("touchstart", onTouchStart, { passive: false });
    pages.addEventListener("pointerdown", onPointerDown);
    pages.addEventListener("pointermove", onPointerMove);
    pages.addEventListener("pointerup", onPointerUp);
    pages.addEventListener("pointercancel", onPointerUp);
    pages.addEventListener("click", (e) => {
      if (!editor || editor.tool !== "select" || !e.target.classList.contains("ed-ink")) return;
      const p = pageFromTarget(e.target);
      if (p && !hitTest(p, toPage(p, e.clientX, e.clientY))) setSelection(null);
    });
    document.querySelectorAll("#ed-tools button").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.edTool)));
    $("#ed-undo").addEventListener("click", () => { commitTextEditor(); undo(); });
    $("#ed-redo").addEventListener("click", () => { commitTextEditor(); redo(); });
    $("#ed-delete").addEventListener("click", deleteSelected);
    $("#ed-zoom-in").addEventListener("click", () => zoom(1.25));
    $("#ed-zoom-out").addEventListener("click", () => zoom(0.8));
    $("#ed-fit").addEventListener("click", fitWidth);
    $("#ed-pencil").addEventListener("click", () => {
      editor.pencilOnly = !editor.pencilOnly;
      localSet("pencilOnly", editor.pencilOnly ? "1" : "0");
      renderEditorToolbar();
      toast(t(editor.pencilOnly ? "ed.pencilOn" : "ed.pencilOff"));
    });
    $("#ed-save").addEventListener("click", openSaveDialog);
    $("#ed-close").addEventListener("click", () => closeEditor(false));
    const ta = $("#ed-text-editor");
    ta.addEventListener("input", () => autoGrow(ta));
    ta.addEventListener("blur", () => commitTextEditor());
    ta.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); ta.blur(); } });
    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (editor && editor.fit && state.view === "editor") fitWidth(); }, 150);
    });
    document.addEventListener("keydown", (e) => {
      if (!editor || state.view !== "editor" || document.querySelector("dialog[open]")) return;
      if (e.target.closest && e.target.closest("input, textarea, select")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && editor.selected) { e.preventDefault(); deleteSelected(); }
    });
    window.addEventListener("beforeunload", (e) => { if (editorDirty()) { e.preventDefault(); e.returnValue = ""; } });

    // save dialog
    $("#save-form").addEventListener("submit", (e) => { e.preventDefault(); doSave("download"); });
    $("#save-share").addEventListener("click", () => doSave("share"));
    $("#save-update").addEventListener("click", () => doSave("update"));
    $("#save-library").addEventListener("click", () => doSave("library"));

    // signature dialog
    for (const id of ["draw", "type", "upload"]) $(`#sig-tab-${id}`).addEventListener("click", () => setSigTab(id));
    const pad = $("#sig-pad");
    pad.addEventListener("pointerdown", onPadDown);
    pad.addEventListener("pointermove", onPadMove);
    pad.addEventListener("pointerup", onPadUp);
    pad.addEventListener("pointercancel", onPadUp);
    pad.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    $("#sig-clear").addEventListener("click", clearPad);
    document.querySelectorAll("#sig-dialog [data-sig-color]").forEach((b) => b.addEventListener("click", () => {
      sig.color = b.dataset.sigColor;
      document.querySelectorAll("#sig-dialog [data-sig-color]").forEach((x) => x.classList.toggle("active", x === b));
      renderTypedPreview();
    }));
    $("#sig-name").addEventListener("input", renderTypedPreview);
    document.querySelectorAll("#sig-styles button").forEach((b) => b.addEventListener("click", () => {
      sig.style = Number(b.dataset.style);
      document.querySelectorAll("#sig-styles button").forEach((x) => x.classList.toggle("active", x === b));
      renderTypedPreview();
    }));
    $("#sig-upload-btn").addEventListener("click", () => { const i = $("#sig-file"); i.value = ""; i.click(); });
    $("#sig-file").addEventListener("change", onSigUpload);
    $("#sig-add").addEventListener("click", onSigAdd);

    renderNav();
  }

  async function boot() {
    wire();
    try {
      const cfg = await api("GET", "/config");
      state.signupEnabled = !!cfg.signup_enabled;
      if (cfg.max_file_bytes) state.maxFileBytes = cfg.max_file_bytes;
      state.quotaBytes = cfg.quota_bytes || 0;
    } catch { state.signupEnabled = false; }
    try {
      state.user = await api("GET", "/me");
    } catch { state.user = null; }
    if (state.user) enterApp();
    else { setAuthMode("login"); showAuth(); }
  }

  boot();
})();
