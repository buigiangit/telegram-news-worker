import "dotenv/config";
import fetch from "node-fetch";
import Parser from "rss-parser";
import cron from "node-cron";
import Database from "better-sqlite3";
import crypto from "crypto";

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const NEWS_CRON = process.env.NEWS_CRON || "*/10 * * * *";
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS || "10", 10);
const MIN_ITEMS = parseInt(process.env.MIN_ITEMS || "5", 10);

const TA_SYMBOL = process.env.TA_SYMBOL || "BTCUSDT";

// ===== On-chain / Intermarket (BTC + Gold/Silver) =====
const ONCHAIN_CRON = process.env.ONCHAIN_CRON || "0 */4 * * *"; // mỗi 4 giờ, phút 0 (theo timezone bên dưới)
const CQ_ACCESS_TOKEN = process.env.CQ_ACCESS_TOKEN; // CryptoQuant Bearer token
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY;   // TwelveData API key
const CQ_EXCHANGE = process.env.CQ_EXCHANGE || "all_exchange"; // all_exchange | spot_exchange | derivative_exchange
const BTC_SYMBOL = process.env.BTC_SYMBOL || "BTCUSDT";

// TEST: 23:20 giờ VN mỗi ngày
const TA_CRON_TEST = "0 7 * * *";
const CRON_TZ = "Asia/Ho_Chi_Minh";

