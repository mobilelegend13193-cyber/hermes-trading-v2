import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ╔══════════════════════════════════════════════════════════════╗
// ║  HERMES AI — Hybrid Multi-Agent Trading System v2.0         ║
// ║  Strategic Planner : Claude Sonnet 4                        ║
// ║  Technical Validator: DeepSeek-V3 (Temperature 0.1)         ║
// ║  Market Engine      : Binance Full USDT Scanner              ║
// ╚══════════════════════════════════════════════════════════════╝

// ── Configuration ─────────────────────────────────────────────
const BINANCE_BASE   = "https://api.binance.com/api/v3";
const BACKEND_URL    = process.env.NEXT_PUBLIC_BACKEND_URL || "";
const MIN_VOLUME_USD = 1_000_000;        // $1M minimum 24h volume filter
const PUMP_THRESHOLD  = 7;              // % gain  → PUMP anomaly
const DUMP_THRESHOLD  = -7;             // % loss  → DUMP anomaly
const BREAKOUT_VOL    = 2.5;            // x avg volume → breakout
const SCAN_DISPLAY    = 60;             // max rows in scanner table
const REFRESH_MS      = 60_000;         // auto-refresh interval

// ── Technical Indicators ───────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = (gains / period) / (losses / period || 0.001);
  return 100 - 100 / (1 + rs);
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcMACD(closes) {
  return calcEMA(closes, 12) - calcEMA(closes, 26);
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { upper: 0, lower: 0, mid: 0, width: 0 };
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, lower: mean - 2 * std, mid: mean, width: (4 * std) / mean * 100 };
}

function calcATR(klines, period = 14) {
  if (klines.length < period) return 0;
  const trs = klines.slice(-period).map((k, i, arr) => {
    const high = parseFloat(k[2]), low = parseFloat(k[3]), prev = i > 0 ? parseFloat(arr[i-1][4]) : high;
    return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  });
  return trs.reduce((a, b) => a + b, 0) / period;
}

// ── Full Technical Score (0–100) ───────────────────────────────
function computeScore(klines) {
  const closes  = klines.map(k => parseFloat(k[4]));
  const volumes = klines.map(k => parseFloat(k[5]));
  const last    = closes[closes.length - 1];

  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const bb     = calcBollinger(closes);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const atr    = calcATR(klines);

  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avgVol    = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio  = recentVol / (avgVol || 1);

  let rsiScore   = rsi < 30 ? 20 : rsi < 45 ? 12 : rsi > 70 ? -20 : rsi > 55 ? -8 : 5;
  let macdScore  = macd > 0 ? 10 : -10;
  let trendScore = last > ema20 && ema20 > ema50 ? 15 : last > ema20 ? 8 : last < ema20 && ema20 < ema50 ? -15 : -8;
  let bbScore    = last < bb.lower ? 10 : last > bb.upper ? -10 : 2;
  let macroScore = last > ema200 ? 10 : -10;
  let volScore   = volRatio > 1.3 ? 15 : volRatio > 1 ? 8 : 0;

  const raw   = 50 + rsiScore + macdScore + trendScore + bbScore + macroScore + volScore;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  // Dynamic SL/TP based on ATR
  const atrMultiplier = 1.5;
  const slPct  = atr ? (atr * atrMultiplier / last * 100).toFixed(2) : 2.5;
  const tpPct  = atr ? (atr * atrMultiplier * 2 / last * 100).toFixed(2) : 5.0;

  return { score, rsi: Math.round(rsi), macd: macd.toFixed(4), bb, ema20, ema50, ema200, last, atr, slPct, tpPct, volumes, volRatio };
}

function getSignal(score) {
  if (score >= 68) return { type: "LONG",    color: "#00e5a0", emoji: "▲" };
  if (score <= 32) return { type: "SHORT",   color: "#ff4466", emoji: "▼" };
  return                   { type: "NEUTRAL", color: "#555",   emoji: "●" };
}

