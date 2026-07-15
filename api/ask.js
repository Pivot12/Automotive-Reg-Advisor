// Serverless endpoint: POST /api/ask  { question: string }
// RAG over LIVE official sources. Retrieval strategy (robust, no-fabrication):
//   0. Explicit UN/ECE regulation numbers (e.g. "R160") route to the official UNECE document page
//      via data/regs_index.json, then hop to the regulation PDF text via Jina Reader.
//   1. If TAVILY_API_KEY set: Tavily search restricted to the official domains for the question's
//      region/topic (bypasses gov-site bot-blocking, returns clean extracted content). Falls back to
//      an unrestricted Tavily search if the domain-scoped one is thin.
//   2. Keyless fallback: direct fetch (browser UA) -> Jina Reader, per routed source.
//   3. If nothing is retrieved, the model is told to SAY SO and point to the authority — never invent.
// LLM: Cerebras free-tier (gpt-oss-120b) by default; any OpenAI-compatible endpoint via env.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.cerebras.ai/v1";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-oss-120b";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.CEREBRAS_API_KEY || "";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || ""; // free 1,000/mo — the reliability win
const JINA_API_KEY = process.env.JINA_API_KEY || "";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || ""; // optional extra scrape fallback
const MAX_SOURCES = 4;
const MAX_DOCS = 6;
const MAX_CHARS_PER_DOC = 4000;
const MAX_CHARS_PDF = 8000; // regulation PDFs carry the actual requirements — keep more

function loadSources() {
  return JSON.parse(readFileSync(join(__dirname, "..", "data", "sources.json"), "utf-8"));
}

function loadRegsIndex() {
  try { return JSON.parse(readFileSync(join(__dirname, "..", "data", "regs_index.json"), "utf-8")); }
  catch { return null; }
}

// Detect explicit UN/ECE regulation numbers: "R160", "UN R 160", "ECE-R160", "Regulation 160", "Regulation No. 160"
function detectRegNumbers(question) {
  const nums = new Set();
  const patterns = [
    /\b(?:un\s*|ece\s*[- ]?|unece\s*)?r\s?\.?\s?(\d{1,3})\b/gi,
    /\bregulation\s+(?:no\.?\s*)?(\d{1,3})\b/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(question)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 0 && n <= 200) nums.add(n);
    }
  }
  return [...nums];
}

// UNECE-specific sources for explicitly-named regulations (official doc page or addenda range page).
function regSources(question) {
  const idx = loadRegsIndex();
  if (!idx) return [];
  const out = [];
  for (const n of detectRegNumbers(question)) {
    const doc = idx.docPages && idx.docPages[String(n)];
    if (doc) { out.push({ key: `UN_R${n}`, name: doc.name, url: doc.url }); continue; }
    const range = (idx.rangePages || []).find((r) => n >= r.min && n <= r.max);
    if (range) out.push({ key: `UN_R${n}`, name: `UNECE Addenda page listing UN Regulation No. ${n}`, url: range.url });
  }
  return out;
}

// Match routing keys on word boundaries — plain substring matching wrongly fired
// e.g. topic "ev" inside "event", region "us" inside "trust".
function matchesKey(q, key) {
  return new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(q);
}