if (!BOT_TOKEN || !CHAT_ID) throw new Error("Missing BOT_TOKEN or CHAT_ID");

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

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return Math.round(n).toLocaleString("en-US");
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return "n/a";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtBtc(n) {
  if (!Number.isFinite(n)) return "n/a";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)} BTC`;
}

function nowVN() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CRON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const d = parts.find(p => p.type === "day")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const y = parts.find(p => p.type === "year")?.value;
  return `${d}/${m}/${y}`;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

// Keyword filter (news)
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
    const res = await fetch(url);
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

// =========================================================
// ===================== NEWS JOB ===========================
// =========================================================
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

function buildNewsPost(items) {
  const dateStr = new Date().toLocaleDateString("vi-VN");
  let text = `❇️ TỔNG HỢP TIN CRYPTO | ${dateStr}\n`;

  items.forEach((it, i) => {
    const titleShow = it.title_vi || it.title;
    const snippetShow = it.snippet_vi || it.contentSnippet || "";

    text += `\n🔹 ${i + 1}) <b>${safeText(titleShow, 140)}</b>\n`;
    text += `👉 Nguồn: ${it.source}\n`;
    if (snippetShow) text += `👉 Tóm tắt: ${safeText(snippetShow, 260)}\n`;
    text += `👉 Link: ${it.link}\n`;
  });

  text += `\n🔹 Lưu ý: Tin tức chỉ mang tính tham khảo, không phải lời khuyên đầu tư.`;
  return text;
}

async function runNewsJob() {
  const raw = await fetchAllRss();
  const candidates = pickCandidates(raw);
  if (candidates.length === 0) return { sent: false, reason: "no_candidates" };

  const picked = candidates.slice(0, MAX_ITEMS);
  if (picked.length < MIN_ITEMS) {
    return { sent: false, reason: "not_enough_relevant", count: picked.length };
  }

  // dịch title + snippet sang VI
  for (const it of picked) {
    it.title_vi = await translateToVi(it.title);
    const snippet = it.contentSnippet || it.content || "";
    it.snippet_vi = await translateToVi(snippet);
  }

  const post = buildNewsPost(picked);
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

// =========================================================
// ===================== TA JOB =============================
// =========================================================
async function fetchKlines(symbol, interval, limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines error: ${await res.text()}`);
  const data = await res.json();
  return data.map(k => ({
    time: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(values, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  const out = new Array(values.length).fill(null);
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function atr(candles, period = 14) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(candles.length).fill(null);
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    const curTR = tr[i - 1];
    prev = (prev * (period - 1) + curTR) / period;
    out[i] = prev;
  }
  return out;
}

// Vùng hỗ trợ/kháng cự 2 tầng từ swing lookback
function swingLevels(candles, lookback = 60) {
  const slice = candles.slice(-lookback);
  const highs = slice.map(x => x.high);
  const lows = slice.map(x => x.low);

  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const lastClose = candles[candles.length - 1].close;

  const r1 = hi;
  const r2 = (hi + lastClose) / 2;
  const s1 = lo;
  const s2 = (lo + lastClose) / 2;

  const resist = [r2, r1].sort((a, b) => a - b);
  const support = [s2, s1].sort((a, b) => b - a);

  return { resist, support };
}

// Chấm điểm PA 0–10 (đơn giản, ổn định)
function scorePriceAction({ close, ema50, rsi14, atr14, h4Trend }) {
  let score = 5;

  if (close > ema50) score += 2;
  else score -= 2;

  if (rsi14 >= 60) score += 1.5;
  else if (rsi14 <= 40) score -= 1.5;

  const volPct = atr14 ? (atr14 / close) * 100 : 0;
  if (volPct >= 6) score -= 1;
  else if (volPct <= 3) score += 0.5;

  if (h4Trend === "up") score += 1;
  if (h4Trend === "down") score -= 1;

  return clamp(score, 0, 10);
}

// Trạng thái thị trường: Tích lũy/Phân phối/Breakout/Breakdown
function detectMarketState(d1Candles, ema50D, atrD) {
  const last = d1Candles[d1Candles.length - 1];
  const slice = d1Candles.slice(-20);

  const highs = slice.map(x => x.high);
  const lows = slice.map(x => x.low);

  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);

  const range = maxHigh - minLow;
  const rangePct = (range / last.close) * 100;
  const atrPct = atrD ? (atrD / last.close) * 100 : 0;

  const ema20Series = ema(d1Candles.map(x => x.close), 20);
  const ema20Now = ema20Series.at(-1);
  const ema20Prev = ema20Series.at(-6);
  const slopePct = ema20Prev ? ((ema20Now - ema20Prev) / ema20Prev) * 100 : 0;

  const body = Math.abs(last.close - last.open);
  const bodyPct = (body / last.close) * 100;

  if (last.close >= maxHigh * 0.998 && bodyPct >= 0.6) {
    return { state: "BREAKOUT", note: "Giá đóng cửa tiệm cận/vượt đỉnh 20 phiên, thân nến rõ" };
  }
  if (last.close <= minLow * 1.002 && bodyPct >= 0.6) {
    return { state: "BREAKDOWN", note: "Giá đóng cửa tiệm cận/thủng đáy 20 phiên, thân nến rõ" };
  }

  const emaFlat = Math.abs(slopePct) <= 0.35;
  const tightRange = rangePct <= 6.0;
  const lowVol = atrPct <= 3.5;

  if ((tightRange && emaFlat) || (tightRange && lowVol)) {
    return { state: "TÍCH LŨY", note: "Biên độ hẹp, EMA phẳng/biến động thấp → ưu tiên chờ phá vỡ" };
  }

  const aboveEma = last.close >= ema50D;
  const atrRising = atrPct >= 4.0;
  const emaWeak = slopePct < 0.1;

  if (aboveEma && emaWeak && atrRising) {
    return { state: "PHÂN PHỐI", note: "Động lượng yếu dần, biến động tăng → dễ nhiễu/giật 2 chiều" };
  }

  return { state: "TRUNG TÍNH", note: "Chưa có mẫu hình rõ ràng, ưu tiên phản ứng tại vùng" };
}

function buildDailyTA({ symbol, d1, h4 }) {
  const dateStr = new Date().toLocaleDateString("vi-VN");

  const dClose = d1[d1.length - 1].close;
  const dCloses = d1.map(x => x.close);

  const ema20D = ema(dCloses, 20).at(-1);
  const ema50D = ema(dCloses, 50).at(-1);
  const rsiD = rsi(dCloses, 14).at(-1);
  const atrD = atr(d1, 14).at(-1);

  const h4Closes = h4.map(x => x.close);
  const ema50H4 = ema(h4Closes, 50).at(-1);
  const h4Close = h4[h4.length - 1].close;
  const h4Trend = h4Close > ema50H4 ? "up" : h4Close < ema50H4 ? "down" : "side";

  const trendD =
    dClose > ema50D ? "Uptrend" :
    dClose < ema50D ? "Downtrend" : "Sideway";

  const momentum =
    rsiD >= 60 ? "Động lượng tăng" :
    rsiD <= 40 ? "Động lượng giảm" : "Trung tính";

  const { resist, support } = swingLevels(d1, 60);

  const paScore = scorePriceAction({
    close: dClose,
    ema50: ema50D,
    rsi14: rsiD,
    atr14: atrD,
    h4Trend
  });

  const ms = detectMarketState(d1, ema50D, atrD);
  const nearSupport = support[0];

  return `❇️ ${symbol} – PHÂN TÍCH KỸ THUẬT 1D & H4 | ${dateStr}

❇️ Cấu trúc thị trường
🔹 Xu hướng (1D)
👉 ${trendD} | Giá: ${fmt(dClose)} | EMA20: ${fmt(ema20D)} | EMA50: ${fmt(ema50D)}

🔹 Xác nhận (H4)
👉 H4 ${h4Trend === "up" ? "đồng pha tăng" : h4Trend === "down" ? "đồng pha giảm" : "đi ngang"} | H4 Close: ${fmt(h4Close)} | EMA50(H4): ${fmt(ema50H4)}

🔹 Động lượng
👉 RSI(14) ~ ${Math.round(rsiD)} → ${momentum}

🔹 Chấm điểm Price Action
👉 ${paScore.toFixed(1)}/10

🔹 Trạng thái thị trường
👉 ${ms.state} – ${ms.note}

❇️ Vùng giá quan trọng
🔹 Kháng cự (2 tầng)
👉 ${fmt(resist[0])}
👉 ${fmt(resist[1])}

🔹 Hỗ trợ (2 tầng)
👉 ${fmt(support[0])}
👉 ${fmt(support[1])}

❇️ Biến động dự kiến
🔹 ATR(14)
👉 ~ ${fmt(atrD)} điểm/ngày (ước lượng)

📊 KỊCH BẢN THAM KHẢO

🔵 LONG – Theo vùng cầu
🔹 Điều kiện
👉 Giữ vững vùng ${fmt(nearSupport)} và có nến xác nhận
🔹 Quản trị rủi ro
👉 Ưu tiên dừng theo biến động (ATR), tránh nhiễu

🔴 SHORT – Khi phá vỡ hỗ trợ
🔹 Điều kiện
👉 Thủng ${fmt(nearSupport)} và retest thất bại
🔹 Quản trị rủi ro
👉 Tránh đuổi theo nến mạnh, ưu tiên chờ hồi

🔹 Lưu ý: Nội dung chỉ mang tính tham khảo, không phải lời khuyên đầu tư.`;
}

async function runTaJob() {
  const d1 = await fetchKlines(TA_SYMBOL, "1d", 220);
  const h4 = await fetchKlines(TA_SYMBOL, "4h", 220);
  const post = buildDailyTA({ symbol: TA_SYMBOL, d1, h4 });
  await sendTelegramMessage(post);
  return { sent: true, symbol: TA_SYMBOL };
}

// =========================================================
// ========= INTERMARKET ONCHAIN JOB (H4 + 1D) ==============
// =========================================================
async function cqGet(path, params = {}) {
  if (!CQ_ACCESS_TOKEN) throw new Error("Missing CQ_ACCESS_TOKEN (CryptoQuant)");
  const base = "https://api.cryptoquant.com/v1";
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const j = await getJson(url.toString(), { Authorization: `Bearer ${CQ_ACCESS_TOKEN}` });
  if (j?.status?.code && j.status.code !== 200) {
    throw new Error(`CryptoQuant status ${j.status.code}: ${j.status.message}`);
  }
  return j;
}

function aggregateH4FromHourlyNetflow(hourlyData) {
  const slice = hourlyData.slice(0, 4); // newest-first
  if (slice.length < 4) throw new Error("Not enough hourly netflow points to build H4.");
  const sum = slice.reduce((acc, x) => acc + (Number(x.netflow_total) || 0), 0);
  return { h4_ending_at: slice[0]?.date, netflow_h4_btc: sum, points: slice };
}

async function getBtcNetflowH4() {
  const j = await cqGet("/btc/exchange-flows/netflow", {
    exchange: CQ_EXCHANGE,
    window: "hour",
    limit: 12
  });
  const data = j?.result?.data || [];
  if (!data.length) throw new Error("CryptoQuant returned empty netflow data.");
  return aggregateH4FromHourlyNetflow(data);
}

async function getBtcVolumeH4() {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", BTC_SYMBOL);
  url.searchParams.set("interval", "1h");
  url.searchParams.set("limit", "12");

  const klines = await getJson(url.toString());
  if (!Array.isArray(klines) || !klines.length) throw new Error("Binance returned empty klines.");

  const last4 = klines.slice(-4);
  const volumes = last4.map(k => toNum(k[5])).filter(Number.isFinite);
  const closes = last4.map(k => toNum(k[4])).filter(Number.isFinite);

  const volH4 = volumes.reduce((a, b) => a + b, 0);
  const closeNow = closes[closes.length - 1];
  const closePrev = closes[0];
  const pct = (Number.isFinite(closeNow) && Number.isFinite(closePrev) && closePrev !== 0)
    ? (closeNow / closePrev - 1) * 100
    : null;

  return { btc_vol_h4: volH4, btc_change_h4_pct: pct, btc_close: closeNow };
}

async function getBtcRange1D() {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", BTC_SYMBOL);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("limit", "3");

  const klines = await getJson(url.toString());
  if (!Array.isArray(klines) || klines.length < 2) throw new Error("Binance returned insufficient 1D klines.");

  const closed = klines[klines.length - 2]; // candle đã đóng
  const high = toNum(closed[2]);
  const low = toNum(closed[3]);
  const close = toNum(closed[4]);

  const range = (Number.isFinite(high) && Number.isFinite(low)) ? (high - low) : null;
  const rangePct = (Number.isFinite(range) && Number.isFinite(close) && close !== 0) ? (range / close) * 100 : null;

  return { high, low, close, range, rangePct };
}

async function getTwelveChangeH4(symbol) {
  if (!TWELVEDATA_KEY) throw new Error("Missing TWELVEDATA_KEY (TwelveData)");

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);      // "XAU/USD" or "XAG/USD"
  url.searchParams.set("interval", "1h");
  url.searchParams.set("outputsize", "10");
  url.searchParams.set("apikey", TWELVEDATA_KEY);

  const j = await getJson(url.toString());
  if (j?.status === "error") throw new Error(`TwelveData error: ${j?.message || "unknown"}`);

  const values = j?.values || [];
  if (!values.length) throw new Error(`TwelveData empty series for ${symbol}`);

  const closes = values.slice(0, 5).map(v => toNum(v.close)).filter(Number.isFinite); // newest-first
  if (closes.length < 5) throw new Error(`Not enough closes for ${symbol}`);

  const now = closes[0];
  const prev4h = closes[4];
  const pct = (prev4h !== 0) ? (now / prev4h - 1) * 100 : null;
  return { now, prev4h, pct };
}

