/* Net-Bot — service worker: recorrido, apuntes, quizzes, exámenes y aprendizaje de patrones. */

const CFG = "ccna.cfg";
const STATE = "ccna.state";
const SAVED = "ccna.saved";
const IDX = "ccna.index";
const TEST = "ccna.test";
const MODEL_CACHE = "ccna.modelCache";
const PATTERNS_KEY = "ccna.patterns";
const ANSWERS = "ccna.answers.v2";
const VERIFIED = "ccna.verified";
const WRONG = "ccna.wrong";

const DEFAULTS = {
  maxPages: 1000,
  waitMs: 3000,
  apiKey: "",
  provider: "auto",
  useAI: false,
  aiModel: "",
};
const PT_RE = /packet\s*tracer/i;
const QUIZ_RE =
  /verifique su comprensi[oó]n|compruebe su comprensi[oó]n|check your understanding|quiz del m[oó]dulo|module quiz|examen|exam|prueba de mi conocimiento|checkpoint|punto de control|midterm|final|pre-?certificaci[oó]n|assessment/i;

let abort = false;
let running = false;
let cachedGeminiModels = null;
let cachedVeniceModels = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getCfg() {
  const o = await chrome.storage.local.get(CFG);
  return { ...DEFAULTS, ...(o[CFG] || {}) };
}
async function setState(patch) {
  const o = await chrome.storage.local.get(STATE);
  await chrome.storage.local.set({
    [STATE]: { ...(o[STATE] || {}), ...patch },
  });
}
async function log(msg) {
  const o = await chrome.storage.local.get(STATE);
  await setState({ log: [...(o[STATE]?.log || []), msg].slice(-200) });
}
function stop(reason, isError) {
  abort = true;
  setState({
    running: false,
    label: "Detenido",
    reason: reason || "",
    error: !!isError,
  });
}
async function guardarRespuestas(answers) {
  if (!answers.length) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  await download(
    `respuestas-${stamp}.md`,
    "# Respuestas de autoevaluaciones\n\n" + answers.join("\n\n"),
  );
}

/* Memoria persistente de patrones de preguntas aprendidos (solo respaldo) */
async function getLearnedPatterns() {
  const o = await chrome.storage.local.get(PATTERNS_KEY);
  return Array.isArray(o[PATTERNS_KEY]) ? o[PATTERNS_KEY] : [];
}
async function learnQuestionPattern(sig) {
  if (!sig || !sig.kind || !sig.optionSel) return;
  const list = await getLearnedPatterns();
  const key = `${sig.kind}::${sig.containerSel || ""}::${sig.optionSel}`;
  const idx = list.findIndex(
    (p) => `${p.kind}::${p.containerSel || ""}::${p.optionSel}` === key,
  );
  if (idx >= 0) {
    list[idx].hits = (list[idx].hits || 1) + 1;
    list[idx].lastUsed = Date.now();
    if (sig.selectedHint) list[idx].selectedHint = sig.selectedHint;
  } else {
    list.push({
      kind: sig.kind,
      containerSel: sig.containerSel || "",
      optionSel: sig.optionSel,
      selectedHint: sig.selectedHint || "",
      hits: 1,
      lastUsed: Date.now(),
    });
  }
  list.sort((a, b) => (b.hits || 1) - (a.hits || 1));
  await chrome.storage.local.set({ [PATTERNS_KEY]: list.slice(0, 40) });
}

/* Caché persistente del último modelo funcional por proveedor y key */
const keySig = (k) => `${k.slice(0, 6)}:${k.slice(-4)}:${k.length}`;
async function getStickyModel(provider, key) {
  const o = await chrome.storage.local.get(MODEL_CACHE);
  const entry = o[MODEL_CACHE]?.[provider];
  return entry && entry.sig === keySig(key) ? entry.model : "";
}
async function setStickyModel(provider, key, model) {
  const o = await chrome.storage.local.get(MODEL_CACHE);
  const prev = o[MODEL_CACHE] || {};
  const next = model
    ? { ...prev, [provider]: { sig: keySig(key), model } }
    : { ...prev, [provider]: null };
  await chrome.storage.local.set({ [MODEL_CACHE]: next });
}

async function fetchT(url, opts = {}, ms = 18000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (e) {
    throw new Error(
      e.name === "AbortError"
        ? `sin respuesta en ${ms / 1000} s`
        : `no se pudo conectar: ${e.message}`,
    );
  } finally {
    clearTimeout(t);
  }
}

const sanitizeKey = (k) =>
  String(k || "")
    .replace(/[\s"'`]/g, "")
    .replace(/^Bearer/i, "");

function resolveProvider(cfg) {
  const key = sanitizeKey(cfg.apiKey);
  if (!key) throw new Error("Falta la API key en los ajustes.");
  const p = cfg.provider || "auto";
  if (["gemini", "claude", "venice"].includes(p)) return p;
  if (/^sk-ant-/.test(key)) return "claude";
  if (/^AIza/.test(key) || /^AQ\./.test(key)) return "gemini";
  return "venice";
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t) throw new Error("No hay pestaña activa.");
  if (!/netacad\.(com|net)|cisco\.com/.test(t.url || ""))
    throw new Error("Abre la lección de NetAcad en esta pestaña.");
  return t;
}
async function execAll(tabId, func, args = []) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func,
      args,
    });
    return r.map((x) => ({ frameId: x.frameId, result: x.result }));
  } catch (e) {
    await log(`  inyección falló: ${e.message}`);
    return [];
  }
}
async function execIn(tabId, frameId, func, args = []) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func,
      args,
    });
    return r[0]?.result;
  } catch {
    return null;
  }
}

async function ensureContent(tabId) {
  const has = await execAll(tabId, () => !!window.__ccna);
  // Basta un frame sin content.js (p. ej. la lección recién cargada) para no poder leerla
  if (has.length && has.every((f) => f.result)) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
    await sleep(120);
    return true;
  } catch (e) {
    await log(
      `  no se pudo inyectar content.js: ${e.message}. Recarga con F5.`,
    );
    return false;
  }
}

/* ---------- proveedores ---------- */
function rankGeminiModel(name) {
  const n = name.toLowerCase();
  if (/gemini-3.*flash|gemini-flash-latest/.test(n)) return 1;
  if (/gemini-3.*pro|gemini-pro-latest/.test(n)) return 2;
  if (/gemini-3/.test(n)) return 3;
  if (/gemini-2\.5-flash-lite/.test(n)) return 4;
  if (/gemini-2\.5-flash/.test(n)) return 5;
  if (/gemini-2\.5-pro/.test(n)) return 6;
  if (/gemini-/.test(n)) return 7;
  if (/gemma-/.test(n)) return 9;
  return 8;
}

async function pickModels(key) {
  if (cachedGeminiModels?.key === key && cachedGeminiModels.list.length) {
    return cachedGeminiModels.list;
  }
  const res = await fetchT(
    "https://generativelanguage.googleapis.com/v1beta/models?key=" +
      encodeURIComponent(key),
    {},
    10000,
  );
  if (!res.ok) throw new Error(`listar modelos (${res.status})`);
  const d = await res.json().catch(() => ({}));
  const list = (d.models || [])
    .filter((m) =>
      (m.supportedGenerationMethods || []).includes("generateContent"),
    )
    .map((m) => m.name.replace("models/", ""))
    .filter(
      (n) =>
        !/embedding|image|imagen|tts|live|aqa|veo|learnlm|robotics|computer-use/i.test(
          n,
        ),
    )
    .sort((a, b) => rankGeminiModel(a) - rankGeminiModel(b))
    .slice(0, 14);
  cachedGeminiModels = { key, list };
  return list;
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

async function geminiCall(
  key,
  model,
  system,
  prompt,
  json,
  maxOut = 1200,
  images = [],
  hard = true,
) {
  const sticky = await getStickyModel("gemini", key);
  let models = [];
  if (!model && !sticky) {
    try {
      models = await pickModels(key);
    } catch (e) {
      throw new Error(`no se pudo listar modelos: ${e.message}`);
    }
  }
  const list = [
    ...new Set(
      [
        model,
        sticky,
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite-preview",
        "gemini-flash-latest",
        ...models,
      ].filter(Boolean),
    ),
  ].slice(0, 12);

  const parts = [{ text: prompt }];
  for (const img of images) {
    const parsed = parseDataUrl(img);
    if (parsed) {
      parts.push({
        inlineData: { mimeType: parsed.mimeType, data: parsed.data },
      });
    }
  }

  const fallos = [];
  for (let idx = 0; idx < list.length; idx++) {
    const m = list[idx];
    let res;
    try {
      res = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: maxOut,
              ...(json ? { responseMimeType: "application/json" } : {}),
              ...(!hard && /gemini-3/.test(m)
                ? { thinkingConfig: { thinkingLevel: "low" } }
                : !hard && /gemini-2\.5/.test(m)
                  ? { thinkingConfig: { thinkingBudget: 512 } }
                  : {}),
            },
          }),
        },
        hard ? 18000 : 8000,
      );
    } catch (e) {
      fallos.push(`${m}=${e.message}`);
      continue;
    }
    if (res.status === 401 || res.status === 403)
      throw new Error(`Google rechazó la key (${res.status}).`);
    if (!res.ok) {
      if (sticky === m) await setStickyModel("gemini", key, "");
      if (cachedGeminiModels?.key === key && res.status === 404) {
        cachedGeminiModels.list = cachedGeminiModels.list.filter(
          (x) => x !== m,
        );
      }
      fallos.push(`${m}=${res.status}`);
      if (idx === list.length - 1 && !models.length) {
        try {
          const extra = await pickModels(key);
          for (const em of extra) if (!list.includes(em)) list.push(em);
        } catch {}
      }
      continue;
    }
    const d = await res.json();
    const out =
      d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    if (out) {
      if (sticky !== m) await setStickyModel("gemini", key, m);
      return out;
    }
    fallos.push(`${m}=vacío`);
  }
  cachedGeminiModels = null;
  await setStickyModel("gemini", key, "");
  throw new Error(`Gemini sin respuesta [${fallos.join(", ")}]`);
}

async function claudeCall(
  key,
  model,
  system,
  prompt,
  json,
  maxOut = 1200,
  images = [],
  hard = true,
) {
  const sticky = await getStickyModel("claude", key);
  const list = [
    ...new Set(
      [
        model,
        sticky,
        "claude-haiku-4-5",
        "claude-sonnet-4-5",
        "claude-3-7-sonnet-latest",
        "claude-3-5-sonnet-latest",
      ].filter(Boolean),
    ),
  ];

  const content = [];
  for (const img of images) {
    const parsed = parseDataUrl(img);
    if (parsed) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parsed.mimeType,
          data: parsed.data,
        },
      });
    }
  }
  content.push({ type: "text", text: prompt });

  const fallos = [];
  for (const m of list) {
    let res;
    try {
      res = await fetchT(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: m,
            max_tokens: maxOut,
            system,
            messages: [{ role: "user", content }],
          }),
        },
        hard ? 25000 : 10000,
      );
    } catch (e) {
      fallos.push(`${m}=${e.message}`);
      continue;
    }
    if (res.status === 401 || res.status === 403)
      throw new Error(`Anthropic rechazó la key (${res.status}).`);
    if (res.status === 429) throw new Error("Claude: cuota agotada (429).");
    if (!res.ok) {
      if (sticky === m) await setStickyModel("claude", key, "");
      fallos.push(`${m}=${res.status}`);
      continue;
    }
    const d = await res.json();
    const out = d.content?.map((c) => c.text).join("") || "";
    if (out) {
      if (sticky !== m) await setStickyModel("claude", key, m);
      return out;
    }
    fallos.push(`${m}=vacío`);
  }
  await setStickyModel("claude", key, "");
  throw new Error(`Claude sin respuesta [${fallos.join(", ")}]`);
}

function rankVeniceModel(id) {
  const n = id.toLowerCase();
  if (/llama-3\.3-70b/.test(n)) return 1;
  if (/mistral-31-24b|mistral-small/.test(n)) return 2;
  if (/qwen-2\.5|qwen3-next|qwen3-32b/.test(n)) return 3;
  if (/llama-3\.1-405b|llama-3\.2/.test(n)) return 4;
  if (/deepseek|glm|qwen3-235b/.test(n)) return 7;
  return 5;
}

async function pickVeniceModels(key) {
  if (cachedVeniceModels?.key === key && cachedVeniceModels.list.length) {
    return cachedVeniceModels.list;
  }
  try {
    const res = await fetchT(
      "https://api.venice.ai/api/v1/models",
      { headers: { authorization: `Bearer ${key}` } },
      8000,
    );
    if (!res.ok) return [];
    const d = await res.json().catch(() => ({}));
    const list = (d.data || [])
      .filter((m) => !m.type || m.type === "text")
      .map((m) => m.id)
      .filter(
        (id) =>
          id &&
          !/whisper|tts|flux|sdxl|upscale|embedding|image|video|audio/i.test(
            id,
          ),
      )
      .sort((a, b) => rankVeniceModel(a) - rankVeniceModel(b))
      .slice(0, 10);
    cachedVeniceModels = { key, list };
    return list;
  } catch {
    return [];
  }
}

async function veniceCall(
  key,
  model,
  system,
  prompt,
  json,
  maxOut = 1200,
  images = [],
  hard = true,
) {
  const sticky = await getStickyModel("venice", key);
  let catalog = [];
  if (!model && !sticky) catalog = await pickVeniceModels(key);
  const visionModels = images.length ? ["mistral-31-24b"] : [];
  const list = [
    ...new Set(
      [
        model,
        ...visionModels,
        sticky,
        ...catalog,
        "llama-3.3-70b",
        "mistral-31-24b",
      ].filter(Boolean),
    ),
  ];
  let fetchedCatalog = catalog.length > 0;

  const userContent = images.length
    ? [
        { type: "text", text: prompt },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : prompt;

  const fallos = [];
  for (let idx = 0; idx < list.length; idx++) {
    const m = list[idx];
    let res;
    try {
      res = await fetchT(
        "https://api.venice.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: m,
            temperature: 0.1,
            max_tokens: maxOut,
            venice_parameters: { include_venice_system_prompt: false },
            messages: [
              { role: "system", content: system },
              { role: "user", content: userContent },
            ],
          }),
        },
        hard ? 22000 : 10000,
      );
    } catch (e) {
      fallos.push(`${m}=${e.message}`);
      continue;
    }
    if (res.status === 401 || res.status === 403)
      throw new Error(`Venice rechazó la key (${res.status}).`);
    if (res.status === 429) throw new Error("Venice: cuota agotada (429).");
    if (!res.ok) {
      if (sticky === m) await setStickyModel("venice", key, "");
      fallos.push(`${m}=${res.status}`);
      if (idx === list.length - 1 && !fetchedCatalog) {
        fetchedCatalog = true;
        const extra = await pickVeniceModels(key);
        for (const cm of extra) if (!list.includes(cm)) list.push(cm);
      }
      continue;
    }
    const d = await res.json();
    const out = d.choices?.[0]?.message?.content || "";
    if (out) {
      if (sticky !== m && !images.length)
        await setStickyModel("venice", key, m);
      return out;
    }
    fallos.push(`${m}=vacío`);
  }
  if (images.length)
    return veniceCall(key, model, system, prompt, json, maxOut, [], hard);
  cachedVeniceModels = null;
  await setStickyModel("venice", key, "");
  throw new Error(`Venice sin respuesta [${fallos.join(", ")}]`);
}

async function callAI(system, prompt, json, maxOut, images = [], hard = true) {
  const cfg = await getCfg();
  const key = sanitizeKey(cfg.apiKey);
  const provider = resolveProvider(cfg);
  const model = (cfg.aiModel || "").trim();
  const tokens = maxOut || 1200;
  if (provider === "gemini")
    return geminiCall(key, model, system, prompt, json, tokens, images, hard);
  if (provider === "claude")
    return claudeCall(key, model, system, prompt, json, tokens, images, hard);
  return veniceCall(key, model, system, prompt, json, tokens, images, hard);
}

async function testKey() {
  const cfg = await getCfg();
  try {
    const provider = resolveProvider(cfg);
    const out = await callAI("Responde solo: ok", "Di ok.", false, 20);
    return {
      ok: true,
      text: `Todo correcto (${provider}). Respuesta: ${out.trim().slice(0, 30)}`,
    };
  } catch (e) {
    return { ok: false, text: e.message };
  }
}

function extractBalancedJSON(str) {
  let start = -1;
  let openCh = "";
  let closeCh = "";
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "{" || str[i] === "[") {
      start = i;
      openCh = str[i];
      closeCh = openCh === "{" ? "}" : "]";
      break;
    }
  }
  if (start === -1) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return str.slice(start);
}

function parseJSON(raw) {
  const clean = String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      const repaired = s
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ': "$1"');
      return JSON.parse(repaired);
    }
  };

  let data = null;
  try {
    data = tryParse(clean);
  } catch {
    const balanced = extractBalancedJSON(clean);
    if (balanced) {
      try {
        data = tryParse(balanced);
      } catch {}
    }
  }

  if (!data) {
    const recovered = [];
    const rePair =
      /"id"\s*:\s*(\d+)[\s\S]{0,120}?"respuesta"\s*:\s*(\{[^}]+\}|\[[^\]]+\]|"[A-Za-z]")/g;
    let m;
    while ((m = rePair.exec(clean)) !== null) {
      try {
        recovered.push({ id: Number(m[1]), respuesta: JSON.parse(m[2]) });
      } catch {}
    }
    if (recovered.length) return recovered;

    const singleMatch = clean.match(
      /"respuesta"\s*:\s*(\{[^}]+\}|\[[^\]]+\]|"[A-Za-z]")/,
    );
    if (singleMatch) {
      try {
        return [{ respuesta: JSON.parse(singleMatch[1]) }];
      } catch {}
    }
    const preview = clean.replace(/\s+/g, " ").slice(0, 90);
    throw new Error(
      `la IA no devolvió JSON válido${preview ? ` (${preview})` : ""}`,
    );
  }

  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of [
      "items",
      "respuestas",
      "answers",
      "preguntas",
      "results",
      "data",
    ]) {
      if (Array.isArray(data[k])) return data[k];
    }
    return [data];
  }
  throw new Error("formato JSON inesperado");
}