// ── Anomaly Detector ──────────────────────────────────────────
function detectAnomaly(ticker) {
  const chg = parseFloat(ticker.priceChangePercent);
  const vol  = parseFloat(ticker.quoteVolume);
  const cnt  = parseFloat(ticker.count || 0);       // number of trades

  if (chg >= PUMP_THRESHOLD)   return { type: "PUMP",     color: "#00e5a0", icon: "🚀", score: Math.min(100, chg * 5) };
  if (chg <= DUMP_THRESHOLD)   return { type: "DUMP",     color: "#ff4466", icon: "💥", score: Math.min(100, Math.abs(chg) * 5) };
  if (Math.abs(chg) > 4)       return { type: "BREAKOUT", color: "#fbbf24", icon: "⚡", score: Math.abs(chg) * 8 };
  return                                { type: "NORMAL",   color: "#555",   icon: "─",  score: 0 };
}

function computeAnomalyScore(ticker) {
  const chgAbs = Math.abs(parseFloat(ticker.priceChangePercent));
  const vol    = parseFloat(ticker.quoteVolume);
  const volM   = vol / 1_000_000;
  return chgAbs * 10 + Math.log10(volM + 1) * 5;
}

// ── localStorage Helpers ───────────────────────────────────────
const ls = {
  get: (key, fallback) => { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch { return fallback; } },
  set: (key, val)      => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
};

