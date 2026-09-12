(() => {
  if (window.top !== window || document.getElementById("repolens-extension-root")) return;

  const isSupported = (value) => {
    try {
      const url = new URL(value);
      const repository = /^\/([^/]+)\/[^/]+\/?$/.exec(url.pathname);
      const reserved = new Set(["about", "collections", "customer-stories", "enterprise", "events", "features", "login", "marketplace", "new", "notifications", "organizations", "orgs", "pricing", "readme", "search", "security", "settings", "signup", "sponsors", "topics"]);
      return url.protocol === "https:" && url.hostname === "github.com" && ((repository && !reserved.has(repository[1].toLowerCase())) || /^\/[^/]+\/[^/]+\/issues\/[1-9]\d*\/?$/.test(url.pathname));
    } catch { return false; }
  };

  const host = document.createElement("div");
  host.id = "repolens-extension-root";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .shell { position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #f7f8fc; }
    .launcher { height: 48px; min-width: 48px; padding: 0 15px; border: 1px solid rgba(255,255,255,.16); border-radius: 16px; display: flex; align-items: center; justify-content: center; gap: 9px; color: #fff; background: rgba(14,15,20,.9); box-shadow: 0 16px 50px rgba(0,0,0,.3), inset 0 1px rgba(255,255,255,.08); backdrop-filter: blur(18px) saturate(1.25); -webkit-backdrop-filter: blur(18px) saturate(1.25); cursor: pointer; font: 650 13px/1 Inter, ui-sans-serif, sans-serif; transition: transform .18s ease, border-color .18s ease, background .18s ease; }
    .launcher:hover { transform: translateY(-2px); border-color: rgba(145,132,255,.65); background: rgba(20,19,30,.96); }
    .launcher:focus-visible, .close:focus-visible { outline: 3px solid rgba(146,133,255,.7); outline-offset: 3px; }
    .mark { width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center; color: white; background: linear-gradient(145deg,#7c6cff,#4c42d7); box-shadow: 0 5px 16px rgba(91,76,225,.4); }
    .mark svg { width: 15px; height: 15px; }
    .panel { position: absolute; right: 0; bottom: 60px; width: min(430px, calc(100vw - 28px)); height: min(760px, calc(100vh - 110px)); border: 1px solid rgba(255,255,255,.14); border-radius: 22px; overflow: hidden; background: rgba(10,11,15,.94); box-shadow: 0 28px 90px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.06); backdrop-filter: blur(24px) saturate(1.2); -webkit-backdrop-filter: blur(24px) saturate(1.2); transform-origin: bottom right; transition: opacity .16s ease, transform .2s cubic-bezier(.2,.8,.2,1), visibility .16s; }
    .panel[aria-hidden="true"] { opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(10px) scale(.97); }
    .panel[aria-hidden="false"] { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }
    .panel-bar { height: 45px; display: flex; align-items: center; justify-content: space-between; padding: 0 11px 0 16px; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(19,20,27,.8); }
    .panel-title { display: flex; align-items: center; gap: 8px; color: #f4f2ff; font-size: 12px; font-weight: 680; letter-spacing: -.1px; }
    .status { width: 6px; height: 6px; border-radius: 50%; background: #8b7cff; box-shadow: 0 0 0 4px rgba(139,124,255,.12); }
    .close { width: 30px; height: 30px; border: 0; border-radius: 9px; display: grid; place-items: center; color: #a9acb7; background: transparent; cursor: pointer; }
    .close:hover { color: #fff; background: rgba(255,255,255,.08); }
    iframe { display: block; width: 100%; height: calc(100% - 45px); border: 0; background: #0b0c11; color-scheme: dark; }
    @media (max-width: 520px) { .shell { right: 10px; bottom: 10px; } .panel { width: calc(100vw - 20px); height: calc(100vh - 80px); bottom: 58px; border-radius: 18px; } .launcher-label { display: none; } .launcher { padding: 0; } }
    @media (prefers-reduced-motion: reduce) { .launcher, .panel { transition: none; } }
  `;

  const shell = document.createElement("div");
  shell.className = "shell";
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.setAttribute("aria-hidden", "true");
  panel.innerHTML = `<div class="panel-bar"><span class="panel-title"><span class="status"></span>RepoLens · GitHub context</span><button class="close" type="button" aria-label="Close RepoLens"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>`;
  const frame = document.createElement("iframe");
  frame.title = "RepoLens GitHub context assistant";
  frame.src = chrome.runtime.getURL("index.html?surface=overlay");
  frame.allow = "clipboard-write";
  panel.append(frame);

  const launcher = document.createElement("button");
  launcher.className = "launcher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open RepoLens");
  launcher.setAttribute("aria-expanded", "false");
  launcher.innerHTML = `<span class="mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6H6v2M16 6h2v2M8 18H6v-2M16 18h2v-2M9 12h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span><span class="launcher-label">RepoLens</span>`;
  shell.append(panel, launcher);
  root.append(style, shell);
  document.documentElement.append(host);

  const setOpen = (open) => {
    panel.setAttribute("aria-hidden", String(!open));
    launcher.setAttribute("aria-expanded", String(open));
    launcher.setAttribute("aria-label", open ? "Close RepoLens" : "Open RepoLens");
  };
  const toggle = () => setOpen(panel.getAttribute("aria-hidden") === "true");
  launcher.addEventListener("click", toggle);
  panel.querySelector(".close").addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") setOpen(false); });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TOGGLE_REPOLENS") toggle();
    if (message?.type === "GITHUB_CONTEXT_CHANGED" || message?.type === "ISSUE_CONTEXT_CHANGED") host.hidden = !isSupported(location.href);
  });
  host.hidden = !isSupported(location.href);
})();
