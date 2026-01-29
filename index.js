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
function nowVN() {
  const date = new Date();
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false
  });
}

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
// ================= BINANCE INTERMARKET JOB ================
// =========================================================
// On-chain proxy using FREE sources (Binance + mempool + gold proxy)
// NOTE: Gold proxy uses PAXGUSDT by default (you can change via env)

const ONCHAIN_CRON = process.env.ONCHAIN_CRON || "0 */4 * * *"; // every 4h
const BTC_SPOT_SYMBOL = process.env.BTC_SPOT_SYMBOL || "BTCUSDT";
const GOLD_SYMBOL = process.env.GOLD_SYMBOL || "PAXGUSDT"; // gold proxy
const SILVER_SYMBOL = process.env.SILVER_SYMBOL || "";     // optional (if your exchange has it)

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function fetchSpotKlines(symbol, interval, limit) {
  const u = new URL("https://api.binance.com/api/v3/klines");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", interval);
  u.searchParams.set("limit", String(limit));
  return fetchJson(u.toString());
}

async function fetchFuturesOpenInterestHist(symbol, period = "4h", limit = 2) {
  const u = new URL("https://fapi.binance.com/futures/data/openInterestHist");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("period", period);
  u.searchParams.set("limit", String(limit));
  return fetchJson(u.toString());
}

async function fetchFuturesFundingRate(symbol, limit = 1) {
  const u = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("limit", String(limit));
  return fetchJson(u.toString());
}

async function fetchMempoolFees() {
  const u = "https://mempool.space/api/v1/fees/precise";
  return fetchJson(u);
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return (a / b - 1) * 100;
}

function fmtPct2(x) {
  if (!Number.isFinite(x)) return "n/a";
  const s = x >= 0 ? "+" : "";
  return `${s}${x.toFixed(2)}%`;
}

function fmtNum(x, d = 0) {
  if (!Number.isFinite(x)) return "n/a";
  if (d === 0) return Math.round(x).toLocaleString("en-US");
  return Number(x).toFixed(d);
}

function classifyBtcH4Move(p) {
  if (!Number.isFinite(p)) return { key: "NA", label: "n/a" };
  const a = Math.abs(p);
  if (a < 0.30) return { key: "FLAT", label: "đi ngang" };
  if (a < 0.80) return { key: "MOVE", label: "dao động" };
  return { key: "STRONG", label: "biến động mạnh" };
}

function classifyRange1D(rangePct) {
  if (!Number.isFinite(rangePct)) return { key: "NA", label: "n/a" };
  if (rangePct < 2.0) return { key: "NARROW", label: "HẸP" };
  if (rangePct > 4.0) return { key: "WIDE", label: "RỘNG" };
  return { key: "MID", label: "TRUNG BÌNH" };
}

function classifyMetalH4(p) {
  if (!Number.isFinite(p)) return { key: "NA", label: "n/a" };
  if (p > 0.50) return { key: "UP_STRONG", label: "tăng mạnh" };
  if (p < -0.50) return { key: "DOWN", label: "giảm" };
  return { key: "FLAT", label: "đi ngang" };
}

function sentenceLiquidityShift({ btcMoveKey, goldKey, silverKey }) {
  const metalsStrong = (goldKey === "UP_STRONG") || (silverKey === "UP_STRONG");
  const btcFlat = (btcMoveKey === "FLAT");
  if (btcFlat && metalsStrong) {
    return { shift: true, line: "Kim loại quý tăng mạnh trong khi BTC đi ngang → thanh khoản ngắn hạn có xu hướng dịch chuyển sang nhóm vàng/bạc." };
  }
  if (metalsStrong) {
    return { shift: true, line: "Nhóm kim loại quý đang chạy mạnh → dòng tiền ngắn hạn thường ưu tiên nơi có biên độ tốt hơn." };
  }
  return { shift: false, line: "Chưa thấy tín hiệu rõ ràng về dịch chuyển thanh khoản sang nhóm kim loại quý." };
}

function sentenceRange1D(rangeKey) {
  if (rangeKey === "NARROW") return "Biên độ 1D co hẹp → thị trường nén biến động; breakout nếu có thường cần volume xác nhận.";
  if (rangeKey === "WIDE") return "Biên độ 1D nở rộng → biến động mạnh, rủi ro quét tăng; ưu tiên kỷ luật SL.";
  return "Biên độ 1D trung bình → theo dõi phản ứng giá tại vùng hỗ trợ/kháng cự quan trọng.";
}