async function aiJSON(system, prompt, maxOut = 1200, images = [], hard = true) {
  for (let i = 0; i < 2; i++) {
    const raw = await callAI(
      i
        ? `${system} IMPORTANTE: Responde ÚNICAMENTE con el objeto JSON, sin markdown ni explicaciones.`
        : system,
      prompt,
      true,
      maxOut,
      images,
      hard,
    );
    try {
      return parseJSON(raw);
    } catch (e) {
      if (i === 1) throw e;
    }
  }
  return [];
}

/* ---------- funciones inyectadas (100% autocontenidas) ---------- */

function ccnaMeta() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const deepText = (root = document.body) => {
    if (!root) return "";
    let t = root.innerText || "";
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) t += " " + deepText(el.shadowRoot);
    return t;
  };
  const REJECT =
    /^(content|gradebook|inicio|home|curso|course|netacad|contenido|calificaciones)$/i;
  const COURSE = /^CCNA:|Ver\.\s?\d/i;
  const title = (() => {
    const NUM = /^(\d+(?:\.\d+)+)\s+\S/;
    const isActive = (el) =>
      !!el.closest(
        '[aria-current]:not([aria-current="false"]), [aria-selected="true"], [class*="active"], [class*="selected"], [class*="current"]',
      );
    const cands = [];
    const push = (el, t) => {
      t = norm(t);
      const m = t.match(NUM);
      if (!m || t.length >= 160 || REJECT.test(t) || COURSE.test(t)) return;
      cands.push({ t, depth: m[1].split(".").length, active: isActive(el) });
    };
    for (const el of deepAll('[class*="blockName"], [class*="block-name"]'))
      push(el, el.getAttribute("title") || el.innerText);
    for (const el of deepAll("h1,h2,h3")) push(el, el.innerText);
    for (const el of deepAll("div,span,header *")) {
      const r = el.getBoundingClientRect();
      if (r && r.top <= 150 && r.width >= 40) push(el, el.innerText);
    }
    cands.sort(
      (a, b) =>
        b.active - a.active || b.depth - a.depth || a.t.length - b.t.length,
    );
    if (cands[0]) return cands[0].t;

    const outline = deepAll(
      '[role="tree"] [aria-selected="true"], [class*="outline"] [class*="active"], [class*="nav"] [class*="active"], li.active a, .active a, a.active',
    )
      .map((el) => norm(el.innerText))
      .filter((t) => t && t.length < 160 && !REJECT.test(t) && !COURSE.test(t));
    if (outline[0]) return outline[0];

    const dt = norm(document.title);
    const marked = dt.match(
      /(verifique su comprensi[oó]n|compruebe su comprensi[oó]n|quiz del m[oó]dulo|punto de control|checkpoint|examen[^|]{0,40})/i,
    );
    if (marked) return dt.slice(marked.index, marked.index + 100).trim();
    return "";
  })();
  const txt = deepText();
  return {
    url: location.href,
    size: txt.length,
    title,
    docTitle: norm(document.title).slice(0, 200),
    lost: /vuelva a iniciar el curso|restart the course|sesión expirada|session expired/i.test(
      txt,
    ),
    sig: norm(txt).slice(0, 400),
  };
}

function ccnaProbe() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const deepText = (el) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : [...el.childNodes];
    return kids.map(deepText).join(" ");
  };
  const isVisibleBox = (el) => {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.nodeType === 1) {
        if (
          cur.hasAttribute?.("hidden") ||
          cur.getAttribute?.("aria-hidden") === "true" ||
          cur.hasAttribute?.("inert")
        )
          return false;
        const st = getComputedStyle(cur);
        if (
          st.display === "none" ||
          st.visibility === "hidden" ||
          st.opacity === "0"
        )
          return false;
      }
      cur = cur.parentElement || cur.getRootNode?.().host || null;
    }
    const r = el.getBoundingClientRect?.();
    return !!r && r.width >= 6 && r.height >= 6;
  };

  const bodyTxt = norm(deepText(document.body));
  let progress = null;
  const mProg =
    bodyTxt.match(/(\d+)\s*(?:de|of|\/)\s*(\d+)\s*(?:preguntas|questions)/i) ||
    bodyTxt.match(/(?:pregunta|question)\s*(\d+)\s*(?:de|of|\/)\s*(\d+)/i) ||
    bodyTxt.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (mProg && +mProg[2] >= 1 && +mProg[1] >= 1 && +mProg[1] <= +mProg[2]) {
    progress = { cur: +mProg[1], total: +mProg[2] };
  } else {
    let maxChip = 0;
    let activeChip = 0;
    for (const el of deepAll("button,a,[role='button'],li,span,div")) {
      if (!el.getClientRects().length) continue;
      if (el.closest("h1,h2,h3,h4,h5,h6,[class*='questionTitle']")) continue;
      const t = norm(deepText(el));
      const m = t.match(/^q\s*(\d+)$/i);
      if (!m) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 12 || r.width > 200 || r.height > 120)
        continue;
      const num = +m[1];
      if (num > maxChip) maxChip = num;
      const holder =
        el.closest("button,a,[role='button'],[role='tab'],li") || el;
      const meta =
        String(holder.className || "") +
        " " +
        (holder.getAttribute?.("aria-current") || "") +
        " " +
        (holder.getAttribute?.("aria-selected") || "");
      if (/\b(active|current|selected|true)\b/i.test(meta)) activeChip = num;
    }
    if (maxChip >= 2) progress = { cur: activeChip || 1, total: maxChip };
  }

  const confirmInput = deepAll(
    'input#confirm-exam, input[name="confirm"]',
  ).find((el) => {
    const host = el.closest("label, div, section") || el;
    return isVisibleBox(host);
  });
  const onConfirmScreen = !!confirmInput;

  const isResultScreen =
    /reiniciar|restart|puntuaci[oó]n|your score|\d+\s*(?:de|of)\s*\d+\s*(?:correctas?|correct)/i.test(
      bodyTxt,
    ) && !onConfirmScreen;

  const activeStem =
    deepAll(
      '[class*="mcq__body-inner"], [class*="objectMatching__body-inner"], [class*="matching__body-inner"], [class*="component__body-inner"], [class*="question-text"], [class*="questionText"], [class*="stem"], [class*="prompt"], legend, p',
    )
      .filter((el) => {
        if (el.closest("header, nav, label, button")) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 20 && r.height >= 10 && r.left >= 0;
      })
      .map((el) => norm(deepText(el)))
      .find(
        (t) =>
          t.length > 14 &&
          !/^(?:pregunta\s*\d+|quiz del m[oó]dulo|module quiz)/i.test(t),
      ) || "";

  return {
    progress,
    onConfirmScreen,
    isResultScreen,
    activeStem: activeStem.slice(0, 200),
  };
}