// ===== Language Engine (tự đổi câu chữ theo dữ liệu) =====
function classifyBtcH4Move(pct) {
  if (!Number.isFinite(pct)) return { key: "NA", label: "n/a" };
  const a = Math.abs(pct);
  if (a < 0.30) return { key: "FLAT", label: "đi ngang" };
  if (a < 0.80) return { key: "MOVE", label: "dao động" };
  return { key: "STRONG", label: "biến động mạnh" };
}

function classifyNetflowH4(btc) {
  if (!Number.isFinite(btc)) return { key: "NA", bias: "TRUNG TÍNH", icon: "⚪️" };
  if (btc <= -500) return { key: "BIG_OUT", bias: "TÍCH LŨY", icon: "🟢" };
  if (btc >= 500) return { key: "BIG_IN", bias: "PHÂN PHỐI", icon: "🔴" };
  if (btc < 0) return { key: "SMALL_OUT", bias: "NGHIÊNG RÚT", icon: "🟡" };
  if (btc > 0) return { key: "SMALL_IN", bias: "NGHIÊNG NẠP", icon: "🟠" };
  return { key: "ZERO", bias: "TRUNG TÍNH", icon: "⚪️" };
}

function classifyRange1D(rangePct) {
  if (!Number.isFinite(rangePct)) return { key: "NA", label: "n/a" };
  if (rangePct < 2.0) return { key: "NARROW", label: "HẸP" };
  if (rangePct > 4.0) return { key: "WIDE", label: "RỘNG" };
  return { key: "MID", label: "TRUNG BÌNH" };
}