function sentenceDerivatives({ oiPct4h, funding }) {
  const fundingPct = Number.isFinite(funding) ? funding * 100 : null; // funding is decimal
  let note = "Phái sinh: chưa có tín hiệu cực đoan.";
  if (Number.isFinite(oiPct4h) && oiPct4h > 3) note = "OI tăng nhanh → dòng vị thế vào mạnh, dễ xuất hiện nhịp quét nếu vào muộn.";
  if (Number.isFinite(oiPct4h) && oiPct4h < -3) note = "OI giảm mạnh → vị thế bị rũ bỏ, thị trường hạ nhiệt ngắn hạn.";
  if (Number.isFinite(fundingPct) && fundingPct > 0.03) note += " Funding dương cao → crowd nghiêng long, cẩn trọng quét.";
  if (Number.isFinite(fundingPct) && fundingPct < -0.03) note += " Funding âm sâu → crowd nghiêng short, dễ có squeeze.";
  return note;
}

async function getH4From1h(symbol) {
  const kl = await fetchSpotKlines(symbol, "1h", 12);
  const last4 = kl.slice(-4);
  const closes = last4.map(k => Number(k[4]));
  const vols = last4.map(k => Number(k[5]));
  const closeNow = closes[closes.length - 1];
  const closePrev = closes[0];
  const changePct = pct(closeNow, closePrev);
  const volH4 = vols.reduce((a, b) => a + b, 0);
  return { closeNow, changePct, volH4 };
}

async function getRange1D(symbol) {
  const kl = await fetchSpotKlines(symbol, "1d", 3);
  const closed = kl[kl.length - 2]; // last closed candle
  const high = Number(closed[2]);
  const low = Number(closed[3]);
  const close = Number(closed[4]);
  const range = high - low;
  const rangePct = close ? (range / close) * 100 : null;
  return { high, low, close, rangePct };
}

function buildIntermarketPost(data) {
  const { dateStr, btc, gold, silver, btc1d, oiPct4h, funding, fees } = data;

  const btcMove = classifyBtcH4Move(btc.changePct);
  const goldCls = classifyMetalH4(gold?.changePct);
  const silverCls = classifyMetalH4(silver?.changePct);
  const rangeCls = classifyRange1D(btc1d?.rangePct);

  const shift = sentenceLiquidityShift({ btcMoveKey: btcMove.key, goldKey: goldCls.key, silverKey: silverCls.key });
  const dNote = sentenceDerivatives({ oiPct4h, funding });
  const rNote = sentenceRange1D(rangeCls.key);

  const fundingPct = Number.isFinite(funding) ? funding * 100 : null;

  const feeBlock = fees ? (
`🔹 Network Fee (BTC)
👉 Fastest: ${fees.fastestFee ?? "n/a"} sat/vB
👉 ~30m: ${fees.halfHourFee ?? "n/a"} sat/vB
👉 ~60m: ${fees.hourFee ?? "n/a"} sat/vB`
  ) : "";

  const silverLines = silver?.symbol ? (
`🔹 ${silver.symbol} H4: <b>${fmtPct2(silver.changePct)}</b> (${silverCls.label})`
  ) : "";

  return (
`📊 <b>DÒNG TIỀN LIÊN THỊ TRƯỜNG | BTC – VÀNG/BẠC</b>
<i>${dateStr} | Khung: H4 (flow proxy) + 1D (range)</i>

❇️ <b>BTC – Thông số kỹ thuật</b>
🔹 Giá: <b>${fmtNum(btc.closeNow, 0)}</b>
🔹 Biến động H4: <b>${fmtPct2(btc.changePct)}</b> (${btcMove.label})
🔹 Volume H4 (spot): <b>${fmtNum(btc.volH4, 0)}</b>
🔹 OI H4 (futures): <b>${fmtPct2(oiPct4h)}</b>
🔹 Funding gần nhất: <b>${fmtPct2(fundingPct)}</b>
👉 Nhận định: ${dNote}

❇️ <b>Kim loại quý (proxy)</b>
🔹 ${gold.symbol} H4: <b>${fmtPct2(gold.changePct)}</b> (${goldCls.label})
${silverLines}
👉 Nhận định: ${shift.line}

🟡 <b>Góc nhìn dòng tiền lớn</b>
👉 ${shift.shift ? "BTC im + kim loại quý chạy thường phản ánh dòng tiền ngắn hạn ưu tiên nơi có biên độ tốt hơn; BTC có thể bị “bỏ qua” tạm thời." : "Dòng tiền ngắn hạn chưa nghiêng mạnh sang kim loại quý; ưu tiên bám theo phản ứng giá BTC."}

❇️ <b>Biên độ BTC (1D)</b>
🔹 High/Low: <b>${fmtNum(btc1d.high, 0)}</b> / <b>${fmtNum(btc1d.low, 0)}</b>
🔹 Range 1D: <b>${fmtPct2(btc1d.rangePct)}</b> | Trạng thái: <b>${rangeCls.label}</b>
👉 Nhận định: ${rNote}

${feeBlock ? `❇️ <b>Áp lực mạng</b>\n${feeBlock}\n` : ""}

❇️ <b>Tổng kết</b>
🔹 BTC: ${btcMove.key === "FLAT" ? "Sideway – chờ thanh khoản, tránh fomo sớm." : "Có dao động – ưu tiên chờ xác nhận tại vùng giá quan trọng."}
🔹 Kim loại quý: ${shift.shift ? "Đang hút chú ý ngắn hạn → có thể trade ngắn hạn, ưu tiên x nhỏ." : "Chưa hút thanh khoản rõ → ưu tiên quan sát."}

⚠️ <i>Nhận định mang tính tham khảo, không phải lời khuyên đầu tư.</i>`
  );
}