function ccnaScan(learnedPatterns = []) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const deepText = (el, skip) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    if (skip && el.matches(skip)) return "";
    if (el.tagName === "IMG")
      return el.alt ? ` [Imagen: ${el.alt}] ` : " [Imagen] ";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : el.tagName === "SLOT"
        ? el.assignedNodes()
        : [...el.childNodes];
    return kids.map((k) => deepText(k, skip)).join(" ");
  };

  deepAll("[data-ccna-id]").forEach((el) => el.removeAttribute("data-ccna-id"));

  const isHiddenSlide = (el, requireBoxSize = false) => {
    let cur = el;
    const vw =
      window.innerWidth || document.documentElement.clientWidth || 1280;
    let checkedSelf = false;
    while (cur && cur !== document.body) {
      if (cur.nodeType === 1) {
        if (
          cur.hasAttribute?.("hidden") ||
          cur.getAttribute?.("aria-hidden") === "true" ||
          cur.hasAttribute?.("inert")
        )
          return true;
        const st = getComputedStyle(cur);
        if (st.display === "none" || st.visibility === "hidden") return true;
        if (!checkedSelf && requireBoxSize && st.opacity === "0") return true;
        if (st.display !== "contents") {
          const visTarget =
            cur.shadowRoot?.querySelector("button,input,div") || cur;
          if (!visTarget.getClientRects().length) return true;
          const r = visTarget.getBoundingClientRect();
          if (!checkedSelf && requireBoxSize && (r.width < 8 || r.height < 8))
            return true;
          if (
            r.width > 30 &&
            r.height > 10 &&
            (r.right <= 2 || r.left >= vw - 2)
          )
            return true;
        }
        checkedSelf = true;
      }
      cur = cur.parentElement || cur.getRootNode?.().host || null;
    }
    return false;
  };

  const SR =
    '[class*="screenReader"], .sr-only, [class*="visually-hidden"], ' +
    '[class*="material-icons"], [class*="material-symbols"], .icon, [aria-hidden="true"]';
  const noIcons = (t) =>
    t
      .replace(
        /\b(?:check_box(?:_outline_blank)?|radio_button_(?:un)?checked|indeterminate_check_box)\b/gi,
        " ",
      )
      .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, " ");
  const cleanChromeText = (t) =>
    norm(
      noIcons(t)
        .replace(
          /(?<![\d.])\b\d+\s*(?:de|of|\/)\s*\d+\s*(?:preguntas|questions)?\b/gi,
          " ",
        )
        .replace(
          /^(?:omitir todo|omitir pregunta|skip all|skip question|enviar|submit)\b|\b(?:omitir todo|omitir pregunta|skip all|skip question|enviar|submit)$/gi,
          " ",
        )
        .replace(
          /^((?:q\s*\d+|incompleto|incomplete|completado|completed?|correcto|incorrecto|pregunta|question)\s*\d*\s*)+/i,
          "",
        ),
    );

  const up = (el) => el.parentElement || el.getRootNode?.().host || null;
  const within = (sel, r) => [
    ...deepAll(sel, r),
    ...(r.shadowRoot ? deepAll(sel, r.shadowRoot) : []),
  ];
  const COOKIE =
    '#onetrust-consent-sdk, [id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i]';
  const isCookie = (el) => {
    if (el.closest(COOKIE)) return true;
    const d = el.closest('[role="dialog"]');
    return !!d && /cookie/i.test(norm(d.innerText).slice(0, 300));
  };
  const chromeZone = (el) =>
    el.closest('nav,aside,header,footer,[role="navigation"],[role="banner"]') ||
    (isCookie(el) ? el : null);

  const CTRL =
    'input[type=radio],input[type=checkbox],[role="radio"],[role="checkbox"]';
  const isCtrlDisabled = (el) =>
    !!el &&
    (el.disabled === true ||
      el.getAttribute?.("aria-disabled") === "true" ||
      !!el.closest?.("[disabled], [aria-disabled='true']"));

  const optBox = (el) => {
    let box = el;
    for (let i = 0; i < 6; i++) {
      const p = up(box);
      if (!p || p === document.body || within(CTRL, p).length > 1) break;
      box = p;
    }
    return box;
  };
  const labelOf = (el) => {
    if (el.matches?.("input") && !el.closest("label")) {
      const root = el.getRootNode();
      const byFor =
        el.id && root.querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) return norm(deepText(byFor, SR)).slice(0, 400);
      const ids = (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .filter(Boolean);
      const byIds = ids
        .map((id) => deepText(root.getElementById?.(id), SR))
        .join(" ");
      if (norm(byIds)) return norm(byIds).slice(0, 400);
      return norm(
        deepText(optBox(el), SR) || el.getAttribute("aria-label") || "",
      ).slice(0, 400);
    }
    const box = el.matches?.("label") ? el : el.closest("label");
    if (box) {
      const inner = box.querySelector(
        '[class*="item-text-inner"], [class*="item-text"]',
      );
      if (inner) return norm(deepText(inner, SR)).slice(0, 400);
      return norm(deepText(box, SR)).slice(0, 400);
    }
    return norm(
      deepText(optBox(el), SR) ||
        deepText(el, SR) ||
        el.getAttribute("aria-label") ||
        "",
    ).slice(0, 400);
  };

  const textOf = (el) => {
    if (!el) return "";
    for (const sel of [
      '[class*="objectMatching__body-inner"]',
      '[class*="mcq__body-inner"]',
      '[class*="component__body-inner"]',
      '[class*="instruction"]',
      '[class*="component__header"]',
      '[class*="questionTitle"]',
      '[class*="question-text"]',
      '[class*="questionText"]',
      '[class*="stem"]',
      '[class*="prompt"]',
      "legend",
    ]) {
      const c = within(sel, el)[0];
      if (c && !isHiddenSlide(c, true)) {
        const t = cleanChromeText(deepText(c, SR));
        if (t.length > 10) return t;
      }
    }
    return "";
  };

  const extractVisuals = (root) => {
    const images = [];
    const svgNotes = [];
    for (const img of within("img", root)) {
      if (isHiddenSlide(img, true)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 45 || r.height < 45) continue;
      try {
        if (img.src?.startsWith("data:")) {
          images.push(img.src);
        } else if (img.complete && img.naturalWidth > 0) {
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 900 / Math.max(img.naturalWidth, 1));
          canvas.width = Math.round(img.naturalWidth * scale);
          canvas.height = Math.round(img.naturalHeight * scale);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          images.push(canvas.toDataURL("image/jpeg", 0.8));
        }
      } catch {}
    }
    for (const svg of within("svg", root)) {
      if (isHiddenSlide(svg, true)) continue;
      const r = svg.getBoundingClientRect();
      if (r.width < 80 || r.height < 60) continue;
      const labels = [...svg.querySelectorAll("text, tspan")]
        .map((t) => norm(t.textContent))
        .filter(Boolean);
      if (labels.length) svgNotes.push(labels.join(" | "));
    }
    return {
      images: images.slice(0, 2),
      svgText: svgNotes.join(" ; ").slice(0, 800),
    };
  };

  const describeSelector = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const tag = el.tagName.toLowerCase();
    const cls = [...(el.classList || [])]
      .filter((c) => !/^(ng-|lit-|is-|active|selected|checked)/.test(c))
      .slice(0, 2)
      .join(".");
    return cls ? `${tag}.${cls}` : tag;
  };

  const questions = [];
  const seen = new Set();
  const seenTexts = [];
  const used = new Set();
  const descartes = [];
  const nota = (motivo, el, extra) =>
    descartes.length < 30 &&
    descartes.push({
      motivo,
      en: String(el?.className || el?.tagName || el?.nodeName || "").slice(
        0,
        80,
      ),
      ...extra,
    });
  const usedBy = (el) => {
    const lab = el.closest?.("label");
    const box = optBox(el);
    return used.has(el) || (!!lab && used.has(lab)) || (!!box && used.has(box));
  };
  let n = 0;

  const add = (
    root,
    type,
    optEls,
    fixedText,
    groupKey = "",
    optionSelUsed = "",
    extraFields = {},
  ) => {
    if (!root) return nota("sin contenedor", null, { type });
    if (isHiddenSlide(root, true))
      return nota("contenedor colapsado o fuera de vista", root, { type });
    const seenKey = groupKey ? `${type}::${groupKey}` : root;
    if (seen.has(seenKey)) return nota("contenedor repetido", root, { type });
    if (isCookie(root)) return nota("cookies", root, { type });
    if ([...optEls].some(usedBy))
      return nota("opciones ya usadas", root, { type, n: optEls.length });

    const visibleOpts = [...new Set(optEls)].filter((el) => {
      const box = optBox(el);
      if (isHiddenSlide(box, true)) return false;
      if (isCtrlDisabled(el)) return false;
      const ctrls = within(CTRL, box);
      if (ctrls.length > 0 && ctrls.every(isCtrlDisabled)) return false;
      return true;
    });
    if (visibleOpts.length < 2 && type !== "select")
      return nota("opciones fuera de vista o deshabilitadas", root, {
        type,
        n: optEls.length,
        vis: visibleOpts.length,
      });

    const vistos = new Set();
    let opts = [];
    if (type === "select" || type === "match") {
      opts = visibleOpts.map((sel, i) => {
        if (sel.tagName === "SELECT") {
          const rowText = norm(noIcons(labelOf(sel))) || `Desplegable ${i + 1}`;
          const choices = [...sel.options]
            .filter(
              (o) =>
                o.value !== "" &&
                !/seleccion|select|elige|choose/i.test(o.text),
            )
            .map((o) => norm(o.text));
          return { el: sel, i, text: `${rowText} [${choices.join(" | ")}]` };
        }
        return { el: sel, i, text: norm(noIcons(labelOf(sel))) };
      });
    } else if (type === "objectMatching") {
      opts = visibleOpts
        .map((el, i) => {
          const txtEl = within('[class*="category-item-text"]', el)[0];
          return {
            el,
            i,
            text: norm(noIcons(deepText(txtEl || el, SR))),
          };
        })
        .filter((o) => o.text);
    } else {
      opts = visibleOpts
        .map((el) => ({ el, text: norm(noIcons(labelOf(el))) }))
        .filter((o) => !o.text || (!vistos.has(o.text) && vistos.add(o.text)))
        .map((o, i) => ({ ...o, i, text: o.text || `Opción ${i + 1}` }));
      if (opts.every((o) => !norm(noIcons(labelOf(o.el)))))
        return nota("opciones sin texto", root, { type });
    }

    if (opts.length < 2 && type !== "select")
      return nota("menos de 2 opciones", root, { type, n: optEls.length });

    let text =
      cleanChromeText(fixedText || "") || textOf(root) || textOf(up(root));
    let node = root;
    if (text.length < 15) {
      text = "";
      for (let k = 0; k < 6 && node; k++) {
        if (
          k > 0 &&
          (within('[class*="mcq__body-inner"]', node).length > 1 ||
            within("button.submit-button", node).length > 0)
        ) {
          const stems = within(
            "p, h1, h2, h3, h4, [class*='stem'], [class*='prompt']",
            node,
          )
            .filter(
              (el) =>
                !isHiddenSlide(el, true) &&
                !el.closest("label, button") &&
                !within(CTRL, el).length,
            )
            .map((el) => cleanChromeText(deepText(el, SR)))
            .filter((t) => t.length > 10 && !opts.some((o) => o.text === t));
          if (stems.length) {
            text = stems.join(" ");
            break;
          }
        }
        let t = norm(
          deepText(
            node,
            'input,select,textarea,button,[role="radio"],[role="checkbox"],[class*="item-label"],' +
              SR,
          ),
        );
        for (const o of opts) t = t.split(o.text).join(" ");
        t = cleanChromeText(t);
        if (t.length > 15) {
          text = t;
          break;
        }
        node = up(node);
      }
    }
    text = cleanChromeText(text).slice(0, 2000);

    if (
      type === "radio" &&
      /elija\s+(?:dos|tres|cuatro|\d+)|choose\s+(?:two|three|four|\d+)|seleccione\s+(?:dos|tres|todas|varias|\d+)|select\s+(?:two|three|all|multiple|\d+)/i.test(
        text,
      )
    ) {
      type = "checkbox";
    }

    const visuals = extractVisuals(root);
    if (visuals.svgText) {
      text = `${text} [Diagrama: ${visuals.svgText}]`.slice(0, 2200);
    }

    const unread = !text;
    const optsSig = opts.map((o) => o.text).join("|");
    if (
      text &&
      seenTexts.some(
        (s) =>
          s.optsSig === optsSig &&
          (s.text.includes(text) || text.includes(s.text)),
      )
    )
      return nota("pregunta duplicada", root, { type });

    seen.add(seenKey);
    if (text) seenTexts.push({ text, optsSig });

    for (const o of opts) {
      used.add(o.el);
      const box = optBox(o.el);
      if (box) {
        used.add(box);
        within(`${CTRL}, label, [class*="mcq__item-label"]`, box).forEach((c) =>
          used.add(c),
        );
      }
      const lab = o.el.closest?.("label");
      if (lab) used.add(lab);
    }

    if (root.nodeType === 1) root.dataset.ccnaId = String(n);
    questions.push({
      id: n++,
      type,
      text: text || `Pregunta ${n}`,
      unread,
      visible: true,
      images: visuals.images,
      patternSig: {
        kind: visuals.images.length ? "image" : type,
        containerSel: describeSelector(root),
        optionSel: optionSelUsed || describeSelector(opts[0]?.el),
      },
      options: opts.map((o) => ({ i: o.i, text: o.text })),
      ...extraFields,
    });
  };

  const boxOf = (el, minCtrls = 2) => {
    let cur = up(el);
    let fallback = null;
    for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
      if (cur.nodeType === 1) {
        const cnt = within(
          `${CTRL}, select, input[type=text], textarea`,
          cur,
        ).filter((c) => !isCtrlDisabled(c)).length;
        if (cnt >= minCtrls && !fallback) fallback = cur;
        const cls = String(cur.className || "");
        const isOptionLevel =
          /\b(?:item|option|choice|answer|label)\b/i.test(cls) ||
          /__(?:item|option|choice)/.test(cls);
        if (
          cnt >= minCtrls &&
          !isOptionLevel &&
          cur.matches?.(
            'fieldset,[data-question-id],.question,[class*="question"],[class*="Question"],[class*="mcq"],[class*="component"]',
          )
        ) {
          return cur;
        }
      }
      cur = up(cur);
    }
    return fallback || up(el);
  };

  // 1. Componentes MCQ estándar de NetAcad
  for (const body of deepAll('[class*="mcq__body-inner"]')) {
    if (chromeZone(body) || isCookie(body) || isHiddenSlide(body, true))
      continue;
    let root = null;
    let cur = up(body);
    for (let i = 0; i < 20 && cur && cur !== document.body; i++) {
      if (within('[class*="mcq__body-inner"]', cur).length > 1) break;
      if (
        cur.nodeType === 1 &&
        within('[class*="mcq__item-label"]', cur).length >= 2
      ) {
        root = cur;
        break;
      }
      cur = up(cur);
    }
    if (!root || isHiddenSlide(root, true)) continue;
    const activeCtrls = within(CTRL, root).filter(
      (c) => !isCtrlDisabled(c) && !isHiddenSlide(optBox(c), true),
    );
    if (activeCtrls.length < 2) continue;
    const labels = within('[class*="mcq__item-label"]', root).filter(
      (l) => !isHiddenSlide(optBox(l), true),
    );
    if (labels.length < 2) continue;
    const boxes = within(
      'input[type=checkbox], [role="checkbox"], [class*="checkbox"]',
      root,
    );
    add(
      root,
      boxes.length ? "checkbox" : "radio",
      labels,
      norm(deepText(body, SR)),
      "",
      '[class*="mcq__item-label"]',
    );
  }

  // 1b. Componentes objectMatching (Categorías A-E ↔ Opciones)
  for (const om of deepAll(
    'objectmatching-view, [class*="objectMatching__widget"]',
  )) {
    if (chromeZone(om) || isCookie(om) || isHiddenSlide(om, true)) continue;
    const omRoot = om.shadowRoot || om;
    let stemEl = null;
    for (const sSel of [
      '[class*="objectMatching__body-inner"]',
      '[class*="component__body-inner"]',
      '[class*="instruction"]',
    ]) {
      stemEl = within(sSel, omRoot).find(
        (el) => norm(deepText(el, SR)).length > 10,
      );
      if (stemEl) break;
    }
    const optItems = within(
      '[class*="objectMatching-option-item"]',
      omRoot,
    ).filter(
      (el) =>
        !el.classList?.contains("objectMatching-option-item-inner") &&
        !isHiddenSlide(el, true) &&
        norm(deepText(el, SR)).length > 0,
    );
    const catItems = within(
      '[class*="objectMatching-category-item"]',
      omRoot,
    ).filter(
      (el) =>
        !el.classList?.contains("objectMatching-category-item-inner") &&
        !isHiddenSlide(el, true) &&
        norm(deepText(el, SR)).length > 0,
    );
    const categories = catItems.map((el, i) => {
      const numEl = within('[class*="category-item-number"]', el)[0];
      const txtEl = within('[class*="category-item-text"]', el)[0];
      return {
        i,
        letter: norm(deepText(numEl, SR)) || String.fromCharCode(65 + i),
        text: norm(noIcons(deepText(txtEl || el, SR))),
      };
    });
    if (optItems.length >= 2) {
      add(
        om,
        "objectMatching",
        optItems,
        stemEl ? norm(deepText(stemEl, SR)) : "",
        "",
        '[class*="objectMatching-option-item"]',
        { categories },
      );
    }
  }

  // 2. Inputs radio nativos
  const byName = new Map();
  deepAll("input[type=radio]").forEach((el) => {
    if (isCtrlDisabled(el) || chromeZone(el)) return;
    if (isHiddenSlide(optBox(el), true)) return;
    const k = el.name || boxOf(el, 2);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(el);
  });
  for (const [k, els] of byName.entries()) {
    if (els.length > 1)
      add(
        boxOf(els[0], 2),
        "radio",
        els,
        "",
        typeof k === "string" ? k : "",
        "input[type=radio]",
      );
  }

  // 3. Inputs checkbox nativos
  deepAll("input[type=checkbox]").forEach((el) => {
    if (isCtrlDisabled(el) || chromeZone(el) || isCookie(el)) return;
    if (el.id === "confirm-exam" || el.name === "confirm") return;
    if (isHiddenSlide(optBox(el), true)) return;
    const root = boxOf(el, 2);
    if (root && !isHiddenSlide(root, true)) {
      const cbs = within("input[type=checkbox]", root).filter(
        (c) =>
          !isCtrlDisabled(c) &&
          c.id !== "confirm-exam" &&
          !isHiddenSlide(optBox(c), true),
      );
      if (cbs.length >= 2)
        add(root, "checkbox", cbs, "", "", "input[type=checkbox]");
    }
  });

  // 4. Roles ARIA
  for (const grp of deepAll(
    '[role="radiogroup"], [role="group"], [role="listbox"]',
  )) {
    if (chromeZone(grp) || isCookie(grp) || isHiddenSlide(grp, true)) continue;
    const rEls = within('[role="radio"]', grp).filter(
      (c) => !isCtrlDisabled(c) && !isHiddenSlide(optBox(c), true),
    );
    if (rEls.length >= 2) add(grp, "radio", rEls, "", "", '[role="radio"]');
    const cEls = within('[role="checkbox"], [role="option"]', grp).filter(
      (c) => !isCtrlDisabled(c) && !isHiddenSlide(optBox(c), true),
    );
    if (cEls.length >= 2)
      add(grp, "checkbox", cEls, "", "", '[role="checkbox"], [role="option"]');
  }

  // 5. Desplegables (<select>)
  const sels = deepAll("select").filter(
    (el) => !isCtrlDisabled(el) && !chromeZone(el) && !isHiddenSlide(el, true),
  );
  if (sels.length > 1) add(boxOf(sels[0], 2), "match", sels, "", "", "select");
  else if (sels.length === 1)
    add(boxOf(sels[0], 1), "select", [sels[0]], "", "", "select");

  // 6. Patrones aprendidos + tarjetas personalizadas
  if (questions.length === 0) {
    for (const pat of learnedPatterns || []) {
      if (!pat.optionSel) continue;
      try {
        const roots = pat.containerSel
          ? deepAll(pat.containerSel).filter(
              (r) => !chromeZone(r) && !isCookie(r) && !isHiddenSlide(r, true),
            )
          : [document.body];
        for (const r of roots) {
          const hits = within(pat.optionSel, r).filter(
            (el) => !chromeZone(el) && !isHiddenSlide(optBox(el), true),
          );
          if (hits.length >= 2) {
            const hasCb = within(
              'input[type=checkbox],[role="checkbox"],[class*="checkbox"]',
              r,
            ).length;
            const qType = hasCb
              ? "checkbox"
              : pat.kind === "image"
                ? "radio"
                : pat.kind;
            add(r, qType, hits, "", "", pat.optionSel);
          }
        }
      } catch {}
    }
  }

  if (questions.length === 0) {
    const cardSelectors = [
      '[class*="option-card"]',
      '[class*="choice-item"]',
      '[class*="answer-option"]',
      '[class*="mcq-option"]',
      '[class*="assessment-option"]',
      'label[class*="option"]',
      'div[class*="option"][tabindex]',
      'button[class*="option"]',
    ];
    for (const cSel of cardSelectors) {
      const cards = deepAll(cSel).filter(
        (el) =>
          !chromeZone(el) &&
          !isCookie(el) &&
          !isHiddenSlide(el, true) &&
          norm(deepText(el, SR)).length > 1,
      );
      if (cards.length >= 2) {
        const root = boxOf(cards[0], 1) || up(cards[0]);
        const isMulti =
          within(
            'input[type=checkbox], [role="checkbox"], [class*="checkbox"]',
            root || document.body,
          ).length > 0;
        add(root, isMulti ? "checkbox" : "radio", cards, "", "", cSel);
        if (questions.length > 0) break;
      }
    }
  }

  deepAll("input[type=text],textarea").forEach((el) => {
    if (isCtrlDisabled(el) || chromeZone(el) || isHiddenSlide(el, true)) return;
    add(boxOf(el, 1), "text", [el, el], "", "", "input[type=text],textarea");
  });

  for (const box of deepAll(
    '[class*="order"],[class*="Order"],[class*="sequence"],[class*="Sequence"],[class*="rank"],[class*="sort"]',
  )) {
    if (chromeZone(box) || isCookie(box) || isHiddenSlide(box, true)) continue;
    const items = deepAll('[draggable="true"]', box);
    if (items.length >= 3 && !deepAll("input[type=radio]", box).length)
      add(box, "order", items, "", "", '[draggable="true"]');
  }

  const btnText = (el) => {
    const inner = el.shadowRoot?.querySelector("button") || el;
    return norm(
      [
        deepText(el, SR),
        el.textContent,
        el.value,
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("title"),
        el.getAttribute?.("label"),
        inner.getAttribute?.("aria-label"),
        inner.getAttribute?.("title"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  };

  const allButtons = deepAll(
    'button, a, [role="button"], input[type=submit], [class*="submit"]',
  ).filter((e) => !isCookie(e) && !isHiddenSlide(e, true));

  const enabledButtons = allButtons.filter((e) => {
    const inner = e.shadowRoot?.querySelector("button") || e;
    return (
      !e.disabled &&
      !inner.disabled &&
      e.getAttribute("aria-disabled") !== "true" &&
      inner.getAttribute("aria-disabled") !== "true" &&
      !e.classList?.contains("disabled") &&
      !e.classList?.contains("is-disabled") &&
      !inner.classList?.contains("disabled") &&
      !inner.classList?.contains("is-disabled")
    );
  });

  const start = enabledButtons.find((el) =>
    /comenzar|iniciar|\bstart\b/i.test(btnText(el)),
  );

  const submitBtn = allButtons.find((el) => {
    const t = btnText(el);
    if (/omitir|skip|reiniciar|restart|cancelar|cancel/i.test(t)) return false;
    if (
      el.matches?.(
        "button.submit-button, button.mcq__submit, button.adaptive-assessment-submit, .adaptive-assessment-submit",
      ) ||
      el.classList?.contains("submit-button") ||
      el.classList?.contains("mcq__submit") ||
      el.classList?.contains("adaptive-assessment-submit")
    )
      return true;
    return /\b(enviar|submit|comprobar|check|verificar)(?:\s+(?:respuesta|respuestas|evaluaci[oó]n|assessment))?\b/i.test(
      t,
    );
  });

  const submitEnabled = !!submitBtn && enabledButtons.includes(submitBtn);

  const confirm = deepAll("input[type=checkbox]").find((el) => {
    if (
      el.id !== "confirm-exam" &&
      el.name !== "confirm" &&
      !/confirm/i.test(el.getAttribute("aria-labelledby") || "")
    )
      return false;
    const host = el.closest("label, div, section") || el;
    return !isHiddenSlide(host, true);
  });

  const bodyTxt = norm(deepText(document.body));

  const unansweredChips = [];
  const seenChips = new Set();
  let maxChipNum = 0;
  let activeChipNum = 0;
  for (const el of deepAll("button,a,[role='button'],li,span,div")) {
    if (isHiddenSlide(el, true)) continue;
    if (el.closest("h1,h2,h3,h4,h5,h6,[class*='questionTitle']")) continue;
    const t = norm(deepText(el));
    const m = t.match(/^q\s*(\d+)$/i);
    if (!m) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || r.width > 200 || r.height > 120)
      continue;
    const num = +m[1];
    if (num > maxChipNum) maxChipNum = num;
    const holder = el.closest("button,a,[role='button'],[role='tab'],li") || el;
    const meta =
      String(holder.className || "") +
      " " +
      (holder.getAttribute?.("aria-label") || "") +
      " " +
      (holder.getAttribute?.("aria-current") || "") +
      " " +
      (holder.getAttribute?.("aria-selected") || "");
    if (/\b(active|current|selected|true)\b/i.test(meta)) activeChipNum = num;
    if (/complet|answered|respondid|correct/i.test(meta)) continue;
    const label = `Q${num}`;
    if (!seenChips.has(label)) {
      seenChips.add(label);
      unansweredChips.push({ label, num });
    }
  }
  unansweredChips.sort((a, b) => a.num - b.num);

  let progress = null;
  const mProg =
    bodyTxt.match(/(\d+)\s*(?:de|of|\/)\s*(\d+)\s*(?:preguntas|questions)/i) ||
    bodyTxt.match(/(?:pregunta|question)\s*(\d+)\s*(?:de|of|\/)\s*(\d+)/i) ||
    bodyTxt.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (mProg && +mProg[2] >= 1 && +mProg[1] >= 1 && +mProg[1] <= +mProg[2]) {
    progress = { cur: +mProg[1], total: +mProg[2] };
  } else if (maxChipNum >= 2) {
    progress = { cur: activeChipNum || 1, total: maxChipNum };
  }

  const onConfirmScreen = !!confirm;

  const isResultScreen =
    /reiniciar|restart|puntuaci[oó]n|your score|\d+\s*(?:de|of)\s*\d+\s*(?:correctas?|correct)/i.test(
      bodyTxt,
    ) &&
    !onConfirmScreen &&
    !submitBtn;

  return {
    url: location.href,
    questions,
    progress,
    onConfirmScreen,
    isResultScreen,
    unansweredChips,
    hasQuiz:
      questions.length > 0 ||
      onConfirmScreen ||
      !!submitBtn ||
      !!deepAll(
        '[class*="mcq__body-inner"], objectmatching-view, [class*="objectMatching__widget"]',
      ).length,
    hasStart: !!start,
    hasSubmit: !!submitBtn,
    submitEnabled,
    hasConfirm: !!confirm,
    signature: questions
      .map((q) => q.text)
      .join("|")
      .slice(0, 500),
    descartes,
  };
}

/* Marca opciones (radio, checkbox, select u objectMatching) y pulsa el botón Enviar de la pregunta. */
async function ccnaAnswerAndSubmit(
  qId,
  opts,
  allowLocalSubmit = true,
  optionSel = "",
  untilEnabled = false,
) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const within = (sel, r) => [
    ...deepAll(sel, r),
    ...(r.shadowRoot ? deepAll(sel, r.shadowRoot) : []),
  ];
  const up = (el) => el.parentElement || el.getRootNode?.().host || null;
  const isHiddenSlide = (el, requireBoxSize = false) => {
    let cur = el;
    const vw =
      window.innerWidth || document.documentElement.clientWidth || 1280;
    let checkedSelf = false;
    while (cur && cur !== document.body) {
      if (cur.nodeType === 1) {
        if (
          cur.hasAttribute?.("hidden") ||
          cur.getAttribute?.("aria-hidden") === "true" ||
          cur.hasAttribute?.("inert")
        )
          return true;
        const st = getComputedStyle(cur);
        if (st.display === "none" || st.visibility === "hidden") return true;
        if (!checkedSelf && requireBoxSize && st.opacity === "0") return true;
        if (st.display !== "contents") {
          const visTarget =
            cur.shadowRoot?.querySelector("button,input,div") || cur;
          if (!visTarget.getClientRects().length) return true;
          const r = visTarget.getBoundingClientRect();
          if (!checkedSelf && requireBoxSize && (r.width < 8 || r.height < 8))
            return true;
          if (
            r.width > 30 &&
            r.height > 10 &&
            (r.right <= 2 || r.left >= vw - 2)
          )
            return true;
        }
        checkedSelf = true;
      }
      cur = cur.parentElement || cur.getRootNode?.().host || null;
    }
    return false;
  };
  const SR =
    '[class*="screenReader"], .sr-only, [class*="material-icons"], [class*="material-symbols"], .icon, [class*="visually-hidden"], [aria-hidden="true"]';
  const noIcons = (t) =>
    t
      .replace(
        /\b(?:check_box(?:_outline_blank)?|radio_button_(?:un)?checked|indeterminate_check_box)\b/gi,
        " ",
      )
      .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, " ");
  const deepText = (el, skip) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    if (skip && el.matches(skip)) return "";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : el.tagName === "SLOT"
        ? el.assignedNodes()
        : [...el.childNodes];
    return kids.map((k) => deepText(k, skip)).join(" ");
  };

  const singleClick = (el) => {
    if (!el) return;
    const target = el.shadowRoot?.querySelector("button") || el;
    target.scrollIntoView?.({ behavior: "instant", block: "nearest" });
    target.focus?.();
    target.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, composed: true }),
    );
    target.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, composed: true }),
    );
    target.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, composed: true }),
    );
    target.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, composed: true }),
    );
    target.click();
  };

  const isEnabledBtn = (b) => {
    if (!b || isHiddenSlide(b, true)) return false;
    const inner = b.shadowRoot?.querySelector("button") || b;
    if (
      b.disabled ||
      inner.disabled ||
      b.getAttribute("aria-disabled") === "true" ||
      inner.getAttribute("aria-disabled") === "true" ||
      b.classList?.contains("disabled") ||
      b.classList?.contains("is-disabled") ||
      inner.classList?.contains("disabled") ||
      inner.classList?.contains("is-disabled")
    )
      return false;
    return true;
  };

  const hasConfirmVisible = () =>
    deepAll('input#confirm-exam, input[name="confirm"]').some((el) => {
      const host = el.closest("label, div, section") || el;
      return !isHiddenSlide(host, true);
    });

  const btnLabelText = (b) => {
    const inner = b.shadowRoot?.querySelector("button") || b;
    return norm(
      [
        deepText(b, SR),
        b.textContent,
        b.value,
        b.getAttribute?.("aria-label"),
        b.getAttribute?.("title"),
        b.getAttribute?.("label"),
        inner.getAttribute?.("aria-label"),
        inner.getAttribute?.("title"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  };

  const isQuestionSubmitMatch = (b, anyState = false) => {
    if (anyState ? isHiddenSlide(b, true) : !isEnabledBtn(b)) return false;
    if (
      b.closest(
        'header, nav, [role="banner"], [class*="topbar"], [class*="top-bar"]',
      )
    )
      return false;
    const txt = btnLabelText(b);
    if (/omitir|skip|reiniciar|restart|cancelar|cancel/i.test(txt))
      return false;
    if (
      b.matches?.(
        "button.submit-button, button.mcq__submit, button.adaptive-assessment-submit, .adaptive-assessment-submit",
      ) ||
      b.classList?.contains("submit-button") ||
      b.classList?.contains("mcq__submit") ||
      b.classList?.contains("adaptive-assessment-submit")
    )
      return true;
    return /\b(enviar|submit|comprobar|check|verificar)(?:\s+(?:respuesta|respuestas))?\b/i.test(
      txt,
    );
  };

  const findQuestionSubmit = (scope, anyState = false) => {
    if (hasConfirmVisible()) return null;
    const match = (b) => isQuestionSubmitMatch(b, anyState);
    const sel =
      'button.submit-button, button.mcq__submit, button.adaptive-assessment-submit, .adaptive-assessment-submit, button, [role="button"], input[type=submit], [class*="submit"]';
    let cur = scope;
    for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
      if (within("[data-ccna-id]", cur).length > 1) break;
      const hit = within(sel, cur).find(match);
      if (hit) return hit;
      cur = up(cur);
    }
    const allEnabled = deepAll(sel).filter(match);
    if (allEnabled.length === 1) return allEnabled[0];
    return null;
  };

  const root = deepAll(`[data-ccna-id="${qId}"]`)[0];
  if (!root)
    return { ok: false, motivo: `no encuentro contenedor data-ccna-id=${qId}` };

  root.scrollIntoView?.({ behavior: "instant", block: "nearest" });

  // Caso objectMatching: clic en categoría y luego en opción
  if (
    Array.isArray(opts) &&
    opts.length > 0 &&
    typeof opts[0] === "object" &&
    opts[0] !== null &&
    "category" in opts[0]
  ) {
    const catEls = within(
      'button.objectMatching-category-item, [class*="objectMatching-category-item"]',
      root,
    ).filter(
      (el) =>
        !el.classList?.contains("objectMatching-category-item-inner") &&
        !isHiddenSlide(el, true),
    );
    const optEls = within(
      'button.objectMatching-option-item, [class*="objectMatching-option-item"]',
      root,
    ).filter(
      (el) =>
        !el.classList?.contains("objectMatching-option-item-inner") &&
        !isHiddenSlide(el, true),
    );
    const textOfItem = (el) => {
      const txtEl = within('[class*="category-item-text"]', el)[0] || el;
      return norm(noIcons(deepText(txtEl, SR))).toLowerCase();
    };
    const findItemByText = (els, expected) => {
      const exp = norm(noIcons(expected)).toLowerCase();
      if (!exp) return null;
      const exact = els.find((el) => textOfItem(el) === exp);
      if (exact) return exact;
      const sub = els.find((el) => {
        const got = textOfItem(el);
        return exp.length >= 4 && (got.includes(exp) || exp.includes(got));
      });
      if (sub) return sub;
      const tokens = exp.split(/\W+/).filter((w) => w.length > 3);
      if (!tokens.length) return null;
      let bestEl = null;
      let bestScore = 0;
      for (const el of els) {
        const got = textOfItem(el);
        const hits = tokens.filter((w) => got.includes(w)).length;
        const score = hits / tokens.length;
        if (score >= 0.7 && score > bestScore) {
          bestScore = score;
          bestEl = el;
        }
      }
      return bestEl;
    };

    const getMatchState = (optEl, optIn) => {
      const badgeEl = within('[class*="item-number"]', optEl)[0];
      const badgeTxt = norm(
        badgeEl?.textContent || deepText(badgeEl, "") || "",
      );
      const fullTxt = norm(optEl.innerText || deepText(optEl, ""));
      const cls = `${optEl.className || ""} ${optIn?.className || ""}`;
      return { badgeTxt, fullTxt, cls };
    };
    const isPairedNow = (optEl, optIn, before) => {
      const now = getMatchState(optEl, optIn);
      if (now.badgeTxt && now.badgeTxt !== before.badgeTxt) return true;
      if (now.fullTxt && now.fullTxt !== before.fullTxt) return true;
      if (
        /\b(is-matched|matched|is-assigned|assigned|is-selected|selected)\b/i.test(
          now.cls,
        ) &&
        now.cls !== before.cls
      )
        return true;
      return false;
    };

    let emparejadas = 0;
    for (const pair of opts) {
      const catTarget = findItemByText(catEls, pair.category);
      const optTarget = findItemByText(optEls, pair.option);
      if (!catTarget || !optTarget) continue;

      const catInner =
        within('button, [class*="category-item-inner"]', catTarget)[0] ||
        catTarget;
      const optInner =
        within('button, [class*="option-item-inner"]', optTarget)[0] ||
        optTarget;

      const before = getMatchState(optTarget, optInner);

      // Intento 1: botón interno categoría -> botón interno opción
      singleClick(catInner);
      await sleep(100);
      singleClick(optInner);
      await sleep(140);

      if (!isPairedNow(optTarget, optInner, before)) {
        // Intento 2: contenedor categoría -> contenedor opción
        singleClick(catTarget);
        await sleep(100);
        singleClick(optTarget);
        await sleep(140);
      }

      if (!isPairedNow(optTarget, optInner, before)) {
        // Intento 3: orden inverso (opción -> categoría)
        singleClick(optInner);
        await sleep(100);
        singleClick(catInner);
        await sleep(140);
      }

      if (isPairedNow(optTarget, optInner, before)) emparejadas++;
    }

    if (emparejadas > 0) {
      let subBtn = null;
      for (let i = 0; i < 30 && !subBtn; i++) {
        subBtn = findQuestionSubmit(root);
        if (!subBtn) await sleep(35);
      }
      if (subBtn && allowLocalSubmit) {
        singleClick(subBtn);
        await sleep(110);
        return {
          ok: true,
          marcadas: emparejadas,
          submitted: true,
          advanced: true,
          motivo: "",
        };
      }
      return {
        ok: true,
        marcadas: emparejadas,
        submitted: false,
        advanced: false,
        motivo: subBtn ? "" : "no se habilitó el botón Enviar",
      };
    }
    return {
      ok: false,
      motivo: "no se pudieron emparejar las opciones en objectMatching",
    };
  }

  // Caso desplegables (<select>)
  const sels = within("select", root).filter(
    (s) => !s.disabled && !isHiddenSlide(s, true),
  );
  if (sels.length > 0 && Array.isArray(opts) && typeof opts[0] === "string") {
    let okSel = 0;
    for (let i = 0; i < sels.length && i < opts.length; i++) {
      const targetTxt = norm(opts[i]).toLowerCase();
      const idx = [...sels[i].options].findIndex(
        (o) => norm(o.text).toLowerCase() === targetTxt,
      );
      if (idx >= 0) {
        sels[i].selectedIndex = idx;
        sels[i].dispatchEvent(
          new Event("input", { bubbles: true, composed: true }),
        );
        sels[i].dispatchEvent(
          new Event("change", { bubbles: true, composed: true }),
        );
        okSel++;
      }
    }
    if (okSel > 0) {
      if (allowLocalSubmit) {
        let subBtn = null;
        for (let i = 0; i < 30 && !subBtn; i++) {
          subBtn = findQuestionSubmit(root);
          if (!subBtn) await sleep(30);
        }
        if (subBtn) {
          singleClick(subBtn);
          await sleep(100);
          return {
            ok: true,
            marcadas: okSel,
            submitted: true,
            advanced: true,
            motivo: "",
          };
        }
      }
      return {
        ok: true,
        marcadas: okSel,
        submitted: false,
        advanced: false,
        motivo: "",
      };
    }
  }

  const CTRL =
    'input[type=radio],input[type=checkbox],[role="radio"],[role="checkbox"],[role="option"]';
  const isCtrlDisabled = (el) =>
    !!el &&
    (el.disabled === true ||
      el.getAttribute?.("aria-disabled") === "true" ||
      !!el.closest?.("[disabled], [aria-disabled='true']"));

  const optBox = (el) => {
    let box = el;
    for (let i = 0; i < 6; i++) {
      const p = up(box);
      if (!p || p === document.body || within(CTRL, p).length > 1) break;
      box = p;
    }
    return box;
  };
  const textOf = (el) =>
    norm(
      deepText(
        el.querySelector?.('[class*="item-text-inner"]') || optBox(el),
        SR,
      ),
    );

  let rawOpts = [];
  if (optionSel) {
    try {
      rawOpts = within(optionSel, root).filter(
        (el) => !isHiddenSlide(optBox(el), true),
      );
    } catch {}
  }
  if (rawOpts.length < 2) {
    rawOpts = within('[class*="mcq__item-label"]', root).filter((el) => {
      if (isHiddenSlide(optBox(el), true)) return false;
      const ctrls = within(CTRL, optBox(el));
      return ctrls.length === 0 || !ctrls.every(isCtrlDisabled);
    });
  }
  if (rawOpts.length < 2) {
    rawOpts = within(CTRL, root).filter(
      (el) => !isCtrlDisabled(el) && !isHiddenSlide(optBox(el), true),
    );
  }

  const vistos = new Set();
  const items = rawOpts.filter((el) => {
    const t = textOf(el);
    if (t && vistos.has(t)) return false;
    if (t) vistos.add(t);
    return true;
  });

  if (items.length < 2)
    return {
      ok: false,
      motivo: `menos de 2 opciones en el contenedor (${items.length})`,
    };

  const POSITIVE_CLS = new Set([
    "is-selected",
    "is-checked",
    "selected",
    "checked",
    "option--selected",
    "item--selected",
  ]);

  const submitLook = (b) =>
    [
      b,
      b.shadowRoot?.querySelector("button"),
      ...within("button", b).slice(0, 2),
    ]
      .filter(Boolean)
      .map((e) => {
        const st = getComputedStyle(e);
        return [
          e.className,
          e.getAttribute("disabled"),
          e.getAttribute("aria-disabled"),
          e.disabled,
          st.opacity,
          st.cursor,
          st.pointerEvents,
          st.backgroundColor,
          st.color,
        ].join("~");
      })
      .join("|");
  const submitAntes = untilEnabled ? findQuestionSubmit(root, true) : null;
  const lookAntes = submitAntes ? submitLook(submitAntes) : "";

  let marcadas = 0;
  let selectedHint = "";
  const fallos = [];

  for (const k of opts) {
    const target = items[k];
    if (!target) {
      fallos.push(`sin opción ${k + 1}`);
      continue;
    }
    const box = optBox(target);
    const rootNode = target.getRootNode?.();
    const targetFor =
      target.getAttribute?.("for") ||
      target.closest?.("label")?.getAttribute?.("for");

    const input =
      (target.matches?.("input") && target) ||
      (targetFor && rootNode?.getElementById?.(targetFor)) ||
      within("input[type=radio],input[type=checkbox]", box)[0] ||
      null;

    const lab =
      (target.matches?.("label") && target) ||
      target.closest?.("label") ||
      (input?.id &&
        rootNode?.querySelector?.(`label[for="${CSS.escape(input.id)}"]`)) ||
      within("label", box)[0] ||
      null;

    const roleCtrl =
      (target.matches?.('[role="checkbox"],[role="radio"],[role="option"]') &&
        target) ||
      within('[role="checkbox"],[role="radio"],[role="option"]', box)[0] ||
      null;

    const isOn = () => {
      if (input?.checked === true || target?.checked === true) {
        selectedHint = "input:checked";
        return true;
      }
      for (const node of [target, lab, roleCtrl, box, ...within("*", box)]) {
        if (!node || node.nodeType !== 1) continue;
        if (node.checked === true) {
          selectedHint = "el:checked";
          return true;
        }
        if (
          node.getAttribute?.("aria-checked") === "true" ||
          node.getAttribute?.("aria-selected") === "true" ||
          node.getAttribute?.("aria-pressed") === "true"
        ) {
          selectedHint = "aria-checked";
          return true;
        }
        if (node.classList) {
          for (const c of node.classList) {
            if (POSITIVE_CLS.has(c.toLowerCase())) {
              selectedHint = c;
              return true;
            }
          }
        }
        const iconTxt = norm(node.textContent || "");
        if (iconTxt === "check_box" || iconTxt === "radio_button_checked") {
          selectedHint = iconTxt;
          return true;
        }
      }
      return false;
    };

    if (!isOn()) {
      const primary =
        (lab && !isHiddenSlide(lab, false) && lab) || roleCtrl || input || box;
      singleClick(primary);
      for (let i = 0; i < 10 && !isOn(); i++) await sleep(35);

      if (!isOn() && input && input !== primary) {
        singleClick(input);
        for (let i = 0; i < 6 && !isOn(); i++) await sleep(35);
      }

      if (!isOn() && input) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "checked",
        )?.set;
        if (setter) setter.call(input, true);
        else input.checked = true;
        input.setAttribute("aria-checked", "true");
        input.dispatchEvent(
          new Event("input", { bubbles: true, composed: true }),
        );
        input.dispatchEvent(
          new Event("change", { bubbles: true, composed: true }),
        );
        await sleep(50);
      }
    }

    if (isOn()) marcadas++;
    else fallos.push(`opción ${k + 1} no quedó marcada`);

    if (untilEnabled && marcadas > 0) {
      let listo = false;
      for (let i = 0; i < 8 && !listo; i++) {
        listo = submitAntes
          ? submitLook(submitAntes) !== lookAntes
          : !!findQuestionSubmit(root);
        if (!listo) await sleep(40);
      }
      if (listo) break;
    }

    if (opts.length > 1) await sleep(60);
  }

  let submitted = false;
  let advanced = false;

  if (marcadas > 0 && allowLocalSubmit) {
    let subBtn = null;
    for (let intento = 0; intento < 35 && !subBtn; intento++) {
      subBtn = findQuestionSubmit(root);
      if (!subBtn) await sleep(30);
    }

    if (subBtn) {
      singleClick(subBtn);
      submitted = true;
      advanced = true;
      await sleep(110);
    } else {
      fallos.push("no se habilitó el botón Enviar");
    }
  }

  return {
    ok: marcadas > 0,
    marcadas,
    submitted,
    advanced,
    selectedHint,
    motivo: fallos.join("; "),
  };
}