function classifyMetalH4(pct) {
  if (!Number.isFinite(pct)) return { key: "NA", label: "n/a" };
  if (pct > 0.50) return { key: "UP_STRONG", label: "tăng mạnh" };
  if (pct < -0.50) return { key: "DOWN", label: "giảm" };
  return { key: "FLAT", label: "đi ngang" };
}

function sentenceBtcContext({ moveKey, netflowKey }) {
  if (moveKey === "FLAT" && (netflowKey === "ZERO" || netflowKey === "SMALL_IN" || netflowKey === "SMALL_OUT")) {
    return "BTC đang giữ nhịp đi ngang, thiếu lực bứt phá rõ ràng; thị trường có xu hướng chờ thanh khoản.";
  }
  if (moveKey === "FLAT" && netflowKey === "BIG_OUT") {
    return "BTC đi ngang nhưng rút sàn mạnh; thiên hướng tích lũy xuất hiện dù giá chưa mở biên.";
  }
  if (moveKey === "FLAT" && netflowKey === "BIG_IN") {
    return "BTC đi ngang nhưng nạp sàn tăng mạnh; cần thận trọng rủi ro xả khi giá chưa có lực mua đẩy.";
  }
  if (moveKey === "STRONG") {
    return "BTC đang mở biên mạnh ở H4; ưu tiên quản trị rủi ro vì dễ có nhịp quét 2 đầu.";
  }
  return "BTC có dao động H4 nhưng chưa đủ để kết luận xu hướng; ưu tiên chờ thêm xác nhận.";
}