function pickSources(question, cfg) {
  const q = question.toLowerCase();
  const keys = new Set();
  for (const [region, list] of Object.entries(cfg.regionRouting)) if (matchesKey(q, region)) list.forEach((k) => keys.add(k));
  for (const [topic, list] of Object.entries(cfg.topicRouting)) if (matchesKey(q, topic)) list.forEach((k) => keys.add(k));
  if (keys.size === 0) cfg.defaultSources.forEach((k) => keys.add(k));
  const routed = [...keys].slice(0, MAX_SOURCES).map((k) => ({ key: k, ...cfg.sources[k] })).filter((s) => s.url);
  // Regulation-number sources go FIRST — they are the most specific official pages.
  const regs = regSources(question);
  const seen = new Set(regs.map((s) => s.url));
  return [...regs, ...routed.filter((s) => !seen.has(s.url))].slice(0, MAX_SOURCES + regs.length);
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function looksBlocked(text) {
  if (!text || text.length < 200) return true;
  const t = text.slice(0, 400).toLowerCase();
  return /access denied|forbidden|403|enable javascript|are you a human|captcha/.test(t);
}

// ---- Retrieval path 1: Tavily (reliable, bypasses blocking) ----
async function tavilySearch(question, domains) {
  const body = {
    api_key: TAVILY_API_KEY,
    query: question,
    search_depth: "advanced",
    max_results: MAX_DOCS,
    include_answer: false,
    include_raw_content: false,
  };
  if (domains && domains.length) body.include_domains = domains;
  const r = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 9000);
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  return (data.results || [])
    .filter((x) => x && x.content)
    .map((x) => ({ name: x.title || hostOf(x.url), url: x.url, text: (x.content || "").slice(0, MAX_CHARS_PER_DOC) }));
}

