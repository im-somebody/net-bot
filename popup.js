const $ = (s) => document.querySelector(s);
const CFG_KEY = "ccna.cfg";
const STATE_KEY = "ccna.state";
const TEST_KEY = "ccna.test";

const els = {
  maxPages: $("#maxPages"),
  waitMs: $("#waitMs"),
  provider: $("#provider"),
  apiKey: $("#apiKey"),
  useAI: $("#useAI"),
  dot: $("#dot"),
  stateText: $("#stateText"),
  pageText: $("#pageText"),
  reason: $("#reason"),
  log: $("#log"),
  stop: $("#stop"),
  keyState: $("#keyState"),
};

function showTest(t) {
  if (!t?.text) return;
  els.keyState.className = t.ok ? "ok" : "bad";
  els.keyState.textContent = t.text;
}

async function load() {
  const {
    [CFG_KEY]: c = {},
    [STATE_KEY]: s = {},
    [TEST_KEY]: t,
  } = await chrome.storage.local.get([CFG_KEY, STATE_KEY, TEST_KEY]);
  els.maxPages.value = c.maxPages ?? 1000;
  els.waitMs.value = c.waitMs ?? 3000;
  els.provider.value = c.provider || "auto";
  els.apiKey.value = c.apiKey ?? "";
  els.useAI.checked = !!c.useAI;
  if (c.theme) document.documentElement.dataset.theme = c.theme;
  showTest(t);
  render(s);
}

async function saveCfg(patch) {
  const { [CFG_KEY]: c = {} } = await chrome.storage.local.get(CFG_KEY);
  await chrome.storage.local.set({ [CFG_KEY]: { ...c, ...patch } });
}

function render(s = {}) {
  const live = !!s.running;
  els.dot.className = "dot" + (s.error ? " err" : live ? " live" : "");
  els.stateText.textContent = s.error
    ? "Error"
    : live
      ? s.label || "Trabajando"
      : "Detenido";
  els.pageText.textContent = s.page ? `Página: ${s.page}` : "—";
  els.reason.textContent = s.reason || "";
  els.log.textContent = (s.log || []).slice(-60).join("\n");
  els.log.scrollTop = els.log.scrollHeight;
  for (const b of document.querySelectorAll("button[data-act]"))
    if (b.id !== "stop") b.disabled = live;
  els.stop.disabled = !live;
  for (const f of [
    els.maxPages,
    els.waitMs,
    els.provider,
    els.apiKey,
    els.useAI,
  ])
    f.disabled = live;
}

els.maxPages.addEventListener("change", () =>
  saveCfg({ maxPages: +els.maxPages.value || 1000 }),
);
els.waitMs.addEventListener("change", () =>
  saveCfg({ waitMs: Math.max(500, +els.waitMs.value || 3000) }),
);
els.provider.addEventListener("change", () =>
  saveCfg({ provider: els.provider.value }),
);
els.apiKey.addEventListener("change", () =>
  saveCfg({ apiKey: els.apiKey.value.trim() }),
);
els.useAI.addEventListener("change", () =>
  saveCfg({ useAI: els.useAI.checked }),
);
$("#eye").addEventListener("click", () => {
  els.apiKey.type = els.apiKey.type === "password" ? "text" : "password";
});
$("#theme").addEventListener("click", async () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  await saveCfg({ theme: next });
});

document.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  if (act === "stop") {
    chrome.runtime.sendMessage({ type: "STOP" });
    return;
  }
  if (act === "testkey") {
    els.keyState.className = "";
    els.keyState.textContent = "Probando…";
    await chrome.storage.local.set({
      [TEST_KEY]: { ok: false, text: "Probando…", at: Date.now() },
    });
    chrome.runtime.sendMessage({ type: "START", mode: "test" });
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "START", mode: act });
  if (res?.error) els.reason.textContent = res.error;
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch[STATE_KEY]) render(ch[STATE_KEY].newValue || {});
  if (ch[TEST_KEY]) showTest(ch[TEST_KEY].newValue);
});

load();
setInterval(async () => {
  const { [STATE_KEY]: s } = await chrome.storage.local.get(STATE_KEY);
  render(s || {});
}, 1000);