function sentenceRange1D(rangeKey) {
  if (rangeKey === "NARROW") return "Biên độ 1D co hẹp → nén biến động; breakout nếu xảy ra thường cần volume xác nhận.";
  if (rangeKey === "WIDE") return "Biên độ 1D nở rộng → biến động mạnh, rủi ro quét tăng; ưu tiên kỷ luật SL.";
  return "Biên độ 1D trung bình → theo dõi phản ứng giá tại vùng hỗ trợ/kháng cự quan trọng.";
}

function sentenceLiquidityShift({ btcMoveKey, xauKey, xagKey }) {
  const metalsStrong = (xauKey === "UP_STRONG") || (xagKey === "UP_STRONG");
  const btcFlat = (btcMoveKey === "FLAT");

  if (btcFlat && metalsStrong) {
    return { shift: true, line: "Vàng/bạc tăng mạnh trong khi BTC đi ngang → khả năng cao thanh khoản ngắn hạn đang dịch chuyển sang nhóm kim loại quý." };
  }
  if (metalsStrong) {
    return { shift: true, line: "Vàng/bạc đang chạy mạnh → dòng tiền có xu hướng ưu tiên nơi có biên độ tốt hơn." };
  }
  return { shift: false, line: "Chưa thấy tín hiệu rõ ràng về dịch chuyển thanh khoản sang vàng/bạc." };
}