/* Marca #confirm-exam (Lit / Shadow DOM) y pulsa el botón Enviar final cuando se habilita. */
async function ccnaConfirmAndSubmit() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const deepText = (el) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : el.tagName === "SLOT"
        ? el.assignedNodes()
        : [...el.childNodes];
    return kids.map(deepText).join(" ");
  };

  const fullClick = (el) => {
    if (!el) return;
    el.scrollIntoView?.({ behavior: "instant", block: "center" });
    el.focus?.();
    el.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, composed: true }),
    );
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, composed: true }),
    );
    el.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, composed: true }),
    );
    el.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, composed: true }),
    );
    el.click();
  };

  const c = deepAll(
    'input#confirm-exam, input[name="confirm"][type="checkbox"], input[type="checkbox"]',
  ).find(
    (el) =>
      el.id === "confirm-exam" ||
      el.name === "confirm" ||
      /confirm/i.test(el.getAttribute("aria-labelledby") || ""),
  );

  const isEnabledBtn = (b) => {
    if (!b) return false;
    const inner = b.shadowRoot?.querySelector("button") || b;
    if (
      b.disabled ||
      inner.disabled ||
      b.getAttribute("aria-disabled") === "true" ||
      inner.getAttribute("aria-disabled") === "true" ||
      b.classList?.contains("disabled") ||
      b.classList?.contains("is-disabled") ||
      inner.classList?.contains("disabled") ||
      inner.classList?.contains("is-disabled")
    )
      return false;
    return b.getClientRects().length > 0 || inner.getClientRects().length > 0;
  };

  const findFinalSubmit = () => {
    const adaptive = deepAll(
      "button.adaptive-assessment-submit, .adaptive-assessment-submit",
    ).find(isEnabledBtn);
    if (adaptive)
      return adaptive.shadowRoot?.querySelector("button") || adaptive;

    const candidates = deepAll(
      'button, [role="button"], input[type=submit]',
    ).filter((b) => {
      if (!isEnabledBtn(b)) return false;
      if (b.classList?.contains("submit-button")) return false;
      const inner = b.shadowRoot?.querySelector("button") || b;
      const txt = norm(
        [
          deepText(b),
          b.value,
          b.getAttribute?.("aria-label"),
          inner.getAttribute?.("aria-label"),
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (/omitir|skip|reiniciar|restart|cancelar|cancel/i.test(txt))
        return false;
      return /\b(enviar|submit|finalizar|finish)(?:\s+(?:evaluaci[oó]n|assessment|respuestas?))?\b/i.test(
        txt,
      );
    });
    if (candidates.length) {
      const target = candidates[candidates.length - 1];
      return target.shadowRoot?.querySelector("button") || target;
    }
    return null;
  };

  if (!c) {
    const directBtn = findFinalSubmit();
    if (directBtn) {
      fullClick(directBtn);
      await sleep(100);
      return { ok: true, motivo: "" };
    }
    return { ok: false, motivo: "no se encontró la casilla confirm-exam" };
  }

  const root = c.getRootNode();
  const host = root?.host || null;
  const lblId = (c.getAttribute("aria-labelledby") || "").split(/\s+/)[0];
  const lbl =
    (lblId && root.getElementById?.(lblId)) ||
    (c.id && root.querySelector?.(`label[for="${CSS.escape(c.id)}"]`)) ||
    c.closest("label");

  if (!c.checked && lbl) {
    fullClick(lbl);
    await sleep(50);
  }
  if (!c.checked && host) {
    fullClick(host);
    await sleep(50);
  }
  if (!c.checked) {
    fullClick(c);
    await sleep(50);
  }

  if (!c.checked || !findFinalSubmit()) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "checked",
    )?.set;
    if (setter) setter.call(c, true);
    else c.checked = true;
    c.setAttribute("aria-checked", "true");
    c.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    c.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    if (host) {
      host.dispatchEvent(
        new Event("change", { bubbles: true, composed: true }),
      );
    }
    await sleep(60);
  }

  if (!c.checked) {
    return { ok: false, motivo: "la casilla confirm-exam no quedó marcada" };
  }

  let btn = null;
  for (let i = 0; i < 45 && !btn; i++) {
    btn = findFinalSubmit();
    if (!btn) await sleep(45);
  }
  if (!btn) {
    return {
      ok: false,
      motivo:
        "el botón Enviar final siguió deshabilitado tras marcar la casilla",
    };
  }

  fullClick(btn);
  await sleep(100);
  return { ok: true, motivo: "" };
}

