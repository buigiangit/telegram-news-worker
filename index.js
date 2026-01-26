import "dotenv/config";
import fetch from "node-fetch";
import Parser from "rss-parser";
import cron from "node-cron";
import Database from "better-sqlite3";
import crypto from "crypto";

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Tắt OpenAI theo CÁCH 2 (không dùng AI)
const OPENAI_API_KEY = ""; // cố định rỗng để không gọi OpenAI

const NEWS_CRON = process.env.NEWS_CRON || "*/10 * * * *"; // mỗi 10 phút
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS || "10", 10); // tối đa 10 tin/post
const MIN_ITEMS = parseInt(process.env.MIN_ITEMS || "5", 10);  // ít nhất 5 tin mới gửi

if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error("Missing BOT_TOKEN or CHAT_ID");
}

// ================= RSS SOURCES =================
const RSS_SOURCES = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" }
];

// ================= HELPERS =================
const parser = new Parser({ timeout: 15000 });

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function safeText(s, max = 280) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// Lọc nhanh bằng keyword để tránh spam tin không liên quan
const KEYWORDS = [
  "bitcoin","btc","ethereum","eth","solana","sol","xrp","bnb","doge","crypto","cryptocurrency",
  "etf","sec","fed","binance","coinbase","hack","exploit","airdrop","on-chain","onchain","layer 2","l2"
];

function ruleRelevant(title, content) {
  const s = (title + " " + content).toLowerCase();
  return KEYWORDS.some(k => s.includes(k));
}

// ================= GOOGLE TRANSLATE (FREE) =================
async function translateToVi(text) {
  const t = safeText(text, 800);
  if (!t) return "";

  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=auto&tl=vi&dt=t&q=" +
    encodeURIComponent(t);

  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return t;

    const data = await res.json();
    const translated = (data?.[0] || [])
      .map(seg => seg?.[0])
      .filter(Boolean)
      .join("");

    return translated || t;
  } catch {
    return t;
  }
}

// ================= DB DEDUPE =================
const db = new Database("./newsbot.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_hash TEXT UNIQUE,
    url TEXT,
    title TEXT,
    source TEXT,
    published_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
const stmtHas = db.prepare("SELECT 1 FROM posted WHERE url_hash=?");
const stmtIns = db.prepare("INSERT INTO posted(url_hash,url,title,source,published_at) VALUES (?,?,?,?,?)");

// ================= TELEGRAM =================
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  return data;
}

// ================= (AI) FALLBACK STUB =================
// Giữ cấu trúc để không cần sửa nhiều chỗ khác
async function aiFilterAndSummarizeBatch(items) {
  // OPENAI_API_KEY bị ép rỗng => luôn fallback
  if (!OPENAI_API_KEY) {
    return items.map((_, idx) => ({
      idx,
      isRelevant: true,      // ruleRelevant đã lọc ở trước
      coins: [],
      sentiment: "neutral",
      impact: "medium",
      summary_vi: "",
      key_points: []
    }));
  }
  return items.map((_, idx) => ({ idx, isRelevant: true }));
}

// ================= FORMAT TELE POST =================
function buildTelegramPost(items) {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();

  let text = `❇️ TỔNG HỢP TIN CRYPTO | ${dd}/${mm}/${yyyy}\n`;

  items.forEach((it, i) => {
    const impactIcon = it.ai?.impact === "high" ? "🔥" : it.ai?.impact === "low" ? "🟢" : "🟡";

    const titleShow = it.title_vi || it.title;
    const snippetShow = it.snippet_vi || it.contentSnippet || "";

    text += `\n🔹 ${i + 1}) <b>${safeText(titleShow, 140)}</b>\n`;
    text += `👉 Nguồn: ${it.source} ${impactIcon}\n`;

    if (snippetShow) text += `👉 Tóm tắt: ${safeText(snippetShow, 260)}\n`;

    text += `👉 Link: ${it.link}\n`;
  });

  text += `\n🔹 Lưu ý: Tin tức chỉ mang tính tham khảo, không phải lời khuyên đầu tư.`;
  return text;
}

// ================= CORE JOB =================
async function fetchAllRss() {
  const all = [];
  for (const s of RSS_SOURCES) {
    try {
      const feed = await parser.parseURL(s.url);
      const items = (feed.items || []).map(it => ({
        title: it.title || "",
        link: it.link || "",
        contentSnippet: it.contentSnippet || it.summary || "",
        content: it.content || "",
        publishedAt: it.isoDate || it.pubDate || "",
        source: s.name
      }));
      all.push(...items);
    } catch (e) {
      console.error(`[RSS] Fail ${s.name}:`, e.message);
    }
  }
  return all;
}

function pickCandidates(raw) {
  const seen = new Set();
  const out = [];

  for (const it of raw) {
    if (!it.link || seen.has(it.link)) continue;
    seen.add(it.link);

    const h = sha1(it.link);
    if (stmtHas.get(h)) continue;

    if (!ruleRelevant(it.title, it.contentSnippet || it.content)) continue;

    out.push({ ...it, urlHash: h });
  }

  out.sort((a, b) => (new Date(b.publishedAt).getTime() || 0) - (new Date(a.publishedAt).getTime() || 0));
  return out.slice(0, MAX_ITEMS * 2);
}

async function runNewsJob() {
  const raw = await fetchAllRss();
  const candidates = pickCandidates(raw);

  if (candidates.length === 0) return { sent: false, reason: "no_candidates" };

  const batch = candidates.slice(0, MAX_ITEMS);
  const aiResults = await aiFilterAndSummarizeBatch(batch);

  const picked = [];
  for (let i = 0; i < batch.length; i++) {
    const ai = aiResults[i];
    if (!ai || ai.isRelevant !== true) continue;
    picked.push({ ...batch[i], ai });
    if (picked.length >= MAX_ITEMS) break;
  }

  if (picked.length < MIN_ITEMS) {
    return { sent: false, reason: "not_enough_relevant", count: picked.length };
  }

  // Dịch title + snippet sang VI (chạy tuần tự để tránh rate-limit)
  for (const it of picked) {
    it.title_vi = await translateToVi(it.title);
    const snippet = it.contentSnippet || it.content || "";
    it.snippet_vi = await translateToVi(snippet);
  }

  const post = buildTelegramPost(picked);
  await sendTelegramMessage(post);

  // mark posted
  const tx = db.transaction((arr) => {
    for (const it of arr) {
      try { stmtIns.run(it.urlHash, it.link, it.title, it.source, it.publishedAt || ""); } catch {}
    }
  });
  tx(picked);

  return { sent: true, count: picked.length };
}

// ================= RUN =================
console.log(`[NEWS] Worker started. Cron=${NEWS_CRON}`);

cron.schedule(NEWS_CRON, async () => {
  try {
    const r = await runNewsJob();
    console.log("[NEWS]", r);
  } catch (e) {
    console.error("[NEWS] Error:", e.message);
  }
});

// Chạy ngay 1 phát lúc start để test
(async () => {
  try {
    const r = await runNewsJob();
    console.log("[NEWS] First run:", r);
  } catch (e) {
    console.error("[NEWS] First run error:", e.message);
  }
})();
