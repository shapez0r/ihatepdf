// ihatepdf colour themes. Loaded synchronously in <head> (before the page is
// drawn) so a chosen theme is applied without a flash of the default colours.
// The choice is remembered in this browser (localStorage).
(() => {
  "use strict";
  const THEMES = [
    { id: "auto", label: "System (light/dark)", group: "" },
    { id: "cyber-light", label: "Cyber light", group: "Light" },
    { id: "paper", label: "Paper", group: "Light" },
    { id: "pink", label: "Pink", group: "Light" },
    { id: "lavender", label: "Lavender", group: "Light" },
    { id: "cyber-night", label: "Cyber night", group: "Dark" },
    { id: "terminal", label: "Terminal", group: "Dark" },
    { id: "purple", label: "Purple", group: "Dark" },
    { id: "rose-night", label: "Rose night", group: "Dark" },
  ];
  const KEY = "ihatepdf.theme";
  const valid = (id) => THEMES.some((t) => t.id === id);

  function get() {
    try {
      const v = localStorage.getItem(KEY);
      return valid(v) ? v : "auto";
    } catch { return "auto"; }
  }

  function apply(id) {
    const root = document.documentElement;
    if (!valid(id) || id === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", id);
  }

  function set(id) {
    if (!valid(id)) id = "auto";
    try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
    apply(id);
    return id;
  }

  apply(get());
  window.IhatepdfTheme = { list: THEMES, get, set };
})();
