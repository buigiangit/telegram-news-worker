// index.js — telegram-news-worker + Intermarket (BTC–Vàng) + BTC Buy/Sell Flow + Fee conclusion
// ✅ Có nowVN() (fix lỗi trước đó)
// ✅ Network Fee có KẾT LUẬN tự động
// ✅ Bullet dùng 🔹 (Telegram-safe)

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

// ===== INTERMARKET (Binance-free) =====
const ONCHAIN_CRON = process.env.ONCHAIN_CRON || "0 */4 * * *"; // default mỗi 4h
const BTC_SPOT_SYMBOL = process.env.BTC_SPOT_SYMBOL || "BTCUSDT";
const GOLD_SYMBOL = process.env.GOLD_SYMBOL || "PAXGUSDT"; // proxy vàng
const SILVER_SYMBOL = process.env.SILVER_SYMBOL || "";     // optional

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

function nowVN() {
  return new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false
  });
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function safeText(s, max = 280) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "n/a";
  return Math.round(n).toLocaleString("en-US");
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

function fmtMoney(n) {
  if (!Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  const sign = n >= 0 ? "" : "-";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return j;
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
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// =========================================================
// ===================== NEWS JOB ===========================
// =========================================================
const KEYWORDS = [
  "bitcoin","btc","ethereum","eth","solana","sol","xrp","bnb","doge","crypto","cryptocurrency",
  "etf","sec","fed","binance","coinbase","hack","exploit","airdrop","on-chain","onchain","layer 2","l2",
  "gold","xau","paxg","fed","inflation","rate"
];

function ruleRelevant(title, content) {
  const s = (title + " " + content).toLowerCase();
  return KEYWORDS.some(k => s.includes(k));
}

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
    text += `🔹 Nguồn: ${it.source}\n`;
    if (snippetShow) text += `🔹 Tóm tắt: ${safeText(snippetShow, 260)}\n`;
    text += `🔹 Link: ${it.link}\n`;
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

  for (const it of picked) {
    it.title_vi = await translateToVi(it.title);
    const snippet = it.contentSnippet || it.content || "";
    it.snippet_vi = await translateToVi(snippet);
  }

  const post = buildNewsPost(picked);
  await sendTelegramMessage(post);

  const tx = db.transaction((arr) => {
    for (const it of arr) {
      try { stmtIns.run(it.urlHash, it.link, it.title, it.source, it.publishedAt || ""); } catch {}
    }
  });
  tx(picked);

  return { sent: true, count: picked.length };
}

// =========================================================
// ===================== TA JOB (giữ nguyên) =================
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

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

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

🔴 SHORT – Khi phá vỡ hỗ trợ
🔹 Điều kiện
👉 Thủng ${fmt(nearSupport)} và retest thất bại

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
// ====== INTERMARKET (BTC–VÀNG + BUY/SELL FLOW + FEES) ======
// =========================================================
const BINANCE_BASE = "https://api.binance.com";

async function fetchSpotKlinesRaw(symbol, interval, limit = 12) {
  const url = new URL(`${BINANCE_BASE}/api/v3/klines`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  return await getJson(url.toString());
}

async function getSpotH4Summary(symbol) {
  const klines = await fetchSpotKlinesRaw(symbol, "1h", 12);
  if (!Array.isArray(klines) || klines.length < 4) throw new Error(`Insufficient klines for ${symbol}`);

  const last4 = klines.slice(-4);
  const closes = last4.map(k => toNum(k[4])).filter(Number.isFinite);
  const vols = last4.map(k => toNum(k[7])).filter(Number.isFinite); // quote volume (USDT)

  const closeNow = closes[closes.length - 1];
  const closePrev = closes[0];
  const pct = (Number.isFinite(closeNow) && Number.isFinite(closePrev) && closePrev !== 0)
    ? (closeNow / closePrev - 1) * 100
    : null;

  const quoteVolH4 = vols.reduce((a, b) => a + b, 0);
  return { closeNow, pctH4: pct, quoteVolH4 };
}

async function getBuySellFlowH4(symbol) {
  const klines = await fetchSpotKlinesRaw(symbol, "1h", 12);
  if (!Array.isArray(klines) || klines.length < 4) throw new Error(`Insufficient klines for flow ${symbol}`);

  const last4 = klines.slice(-4);

  // kline fields:
  // [7] quote asset volume (USDT)
  // [10] taker buy quote asset volume (USDT)
  let buyQuote = 0;
  let totalQuote = 0;

  for (const k of last4) {
    totalQuote += Number(k[7]) || 0;
    buyQuote += Number(k[10]) || 0;
  }

  const sellQuote = Math.max(0, totalQuote - buyQuote);
  const delta = buyQuote - sellQuote;
  const buyPct = totalQuote > 0 ? (buyQuote / totalQuote) * 100 : null;

  return { buyQuote, sellQuote, totalQuote, delta, buyPct };
}

async function getRange1D(symbol) {
  const klines = await fetchSpotKlinesRaw(symbol, "1d", 3);
  if (!Array.isArray(klines) || klines.length < 2) throw new Error(`Insufficient 1D klines for ${symbol}`);

  const closed = klines[klines.length - 2]; // nến đã đóng
  const high = toNum(closed[2]);
  const low = toNum(closed[3]);
  const close = toNum(closed[4]);

  const range = (Number.isFinite(high) && Number.isFinite(low)) ? (high - low) : null;
  const rangePct = (Number.isFinite(range) && Number.isFinite(close) && close !== 0)
    ? (range / close) * 100
    : null;

  let state = "TRUNG BÌNH";
  if (Number.isFinite(rangePct)) {
    if (rangePct < 2.0) state = "HẸP";
    else if (rangePct > 4.0) state = "RỘNG";
  }

  return { high, low, close, rangePct, state };
}

// Optional Futures OI/Funding — bọc try/catch vì có thể bị hạn chế vùng
async function getFuturesOI(symbol) {
  const url = new URL("https://fapi.binance.com/fapi/v1/openInterest");
  url.searchParams.set("symbol", symbol);
  const j = await getJson(url.toString());
  return toNum(j?.openInterest);
}
async function getFuturesFunding(symbol) {
  const url = new URL("https://fapi.binance.com/fapi/v1/premiumIndex");
  url.searchParams.set("symbol", symbol);
  const j = await getJson(url.toString());
  const r = toNum(j?.lastFundingRate);
  return Number.isFinite(r) ? r * 100 : null; // %
}

async function getMempoolFees() {
  const url = "https://mempool.space/api/v1/fees/recommended";
  try {
    const j = await getJson(url);
    return {
      fastest: j?.fastestFee ?? null,
      halfHour: j?.halfHourFee ?? null,
      hour: j?.hourFee ?? null
    };
  } catch {
    return { fastest: null, halfHour: null, hour: null };
  }
}

// ===== Language helpers =====
function flowConclusion({ buyPct, delta }) {
  if (!Number.isFinite(buyPct) || !Number.isFinite(delta)) return "Chưa đủ dữ liệu để kết luận dòng tiền.";
  if (buyPct >= 58) return "Mua chủ động áp đảo → lực đẩy ngắn hạn tốt hơn.";
  if (buyPct <= 42) return "Bán chủ động áp đảo → cẩn trọng áp lực xả ngắn hạn.";
  if (Math.abs(delta) < 0.02 * (Math.abs(delta) + 1)) return "Buy/Sell cân bằng → chưa có phe áp đảo.";
  return "Dòng tiền lệch nhẹ → cần thêm xác nhận từ giá & volume.";
}

function rangeConclusion(state) {
  if (state === "HẸP") return "Biên độ 1D co hẹp → nén biến động, ưu tiên chờ breakout có volume xác nhận.";
  if (state === "RỘNG") return "Biên độ 1D nở rộng → biến động mạnh, rủi ro quét tăng; ưu tiên kỷ luật SL.";
  return "Biên độ 1D trung bình → quan sát phản ứng tại vùng giá quan trọng.";
}

function feeConclusion(fastestFee) {
  if (!Number.isFinite(fastestFee)) return "Chưa có dữ liệu fee để kết luận.";
  if (fastestFee < 15) {
    return "Phí mạng thấp → mạng lưới rảnh, chưa có dòng tiền on-chain gấp; phù hợp trạng thái sideway.";
  }
  if (fastestFee <= 40) {
    return "Phí mạng mức trung bình → chưa có áp lực giao dịch gấp (panic/fomo); thị trường thiên về quan sát.";
  }
  if (fastestFee <= 80) {
    return "Phí mạng tăng cao → nhu cầu giao dịch on-chain gia tăng; cần theo dõi sát phản ứng giá & volume.";
  }
  return "Phí mạng rất cao → mạng lưới quá tải, thường đi kèm panic/fomo mạnh; rủi ro biến động lớn.";
}

function liquidityShiftText({ btcPctH4, goldPctH4 }) {
  const btcFlat = Number.isFinite(btcPctH4) ? Math.abs(btcPctH4) < 0.30 : false;
  const goldStrong = Number.isFinite(goldPctH4) ? goldPctH4 > 0.50 : false;

  if (btcFlat && goldStrong) {
    return { shift: true, text: "BTC đi ngang trong khi vàng tăng mạnh → thanh khoản ngắn hạn có xu hướng dịch chuyển sang kim loại quý." };
  }
  if (goldStrong) {
    return { shift: true, text: "Vàng đang chạy mạnh → dòng tiền có xu hướng ưu tiên nơi có biên độ tốt hơn." };
  }
  return { shift: false, text: "Chưa thấy dấu hiệu rõ ràng về dịch chuyển thanh khoản sang vàng." };
}

function buildIntermarketPost({ btc, flow, gold, silver, range1d, fees, oiNow, fundingNow }) {
  const ts = nowVN();
  const shift = liquidityShiftText({ btcPctH4: btc.pctH4, goldPctH4: gold.pctH4 });

  const oiLine = Number.isFinite(oiNow) ? `🔹 OI Futures: <b>${fmtMoney(oiNow)}</b>\n` : "";
  const fundingLine = Number.isFinite(fundingNow) ? `🔹 Funding: <b>${fmtPct(fundingNow)}</b>\n` : "";

  const silverBlock = silver
    ? `🔹 Bạc (Proxy) H4: <b>${fmtPct(silver.pctH4)}</b>\n`
    : "";

  const feeFast = fees.fastest;
  const feeHalf = fees.halfHour;
  const feeHour = fees.hour;

  return (
`📊 <b>DÒNG TIỀN LIÊN THỊ TRƯỜNG | BTC – VÀNG</b>
<i>${ts} | Khung: H4 (flow) · 1D (biên độ)</i>

❇️ <b>BTC – Thông số kỹ thuật</b>
🔹 Giá hiện tại: <b>${fmt(btc.closeNow)}</b>
🔹 Biến động H4: <b>${fmtPct(btc.pctH4)}</b>
🔹 Volume H4 (USDT): <b>${fmtMoney(btc.quoteVolH4)}</b>

🔹 <b>Dòng tiền H4 (taker – USDT)</b>
🔹 Buy: <b>${fmtMoney(flow.buyQuote)}</b> | Sell: <b>${fmtMoney(flow.sellQuote)}</b>
🔹 Delta: <b>${fmtMoney(flow.delta)}</b> | Buy%: <b>${Number.isFinite(flow.buyPct) ? flow.buyPct.toFixed(1) + "%" : "n/a"}</b>
${oiLine}${fundingLine}👉 Nhận định: ${flowConclusion(flow)}

❇️ <b>Vàng (Proxy: ${GOLD_SYMBOL})</b>
🔹 Biến động H4: <b>${fmtPct(gold.pctH4)}</b>
🔹 Volume H4 (USDT): <b>${fmtMoney(gold.quoteVolH4)}</b>
${silverBlock}👉 Nhận định: ${shift.text}

🟡 <b>Góc nhìn dòng tiền lớn</b>
🔹 Khi BTC đi ngang nhưng vàng chạy mạnh, thường phản ánh vị thế lớn ưu tiên narrative có biên độ tốt hơn → BTC có thể bị “bỏ qua” tạm thời.

❇️ <b>Biên độ BTC (1D)</b>
🔹 High/Low: <b>${fmt(range1d.high)}</b> / <b>${fmt(range1d.low)}</b>
🔹 Range 1D: <b>${Number.isFinite(range1d.rangePct) ? range1d.rangePct.toFixed(2) + "%" : "n/a"}</b> | Trạng thái: <b>${range1d.state}</b>
👉 Nhận định: ${rangeConclusion(range1d.state)}

❇️ <b>Network Fee (mempool)</b>
🔹 Fastest: <b>${feeFast ?? "n/a"}</b> sat/vB
🔹 ~30m: <b>${feeHalf ?? "n/a"}</b> sat/vB
🔹 ~60m: <b>${feeHour ?? "n/a"}</b> sat/vB
👉 Kết luận: ${feeConclusion(Number.isFinite(feeFast) ? Number(feeFast) : NaN)}

❇️ <b>Tổng kết</b>
🔹 BTC: ${Number.isFinite(btc.pctH4) && Math.abs(btc.pctH4) < 0.30 ? "Sideway – chờ thanh khoản; ưu tiên quan sát." : "Có dao động H4; theo dõi xác nhận."}
🔹 Vàng: ${shift.shift ? "Đang hút chú ý ngắn hạn → ưu tiên x nhỏ, quản trị rủi ro." : "Chưa hút thanh khoản rõ → ưu tiên chờ."}

⚠️ <i>Nhận định mang tính tham khảo, không phải lời khuyên đầu tư.</i>`
  );
}

async function runIntermarketH4() {
  const btc = await getSpotH4Summary(BTC_SPOT_SYMBOL);
  const flow = await getBuySellFlowH4(BTC_SPOT_SYMBOL);
  const range1d = await getRange1D(BTC_SPOT_SYMBOL);

  const gold = await getSpotH4Summary(GOLD_SYMBOL);

  let silver = null;
  if (SILVER_SYMBOL) {
    try { silver = await getSpotH4Summary(SILVER_SYMBOL); } catch { silver = null; }
  }

  let oiNow = null;
  let fundingNow = null;
  try { oiNow = await getFuturesOI(BTC_SPOT_SYMBOL); } catch {}
  try { fundingNow = await getFuturesFunding(BTC_SPOT_SYMBOL); } catch {}

  const fees = await getMempoolFees();

  const post = buildIntermarketPost({ btc, flow, gold, silver, range1d, fees, oiNow, fundingNow });
  await sendTelegramMessage(post);

  return { sent: true };
}

// ================= RUN =================
console.log(`[WORKER] Started. NEWS_CRON=${NEWS_CRON} | ONCHAIN_CRON=${ONCHAIN_CRON} | TZ=${CRON_TZ}`);

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

cron.schedule(
  ONCHAIN_CRON,
  async () => {
    try {
      const r = await runIntermarketH4();
      console.log("[INTERMARKET][H4]", r);
    } catch (e) {
      console.error("[INTERMARKET][H4] Error:", e.message);
    }
  },
  { timezone: CRON_TZ }
);

console.log("[NEWS] Scheduled.");
console.log("[INTERMARKET] Scheduled.");

// OPTIONAL: chạy thử tin News khi start (giữ nguyên hành vi cũ, tránh spam intermarket)
(async () => {
  try {
    const r1 = await runNewsJob();
    console.log("[NEWS] First run:", r1);
  } catch (e) {
    console.error("[NEWS] First run error:", e.message);
  }
})();