// ---- Retrieval path 2 (keyless fallback): direct fetch -> Jina Reader ----
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
async function directFetch(url) {
  try {
    const r = await fetchWithTimeout(url, { headers: { "User-Agent": BROWSER_UA, "Accept": "text/html" } }, 8000);
    if (!r.ok) return null;
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return looksBlocked(text) ? null : text.slice(0, MAX_CHARS_PER_DOC);
  } catch { return null; }
}
async function jinaFetch(url, maxChars = MAX_CHARS_PER_DOC) {
  try {
    const headers = { "X-Return-Format": "markdown" };
    if (JINA_API_KEY) headers["Authorization"] = `Bearer ${JINA_API_KEY}`;
    const r = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers }, 12000);
    if (!r.ok) return null;
    const text = await r.text();
    return looksBlocked(text) ? null : text.slice(0, maxChars);
  } catch { return null; }
}
async function firecrawlFetch(url) {
  if (!FIRECRAWL_API_KEY) return null;
  try {
    const r = await fetchWithTimeout("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    }, 15000);
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const text = d?.data?.markdown || "";
    return looksBlocked(text) ? null : text.slice(0, MAX_CHARS_PER_DOC);
  } catch { return null; }
}
async function keylessRetrieve(selected) {
  const out = [];
  await Promise.all(selected.map(async (s) => {
    // For UNECE pages, Jina first — it returns markdown WITH the PDF links pdfHop needs.
    const preferJina = /unece\.org/.test(s.url);
    const text = preferJina
      ? (await jinaFetch(s.url)) || (await directFetch(s.url)) || (await firecrawlFetch(s.url))
      : (await directFetch(s.url)) || (await jinaFetch(s.url)) || (await firecrawlFetch(s.url));
    if (text) out.push({ name: s.name, url: s.url, text });
  }));
  return out;
}

// PDF hop: UNECE document/addenda pages contain links to the actual regulation PDFs.
// Jina Reader can extract text from those PDFs — that's where the real requirements live.
async function pdfHop(docs, question) {
  const regNums = detectRegNumbers(question);
  if (!regNums.length) return docs;
  const pdfUrls = new Set();
  for (const d of docs) {
    if (!/unece\.org/.test(d.url)) continue;
    const matches = (d.text || "").match(/https?:\/\/unece\.org\/sites\/default\/files\/[^\s)"'\]]+\.pdf/gi) || [];
    for (const u of matches) {
      // Prefer PDFs whose filename mentions one of the asked reg numbers (e.g. R160e.pdf, R160r1e.pdf)
      if (regNums.some((n) => new RegExp(`R0*${n}[^0-9]`, "i").test(u.split("/").pop()))) pdfUrls.add(u);
    }
  }
  const picks = [...pdfUrls].slice(0, 2); // cap: serverless time budget
  await Promise.all(picks.map(async (u) => {
    const text = await jinaFetch(u, MAX_CHARS_PDF);
    if (text) docs.unshift({ name: `Official regulation text (PDF): ${u.split("/").pop()}`, url: u, text });
  }));
  return docs.slice(0, MAX_DOCS);
}

async function retrieve(question, selected) {
  const domains = [...new Set(selected.map((s) => hostOf(s.url)).filter(Boolean))];
  const regSpecific = selected.filter((s) => /^UN_R\d+/.test(s.key || ""));
  if (TAVILY_API_KEY) {
    let docs = await tavilySearch(question, domains);          // official-domain scoped
    if (docs.length < 2) {
      const wide = await tavilySearch(question, null);          // widen if thin
      const seen = new Set(docs.map((d) => d.url));
      for (const d of wide) if (!seen.has(d.url)) docs.push(d);
    }
    if (docs.length) {
      // Even when Tavily works, make sure explicitly-named regs get their official page + PDF text.
      if (regSpecific.length) {
        const regDocs = await keylessRetrieve(regSpecific);
        const seen = new Set(docs.map((d) => d.url));
        for (const d of regDocs) if (!seen.has(d.url)) docs.unshift(d);
        docs = await pdfHop(docs, question);
      }
      return docs.slice(0, MAX_DOCS);
    }
  }
  let docs = await keylessRetrieve(selected);                   // keyless fallback
  docs = await pdfHop(docs, question);                          // pull actual regulation PDF text
  return docs;
}

async function askLLM(question, docs) {
  const context = docs.map((d, i) => `[Source ${i + 1}] ${d.name} (${d.url})\n${d.text}`).join("\n\n---\n\n");
  const system =
    "You are an automotive regulatory research assistant. Use ONLY the provided official sources to answer. " +
    "Cite sources inline as [Source N]. If the sources DO contain the answer, answer fully and specifically. " +
    "If they do NOT contain enough to answer, say exactly what is missing and name the official body/standard to consult — " +
    "NEVER invent regulation numbers, dates, thresholds, or standard codes. End with a one-line reminder to verify with the official authority.";
  const r = await fetchWithTimeout(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL, temperature: 0.1, max_tokens: 1200,
      messages: [{ role: "system", content: system }, { role: "user", content: `Question: ${question}\n\nOfficial sources:\n${context}` }],
    }),
  }, 9000);
  if (!r.ok) throw new Error(`LLM error ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() || "No answer generated.";
}

function logEvent(req, payload) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  const row = {
    type: "query", app: "Auto Reg Advisor", ts: new Date().toISOString(),
    country: req.headers["x-vercel-ip-country"] || "", region: req.headers["x-vercel-ip-country-region"] || "",
    city: req.headers["x-vercel-ip-city"] || "", ua: (req.headers["user-agent"] || "").slice(0, 200), ...payload,
  };
  fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(row) }, 3000).catch(() => {});
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }
  if (!LLM_API_KEY) { res.status(500).json({ error: "Server missing LLM_API_KEY (set CEREBRAS_API_KEY)." }); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const question = (body.question || "").toString().trim();
    if (!question) { res.status(400).json({ error: "Missing 'question'." }); return; }

    const cfg = loadSources();
    const selected = pickSources(question, cfg);
    const docs = await retrieve(question, selected);

    if (!docs.length) {
      logEvent(req, { question, sources: "", status: "no_retrieval", answer_chars: 0 });
      res.status(200).json({
        answer: "I couldn't retrieve the official source text right now (some authorities block automated reads). I won't guess — please try again shortly, or check the authority directly.",
        sources: selected.map((s) => ({ name: s.name, url: s.url })),
      });
      return;
    }

    const answer = await askLLM(question, docs);
    logEvent(req, { question, sources: docs.map((d) => hostOf(d.url)).join("|"), status: "ok", answer_chars: answer.length });
    res.status(200).json({ answer, sources: docs.map((d) => ({ name: d.name, url: d.url })) });
  } catch (err) {
    res.status(200).json({ answer: `System error while researching: ${err.message}. Please try again.`, sources: [] });
  }
}