function ccnaClickChip(chipLabel) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const deepText = (el) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : el.tagName === "SLOT"
        ? el.assignedNodes()
        : [...el.childNodes];
    return kids.map(deepText).join(" ");
  };

  const targetNum = String(chipLabel).replace(/\D+/g, "");
  const re = new RegExp(`^q\\s*${targetNum}$`, "i");

  const hits = deepAll("button,a,[role='button'],li,span,div").filter((el) => {
    if (!el.getClientRects().length) return false;
    if (el.closest("h1,h2,h3,h4,h5,h6,[class*='questionTitle']")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || r.width > 200 || r.height > 120)
      return false;
    return re.test(norm(deepText(el)));
  });

  const inner = hits.find((h) => !hits.some((o) => o !== h && h.contains(o)));
  if (!inner) return false;
  const clickable =
    inner.closest("button,a,[role='button'],[role='tab']") || inner;
  clickable.scrollIntoView?.({ behavior: "instant", block: "center" });
  clickable.click();
  return true;
}

function ccnaResult() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepText = (el) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : [...el.childNodes];
    return kids.map(deepText).join(" ");
  };
  const t = norm(deepText(document.body));
  const m =
    t.match(/(\d+)\s*(?:de|of)\s*(\d+)\s*(?:correctas?|correct)/i) ||
    t.match(/\b\d{1,3}\s*%/);
  return { puntaje: m ? m[0] : "" };
}

function ccnaNav(kind, arg) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const shadowText = (el) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : el.tagName === "SLOT"
        ? el.assignedNodes()
        : [...el.childNodes];
    return kids.map(shadowText).join(" ");
  };
  const ok = (el) =>
    el &&
    !el.disabled &&
    el.getAttribute("aria-disabled") !== "true" &&
    !el.classList?.contains("disabled") &&
    !el.classList?.contains("is-disabled");
  const topBar = (el) =>
    el.closest(
      'header, [role="banner"], [class*="topbar"], [class*="top-bar"], [class*="appbar"], [class*="app-header"], [class*="global-nav"]',
    );
  const outlineRoot = () =>
    deepAll(
      '[role="tree"], [class*="outline"], [class*="syllabus"], [class*="module-list"], [class*="toc"]',
    )[0] || null;
  const numbered = (el) => /\d+\.\d+/.test(norm(shadowText(el)));
  const findSubmit = () =>
    deepAll('button,a,[role="button"],input[type=submit]')
      .filter(ok)
      .find((el) => {
        const inner = el.shadowRoot?.querySelector("button") || el;
        const txt = norm(
          [
            shadowText(el),
            el.value,
            el.getAttribute?.("aria-label"),
            inner.getAttribute?.("aria-label"),
          ]
            .filter(Boolean)
            .join(" "),
        );
        if (/omitir|skip|reiniciar|restart/i.test(txt)) return false;
        return (
          el.matches?.(
            ".adaptive-assessment-submit, button.submit-button, button[aria-label='submit']",
          ) ||
          /adaptive-assessment-submit|submit-button/.test(el.className || "") ||
          /\b(enviar|submit)(?:\s+(?:evaluaci[oó]n|assessment|respuestas?))?\b/i.test(
            txt,
          )
        );
      });

  if (kind === "start") {
    const b = deepAll('button,a,[role="button"]')
      .filter(ok)
      .find((el) =>
        /comenzar|iniciar|\bstart\b/i.test(
          norm(shadowText(el)) + " " + (el.value || ""),
        ),
      );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }
  if (kind === "content") {
    const b = deepAll('button,a,[role="button"],[role="tab"]')
      .filter(ok)
      .find((el) =>
        /^(content|contenido|curso|course)$/i.test(
          norm(shadowText(el)) || norm(el.getAttribute("aria-label") || ""),
        ),
      );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }
  if (kind === "confirm") {
    const c = deepAll("input[type=checkbox]").find(
      (el) =>
        el.id === "confirm-exam" ||
        el.name === "confirm" ||
        /confirm/i.test(el.getAttribute("aria-labelledby") || ""),
    );
    if (!c) return false;
    if (c.checked) return true;
    c.click();
    if (!c.checked) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "checked",
      )?.set;
      if (setter) setter.call(c, true);
      else c.checked = true;
      c.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      c.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
    return c.checked === true;
  }
  if (kind === "submit") {
    const b = findSubmit();
    if (b) {
      (b.shadowRoot?.querySelector("button") || b).click();
      return true;
    }
    const s = deepAll('button,[role="button"],a')
      .filter(ok)
      .find((el) =>
        /^(s[ií]|yes|enviar|submit|aceptar|ok)$/i.test(norm(shadowText(el))),
      );
    if (s) {
      s.click();
      return true;
    }
    return false;
  }
  if (kind === "next") {
    const b = deepAll('button,a,[role="button"]')
      .filter(ok)
      .filter((el) => !topBar(el))
      .find((el) =>
        /siguiente|next/i.test(
          (el.getAttribute("aria-label") || "") + " " + norm(shadowText(el)),
        ),
      );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }
  if (kind === "sidebarNext") {
    const root = outlineRoot();
    if (!root) return false;
    const links = deepAll('a,[role="treeitem"],[role="button"],button', root)
      .filter(
        (el) =>
          !el.getAttribute("aria-disabled") &&
          !/disabled|locked|bloqueado/i.test(el.className || ""),
      )
      .filter((el) => numbered(el) || el.matches('[role="treeitem"]'));
    const cur = links.findIndex(
      (el) =>
        el.matches('[aria-current="page"],[aria-selected="true"]') ||
        /active|selected/i.test(el.className || ""),
    );
    if (cur === -1 || !links[cur + 1]) return false;
    const target = links[cur + 1];
    target.click();
    if (target.getAttribute("aria-expanded") === "false" && links[cur + 2]) {
      setTimeout(() => links[cur + 2]?.click?.(), 300);
    }
    return true;
  }
  if (kind === "expandModule") {
    const root = outlineRoot();
    if (!root) return false;
    const m = deepAll(
      '[role="treeitem"][aria-expanded="false"], [aria-expanded="false"][class*="module"]',
      root,
    )[0];
    if (!m) return false;
    m.click();
    return true;
  }
  return false;
}

function ccnaDiag() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const deepText = (el) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : [...el.childNodes];
    return kids.map(deepText).join(" ");
  };
  const n = (s) => {
    try {
      return deepAll(s).length;
    } catch {
      return -1;
    }
  };
  return {
    url: location.href || "(frame)",
    contentScript: !!window.__ccna,
    title: (document.title || "").slice(0, 120),
    radios: n("input[type=radio]"),
    checks: n("input[type=checkbox]"),
    roleRadios: n('[role="radio"]'),
    roleChecks: n('[role="checkbox"]'),
    selects: n("select"),
    objectMatching: n('objectmatching-view, [class*="objectMatching__widget"]'),
    submitButtons: n(
      'button.submit-button, button.mcq__submit, button.adaptive-assessment-submit, button[aria-label="submit"]',
    ),
    shadow: deepAll("*").filter((e) => e.shadowRoot).length,
    texto: norm(deepText(document.body)).length,
  };
}

/* ---------- descargas ---------- */
const slug = (s) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "pagina";

async function download(name, content) {
  const url = "data:text/markdown;charset=utf-8," + encodeURIComponent(content);
  await chrome.downloads.download({
    url,
    filename: `ccna/${name}`,
    conflictAction: "overwrite",
    saveAs: false,
  });
}

/* ---------- lectura ---------- */
async function pageInfo(tabId, expand = false) {
  const metas = await execAll(tabId, ccnaMeta);
  const list = metas
    .map((m) => ({ frameId: m.frameId, ...(m.result || {}) }))
    .filter((m) => m.url);
  const lesson =
    list.find((m) =>
      /authoring-resources|assessment|scorm|content\//i.test(m.url),
    ) ||
    list
      .filter((m) => !/login-status|realms|keycloak/i.test(m.url))
      .sort((a, b) => b.size - a.size)[0];

  const title =
    (lesson && lesson.title) ||
    list.map((m) => m.title).filter(Boolean)[0] ||
    "";
  const lost = list.some((m) => m.lost);
  const sig =
    list
      .map((m) => m.sig)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || "";
  const docTitles = list
    .map((m) => m.docTitle)
    .filter(Boolean)
    .join(" | ");
  const url = (list[0] && list[0].url) || "";

  // El frame elegido puede estar vacío u oculto: se prueban los demás, del más grande al más chico
  const frames = [
    ...(lesson ? [lesson] : []),
    ...list
      .filter((m) => m !== lesson && !/login-status|realms|keycloak/i.test(m.url))
      .sort((a, b) => (b.size || 0) - (a.size || 0)),
  ];
  let text = "";
  for (const f of frames) {
    text =
      (await execIn(
        tabId,
        f.frameId,
        (exp) =>
          window.__ccna
            ? window.__ccna.extract(exp)
            : document.body?.innerText || "",
        [expand],
      )) || "";
    if (text.trim()) break;
  }
  return { title, text, lost, sig, docTitles, url };
}

async function waitChange(tabId, before) {
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const m = await execAll(tabId, ccnaMeta);
    const sig =
      m
        .map((x) => x.result?.sig)
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] || "";
    if (sig && sig !== before) return true;
  }
  return false;
}
async function nav(tabId, kind, arg) {
  const args = arg === undefined ? [kind] : [kind, arg];
  return (await execAll(tabId, ccnaNav, args)).some((r) => r.result === true);
}
async function navIn(tabId, frameId, kind, arg) {
  const args = arg === undefined ? [kind] : [kind, arg];
  return (await execIn(tabId, frameId, ccnaNav, args)) === true;
}
async function advance(tabId, before) {
  if (await nav(tabId, "next")) return true;
  if (await nav(tabId, "sidebarNext")) return true;
  if (await nav(tabId, "expandModule")) {
    await sleep(600);
    if (await nav(tabId, "sidebarNext")) return true;
  }
  return waitChange(tabId, before);
}

async function scanTab(tabId) {
  const patterns = await getLearnedPatterns();
  const frames = await execAll(tabId, ccnaScan, [patterns]);
  const best = frames
    .filter(
      (f) =>
        f.result?.questions?.length ||
        f.result?.onConfirmScreen ||
        f.result?.hasQuiz,
    )
    .sort(
      (a, b) =>
        (b.result.questions?.length || 0) - (a.result.questions?.length || 0),
    )[0];
  const flag = (k) => frames.some((f) => f.result && f.result[k]);
  return {
    questions: best?.result?.questions || [],
    progress: best?.result?.progress || null,
    onConfirmScreen: flag("onConfirmScreen"),
    unansweredChips: best?.result?.unansweredChips || [],
    hasQuiz: flag("hasQuiz"),
    hasStart: flag("hasStart"),
    hasSubmit: flag("hasSubmit"),
    hasConfirm: flag("hasConfirm"),
    frameId: best?.frameId ?? null,
    signature: best?.result?.signature || "",
  };
}

/* ---------- IA ---------- */
const answerKey = (q) =>
  `${rankAll(q) ? "rank" : q.type}::${q.text}::${q.options
    .map((o) => o.text)
    .sort()
    .join("|")}`;

const COUNT_RE =
  /(?:elija|escoja|seleccione|choose|select|pick)\s+(?:las\s+)?(?:dos|tres|cuatro|cinco|two|three|four|five|\d+)\b/i;
const rankAll = (q) => q.type === "checkbox" && !COUNT_RE.test(q.text);