// Compressed history — keep only essential fields
function compressHistory(h) {
  return h.slice(-300).map(e => ({
    id: e.id, sym: e.symbol, sig: e.signal, sc: e.score,
    px: e.price, ts: e.timestamp, out: e.outcome, dp: e.priceDiff,
  }));
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  MAIN DASHBOARD COMPONENT                                   ║
// ╚══════════════════════════════════════════════════════════════╝
export default function HermesDashboard() {
  // Core state
  const [coins, setCoins]             = useState([]);
  const [loading, setLoading]         = useState(true);
  const [lastUpdate, setLastUpdate]   = useState(null);
  const [activeTab, setActiveTab]     = useState("dashboard");
  const [selectedCoin, setSelectedCoin] = useState(null);

  // Scanner state
  const [scanData, setScanData]         = useState([]);
  const [scanLoading, setScanLoading]   = useState(false);
  const [scanFilter, setScanFilter]     = useState("ALL");    // ALL | PUMP | DUMP | BREAKOUT
  const [minVol, setMinVol]             = useState(1);        // $M
  const [scanSort, setScanSort]         = useState("anomaly"); // anomaly | change | volume

  // AI state
  const [aiChat, setAiChat]             = useState([{ role: "assistant", content: "HERMES v2.0 ONLINE. Multi-Agent engine aktif — Claude Sonnet (Strategic Planner) + DeepSeek-V3 (Technical Validator). Full Binance USDT market scanner siap. Tanya tentang sinyal, anomali, atau minta analisis koin apa pun." }]);
  const [chatInput, setChatInput]       = useState("");
  const [chatLoading, setChatLoading]   = useState(false);
  const [deepseekStatus, setDsStatus]   = useState("idle"); // idle | validating | validated | error

  // History & memory
  const [history, setHistory]           = useState(() => {
    const raw = ls.get("hermes_v2_history", []);
    return raw.map(e => ({ id: e.id, symbol: e.sym || e.symbol, signal: e.sig || e.signal, score: e.sc || e.score, price: e.px || e.price, timestamp: e.ts || e.timestamp, outcome: e.out ?? e.outcome, priceDiff: e.dp ?? e.priceDiff }));
  });
  const [memory, setMemory]             = useState(() => ls.get("hermes_v2_memory", { totalSignals: 0, wins: 0, deepseekValidated: 0 }));

  // Trade modal
  const [tradeModal, setTradeModal]     = useState(null);

  const chatEndRef = useRef(null);

  // ── Derived stats ────────────────────────────────────────────
  const winRate  = memory.totalSignals > 0 ? ((memory.wins / memory.totalSignals) * 100).toFixed(1) : "—";
  const topLong  = coins.filter(c => c.signal?.type === "LONG").slice(0, 3);
  const topShort = coins.filter(c => c.signal?.type === "SHORT").slice(0, 3);

  // ── Fetch klines for one coin ────────────────────────────────
  const fetchKlines = useCallback(async (symbol, interval = "4h", limit = 250) => {
    const r = await fetch(`${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!r.ok) throw new Error("Binance klines error");
    return r.json();
  }, []);

  // ── Dashboard: load top 20 coins from scanner ────────────────
  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      // Get all tickers then pick top 20 by volume for deep analysis
      const allTickers = await fetch(`${BINANCE_BASE}/ticker/24hr`).then(r => r.json());
      const filtered = allTickers
        .filter(t => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) > 10_000_000)
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 20);

      const results = await Promise.allSettled(
        filtered.map(async ticker => {
          const klines = await fetchKlines(ticker.symbol);
          const analysis = computeScore(klines);
          const signal   = getSignal(analysis.score);
          return {
            symbol: ticker.symbol,
            short: ticker.symbol.replace("USDT", ""),
            name:  ticker.symbol.replace("USDT", ""),
            ...analysis,
            signal,
            priceChange: parseFloat(ticker.priceChangePercent),
            volume24h:   parseFloat(ticker.quoteVolume),
            anomaly:     detectAnomaly(ticker),
            timestamp:   Date.now(),
          };
        })
      );

      const valid = results.filter(r => r.status === "fulfilled").map(r => r.value);
      valid.sort((a, b) => {
        const sa = a.signal.type === "LONG" ? a.score : a.signal.type === "SHORT" ? 100 - a.score : 50;
        const sb = b.signal.type === "LONG" ? b.score : b.signal.type === "SHORT" ? 100 - b.score : 50;
        return sb - sa;
      });

      // Update history
      const newHistory = [...history];
      for (const coin of valid) {
        if (coin.signal.type === "NEUTRAL") continue;
        const last = newHistory.filter(h => h.symbol === coin.symbol).slice(-1)[0];
        if (!last || Date.now() - last.timestamp > 4 * 3600000) {
          newHistory.push({ id: Date.now() + Math.random(), symbol: coin.symbol, signal: coin.signal.type, score: coin.score, price: coin.last, timestamp: Date.now(), outcome: null });
        }
      }
      const trimmed = newHistory.slice(-300);
      setHistory(trimmed);
      ls.set("hermes_v2_history", compressHistory(trimmed));
      setCoins(valid);
      setLastUpdate(new Date());
    } catch(e) {
      console.error("Dashboard load error:", e);
    }
    setLoading(false);
  }, [history, fetchKlines]);

  // ── Scanner: full USDT market scan ──────────────────────────
  const runFullScan = useCallback(async () => {
    setScanLoading(true);
    try {
      const tickers = await fetch(`${BINANCE_BASE}/ticker/24hr`).then(r => r.json());
      const usdt = tickers
        .filter(t => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) >= minVol * 1_000_000)
        .map(t => ({
          symbol:       t.symbol,
          short:        t.symbol.replace("USDT",""),
          price:        parseFloat(t.lastPrice),
          change:       parseFloat(t.priceChangePercent),
          volume:       parseFloat(t.quoteVolume),
          high:         parseFloat(t.highPrice),
          low:          parseFloat(t.lowPrice),
          trades:       parseInt(t.count),
          anomaly:      detectAnomaly(t),
          anomalyScore: computeAnomalyScore(t),
        }));

      // Sort
      const sorted = [...usdt].sort((a, b) => {
        if (scanSort === "anomaly")  return b.anomalyScore - a.anomalyScore;
        if (scanSort === "change")   return Math.abs(b.change) - Math.abs(a.change);
        if (scanSort === "volume")   return b.volume - a.volume;
        return 0;
      });

      setScanData(sorted.slice(0, SCAN_DISPLAY));
    } catch(e) {
      console.error("Scanner error:", e);
    }
    setScanLoading(false);
  }, [minVol, scanSort]);

  // ── Deep scan a single coin (from scanner) ───────────────────
  const deepDiveCoin = useCallback(async (scanRow) => {
    try {
      const klines = await fetchKlines(scanRow.symbol);
      const analysis = computeScore(klines);
      const signal   = getSignal(analysis.score);
      const fullCoin = { ...scanRow, ...analysis, signal, name: scanRow.short, timestamp: Date.now() };
      setSelectedCoin(fullCoin);
      setActiveTab("signals");
    } catch(e) {
      console.error("Deep dive error:", e);
    }
  }, [fetchKlines]);

  // ── DeepSeek-V3 validation via backend ──────────────────────
  const validateWithDeepSeek = useCallback(async (coin) => {
    if (!BACKEND_URL && !window.__HERMES_BACKEND) {
      return { validated: false, reason: "No backend configured" };
    }
    setDsStatus("validating");
    try {
      const klines = await fetchKlines(coin.symbol, "1h", 100);
      const ohlcv  = klines.slice(-50).map(k => ({
        t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]),
        l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
      }));
      const res = await fetch(`${BACKEND_URL || window.__HERMES_BACKEND}/api/deepseek`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: coin.symbol, signal: coin.signal.type, score: coin.score, ohlcv }),
      });
      const data = await res.json();
      setDsStatus("validated");
      return data;
    } catch(e) {
      setDsStatus("error");
      return { validated: false, reason: e.message };
    }
  }, [fetchKlines]);

  // ── AI Learning Loop ─────────────────────────────────────────
  const runLearning = useCallback(() => {
    if (coins.length === 0) return;
    const updated = history.map(e => {
      if (e.outcome !== null) return e;
      const now = coins.find(c => c.symbol === e.symbol);
      if (!now || Date.now() - e.timestamp < 4 * 3600000) return e;
      const pct = ((now.last - e.price) / e.price) * 100;
      const outcome = (e.signal === "LONG" && pct > 1.5) || (e.signal === "SHORT" && pct < -1.5) ? "win"
                    : (e.signal === "LONG" && pct < -1.5) || (e.signal === "SHORT" && pct > 1.5) ? "loss"
                    : "neutral";
      return { ...e, outcome, priceDiff: pct.toFixed(2), closedPrice: now.last };
    });
    const wins  = updated.filter(h => h.outcome === "win").length;
    const total = updated.filter(h => h.outcome !== null).length;
    const newMem = { ...memory, totalSignals: total, wins };
    setMemory(newMem);
    ls.set("hermes_v2_memory", newMem);
    setHistory(updated);
    ls.set("hermes_v2_history", compressHistory(updated));
  }, [coins, history, memory]);

  // ── Effects ──────────────────────────────────────────────────
  useEffect(() => {
    loadDashboard();
    const t = setInterval(loadDashboard, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (coins.length > 0) runLearning();
  }, [coins]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [aiChat]);

  useEffect(() => {
    if (activeTab === "scanner" && scanData.length === 0) runFullScan();
  }, [activeTab]);

  // ── Multi-Agent Chat ─────────────────────────────────────────
  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatLoading(true);

    const newChat = [...aiChat, { role: "user", content: userMsg }];
    setAiChat(newChat);

    const mktCtx = coins.slice(0, 8).map(c =>
      `${c.short}: $${c.last?.toFixed(4)}, Score=${c.score}/100, ${c.signal?.type}, RSI=${c.rsi}, MACD=${c.macd}, Vol24h=$${(c.volume24h/1e6).toFixed(1)}M, Change=${c.priceChange?.toFixed(2)}%`
    ).join("\n");

    const anomCtx = scanData.filter(s => s.anomaly.type !== "NORMAL").slice(0, 8).map(s =>
      `${s.short}: ${s.anomaly.icon}${s.anomaly.type} | ${s.change?.toFixed(2)}% | $${(s.volume/1e6).toFixed(1)}M vol`
    ).join("\n");

    const recentSig = history.slice(-10).reverse().map(h =>
      `[${new Date(h.timestamp).toLocaleTimeString()}] ${h.symbol} ${h.signal} @ $${h.price?.toFixed(4)} → ${h.outcome || "pending"}`
    ).join("\n");

    const systemPrompt = `Kamu adalah HERMES v2.0 — Hybrid Multi-Agent Crypto Trading System.
Kamu menjalankan dua agen AI:
1. Claude Sonnet 4 (Strategic Planner) — YOU: konteks makro, risk management, portfolio allocation
2. DeepSeek-V3 (Technical Validator) — noise filtering pada OHLCV mentah, konfirmasi teknikal

MARKET DATA REALTIME (4H Timeframe — Top Volume):
${mktCtx}

ANOMALI DETECTOR (Pump/Dump/Breakout saat ini):
${anomCtx || "Tidak ada anomali signifikan terdeteksi"}

SINYAL HISTORY (10 terakhir):
${recentSig || "Belum ada history"}

WIN RATE HERMES: ${winRate}% dari ${memory.totalSignals} sinyal dievaluasi.

INSTRUKSI SISTEM:
- Berikan analisis TAJAM dan SPESIFIK, bukan generik
- Setiap rekomendasi HARUS menyertakan: Entry Zone, Target TP1/TP2, Stop Loss, Risk/Reward
- Hitung SL/TP berdasarkan ATR jika data tersedia
- Bedakan sinyal Small Cap (high risk/high reward) vs Large Cap (konservatif)
- Jika ada anomali PUMP/DUMP, flag sebagai "HIGH PRIORITY ALERT"
- Gunakan framework: Konfirmasi volume → Trend alignment → Momentum → Entry timing
- Jawab dalam Bahasa Indonesia yang profesional dan terstruktur
- DeepSeek-V3 Validator: sebutkan jika sinyal perlu konfirmasi noise filter tambahan`;

    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1200,
          system: systemPrompt,
          messages: newChat.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data  = await r.json();
      const reply = data.content?.[0]?.text || "HERMES tidak dapat merespons.";
      setAiChat([...newChat, { role: "assistant", content: reply }]);
    } catch {
      setAiChat([...newChat, { role: "assistant", content: "⚠ Koneksi ke HERMES terputus. Periksa API key." }]);
    }
    setChatLoading(false);
  };

  // ── Filtered scanner data ────────────────────────────────────
  const filteredScan = useMemo(() => {
    if (scanFilter === "ALL") return scanData;
    return scanData.filter(s => s.anomaly.type === scanFilter);
  }, [scanData, scanFilter]);

  // ╔══════════════════════════════════════════════════════════════╗
  // ║  RENDER                                                     ║
  // ╚══════════════════════════════════════════════════════════════╝
  return (
    <div style={S.root}>
      <style>{CSS_ANIMATIONS}</style>
      <div style={S.scanline} />
      <div style={S.gridBg} />
      <div style={S.glowOrb1} />
      <div style={S.glowOrb2} />

      {/* ── HEADER ────────────────────────────────────────────── */}
      <header style={S.header}>
        <div style={S.headerLeft}>
          <div style={S.logo}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <polygon points="12,2 22,7 22,17 12,22 2,17 2,7" stroke="#00e5a0" strokeWidth="1.5" fill="none"/>
              <polygon points="12,6 18,9 18,15 12,18 6,15 6,9" stroke="#00e5a040" strokeWidth="1"