function sentenceBigMoney({ shift, netflowKey }) {
  if (shift && (netflowKey === "ZERO" || netflowKey === "SMALL_OUT" || netflowKey === "SMALL_IN")) {
    return "Mẫu hình BTC im + vàng/bạc chạy thường phản ánh vị thế lớn đang ưu tiên giao dịch narrative kim loại quý; BTC có thể bị “bỏ qua” tạm thời.";
  }
  if (netflowKey === "BIG_OUT") return "Rút sàn mạnh thường là tín hiệu dòng tiền dài hơi thiên về tích lũy (dù giá có thể chưa tăng ngay).";
  if (netflowKey === "BIG_IN") return "Nạp sàn mạnh thường đi kèm áp lực cung tiềm ẩn; cần cảnh giác khi giá chưa có lực mua chủ động.";
  return "Dòng tiền lớn chưa cho tín hiệu cực đoan; ưu tiên đánh theo xác nhận của giá và thanh khoản.";
}

function buildIntermarketReport({ btc, netflowH4, xauPct, xagPct, btc1d }) {
  const dateStr = nowVN();

  const move = classifyBtcH4Move(btc.btc_change_h4_pct);
  const nf = classifyNetflowH4(netflowH4);
  const r1d = classifyRange1D(btc1d?.rangePct);
  const xau = classifyMetalH4(xauPct);
  const xag = classifyMetalH4(xagPct);

  const shiftInfo = sentenceLiquidityShift({ btcMoveKey: move.key, xauKey: xau.key, xagKey: xag.key });

  const btcContext = sentenceBtcContext({ moveKey: move.key, netflowKey: nf.key });
  const rangeText = sentenceRange1D(r1d.key);
  const bigMoney = sentenceBigMoney({ shift: shiftInfo.shift, netflowKey: nf.key });

  const btcCloseStr = Number.isFinite(btc.btc_close) ? btc.btc_close.toLocaleString("en-US") : "n/a";
  const btcH4Str = Number.isFinite(btc.btc_change_h4_pct) ? `${btc.btc_change_h4_pct >= 0 ? "+" : ""}${btc.btc_change_h4_pct.toFixed(2)}%` : "n/a";

  const hiStr = Number.isFinite(btc1d?.high) ? btc1d.high.toLocaleString("en-US") : "n/a";
  const loStr = Number.isFinite(btc1d?.low) ? btc1d.low.toLocaleString("en-US") : "n/a";
  const rangePctStr = Number.isFinite(btc1d?.rangePct) ? `${btc1d.rangePct.toFixed(2)}%` : "n/a";

  const btcSummary =
    (nf.key === "BIG_OUT") ? "Thiên hướng tích lũy (rút sàn mạnh), nhưng vẫn cần giá/volume xác nhận." :
    (nf.key === "BIG_IN") ? "Cẩn trọng áp lực cung (nạp sàn mạnh), ưu tiên phòng thủ." :
    (move.key === "FLAT") ? "Sideway – chờ thanh khoản, tránh fomo sớm." :
    "Quan sát thêm phản ứng giá ở vùng quan trọng.";

  const metalSummary =
    shiftInfo.shift ? "Kim loại quý đang hút chú ý ngắn hạn → có thể trade ngắn hạn, ưu tiên x nhỏ." :
    "Chưa có lực hút rõ → ưu tiên tập trung BTC & chờ xác nhận.";

  return `📊 <b>DÒNG TIỀN LIÊN THỊ TRƯỜNG | BTC – VÀNG/BẠC</b>
<i>${dateStr} | Khung: H4 (flow) + 1D (range)</i>

❇️ <b>BTC – Thông số kỹ thuật</b>
🔹 Giá hiện tại: <b>${btcCloseStr}</b>
🔹 Biến động H4: <b>${btcH4Str}</b> (${move.label})
🔹 Exchange Netflow H4: <b>${fmtBtc(netflowH4)}</b> ${nf.icon} (<b>${nf.bias}</b>)
👉 Nhận định: ${btcContext}

❇️ <b>Vàng/Bạc – Thông số kỹ thuật</b>
🔹 XAUUSD H4: <b>${fmtPct(xauPct)}</b> (${xau.label})
🔹 XAGUSD H4: <b>${fmtPct(xagPct)}</b> (${xag.label})
👉 Nhận định: ${shiftInfo.line}

🟡 <b>Góc nhìn dòng tiền lớn</b>
👉 ${bigMoney}

❇️ <b>Biên độ BTC (1D)</b>
🔹 High/Low: <b>${hiStr}</b> / <b>${loStr}</b>
🔹 Range 1D: <b>${rangePctStr}</b> | Trạng thái: <b>${r1d.label}</b>
👉 Nhận định: ${rangeText}

❇️ <b>Tổng kết</b>
🔹 BTC: ${btcSummary}
🔹 Vàng/Bạc: ${metalSummary}

⚠️ <i>Nhận định mang tính tham khảo, không phải lời khuyên đầu tư.</i>`;
}