const isHardQuestion = (q) =>
  q.type !== "radio" ||
  (q.images || []).length > 0 ||
  /\[Diagrama:|\b\d{1,3}(?:\.\d{1,3}){3}\b|\/\d{1,2}\b|m[aá]scara|wildcard|subred|subnet|costo|\bcost\b|m[eé]trica|\bhosts?\b|binari|hexadecimal/i.test(
    q.text,
  ) ||
  /\bNO\b/.test(q.text);

function cachedPick(q, c) {
  if (q.type === "select" || q.type === "match" || q.type === "objectMatching")
    return c.answers;
  const idx = c.answers.map((t) => q.options.findIndex((o) => o.text === t));
  return idx.length && idx.every((k) => k >= 0) ? idx : null;
}

const nrm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const optsSigOf = (texts) => texts.map(nrm).sort().join("|");

function verifiedPick(q, verified) {
  const t = nrm(q.text);
  const byOpts = verified[optsSigOf(q.options.map((o) => o.text))] || [];
  const cands = byOpts.filter((e) => t.includes(e.text) || e.text.includes(t));
  let v =
    cands.find((e) => e.text === t) ||
    cands
      .filter((e) => t.includes(e.text))
      .sort((a, b) => b.text.length - a.text.length)[0] ||
    cands.sort((a, b) => a.text.length - b.text.length)[0] ||
    (byOpts.length === 1 ? byOpts[0] : null);

  if (!v && q.type === "objectMatching") {
    for (const entries of Object.values(verified)) {
      for (const e of entries || []) {
        if (!Array.isArray(e.pairs) || !e.pairs.length) continue;
        if (
          e.text === t ||
          (t.length > 12 && (t.includes(e.text) || e.text.includes(t)))
        ) {
          const optSet = q.options.map((o) => nrm(o.text));
          const allMatch = e.pairs.every((p) =>
            optSet.some(
              (ot) =>
                ot === nrm(p.option) ||
                ot.includes(nrm(p.option)) ||
                nrm(p.option).includes(ot),
            ),
          );
          if (allMatch) {
            v = e;
            break;
          }
        }
      }
      if (v) break;
    }
  }

  if (!v) return null;
  if (q.type === "objectMatching") {
    return Array.isArray(v.pairs) && v.pairs.length
      ? {
          idx: v.pairs,
          correct: v.pairs.map((p) => `${p.category} → ${p.option}`),
        }
      : null;
  }
  const idx = (v.correct || []).map((c) =>
    q.options.findIndex((o) => nrm(o.text) === nrm(c)),
  );
  return idx.length && idx.every((k) => k >= 0)
    ? { idx, correct: v.correct }
    : null;
}

async function answerQuestions(questions, useAiCache = true) {
  const o = await chrome.storage.local.get([ANSWERS, VERIFIED, WRONG]);
  const cache = o[ANSWERS] || {};
  const verified = o[VERIFIED] || {};
  const wrong = o[WRONG] || {};
  const hits = [];
  const miss = [];
  for (const q of questions) {
    const ver = !q.unread && verifiedPick(q, verified);
    if (ver) {
      hits.push({
        id: q.id,
        idx: ver.idx,
        md: `**${q.text}**\n\n→ ${ver.correct.join(" · ")} (verificada por NetAcad)`,
        verificada: true,
      });
      continue;
    }
    const c = useAiCache && !q.unread && cache[answerKey(q)];
    const idx = c && cachedPick(q, c);
    if (idx) hits.push({ id: q.id, idx, md: c.md });
    else {
      const t = nrm(q.text);
      const w = (wrong[optsSigOf(q.options.map((x) => x.text))] || []).find(
        (e) => t.includes(e.text) || e.text.includes(t),
      );
      miss.push(w ? { ...q, descartadas: w.wrong } : q);
    }
  }
  const sinVerificar =
    questions.length - hits.filter((h) => h.verificada).length;
  const { apiKey } = await getCfg();
  const res =
    miss.length && apiKey
      ? await answerFresh(miss)
      : { md: "", picks: [], entries: [] };
  const nuevas = res.entries.filter((e) => !e.q.unread);
  if (nuevas.length) {
    for (const e of nuevas)
      cache[answerKey(e.q)] = { answers: e.answers, md: e.md };
    await chrome.storage.local.set({ [ANSWERS]: cache });
    chrome.storage.local.remove("ccna.answers").catch(() => {});
  }
  return {
    md: [...hits.map((h) => h.md), res.md].filter(Boolean).join("\n\n"),
    picks: [...hits.map((h) => ({ id: h.id, idx: h.idx })), ...res.picks],
    sinVerificar,
  };
}

async function answerFresh(questions) {
  if (questions.length > 1) {
    try {
      return await answerQuestionsRaw(questions);
    } catch {
      const parts = await Promise.all(
        questions.map((q) => answerQuestionsRaw([q])),
      );
      return {
        md: parts
          .map((p) => p.md)
          .filter(Boolean)
          .join("\n\n"),
        picks: parts.flatMap((p) => p.picks),
        entries: parts.flatMap((p) => p.entries),
      };
    }
  }
  return answerQuestionsRaw(questions);
}

async function answerQuestionsRaw(questions) {
  const payload = questions.map((q) => {
    if (q.type === "objectMatching") {
      return {
        id: q.id,
        tipo: "objectMatching",
        pregunta: q.text,
        categorias: (q.categories || []).map((c, idx) => ({
          letra: c.letter || String.fromCharCode(65 + idx),
          texto: c.text,
        })),
        opciones: q.options.map((o, k) => ({
          numero: String(k + 1),
          texto: o.text,
        })),
      };
    }
    return {
      id: q.id,
      tipo: q.type,
      pregunta: q.text,
      ...(rankAll(q) ? { ordenar_todas: true } : {}),
      ...(q.descartadas?.length ? { descartadas: q.descartadas } : {}),
      opciones: q.options.map((o, k) => ({
        letra: String.fromCharCode(65 + k),
        texto: o.text,
      })),
    };
  });
  const images = questions.flatMap((q) => q.images || []).slice(0, 3);
  const hard = questions.some(
    (q) => isHardQuestion(q) || q.descartadas?.length,
  );
  const maxOut = Math.max(hard ? 4096 : 1200, questions.length * 450);
  const parsed = await aiJSON(
    'Instructor CCNA. Responde SOLO JSON válido: {"items":[{"id":0,"respuesta":"B"}]}',
    `Resuelve estas preguntas de CCNA. Devuelve únicamente {"items":[{"id":0,"respuesta":"B"}]}.
Reglas:
- "radio": 1 letra mayúscula (ej. "B").
- "checkbox": array con TODAS las letras correctas que pide el enunciado, por ejemplo si pide dos opciones devuelve 2 letras: ["A","C"].
- "checkbox" con "ordenar_todas": array con TODAS las letras de las opciones, de la más probable a la menos probable de ser correcta.
- "objectMatching": objeto que empareja cada número de opción ("1","2",...) con la letra de su categoría ("A","B",...), ej. {"1":"D","2":"B","3":"C","4":"A"}.
- "descartadas": textos de opciones que ya se comprobó que son INCORRECTAS. Nunca las elijas (en "ordenar_todas" van al final). Si la pregunta dice "es incorrecta"/"NO", lee con cuidado qué se pide.
- "match"/"select": array con textos exactos entre [corchetes].

${JSON.stringify(payload)}`,
    maxOut,
    images,
    hard,
  );
  const items = parsed.map((p, i) => ({
    id: p.id ?? questions[i]?.id,
    respuesta: p.respuesta ?? p.answer ?? p.respuesta_correcta ?? p.indice,
  }));

  const md = [];
  const picks = [];
  const entries = [];
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const q =
      questions.find((x) => String(x.id) === String(p.id)) ||
      (questions.length === 1 && items.length === 1
        ? questions[0]
        : questions[i]);
    if (!q) continue;
    const opts = q.options;

    if (q.type === "objectMatching") {
      const cats = q.categories || [];
      const pairs = [];
      const rawMap =
        p.respuesta && typeof p.respuesta === "object" ? p.respuesta : {};
      for (const [kStr, letterRaw] of Object.entries(rawMap)) {
        const optIdx = Number(kStr) - 1;
        const letter = String(letterRaw || "")
          .trim()
          .toUpperCase();
        const cat =
          cats.find((c) => c.letter.toUpperCase() === letter) ||
          cats[letter.charCodeAt(0) - 65];
        if (opts[optIdx] && cat) {
          pairs.push({ category: cat.text, option: opts[optIdx].text });
        }
      }
      const qmd = `**${q.text}**\n\n→ ${pairs.map((pr) => `${pr.category} → ${pr.option}`).join(" · ") || "sin respuesta"}`;
      md.push(qmd);
      if (pairs.length) {
        picks.push({ id: q.id, idx: pairs });
        entries.push({ q, answers: pairs, md: qmd });
      }
      continue;
    }

    if (q.type === "select" || q.type === "match") {
      const vals = [].concat(p.respuesta ?? []).map((v) => String(v).trim());
      const lista = opts.map((o, k) => `${k + 1}) ${o.text}`).join("\n");
      const qmd = `**${q.text}**\n\n${lista}\n\n→ ${vals.join(" · ") || "sin respuesta"}`;
      md.push(qmd);
      if (vals.length) {
        picks.push({ id: q.id, idx: vals });
        entries.push({ q, answers: vals, md: qmd });
      }
      continue;
    }

    const letras = []
      .concat(p.respuesta ?? [])
      .map((r) => {
        const m = String(r)
          .trim()
          .match(/^([A-Za-z])(?:\W|$)/);
        return m ? m[1].toUpperCase() : "";
      })
      .filter(Boolean);
    const idx = letras
      .map((L) => L.charCodeAt(0) - 65)
      .filter((k) => k >= 0 && k < opts.length);
    const lista = opts
      .map((o, k) => `${String.fromCharCode(65 + k)}) ${o.text}`)
      .join("\n");
    const fmt = idx.length
      ? idx
          .map((k) => `${String.fromCharCode(65 + k)}) ${opts[k].text}`)
          .join(" · ")
      : letras.join(" · ") || "sin respuesta";
    const qmd = `**${q.text}**\n\n${lista}\n\n→ ${rankAll(q) ? "orden de probabilidad (se marcan hasta habilitar Enviar): " : ""}${fmt}`;
    md.push(qmd);
    if (idx.length) {
      picks.push({ id: q.id, idx });
      entries.push({ q, answers: idx.map((k) => opts[k].text), md: qmd });
    }
  }
  return { md: md.join("\n\n"), picks, entries };
}

/* ---------- flujos ---------- */
async function summarize(title, body) {
  return callAI(
    "Eres profesor de CCNA. Apuntes en español, Markdown.",
    `Resume para estudiar: ${title}\n\n${body.slice(0, 12000)}`,
    false,
    1200,
  );
}

async function runWalk() {
  const cfg = await getCfg();
  const tab = await activeTab();
  await ensureContent(tab.id);
  await chrome.storage.local.set({ [SAVED]: [] });
  const saved = new Set();
  let index = (await chrome.storage.local.get(IDX))[IDX] || 0;

  for (let n = 0; n < cfg.maxPages; n++) {
    if (abort) return;
    let info = null,
      prev = "";
    for (let a = 0; a < 3; a++) {
      info = await pageInfo(tab.id);
      if (info.lost) {
        stop("Sesión perdida: vuelve a iniciar sesión.", true);
        return;
      }
      if (info.text && info.text.length > 80 && info.text !== prev) break;
      prev = info.text;
      if (!info.text) await ensureContent(tab.id);
      await sleep(3000);
    }
    if (!info?.text) {
      stop("No se pudo extraer contenido. ¿Recargaste con F5?", true);
      return;
    }

    if (
      /gradebook|calificaci/i.test(info.title) ||
      /gradebook/i.test(info.url)
    ) {
      await log("  fuera del curso: volviendo a Content");
      await nav(tab.id, "content");
      await sleep(2500);
      continue;
    }

    const title = info.title || `Página ${index + 1}`;
    await setState({ page: title, label: "Recorriendo" });
    await log(`· ${title}`);

    if (PT_RE.test(title) || PT_RE.test(info.docTitles))
      await log("  Packet Tracer: saltado");
    else if (!saved.has(title)) {
      saved.add(title);
      const isQuiz = QUIZ_RE.test(title) || QUIZ_RE.test(info.docTitles);
      const body = isQuiz
        ? info.text
        : (await pageInfo(tab.id, true)).text || info.text;
      let md = `# ${title}\n\n`;
      if (cfg.useAI && cfg.apiKey) {
        await setState({ label: "Resumiendo" });
        try {
          md += `## Resumen\n\n${await summarize(title, body)}\n\n`;
        } catch (e) {
          md += `> Error al resumir: ${e.message}\n\n`;
        }
        await setState({ label: "Recorriendo" });
      }
      md += `## Contenido original\n\n${body}\n`;
      await download(
        `${String(++index).padStart(3, "0")}-${slug(title)}.md`,
        md,
      );
      await chrome.storage.local.set({ [IDX]: index });
    } else await log("  ya guardada");

    if (!(await advance(tab.id, info.sig))) {
      stop("No se pudo avanzar.");
      return;
    }
    await sleep(cfg.waitMs);
  }
  stop("Límite de páginas.");
}

async function finishConfirmation(tabId, frameId) {
  let resFinal = await execIn(tabId, frameId, ccnaConfirmAndSubmit);
  if (!resFinal?.ok) {
    const allRes = await execAll(tabId, ccnaConfirmAndSubmit);
    const hit = allRes.find((r) => r.result?.ok);
    if (hit) resFinal = hit.result;
    else {
      const errHit = allRes.find((r) => r.result?.motivo);
      if (errHit) resFinal = errHit.result;
    }
  }
  if (!resFinal?.ok) return resFinal || { ok: false, motivo: "sin respuesta" };

  for (let w = 0; w < 25; w++) {
    await sleep(160);
    const probes = await execAll(tabId, ccnaProbe);
    if (probes.some((p) => p.result?.isResultScreen)) {
      const res = await execIn(tabId, frameId, ccnaResult);
      return { ok: true, puntaje: res?.puntaje || "" };
    }
    if (w === 6) await nav(tabId, "submit");
  }
  return { ok: true, puntaje: "" };
}