async function runIntermarketJob() {
  const dateStr = nowVN();

  // BTC spot H4 + 1D range
  const btc = await getH4From1h(BTC_SPOT_SYMBOL);
  const btc1d = await getRange1D(BTC_SPOT_SYMBOL);

  // Gold/silver proxies
  let gold = null;
  try {
    const g = await getH4From1h(GOLD_SYMBOL);
    gold = { ...g, symbol: GOLD_SYMBOL };
  } catch (e) {
    gold = { symbol: GOLD_SYMBOL, changePct: null };
  }

  let silver = null;
  if (SILVER_SYMBOL) {
    try {
      const s = await getH4From1h(SILVER_SYMBOL);
      silver = { ...s, symbol: SILVER_SYMBOL };
    } catch {
      silver = null;
    }
  }

  // Futures OI hist + funding (optional; some symbols may not exist on futures)
  let oiPct4h = null;
  let funding = null;
  try {
    const oi = await fetchFuturesOpenInterestHist(BTC_SPOT_SYMBOL, "4h", 2);
    const last = Number(oi?.[0]?.sumOpenInterest);
    const prev = Number(oi?.[1]?.sumOpenInterest);
    oiPct4h = pct(last, prev);
  } catch {}

  try {
    const fr = await fetchFuturesFundingRate(BTC_SPOT_SYMBOL, 1);
    funding = Number(fr?.[0]?.fundingRate);
  } catch {}

  // Mempool fees (optional)
  let fees = null;
  try { fees = await fetchMempoolFees(); } catch {}

  const post = buildIntermarketPost({
    dateStr,
    btc,
    gold,
    silver,
    btc1d,
    oiPct4h,
    funding,
    fees
  });

  await sendTelegramMessage(post);
  return { sent: true, symbol: BTC_SPOT_SYMBOL, gold: GOLD_SYMBOL };
}

// ================= RUN =================
console.log(`[WORKER] Started. NEWS_CRON=${NEWS_CRON} | TA_CRON_TEST=${TA_CRON_TEST} | TZ=${CRON_TZ}`);

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

// INTERMARKET schedule (every 4h)
cron.schedule(
  ONCHAIN_CRON,
  async () => {
    try {
      const r = await runIntermarketJob();
      console.log("[INTERMARKET][H4]", r);
    } catch (e) {
      console.error("[INTERMARKET][H4] Error:", e.message);
    }
  },
  { timezone: CRON_TZ }
);
console.log(`[INTERMARKET] Scheduled. ONCHAIN_CRON=${ONCHAIN_CRON}`);

console.log("[TA] Scheduled test cron at 23:20 Asia/Ho_Chi_Minh");

// OPTIONAL: chạy thử ngay khi start (chỉ NEWS, không post TA)
(async () => {
  try {
    const r1 = await runNewsJob();
    console.log("[NEWS] First run:", r1);
  } catch (e) {
    console.error("[NEWS] First run error:", e.message);
  }
})();