async function runIntermarketOnchainJob() {
  // Lấy dữ liệu song song
  const [nf, btc, btc1d, xau, xag] = await Promise.all([
    getBtcNetflowH4(),
    getBtcVolumeH4(),
    getBtcRange1D(),
    getTwelveChangeH4("XAU/USD"),
    getTwelveChangeH4("XAG/USD")
  ]);

  const report = buildIntermarketReport({
    btc,
    netflowH4: nf.netflow_h4_btc,
    xauPct: xau.pct,
    xagPct: xag.pct,
    btc1d
  });

  await sendTelegramMessage(report);
  return { sent: true, exchange: CQ_EXCHANGE, symbol: BTC_SYMBOL };
}

// ================= RUN =================
console.log(`[WORKER] Started. NEWS_CRON=${NEWS_CRON} | ONCHAIN_CRON=${ONCHAIN_CRON} | TZ=${CRON_TZ}`);

// NEWS schedule
cron.schedule(
  NEWS_CRON,
  async () => {
    try {
      const r = await runNewsJob();
      console.log("[NEWS]", r);
    } catch (e) {
      console.error("[NEWS] Error:", e.message);
    }
  },
  { timezone: CRON_TZ }
);

// ONCHAIN schedule (mỗi 4h)
cron.schedule(
  ONCHAIN_CRON,
  async () => {
    try {
      const r = await runIntermarketOnchainJob();
      console.log("[ONCHAIN]", r);
    } catch (e) {
      console.error("[ONCHAIN] Error:", e.message);
    }
  },
  { timezone: CRON_TZ }
);

// TA schedule (test 23:20 VN)
/*cron.schedule(
  TA_CRON_TEST,
  async () => {
    try {
      const r = await runTaJob();
      console.log("[TA][TEST 23:20 VN]", r);
    } catch (e) {
      console.error("[TA][TEST 23:20 VN] Error:", e.message);
    }
  },
  { timezone: CRON_TZ }
);*/

console.log("[NEWS] Scheduled.");
console.log("[ONCHAIN] Scheduled every 4h.");
console.log("[TA] Scheduled test cron at 23:20 Asia/Ho_Chi_Minh");

// OPTIONAL: chạy thử ngay khi start (chỉ NEWS, không auto post onchain để tránh spam khi restart)
(async () => {
  try {
    const r1 = await runNewsJob();
    console.log("[NEWS] First run:", r1);
  } catch (e) {
    console.error("[NEWS] First run error:", e.message);
  }
})();