async function runQuizzes() {
  const patterns = await getLearnedPatterns();
  await log(
    `versión: quizzes-envio-v67 (patrones aprendidos: ${patterns.length})`,
  );
  const cfg = await getCfg();
  const tab = await activeTab();
  await ensureContent(tab.id);
  const answers = [];
  const hechos = new Set();
  const intentosQuiz = new Map();
  let visited = 0;

  for (let n = 0; n < cfg.maxPages && !abort; n++) {
    let info = await pageInfo(tab.id);
    if (info.lost) {
      stop("Sesión perdida.", true);
      return;
    }

    if (
      /gradebook|calificaci/i.test(info.title) ||
      /gradebook/i.test(info.url)
    ) {
      await log("  fuera del curso: volviendo a Content");
      await nav(tab.id, "content");
      await sleep(1400);
      info = await pageInfo(tab.id);
    }

    await setState({ label: "Buscando quizzes" });
    const title = info.title || `Página ${n + 1}`;
    await setState({ page: title });

    const isPT = PT_RE.test(title) || PT_RE.test(info.docTitles);
    let scan = { questions: [], hasQuiz: false, frameId: null, signature: "" };
    let repetir = false;

    if (isPT) {
      await log(`· ${title}: Packet Tracer, saltado`);
    } else {
      scan = await scanTab(tab.id);
      if (scan.hasStart) {
        await setState({ label: "Comenzando" });
        await nav(tab.id, "start");
        for (let i = 0; i < 18 && !scan.questions.length && !abort; i++) {
          await sleep(250);
          scan = await scanTab(tab.id);
        }
      }
    }

    const isQuiz =
      !isPT &&
      (QUIZ_RE.test(title) || QUIZ_RE.test(info.docTitles) || scan.hasQuiz);
    const quizKey = `${title}::${scan.signature || info.sig.slice(0, 120)}`;

    if (isQuiz && hechos.has(quizKey)) {
      await log(`· ${title}: ya hecho`);
    } else if (isQuiz && scan.frameId !== null) {
      await log(`· ${title}`);
      hechos.add(quizKey);
      visited++;
      let frameId = scan.frameId;

      const ver = (await chrome.storage.local.get(VERIFIED))[VERIFIED] || {};
      const visibles0 = scan.questions.filter((q) => q.visible);
      const isPaginatedExam = (scan.progress?.total || 0) > visibles0.length;
      const attemptNum = intentosQuiz.get(title) || 0;
      const shouldBlankPass =
        attemptNum === 0 &&
        visibles0.length > 0 &&
        (isPaginatedExam || !visibles0.every((q) => verifiedPick(q, ver)));

      if (shouldBlankPass) {
        if (await blankPass(tab.id, frameId)) {
          scan = { questions: [] };
          for (let i = 0; i < 30 && !scan.questions?.length && !abort; i++) {
            await sleep(200);
            scan = await scanTab(tab.id);
            if (scan.hasStart) await nav(tab.id, "start");
          }
          if (scan.frameId != null) frameId = scan.frameId;
        } else {
          await log("  intento en blanco no completado, sigo normal");
        }
      }

      const md = [];
      let sinVerificar = 0;
      const elegidas = [];
      const respondidas = new Set();
      const intentosPregunta = new Map();
      const intentosChip = new Map();
      let enviadasCount = 0;
      let totalEsperado = scan.progress?.total || 0;
      let enviado = false;
      let quizCompletado = false;
      let reintentosVacios = 0;
      let motivoFreno = "";
      let extra = "";

      for (let paso = 1; paso <= 95 && !abort; paso++) {
        const curPatterns = await getLearnedPatterns();
        const st = await execIn(tab.id, frameId, ccnaScan, [curPatterns]);
        if (!st) {
          reintentosVacios++;
          motivoFreno = "frame sin respuesta";
          if (reintentosVacios >= 8) break;
          await sleep(160);
          continue;
        }

        if (st.progress?.total && st.progress.total > totalEsperado) {
          totalEsperado = st.progress.total;
        }

        if (st.isResultScreen) {
          const res = await execIn(tab.id, frameId, ccnaResult);
          if (res?.puntaje) {
            await log(`  resultado: ${res.puntaje}`);
            extra = `\n\n> Resultado: ${res.puntaje}`;
          }
          enviado = true;
          quizCompletado = true;
          break;
        }

        if (st.onConfirmScreen) {
          reintentosVacios = 0;
          const faltanPreguntas =
            totalEsperado > 0 && enviadasCount < totalEsperado;
          const pendientesChips = faltanPreguntas
            ? (st.unansweredChips || []).filter(
                (c) => (intentosChip.get(c.label) || 0) < 2,
              )
            : [];

          if (pendientesChips.length > 0) {
            const chip = pendientesChips[0];
            intentosChip.set(
              chip.label,
              (intentosChip.get(chip.label) || 0) + 1,
            );
            await setState({
              label: `Faltan ${pendientesChips.length} (${chip.label})`,
            });
            await log(
              `  faltan ${pendientesChips.length} sin enviar → abriendo ${chip.label}`,
            );
            const clicked = await execIn(tab.id, frameId, ccnaClickChip, [
              chip.label,
            ]);
            if (clicked) {
              await sleep(300);
              continue;
            }
          }

          await setState({ label: "Confirmando envío" });
          const resFinal = await finishConfirmation(tab.id, frameId);
          if (!resFinal?.ok) {
            motivoFreno = resFinal?.motivo || "no se pudo confirmar el envío";
            reintentosVacios++;
            await log(`  aviso: ${motivoFreno} (intento ${reintentosVacios})`);
            if (reintentosVacios >= 5) break;
            await sleep(220);
            continue;
          }

          enviado = true;
          await log("  casilla marcada y evaluación enviada");
          if (resFinal.puntaje) {
            await log(`  resultado: ${resFinal.puntaje}`);
            extra = `\n\n> Resultado: ${resFinal.puntaje}`;
          }
          quizCompletado = true;
          break;
        }

        const visibles = (st.questions || []).filter((q) => q.visible);
        const candidatas = visibles.length ? visibles : st.questions || [];

        if (!candidatas.length) {
          const allFrames = await execAll(tab.id, ccnaProbe);
          if (allFrames.some((f) => f.result?.onConfirmScreen)) {
            await setState({ label: "Confirmando envío" });
            const resFinal = await finishConfirmation(tab.id, frameId);
            if (resFinal?.ok) {
              enviado = true;
              await log("  casilla marcada y evaluación enviada");
              if (resFinal.puntaje) {
                await log(`  resultado: ${resFinal.puntaje}`);
                extra = `\n\n> Resultado: ${resFinal.puntaje}`;
              }
              quizCompletado = true;
              break;
            }
          }

          if (
            totalEsperado > 0 &&
            enviadasCount >= totalEsperado &&
            !st.hasSubmit
          ) {
            quizCompletado = true;
            break;
          }
          reintentosVacios++;
          motivoFreno = `no se detectó pregunta en pantalla (progreso ${st.progress?.cur || "?"}/${totalEsperado || "?"})`;
          if (reintentosVacios >= 12) {
            await log(`  aviso: ${motivoFreno}`);
            break;
          }
          await sleep(180);
          continue;
        }
        reintentosVacios = 0;

        const porMarcar = candidatas.filter(
          (q) =>
            !respondidas.has(q.text) && (intentosPregunta.get(q.text) || 0) < 3,
        );

        if (!porMarcar.length) {
          if (
            st.submitEnabled &&
            (totalEsperado === 0 || enviadasCount >= totalEsperado)
          ) {
            await navIn(tab.id, frameId, "submit");
            await sleep(260);
            continue;
          }
          if (totalEsperado > 0 && enviadasCount >= totalEsperado) {
            quizCompletado = true;
            break;
          }
          reintentosVacios++;
          if (!motivoFreno) {
            motivoFreno = candidatas.some((q) => respondidas.has(q.text))
              ? "la pregunta ya fue procesada pero no avanzó"
              : "no se encontró el botón Enviar de la pregunta";
          }
          if (reintentosVacios >= 5) {
            await log(`  aviso: ${motivoFreno}`);
            break;
          }
          await sleep(180);
          continue;
        }

        const singlePaginated = candidatas.length === 1;
        const antesSig = st.signature;
        const antesCur = st.progress?.cur || 0;
        const totalPreg = st.progress?.total || totalEsperado || 0;

        for (const q of porMarcar) {
          intentosPregunta.set(q.text, (intentosPregunta.get(q.text) || 0) + 1);
        }

        const numActual = antesCur || enviadasCount + 1;
        const etiquetaBase =
          porMarcar.length > 1
            ? `Resolviendo ${porMarcar.length} preguntas`
            : totalPreg
              ? `Pregunta ${numActual} de ${totalPreg}`
              : `Pregunta ${numActual}`;
        await setState({ label: etiquetaBase });

        let huboEnvioEnLote = false;

        try {
          const lote = porMarcar.slice(0, 4);
          const batchRes = await answerQuestions(lote, false);
          const pickById = new Map(
            batchRes.picks.map((pk) => [String(pk.id), pk.idx]),
          );

          for (let idxQ = 0; idxQ < lote.length; idxQ++) {
            if (abort) break;
            const q = lote[idxQ];
            const etiqueta = totalPreg
              ? `Pregunta ${antesCur || enviadasCount + 1} de ${totalPreg}`
              : `Pregunta ${enviadasCount + 1}`;
            const picks =
              pickById.get(String(q.id)) ||
              (lote.length === 1 ? batchRes.picks[0]?.idx : []) ||
              [];

            if (
              !picks.length &&
              !cfg.apiKey &&
              singlePaginated &&
              (intentosPregunta.get(q.text) || 0) < 2
            ) {
              await log(
                `  ${etiqueta.toLowerCase()}: sin coincidencia con "${q.text.slice(0, 65)}", reintentando`,
              );
              await sleep(250);
              continue;
            }
            if (!picks.length && !cfg.apiKey && singlePaginated) {
              const skipped = await execIn(tab.id, frameId, ccnaClickText, [
                "^(omitir pregunta|skip question)$",
                'label[for="skip-question"], #skip-question',
              ]);
              if (skipped) {
                respondidas.add(q.text);
                enviadasCount++;
                huboEnvioEnLote = true;
                await log(
                  `  ${etiqueta.toLowerCase()}: sin respuesta verificada, omitida`,
                );
              } else {
                motivoFreno =
                  "sin respuesta verificada y no se pudo omitir la pregunta";
                await log(`  ${etiqueta.toLowerCase()}: ${motivoFreno}`);
              }
              continue;
            }
            if (!picks.length) {
              await log(
                `  ${etiqueta.toLowerCase()}: la IA no devolvió opción`,
              );
              continue;
            }

            const resSub = await execIn(tab.id, frameId, ccnaAnswerAndSubmit, [
              q.id,
              picks,
              singlePaginated,
              q.patternSig?.optionSel || "",
              rankAll(q),
            ]);
            if (resSub?.ok && (!singlePaginated || resSub.submitted)) {
              elegidas.push({ q, idx: picks });
              respondidas.add(q.text);
              enviadasCount++;
              if (resSub.submitted) {
                enviado = true;
                huboEnvioEnLote = true;
              }
              if (q.patternSig) {
                learnQuestionPattern({
                  ...q.patternSig,
                  selectedHint: resSub.selectedHint || "",
                }).catch(() => {});
              }
              await log(
                `  ${etiqueta.toLowerCase()} [${q.type}]: marcada (${resSub.marcadas}/${picks.length})${resSub.submitted ? " y enviada" : ""}`,
              );
            } else {
              motivoFreno = resSub?.motivo || "no se pudo enviar la pregunta";
              await log(`  ${etiqueta.toLowerCase()}: ${motivoFreno}`);
            }
            if (lote.length > 1) await sleep(30);
          }
          if (batchRes.md) md.push(batchRes.md);
          sinVerificar += batchRes.sinVerificar || 0;
        } catch (e) {
          motivoFreno = e.message;
          await log(
            `  ${etiquetaBase.toLowerCase()}: error (${e.message}), reintentando…`,
          );
          await sleep(700);
        }

        if (singlePaginated && huboEnvioEnLote) {
          for (let w = 0; w < 45; w++) {
            await sleep(60);
            const pr = await execIn(tab.id, frameId, ccnaProbe);
            if (!pr) continue;
            if (
              pr.isResultScreen ||
              pr.onConfirmScreen ||
              (pr.progress?.cur && pr.progress.cur !== antesCur) ||
              (pr.activeStem &&
                antesSig &&
                !antesSig.startsWith(pr.activeStem.slice(0, 60)))
            ) {
              await sleep(180);
              break;
            }
          }
          continue;
        }

        if (!singlePaginated && respondidas.size >= candidatas.length) {
          const stAfter = await execIn(tab.id, frameId, ccnaScan, [
            curPatterns,
          ]);
          if (stAfter?.submitEnabled) {
            await navIn(tab.id, frameId, "submit");
            await sleep(250);
            continue;
          }
          if (totalEsperado === 0 || enviadasCount >= totalEsperado) {
            quizCompletado = true;
            break;
          }
        }
        await sleep(100);
      }

      const cortado = abort;
      await log(
        `  total enviadas: ${enviadasCount}${totalEsperado ? ` de ${totalEsperado}` : ""}${cortado ? " (interrumpido)" : ""}`,
      );
      const cuerpo = `### ${title}\n\n${md.join("\n\n")}\n\n> Respondidas: ${enviadasCount}${totalEsperado ? ` de ${totalEsperado}` : ""}`;

      answers.push(
        `${cuerpo}${extra}\n\n> ${
          cortado
            ? "Interrumpido, sin enviar"
            : `Enviado: ${enviado ? "sí" : "no"}`
        }`,
      );

      if (cortado) {
        await guardarRespuestas(answers);
        return;
      }

      if (quizCompletado && sinVerificar > 0) {
        const rev = await harvestReview(tab.id);
        const ver2 = (await chrome.storage.local.get(VERIFIED))[VERIFIED] || {};
        const igual = (a, b) =>
          Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          [...a].sort().join() === [...b].sort().join();
        const falladas = elegidas.filter(({ q, idx }) => {
          const v = verifiedPick(q, ver2);
          return v ? !igual(v.idx, idx) : false;
        }).length;
        const omitidas = Math.max(0, sinVerificar - elegidas.length);
        if (rev && falladas)
          await log(
            `  ${falladas} respuestas de la IA no coinciden con NetAcad`,
          );
        const n = (intentosQuiz.get(title) || 0) + 1;
        intentosQuiz.set(title, n);
        if ((rev?.malas > 0 || falladas > 0 || omitidas > 0) && n < 4) {
          let retried = false;
          for (let rTry = 0; rTry < 5 && !retried; rTry++) {
            const re = await execAll(tab.id, ccnaClickText, [
              "^(reiniciar|restablecer|retry)$",
              ".js-assessment-retry-btn",
            ]);
            if (re.some((f) => f.result)) {
              retried = true;
              await log(
                `  reintento ${n + 1} de 4: completando ${omitidas > 0 ? `${omitidas} omitidas` : "incorrectas"}`,
              );
              hechos.delete(quizKey);
              repetir = true;
            } else {
              await sleep(220);
            }
          }
        }
      }

      if (
        !quizCompletado &&
        totalEsperado > 0 &&
        enviadasCount < totalEsperado
      ) {
        await guardarRespuestas(answers);
        await dumpDiag(tab.id, `diagnostico-quiz-${Date.now()}.md`);
        stop(
          `Detenido en ${title}: ${enviadasCount} de ${totalEsperado}${motivoFreno ? ` (${motivoFreno})` : ""}.`,
          true,
        );
        return;
      }

      await sleep(120);
    }

    if (abort) {
      await guardarRespuestas(answers);
      return;
    }

    if (repetir) {
      await sleep(400);
      continue;
    }

    let movido = await advance(tab.id, info.sig);
    if (!movido) {
      await guardarRespuestas(answers);
      stop(
        visited
          ? `Fin: ${visited} quizzes procesados.`
          : "No encontré quizzes y no puedo avanzar.",
        !visited,
      );
      return;
    }
    await sleep(Math.min(cfg.waitMs, 450));
  }
  await guardarRespuestas(answers);
  if (!abort) stop(`Límite alcanzado: ${visited} quizzes.`);
}

async function runExplain() {
  const tab = await activeTab();
  await ensureContent(tab.id);
  await setState({ label: "Buscando preguntas" });
  let scan = await scanTab(tab.id);
  if (scan.hasStart) {
    await nav(tab.id, "start");
    for (let i = 0; i < 12 && !scan.questions.length; i++) {
      await sleep(200);
      scan = await scanTab(tab.id);
    }
  }
  if (!scan.questions.length) {
    const d = await dumpDiag(tab.id, "diagnostico-explicar.md");
    throw new Error(`No se encontraron preguntas (${d.resumen}).`);
  }
  await setState({ label: "Consultando a la IA" });
  const { md } = await answerQuestions(scan.questions);
  const info = await pageInfo(tab.id);
  const title = info.title || "pagina";
  await download(`vsc-${slug(title)}.md`, `# ${title}\n\n${md}\n`);
  await setState({ reason: md });
  stop("Explicación guardada.");
}

async function dumpDiag(tabId, name) {
  await ensureContent(tabId);
  const frames = await execAll(tabId, ccnaDiag);
  const rows = frames
    .map((f) => ({ frameId: f.frameId, ...(f.result || {}) }))
    .filter((r) => r.url);
  const patterns = await getLearnedPatterns();
  const scans = await execAll(tabId, ccnaScan, [patterns]);
  for (const r of rows) {
    const sc = scans.find((x) => x.frameId === r.frameId)?.result;
    if (sc)
      r.escaner = {
        progress: sc.progress,
        submitEnabled: sc.submitEnabled,
        onConfirmScreen: sc.onConfirmScreen,
        isResultScreen: sc.isResultScreen,
        preguntas: sc.questions.map((q) => ({
          tipo: q.type,
          texto: q.text.slice(0, 120),
          opciones: q.options.length,
        })),
        descartes: sc.descartes,
      };
  }
  const sin = rows.filter((r) => !r.contentScript).length;
  const resumen = `${rows.length} frames · sin content script: ${sin}`;
  const md = [
    "# Diagnóstico",
    "",
    resumen,
    "",
    "```json",
    JSON.stringify(rows, null, 2),
    "```",
    "",
  ].join("\n");
  const htmls = await execAll(tabId, ccnaDeepHTML);
  const paginas = htmls
    .map((f) => f.result)
    .filter((r) => r?.html && r.html.length > 200)
    .map((r) => `## Frame ${r.url}\n\n\`\`\`html\n${r.html}\n\`\`\``)
    .join("\n\n");
  await download(name, `${md}\n${paginas}\n`);
  await log(`  diagnóstico: ${resumen}`);
  await setState({ reason: resumen });
  return { resumen, rows };
}

/* Pulsa el primer botón visible cuyo texto coincide (o que cumple el selector) */
function ccnaClickText(pattern, selector = "") {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const shadowText = (el) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (el.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(el.tagName)) return "";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : el.tagName === "SLOT"
        ? el.assignedNodes()
        : [...el.childNodes];
    return kids.map(shadowText).join(" ");
  };
  const isVis = (el) => {
    if (!el || el.disabled || el.getAttribute?.("aria-disabled") === "true")
      return false;
    if (
      el.classList?.contains("disabled") ||
      el.classList?.contains("is-disabled")
    )
      return false;
    const r = el.getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0;
  };
  const re = new RegExp(pattern, "i");
  const b = [
    ...(selector ? deepAll(selector) : []),
    ...deepAll('button,a,[role="button"],label,[class*="skip"]').filter((el) =>
      re.test(norm(shadowText(el))),
    ),
  ].find(isVis);
  if (!b) return false;
  const target = b.shadowRoot?.querySelector("button") || b;
  target.scrollIntoView?.({ behavior: "instant", block: "nearest" });
  target.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, composed: true }),
  );
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, composed: true }),
  );
  target.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, composed: true }),
  );
  target.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, composed: true }),
  );
  target.click();
  return true;
}

/* Pulsa "Revisar la evaluación" / "Evaluación de la revisión" en la pantalla de resultados */
function ccnaReviewClick() {
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const b =
    deepAll(".review-assessment-button")[0] ||
    deepAll('button,a,[role="button"]').find((el) =>
      /revisar la evaluaci[oó]n|evaluaci[oó]n de la revisi[oó]n|review (the )?assessment/i.test(
        el.textContent || "",
      ),
    );
  if (!b) return false;
  (b.shadowRoot?.querySelector("button") || b).click();
  return true;
}

/* Cierra el modal/panel de revisión (.review-container) para dejar visible el botón Reiniciar */
function ccnaCloseReview() {
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const containers = deepAll(
    '.review-container, [class*="review-container"], [class*="review__"]',
  );
  for (const box of containers) {
    const btn = deepAll(
      'button, [role="button"], .review-close-button, [class*="close"]',
      box,
    ).find((el) => {
      if (el.disabled) return false;
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const meta = [
        el.className || "",
        el.getAttribute?.("aria-label") || "",
        el.getAttribute?.("title") || "",
        el.textContent || "",
        el.querySelector?.("material-icon")?.getAttribute?.("icon") || "",
      ].join(" ");
      return /close|cerrar|clear|cross/i.test(meta);
    });
    if (btn) {
      (btn.shadowRoot?.querySelector("button") || btn).click();
      return true;
    }
  }
  return false;
}

