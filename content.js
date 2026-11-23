/* Extracción de contenido, índice lateral, avance y diagnóstico. Corre en todos los frames. */
(() => {
  if (window.__ccna) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  function deepAll(sel, root = document) {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  }
  function deepText(root = document.body) {
    if (!root) return "";
    let t = root.innerText || "";
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) t += " " + deepText(el.shadowRoot);
    return t;
  }

  const COOKIE_SEL =
    '#onetrust-consent-sdk, [id*="cookie" i], [class*="cookie" i], [aria-label*="cookie" i]';
  const isCookie = (el) => {
    if (el.closest(COOKIE_SEL)) return true;
    const dlg = el.closest('[role="dialog"]');
    return !!dlg && /cookie/i.test(norm(dlg.innerText).slice(0, 300));
  };

  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "NAV",
    "HEADER",
    "FOOTER",
    "BUTTON",
    "IFRAME",
    "SVG",
    "CANVAS",
    "TEMPLATE",
  ]);
  const SKIP_RE =
    /(sidebar|side-nav|sidenav|toc|index-nav|breadcrumb|menu|nav-|player-controls|assessment-nav|cookie)/i;
  const isChrome = (el) =>
    SKIP_RE.test(el.id || "") ||
    SKIP_RE.test(el.className?.toString?.() || "") ||
    el.getAttribute("role") === "navigation" ||
    el.tagName === "ASIDE" ||
    isCookie(el);

  function tableToMd(tbl) {
    const rows = [...tbl.querySelectorAll("tr")].map((tr) =>
      [...tr.children].map((td) => norm(td.innerText).replace(/\|/g, "\\|")),
    );
    if (!rows.length) return "";
    const w = Math.max(...rows.map((r) => r.length));
    const pad = (r) => {
      const c = [...r];
      while (c.length < w) c.push("");
      return c;
    };
    const head = pad(rows[0]);
    return (
      "\n\n| " +
      head.join(" | ") +
      " |\n| " +
      head.map(() => "---").join(" | ") +
      " |\n" +
      rows
        .slice(1)
        .map((r) => "| " + pad(r).join(" | ") + " |")
        .join("\n") +
      "\n\n"
    );
  }

  function walk(node, out, depth) {
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/\s+/g, " ");
      if (t.trim()) out.push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP_TAGS.has(el.tagName) || isChrome(el)) return;
    if (el.shadowRoot) walk(el.shadowRoot, out, depth);
    if (el.tagName === "SLOT" && el.assignedNodes) {
      for (const n of el.assignedNodes()) walk(n, out, depth);
      return;
    }
    if (el.tagName === "BR") {
      out.push("\n");
      return;
    }
    if (el.tagName === "IMG") {
      out.push(`\n\n[Imagen: ${el.alt || "sin texto"}]\n\n`);
      return;
    }
    if (/^H[1-6]$/.test(el.tagName)) {
      out.push("\n\n" + "#".repeat(+el.tagName[1]) + " ");
      for (const n of el.childNodes) walk(n, out, depth);
      out.push("\n\n");
      return;
    }
    if (el.tagName === "PRE") {
      out.push("\n\n```\n" + el.innerText.replace(/\n+$/, "") + "\n```\n\n");
      return;
    }
    if (el.tagName === "CODE" && el.parentElement?.tagName !== "PRE") {
      out.push("`" + norm(el.innerText) + "`");
      return;
    }
    if (el.tagName === "TABLE") {
      out.push(tableToMd(el));
      return;
    }
    if (el.tagName === "LI") {
      out.push("\n" + "  ".repeat(Math.max(0, depth)) + "- ");
      for (const n of el.childNodes) walk(n, out, depth + 1);
      out.push("\n");
      return;
    }
    const block =
      /^(P|DIV|SECTION|ARTICLE|UL|OL|DL|DD|DT|FIGURE|FIGCAPTION|MAIN|BODY|TD|TH|FORM|FIELDSET|LEGEND)$/.test(
        el.tagName,
      );
    if (block) out.push("\n\n");
    for (const n of el.childNodes) walk(n, out, depth);
    if (block) out.push("\n\n");
  }

  function toMarkdown(root) {
    const out = [];
    walk(root, out, 0);
    return out
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  // Menús, índice lateral y barras no son contenido: no se recorren
  const NAV =
    'nav, header, [role="tree"], [role="navigation"], [class*="sidebar" i], [class*="outline" i], [class*="drawer" i]';

  async function scrollEverything() {
    const page = document.scrollingElement;
    const cs = [
      ...(page && page.scrollHeight > page.clientHeight + 40 ? [page] : []),
      ...deepAll("*").filter(
        (el) =>
          el.scrollHeight > el.clientHeight + 40 &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
          !el.closest(NAV),
      ),
    ]
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
      .slice(0, 5);
    for (const c of cs) {
      const step = Math.max(200, c.clientHeight * 0.7);
      for (let y = 0; y <= c.scrollHeight && y < 30000; y += step) {
        c.scrollTop = y;
        await sleep(150);
      }
    }
    // Cada sección en pantalla un momento, para que NetAcad la cuente como vista
    const secciones = deepAll('.component, [class*="component__inner"]')
      .filter((el) => !el.closest(NAV) && el.getClientRects().length)
      .slice(0, 60);
    for (const el of secciones) {
      el.scrollIntoView({ behavior: "instant", block: "center" });
      await sleep(200);
    }
    for (const c of cs) c.scrollTop = 0;
    await sleep(150);
  }

  async function expandAll() {
    for (const t of deepAll('[role="tab"]').filter(
      (x) => x.getAttribute("aria-selected") !== "true",
    )) {
      try {
        t.click();
        await sleep(400);
      } catch {}
    }
    for (const a of deepAll('[aria-expanded="false"]').filter(
      (el) => el.tagName === "BUTTON" || el.getAttribute("role") === "button",
    )) {
      try {
        a.click();
        await sleep(180);
      } catch {}
    }
  }

  async function videoPass() {
    const lines = [];
    for (const v of deepAll("video")) {
      try {
        v.muted = true;
        for (const t of v.textTracks) t.mode = "showing";
        try {
          await v.play();
        } catch {}
        if (isFinite(v.duration) && v.duration > 3) {
          v.scrollIntoView?.({ behavior: "instant", block: "center" });
          v.currentTime = Math.max(0, v.duration - 1.5);
          for (let i = 0; i < 20 && !v.ended; i++) await sleep(150);
        }
        for (const t of v.textTracks)
          for (const c of t.cues ? [...t.cues] : []) {
            const txt = norm(c.text);
            if (txt && !lines.includes(txt)) lines.push(txt);
          }
        v.pause();
      } catch {}
    }
    return lines.length
      ? "\n\n### Transcripción del video\n\n" + lines.join("\n") + "\n"
      : "";
  }

  window.__ccna = {
    async extract(expand) {
      if (expand) {
        await expandAll();
        await scrollEverything();
      }
      return (toMarkdown(document.body) + (await videoPass())).trim();
    },
    size() {
      return deepText().length;
    },
    docTitle() {
      return norm(document.title).slice(0, 200);
    },
    title() {
      const REJECT =
        /^(content|gradebook|inicio|home|curso|course|netacad|contenido|calificaciones)$/i;
      const COURSE = /^CCNA:|Ver\.\s?\d/i;

      const block = deepAll('[class*="blockName"], [class*="block-name"]').find(
        (el) => {
          const t = norm(el.getAttribute("title") || el.innerText);
          return t && t.length < 160 && /^\d+\.\d+/.test(t);
        },
      );
      if (block) return norm(block.getAttribute("title") || block.innerText);

      for (const el of deepAll("h1,h2,h3")) {
        if (isChrome(el)) continue;
        const t = norm(el.innerText);
        if (t && t.length < 160 && /^\d+\.\d+/.test(t) && !REJECT.test(t))
          return t;
      }

      const geo = deepAll("div,span,header *").filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r || r.top > 150 || r.width < 40) return false;
        const t = norm(el.innerText);
        return (
          t &&
          t.length < 160 &&
          !REJECT.test(t) &&
          /^\d+\.\d+(\.\d+)?\s+\S/.test(t)
        );
      });
      geo.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
      if (geo[0]) return norm(geo[0].innerText);

      const outline = deepAll(
        '[role="tree"] [aria-selected="true"], [class*="outline"] [class*="active"], [class*="nav"] [class*="active"], li.active a, .active a, a.active',
      )
        .map((el) => norm(el.innerText))
        .filter(
          (t) => t && t.length < 160 && !REJECT.test(t) && !COURSE.test(t),
        );
      if (outline[0]) return outline[0];

      const dt = norm(document.title);
      const marked = dt.match(
        /(verifique su comprensi[oó]n|compruebe su comprensi[oó]n|quiz del m[oó]dulo|punto de control|checkpoint|examen[^|]{0,40})/i,
      );
      if (marked) return dt.slice(marked.index, marked.index + 100).trim();
      return "";
    },
    heading() {
      const h = deepAll('h1,h2,legend,[class*="questionTitle"]').find(
        (el) => !isCookie(el) && !isChrome(el),
      );
      return norm(h?.innerText).slice(0, 160);
    },
    // Estado del quiz/submódulo actual en el esquema del curso (solo existe en el frame superior)
    outlineStatus(hintTitle = "") {
      const items = [...document.querySelectorAll('[role="treeitem"]')];
      if (!items.length) return null;
      const QUIZ_RE =
        /verifique su comprensi[oó]n|compruebe su comprensi[oó]n|check your understanding|quiz del m[oó]dulo|module quiz|examen|exam|prueba de mi conocimiento|checkpoint|punto de control|midterm|final|pre-?certificaci[oó]n|assessment/i;
      const isDone = (el) =>
        [...el.querySelectorAll("img[alt]")].some((i) =>
          /complet/i.test(i.getAttribute("alt") || ""),
        );

      // 1) Si el elemento activo en el esquema ES el propio quiz, usar su estado directo
      const act = items.find(
        (el) =>
          /blockContainer/.test(el.className || "") &&
          /active/.test(el.className || ""),
      );
      if (act && QUIZ_RE.test(norm(act.innerText))) {
        return {
          status: isDone(act) ? "completed" : "in-progress",
          title: norm(act.innerText).slice(0, 160),
        };
      }

      // 2) Identificar el submódulo actual (p. ej. "12.6.") a partir del título o del bloque activo
      const subMatch =
        norm(hintTitle).match(/\b(\d+\.\d+)\b/) ||
        norm(document.title).match(/\b(\d+\.\d+)\b/) ||
        (act && norm(act.innerText).match(/^(\d+\.\d+)\b/));
      if (subMatch) {
        const subNum = subMatch[1];
        const subRe = new RegExp(
          "^" + subNum.replace(/\./g, "\\.") + "(?:\\.|\\s|$)",
        );
        const subBtn = items.find(
          (el) =>
            /subModuleBtn/.test(el.className || "") &&
            subRe.test(norm(el.innerText)),
        );
        if (subBtn && isDone(subBtn)) {
          return {
            status: "completed",
            title: norm(subBtn.innerText).slice(0, 160),
          };
        }
        const quizBlocks = items.filter(
          (el) =>
            /blockContainer/.test(el.className || "") &&
            subRe.test(norm(el.innerText)) &&
            QUIZ_RE.test(norm(el.innerText)),
        );
        if (quizBlocks.length) {
          const allDone = quizBlocks.every(isDone);
          return {
            status: allDone ? "completed" : "in-progress",
            title: norm(quizBlocks[0].innerText).slice(0, 160),
          };
        }
        if (subBtn) {
          return {
            status: "in-progress",
            title: norm(subBtn.innerText).slice(0, 160),
          };
        }
      }

      // 3) Exámenes independientes (Checkpoint Exam, Final Exam, etc.)
      // Usar el nodo expandido/activo o el título específico completo (evitar coincidir con "Checkpoint Exam" genérico)
      const activeNode = items.find(
        (el) =>
          /nodeInfoContainer/.test(el.className || "") &&
          (el.getAttribute("aria-expanded") === "true" ||
            /active/.test(el.className || "")) &&
          QUIZ_RE.test(norm(el.innerText)),
      );
      const rawName = norm(hintTitle.split("|")[0] || "").toLowerCase();
      const specificName =
        rawName.length > 20 && !/^checkpoint exam$/i.test(rawName)
          ? rawName
          : "";
      const node =
        activeNode ||
        (specificName
          ? items.find(
              (el) =>
                /nodeInfoContainer/.test(el.className || "") &&
                norm(el.innerText).toLowerCase().includes(specificName),
            )
          : null);
      if (node) {
        const txt = norm(node.innerText);
        const done = isDone(node) || /\b(?:[789]\d|100)%/.test(txt);
        return { status: done ? "completed" : "in-progress", title: txt.slice(0, 160) };
      }

      return null;
    },
    sessionLost() {
      return /vuelva a iniciar el curso|restart the course|sesión expirada|session expired/i.test(
        deepText(),
      );
    },
    pageSignature() {
      return norm(deepText()).slice(0, 400);
    },
  };
})();