/* Recorre las pestañas/bloques de revisión en evaluaciones adaptativas (.review-container) */
function ccnaReviewNav(action, index = 0) {
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const btns = deepAll(
    '.attempted-blocks-wrapper .block-button, .review-container .block-button, [class*="attempted-blocks"] button',
  ).filter((el) => {
    if (el.disabled) return false;
    const r = el.getBoundingClientRect?.();
    return !!r && r.width > 0 && r.height > 0;
  });
  if (action === "count") return btns.length;
  const b = btns[index];
  if (!b) return false;
  const target = b.shadowRoot?.querySelector("button") || b;
  target.scrollIntoView?.({ behavior: "instant", block: "nearest" });
  target.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, composed: true }),
  );
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, composed: true }),
  );
  target.click();
  return true;
}

/* Lee la revisión: MCQ (is-correct / is-incorrect) y objectMatching (tabla .component__feedback-content / .table-feedback) */
function ccnaReviewHarvest() {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const deepAll = (sel, root = document) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  };
  const within = (sel, r) => [
    ...deepAll(sel, r),
    ...(r.shadowRoot ? deepAll(sel, r.shadowRoot) : []),
  ];
  const up = (el) => el.parentElement || el.getRootNode?.().host || null;
  const SKIP =
    '[class*="screenReader"], .sr-only, [class*="visually-hidden"], [class*="material-icons"], [class*="material-symbols"], .icon, .aria-label, [aria-hidden="true"]';
  const noIcons = (t) =>
    t
      .replace(
        /\b(?:check_box(?:_outline_blank)?|radio_button_(?:un)?checked|indeterminate_check_box)\b/gi,
        " ",
      )
      .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, " ");
  const cleanPrompt = (t) =>
    norm(
      noIcons(t)
        .replace(
          /(?<![\d.])\b\d+\s*(?:de|of|\/)\s*\d+\s*(?:preguntas|questions)?\b/gi,
          " ",
        )
        .replace(
          /^(?:omitir todo|omitir pregunta|skip all|skip question|enviar|submit)\b|\b(?:omitir todo|omitir pregunta|skip all|skip question|enviar|submit)$/gi,
          " ",
        )
        .replace(
          /^((?:q\s*\d+|incompleto|incomplete|completado|completed?|correcto|incorrecto|pregunta|question)\s*\d*\s*)+/i,
          "",
        ),
    );
  const text = (el) => {
    if (!el) return "";
    if (el.nodeType === 3) return el.textContent;
    if (
      el.nodeType !== 1 ||
      /^(SCRIPT|STYLE)$/.test(el.tagName) ||
      el.matches(SKIP)
    )
      return "";
    if (el.tagName === "IMG")
      return el.alt ? ` [Imagen: ${el.alt}] ` : " [Imagen] ";
    const kids = el.shadowRoot
      ? [...el.shadowRoot.childNodes]
      : [...el.childNodes];
    return kids.map(text).join(" ");
  };

  const out = [];
  for (const view of deepAll("mcq-view")) {
    const root = view.shadowRoot || view;
    const items = deepAll(".mcq__item", root);
    if (items.length < 2) continue;
    const pregunta = cleanPrompt(text(deepAll(".mcq__body-inner", root)[0]));
    const opciones = items.map((it) => {
      const nodes = [it, ...deepAll("*", it)];
      const isCorrect = nodes.some(
        (el) =>
          el.classList?.contains("is-correct") ||
          /^(check|done|check_circle)$/i.test(el.getAttribute?.("icon") || ""),
      );
      const isIncorrect = nodes.some(
        (el) =>
          el.classList?.contains("is-incorrect") ||
          /^(close|clear|cancel)$/i.test(el.getAttribute?.("icon") || ""),
      );
      return {
        texto: norm(
          noIcons(text(it.querySelector(".mcq__item-text-inner") || it)),
        ),
        estado: isCorrect ? "c" : isIncorrect ? "i" : "",
      };
    });
    if (pregunta && opciones.some((o) => o.estado))
      out.push({ type: "mcq", pregunta, opciones });
  }

  const allOmWidgets = deepAll(
    'objectmatching-view, [class*="objectMatching__widget"]',
  );

  for (const om of allOmWidgets) {
    // Subir hasta el contenedor completo del componente sin cruzar a otra pregunta
    let compBox = om;
    let cur = up(om);
    for (let d = 0; d < 6 && cur && cur !== document.body; d++) {
      if (
        within(
          'objectmatching-view, [class*="objectMatching__widget"], mcq-view',
          cur,
        ).length > 1
      ) {
        break;
      }
      compBox = cur;
      cur = up(cur);
    }

    let stemEl = null;
    for (const sSel of [
      '[class*="objectMatching__body-inner"]',
      '[class*="component__body-inner"]',
      '[class*="instruction"]',
    ]) {
      stemEl = within(sSel, compBox).find((el) => norm(text(el)).length > 10);
      if (stemEl) break;
    }
    const pregunta = cleanPrompt(text(stemEl));

    const catTexts = [];
    const catMap = new Map();
    within('[class*="objectMatching-category-item"]', compBox)
      .filter(
        (el) => !el.classList?.contains("objectMatching-category-item-inner"),
      )
      .forEach((el, i) => {
        const letter = norm(
          text(within('[class*="category-item-number"]', el)[0]),
        ).toUpperCase();
        const catTxt = norm(
          noIcons(text(within('[class*="category-item-text"]', el)[0] || el)),
        );
        if (catTxt) {
          catTexts.push(catTxt);
          catMap.set(letter || String.fromCharCode(65 + i), catTxt);
        }
      });

    const optEls = within(
      '[class*="objectMatching-option-item"]',
      compBox,
    ).filter(
      (el) => !el.classList?.contains("objectMatching-option-item-inner"),
    );
    const opciones = [];
    const pairs = [];
    for (const el of optEls) {
      const optTxt = norm(
        noIcons(text(within('[class*="category-item-text"]', el)[0] || el)),
      );
      const assigned = norm(
        text(within('[class*="category-item-number"]', el)[0]),
      ).toUpperCase();
      const hasIncorrectIcon = within("*", el).some(
        (n) =>
          n.classList?.contains("is-incorrect") ||
          /^(close|clear|cancel)$/i.test(n.getAttribute?.("icon") || ""),
      );
      if (optTxt) {
        opciones.push({
          texto: optTxt,
          estado: hasIncorrectIcon ? "i" : assigned ? "c" : "",
        });
        if (assigned && !hasIncorrectIcon && catMap.has(assigned)) {
          pairs.push({ category: catMap.get(assigned), option: optTxt });
        }
      }
    }

    // Leer la tabla de solución en .component__feedback-content (.table-feedback)
    if (pairs.length < 2) {
      const optTexts = opciones.map((o) => o.texto);
      const matchOne = (raw, list) => {
        const needle = norm(raw).toLowerCase();
        if (!needle) return "";
        return (
          list.find((it) => norm(it).toLowerCase() === needle) ||
          list.find((it) => {
            const h = norm(it).toLowerCase();
            return h.length >= 4 && (needle.includes(h) || h.includes(needle));
          }) ||
          ""
        );
      };
      const matchMany = (raw, list) => {
        const single = matchOne(raw, list);
        if (single) return [single];
        const needle = norm(raw).toLowerCase();
        return list.filter((it) => {
          const h = norm(it).toLowerCase();
          return h.length >= 5 && needle.includes(h);
        });
      };

      let tables = within(
        '.component__feedback-content table, table.table-feedback, [class*="feedback-content"] table',
        compBox,
      );
      if (!tables.length && allOmWidgets.length === 1) {
        tables = deepAll(
          '.component__feedback-content table, table.table-feedback, [class*="feedback-content"] table',
        );
      }

      for (const tbl of tables) {
        const extracted = [];
        for (const tr of within("tr", tbl)) {
          const cells = [...tr.querySelectorAll("td, th")];
          if (cells.length < 2) continue;
          const t0 = norm(noIcons(text(cells[0])));
          const t1 = norm(noIcons(text(cells[1])));

          const cat0 = matchOne(t0, catTexts);
          const opts1 = cat0 ? matchMany(t1, optTexts) : [];
          if (cat0 && opts1.length) {
            for (const opt of opts1)
              extracted.push({ category: cat0, option: opt });
            continue;
          }

          const cat1 = matchOne(t1, catTexts);
          const opts0 = cat1 ? matchMany(t0, optTexts) : [];
          if (cat1 && opts0.length) {
            for (const opt of opts0)
              extracted.push({ category: cat1, option: opt });
          }
        }
        if (extracted.length >= 2) {
          pairs.length = 0;
          pairs.push(...extracted);
          break;
        }
      }
    }

    if (pregunta && opciones.length >= 2) {
      out.push({ type: "objectMatching", pregunta, opciones, pairs });
    }
  }
  return out;
}

// Omitir todo → confirmar → leer la revisión → Reiniciar: respuestas reales sin gastar IA
async function blankPass(tabId, frameId) {
  const falla = async (m) => (await log(`  intento en blanco: ${m}`), false);
  await log("  intento en blanco: omitiendo todo");
  const omit = await execAll(tabId, ccnaClickText, [
    "^(omitir todo|skip all)$",
    'label[for="skip-all-question"], #skip-all-question',
  ]);
  if (!omit.some((f) => f.result)) return falla('no encontré "Omitir todo"');
  let conf = false;
  for (let i = 0; i < 20 && !conf; i++) {
    await sleep(150);
    conf = (await execAll(tabId, ccnaProbe)).some(
      (p) => p.result?.onConfirmScreen,
    );
  }
  if (!conf) return falla("no apareció la pantalla de confirmación");
  const fin = await finishConfirmation(tabId, frameId);
  if (!fin?.ok) return falla(`no se pudo enviar (${fin?.motivo || "?"})`);
  if (!(await harvestReview(tabId)))
    await log("  intento en blanco: no se pudo leer la revisión");
  let restarted = false;
  for (let rTry = 0; rTry < 5 && !restarted; rTry++) {
    const re = await execAll(tabId, ccnaClickText, [
      "^(reiniciar|restablecer|retry)$",
      ".js-assessment-retry-btn",
    ]);
    if (re.some((f) => f.result)) restarted = true;
    else await sleep(220);
  }
  if (!restarted) return falla('no encontré "Reiniciar"');
  return true;
}

// Al terminar un quiz lee las marcas ✓/✗ (con "Revisar la evaluación" si existe) y las guarda
async function harvestReview(tabId) {
  const leidas = [];
  const seenQ = new Map();
  const keyOf = (q) =>
    `${nrm(q.pregunta)}::${optsSigOf(q.opciones.map((x) => x.texto))}`;
  const isComplete = (q) =>
    q.type === "objectMatching"
      ? (q.pairs?.length || 0) >= 2
      : q.opciones.some((o) => o.estado);
  const pushUniq = (arr) => {
    let completeAdded = 0;
    for (const q of arr || []) {
      const k = keyOf(q);
      const prevIdx = seenQ.get(k);
      if (prevIdx === undefined) {
        seenQ.set(k, leidas.length);
        leidas.push(q);
        if (isComplete(q)) completeAdded++;
      } else if (!isComplete(leidas[prevIdx]) && isComplete(q)) {
        leidas[prevIdx] = q;
        completeAdded++;
      }
    }
    return completeAdded;
  };
  let hasReviewBtn = false;
  try {
    const clic = await execAll(tabId, ccnaReviewClick);
    hasReviewBtn = clic.some((f) => f.result);
    const espera = hasReviewBtn ? 22 : 4;
    let btnCount = 0;
    let lastCount = -1;
    let stableTicks = 0;
    for (let i = 0; i < espera; i++) {
      await sleep(150);
      const r = await execAll(tabId, ccnaReviewHarvest);
      pushUniq(r.flatMap((f) => f.result || []));
      const counts = await execAll(tabId, ccnaReviewNav, ["count", 0]);
      btnCount = Math.max(0, ...counts.map((c) => Number(c.result) || 0));
      if (!hasReviewBtn && leidas.length) break;
      if (btnCount > 1) {
        if (btnCount === lastCount) stableTicks++;
        else {
          lastCount = btnCount;
          stableTicks = 0;
        }
        if (stableTicks >= 2) break;
      } else if (leidas.length && i >= 6) {
        break;
      }
    }
    if (btnCount > 1) {
      for (let idx = 0; idx < btnCount && !abort; idx++) {
        await execAll(tabId, ccnaReviewNav, ["click", idx]);
        for (let w = 0; w < 8; w++) {
          await sleep(90);
          const r = await execAll(tabId, ccnaReviewHarvest);
          const completeAdded = pushUniq(r.flatMap((f) => f.result || []));
          if (completeAdded > 0) break;
        }
      }
    }
    if (hasReviewBtn) {
      await execAll(tabId, ccnaCloseReview);
      await sleep(180);
    }
  } catch {}
  if (!leidas.length) {
    await log("  revisión: no se pudo leer");
    return false;
  }
  const o = await chrome.storage.local.get([VERIFIED, WRONG]);
  const verified = o[VERIFIED] || {};
  const wrong = o[WRONG] || {};
  let buenas = 0;
  let malas = 0;
  for (const q of leidas) {
    const sig = optsSigOf(q.opciones.map((x) => x.texto));
    const text = nrm(q.pregunta);
    if (q.type === "objectMatching") {
      if (q.pairs?.length >= 2) {
        verified[sig] = [
          ...(verified[sig] || []).filter((e) => e.text !== text),
          { text, pairs: q.pairs },
        ];
        buenas++;
      } else {
        malas++;
      }
      continue;
    }
    const c = q.opciones.filter((x) => x.estado === "c").map((x) => x.texto);
    const i = q.opciones.filter((x) => x.estado === "i").map((x) => x.texto);
    const completa = q.opciones.every((x) => x.estado);
    if (completa ? c.length : c.length && !i.length) {
      verified[sig] = [
        ...(verified[sig] || []).filter((e) => e.text !== text),
        { text, correct: c },
      ];
      buenas++;
    } else if (i.length) {
      const prev = (wrong[sig] || []).find((e) => e.text === text)?.wrong || [];
      wrong[sig] = [
        ...(wrong[sig] || []).filter((e) => e.text !== text),
        { text, wrong: [...new Set([...prev, ...i])] },
      ];
      malas++;
    }
  }
  await chrome.storage.local.set({ [VERIFIED]: verified, [WRONG]: wrong });
  await log(
    `  revisión: ${buenas} correctas guardadas, ${malas} incorrectas por reintentar`,
  );
  return { ok: true, buenas, malas };
}

/* HTML de la página con el contenido de los shadow roots, para ver cómo marca NetAcad cada pregunta */
function ccnaDeepHTML() {
  const LIM = 400000;
  let out = "";
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const walk = (n, d) => {
    if (out.length > LIM) return;
    if (n.nodeType === 3) {
      const t = n.textContent.replace(/\s+/g, " ").trim();
      if (t) out += "  ".repeat(d) + esc(t) + "\n";
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11) return;
    if (
      n.nodeType === 1 &&
      /^(SCRIPT|STYLE|NOSCRIPT|LINK|META)$/.test(n.tagName)
    )
      return;
    const tag = n.nodeType === 11 ? "#shadow" : n.tagName.toLowerCase();
    const attrs =
      n.nodeType === 1
        ? [...n.attributes]
            .filter(
              (a) =>
                !/^(style|d|points|transform|viewbox|xmlns.*)$/i.test(a.name),
            )
            .map((a) => ` ${a.name}="${esc(a.value.slice(0, 120))}"`)
            .join("")
        : "";
    out += `${"  ".repeat(d)}<${tag}${attrs}>\n`;
    if (tag === "svg" || tag === "path") return;
    if (n.shadowRoot) walk(n.shadowRoot, d + 1);
    for (const c of n.childNodes) walk(c, d + 1);
  };
  walk(document.body || document.documentElement, 0);
  return { url: location.href, html: out.slice(0, LIM) };
}

/* ---------- mensajes ---------- */
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg?.type === "STOP") {
    abort = true;
    stop("Detenido por el usuario.");
    send({ ok: true });
    return;
  }
  if (msg?.type !== "START") return;

  if (msg.mode === "test") {
    (async () => {
      const out = { at: Date.now(), ok: false, text: "Probando…" };
      try {
        Object.assign(out, await testKey());
      } catch (e) {
        out.text = e.message;
      }
      await chrome.storage.local.set({ [TEST]: out });
      send({ ok: out.ok, error: out.ok ? "" : out.text });
    })();
    return true;
  }

  if (running) {
    send({ error: "Ya hay una tarea en curso." });
    return;
  }
  running = true;
  abort = false;
  setState({
    running: true,
    error: false,
    reason: "",
    log: [],
    page: "",
    label: "Iniciando",
  });

  (async () => {
    try {
      const cfg = await getCfg();
      if (!["notes", "diag", "quizzes"].includes(msg.mode) && !cfg.apiKey)
        throw new Error("Falta la API key.");

      if (msg.mode === "notes") await runWalk();
      else if (msg.mode === "quizzes") await runQuizzes();
      else if (msg.mode === "explain") await runExplain();
      else if (msg.mode === "diag") {
        const tab = await activeTab();
        await dumpDiag(tab.id, `diagnostico-${Date.now()}.md`);
        stop("Diagnóstico guardado.");
      }
      send({ ok: true });
    } catch (e) {
      stop(e.message, true);
      send({ error: e.message });
    } finally {
      running = false;
    }
  })();
  return true;
});
