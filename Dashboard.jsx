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
              <polygon points="12,6 18,9 18,15 12,18 6,15 6,9" stroke="#00e5a040" strokeWidth="1" fill="#00e5a008"/>
              <circle cx="12" cy="12" r="2" fill="#00e5a0"/>
            </svg>
            <div>
              <div style={S.logoText}>HERMES</div>
              <div style={S.logoSub}>v2.0 · Multi-Agent</div>
            </div>
          </div>
          <div style={S.statusRow}>
            <span style={S.pulseDot}/>
            <span style={S.liveText}>LIVE</span>
          </div>
          <div style={{ ...S.agentBadge, borderColor: "#a78bfa40", color: "#a78bfa" }}>
            ◆ Sonnet 4
          </div>
          <div style={{ ...S.agentBadge,
            borderColor: deepseekStatus === "validated" ? "#00e5a040" : deepseekStatus === "validating" ? "#fbbf2440" : "#33333380",
            color: deepseekStatus === "validated" ? "#00e5a0" : deepseekStatus === "validating" ? "#fbbf24" : "#444"
          }}>
            ◈ DeepSeek-V3 {deepseekStatus === "validating" ? "..." : deepseekStatus === "validated" ? "✓" : deepseekStatus === "error" ? "✗" : ""}
          </div>
        </div>
        <div style={S.headerRight}>
          <Stat label="Win Rate" value={`${winRate}%`} accent="#00e5a0" />
          <Stat label="Sinyal"   value={memory.totalSignals} />
          <Stat label="Pairs"    value={`${scanData.length || "—"}`} accent="#fbbf24" />
          <Stat label="Update"   value={lastUpdate ? lastUpdate.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"} />
          <button onClick={loadDashboard} style={S.refreshBtn} disabled={loading}>
            <span style={loading ? { display:"inline-block", animation:"spin 1s linear infinite" } : {}}>↻</span>
            {loading ? " Scan..." : " Refresh"}
          </button>
        </div>
      </header>

      {/* ── NAV ───────────────────────────────────────────────── */}
      <nav style={S.nav}>
        {[
          ["dashboard", "◈ Dashboard"],
          ["scanner",   "⊛ Full Scanner"],
          ["signals",   "△ Sinyal"],
          ["history",   "◎ History"],
          ["hermes",    "⬡ Hermes AI"],
        ].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)}
            style={{ ...S.navBtn, ...(activeTab === id ? S.navBtnActive : {}) }}>
            {label}
            {id === "scanner" && scanData.filter(s => s.anomaly.type !== "NORMAL").length > 0 && (
              <span style={S.alertBadge}>{scanData.filter(s => s.anomaly.type !== "NORMAL").length}</span>
            )}
          </button>
        ))}
      </nav>

      {/* ══════════════════════════════════════════════════════════
           TAB: DASHBOARD
      ══════════════════════════════════════════════════════════ */}
      {activeTab === "dashboard" && (
        <main style={S.main}>
          {/* Top picks row */}
          <div style={S.topRow}>
            <TopCard title="▲ LONG CANDIDATES" items={topLong} color="#00e5a0" dir="LONG" />
            <TopCard title="▼ SHORT CANDIDATES" items={topShort} color="#ff4466" dir="SHORT" />
            <div style={S.perfCard}>
              <h3 style={S.cardTitle}>⚡ HERMES PERFORMA</h3>
              <PerfRow label="Total Sinyal"   value={memory.totalSignals} />
              <PerfRow label="WIN"            value={memory.wins}           accent="#00e5a0" />
              <PerfRow label="Win Rate"       value={`${winRate}%`}         accent="#00e5a0" />
              <PerfRow label="Pairs Scanned"  value={`${scanData.length || 0}+`} accent="#fbbf24" />
              <PerfRow label="Agents Active"  value="Sonnet 4 + DS-V3"      accent="#a78bfa" />
            </div>
          </div>

          {/* Anomaly alerts from scanner */}
          {scanData.filter(s => s.anomaly.type !== "NORMAL").length > 0 && (
            <div style={S.alertBanner}>
              <span style={S.alertTitle}>⚡ ANOMALI AKTIF —</span>
              {scanData.filter(s => s.anomaly.type !== "NORMAL").slice(0, 6).map(s => (
                <span key={s.symbol} style={{ ...S.alertChip, color: s.anomaly.color, borderColor: s.anomaly.color + "40" }}>
                  {s.anomaly.icon} {s.short} {s.change?.toFixed(1)}%
                </span>
              ))}
            </div>
          )}

          {/* Coin grid */}
          <div style={S.coinGrid}>
            {loading && coins.length === 0 ? (
              <div style={S.loadingBox}>
                <div style={S.spinner}/>
                <p style={{ color: "#555", marginTop: 14, fontSize: 12, letterSpacing: 2 }}>SCANNING BINANCE MARKETS...</p>
              </div>
            ) : coins.map(c => (
              <CoinCard key={c.symbol} coin={c}
                onClick={() => { setSelectedCoin(c); setActiveTab("signals"); }}
                onTrade={() => setTradeModal(c)} />
            ))}
          </div>
        </main>
      )}

      {/* ══════════════════════════════════════════════════════════
           TAB: FULL SCANNER
      ══════════════════════════════════════════════════════════ */}
      {activeTab === "scanner" && (
        <main style={S.main}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={S.sectionTitle}>⊛ Full Binance USDT Scanner</h2>
            <button onClick={runFullScan} style={S.scanBtn} disabled={scanLoading}>
              {scanLoading ? "◌ Scanning..." : "⊛ Scan Now"}
            </button>
          </div>

          {/* Filter bar */}
          <div style={S.filterBar}>
            <div style={S.filterGroup}>
              <span style={S.filterLabel}>ANOMALI</span>
              {["ALL", "PUMP", "DUMP", "BREAKOUT"].map(f => (
                <button key={f} onClick={() => setScanFilter(f)}
                  style={{ ...S.filterBtn, ...(scanFilter === f ? S.filterBtnActive : {}) }}>{f}</button>
              ))}
            </div>
            <div style={S.filterGroup}>
              <span style={S.filterLabel}>SORT</span>
              {[["anomaly","Anomaly"],["change","Change%"],["volume","Volume"]].map(([v,l]) => (
                <button key={v} onClick={() => { setScanSort(v); runFullScan(); }}
                  style={{ ...S.filterBtn, ...(scanSort === v ? S.filterBtnActive : {}) }}>{l}</button>
              ))}
            </div>
            <div style={S.filterGroup}>
              <span style={S.filterLabel}>MIN VOL</span>
              {[[1,"$1M"],[5,"$5M"],[10,"$10M"],[50,"$50M"]].map(([v,l]) => (
                <button key={v} onClick={() => { setMinVol(v); runFullScan(); }}
                  style={{ ...S.filterBtn, ...(minVol === v ? S.filterBtnActive : {}) }}>{l}</button>
              ))}
            </div>
          </div>

          {/* Stats bar */}
          <div style={S.scanStats}>
            <span style={S.scanStatItem}>Total: <b style={{ color: "#e2e8f0" }}>{scanData.length}</b></span>
            <span style={S.scanStatItem}>🚀 Pump: <b style={{ color: "#00e5a0" }}>{scanData.filter(s=>s.anomaly.type==="PUMP").length}</b></span>
            <span style={S.scanStatItem}>💥 Dump: <b style={{ color: "#ff4466" }}>{scanData.filter(s=>s.anomaly.type==="DUMP").length}</b></span>
            <span style={S.scanStatItem}>⚡ Breakout: <b style={{ color: "#fbbf24" }}>{scanData.filter(s=>s.anomaly.type==="BREAKOUT").length}</b></span>
          </div>

          {/* Table header */}
          <div style={S.scanTableHead}>
            <span style={{ flex: 1.2 }}>PAIR</span>
            <span style={{ flex: 1 }}>ANOMALI</span>
            <span style={{ flex: 1, textAlign:"right" }}>PRICE</span>
            <span style={{ flex: 1, textAlign:"right" }}>CHANGE 24H</span>
            <span style={{ flex: 1.2, textAlign:"right" }}>VOL 24H</span>
            <span style={{ flex: 1, textAlign:"right" }}>TRADES</span>
            <span style={{ flex: 0.8, textAlign:"center" }}>ACTION</span>
          </div>

          {scanLoading ? (
            <div style={{ ...S.loadingBox, padding: 40 }}>
              <div style={S.spinner}/>
              <p style={{ color: "#555", marginTop: 12, fontSize: 12 }}>SCANNING {(minVol)}M+ VOLUME PAIRS...</p>
            </div>
          ) : filteredScan.map((row, i) => (
            <ScannerRow key={row.symbol} row={row} rank={i+1} onDeepDive={() => deepDiveCoin(row)} />
          ))}
          {!scanLoading && filteredScan.length === 0 && (
            <div style={{ textAlign: "center", padding: 40, color: "#444", fontSize: 13 }}>
              Belum ada data. Klik "⊛ Scan Now" untuk memulai.
            </div>
          )}
        </main>
      )}

      {/* ══════════════════════════════════════════════════════════
           TAB: SIGNALS
      ══════════════════════════════════════════════════════════ */}
      {activeTab === "signals" && (
        <main style={S.main}>
          <h2 style={S.sectionTitle}>△ Analisis Sinyal Detail</h2>
          {(selectedCoin ? [selectedCoin, ...coins.filter(c => c.symbol !== selectedCoin?.symbol)] : coins).map(c => (
            <SignalDetail key={c.symbol} coin={c}
              onValidate={() => validateWithDeepSeek(c)}
              onTrade={() => setTradeModal(c)} />
          ))}
          {coins.length === 0 && <p style={{ color: "#555", textAlign: "center", padding: 40 }}>Memuat data teknikal...</p>}
        </main>
      )}

      {/* ══════════════════════════════════════════════════════════
           TAB: HISTORY
      ══════════════════════════════════════════════════════════ */}
      {activeTab === "history" && (
        <main style={S.main}>
          <h2 style={S.sectionTitle}>◎ Signal History & Performance</h2>
          <div style={S.histStats}>
            {[
              ["Total",   history.length,                                     "#e2e8f0"],
              ["WIN ✅",  history.filter(h=>h.outcome==="win").length,         "#00e5a0"],
              ["LOSS ❌", history.filter(h=>h.outcome==="loss").length,        "#ff4466"],
              ["Pending ⏳", history.filter(h=>!h.outcome||h.outcome==="neutral").length, "#fbbf24"],
            ].map(([l,v,c]) => (
              <div key={l} style={S.hStat}>
                <span style={{ fontSize: 11, color: "#555", letterSpacing: 1 }}>{l}</span>
                <strong style={{ fontSize: 22, color: c }}>{v}</strong>
              </div>
            ))}
          </div>
          {history.slice().reverse().map(e => (
            <HistoryRow key={e.id} entry={e} />
          ))}
          {history.length === 0 && <p style={{ color:"#444", textAlign:"center", padding: 40 }}>Belum ada sinyal tercatat.</p>}
        </main>
      )}

      {/* ══════════════════════════════════════════════════════════
           TAB: HERMES AI (Multi-Agent Chat)
      ══════════════════════════════════════════════════════════ */}
      {activeTab === "hermes" && (
        <main style={{ ...S.main, maxWidth: 860, margin: "0 auto" }}>
          <h2 style={S.sectionTitle}>⬡ Hermes Multi-Agent Console</h2>
          <div style={S.agentInfo}>
            <div style={S.agentBox}>
              <span style={{ color: "#a78bfa", fontWeight: 700 }}>◆ AGENT 1: Claude Sonnet 4</span>
              <span style={{ color: "#555", fontSize: 12 }}>Strategic Planner · Macro Context · Risk Management</span>
            </div>
            <div style={S.agentBox}>
              <span style={{ color: "#00e5a0", fontWeight: 700 }}>◈ AGENT 2: DeepSeek-V3</span>
              <span style={{ color: "#555", fontSize: 12 }}>Technical Validator · OHLCV Noise Filter · Low Temperature (0.1)</span>
            </div>
          </div>

          <div style={S.chatBox}>
            {aiChat.map((msg, i) => (
              <div key={i} style={{ ...S.chatMsg, ...(msg.role === "user" ? S.chatUser : S.chatBot) }}>
                <span style={S.chatRole}>{msg.role === "user" ? "YOU" : "⬡ HERMES"}</span>
                <p style={S.chatText}>{msg.content}</p>
              </div>
            ))}
            {chatLoading && (
              <div style={{ ...S.chatMsg, ...S.chatBot }}>
                <span style={S.chatRole}>⬡ HERMES</span>
                <p style={{ ...S.chatText, color: "#444" }}>◌◌◌ Menganalisis pasar &amp; mengkoordinasi agents...</p>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div style={S.chatInputRow}>
            <input style={S.chatInput} value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendChat()}
              placeholder="Tanya HERMES: sinyal small cap terbaik, anomali PUMP hari ini, entry SOL short..." />
            <button style={S.sendBtn} onClick={sendChat} disabled={chatLoading}>
              {chatLoading ? "◌" : "▶"}
            </button>
          </div>
          <div style={S.quickPrompts}>
            {[
              "Anomali pump/dump apa saja hari ini?",
              "Sinyal LONG terkuat dari full scan",
              "Analisis RSI extreme market wide",
              "Rekomendasi entry BTCUSDT sekarang",
              "Small cap yg sedang breakout volume",
              "Risk management sizing optimal",
            ].map(q => (
              <button key={q} style={S.quickBtn} onClick={() => setChatInput(q)}>{q}</button>
            ))}
          </div>
        </main>
      )}

      {/* ── Trade Modal ──────────────────────────────────────────── */}
      {tradeModal && (
        <TradeModal coin={tradeModal} onClose={() => setTradeModal(null)} />
      )}

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer style={S.footer}>
        <span style={{ color: "#00e5a0" }}>⬡ HERMES v2.0</span>
        <Sep/>
        <span>Claude Sonnet 4 + DeepSeek-V3</span>
        <Sep/>
        <span>Binance Full USDT Scanner</span>
        <Sep/>
        <span style={{ color: "#555" }}>Interval: 4H</span>
        <Sep/>
        <span style={{ color: "#ff4466" }}>⚠ Bukan financial advice</span>
      </footer>
    </div>
  );
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  SUB-COMPONENTS                                             ║
// ╚══════════════════════════════════════════════════════════════╝

function Sep() { return <span style={{ color: "#222" }}>│</span>; }

function Stat({ label, value, accent = "#e2e8f0" }) {
  return (
    <div style={S.statBadge}>
      <span style={S.statLabel}>{label}</span>
      <span style={{ ...S.statVal, color: accent }}>{value}</span>
    </div>
  );
}

function TopCard({ title, items, color, dir }) {
  return (
    <div style={S.topCard}>
      <h3 style={{ ...S.cardTitle, color }}>{title}</h3>
      {items.length === 0
        ? <p style={{ color: "#333", fontSize: 12 }}>Tidak ada sinyal {dir} kuat</p>
        : items.map(c => (
          <div key={c.symbol} style={S.topItem}>
            <span style={{ fontWeight: 700, color: "#e2e8f0", fontSize: 14 }}>{c.short}</span>
            <span style={{ color, fontSize: 13 }}>{c.score}/100</span>
            <span style={{ color: "#666", fontSize: 12 }}>${c.last?.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
          </div>
        ))
      }
    </div>
  );
}

function PerfRow({ label, value, accent = "#777" }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:"1px solid rgba(255,255,255,0.03)", fontSize:12 }}>
      <span style={{ color:"#555" }}>{label}</span>
      <strong style={{ color: accent }}>{value}</strong>
    </div>
  );
}

function CoinCard({ coin, onClick, onTrade }) {
  const c = coin.priceChange || 0;
  const sc = coin.score;
  const barColor = sc > 65 ? "#00e5a0" : sc < 35 ? "#ff4466" : "#fbbf24";
  return (
    <div style={S.coinCard} onClick={onClick}>
      <div style={S.coinCardTop}>
        <div>
          <div style={S.coinSymbol}>{coin.short}</div>
          <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>${(coin.volume24h/1e6).toFixed(1)}M vol</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4 }}>
          <div style={{ ...S.sigChip, background: coin.signal?.color+"18", border:`1px solid ${coin.signal?.color}35`, color: coin.signal?.color }}>
            {coin.signal?.emoji} {coin.signal?.type}
          </div>
          {coin.anomaly?.type !== "NORMAL" && (
            <div style={{ fontSize: 10, color: coin.anomaly?.color }}>{coin.anomaly?.icon} {coin.anomaly?.type}</div>
          )}
        </div>
      </div>
      <div style={S.scoreRow}>
        <div style={S.scoreBarBg}>
          <div style={{ ...S.scoreBarFill, width:`${sc}%`, background: barColor }}/>
        </div>
        <span style={{ fontSize:12, fontWeight:700, color: barColor, minWidth:28, textAlign:"right" }}>{sc}</span>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <span style={{ fontSize:15, fontWeight:700 }}>${coin.last?.toLocaleString(undefined,{maximumFractionDigits:coin.last>1?2:6})}</span>
        <span style={{ color: c>=0?"#00e5a0":"#ff4466", fontSize:12 }}>{c>=0?"+":""}{c.toFixed(2)}%</span>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#444" }}>
        <span>RSI <b style={{ color:"#777" }}>{coin.rsi}</b></span>
        <span>EMA20 <b style={{ color:"#777" }}>{parseFloat(coin.ema20)>coin.last?"↑":"↓"}</b></span>
        <span>Vol <b style={{ color: coin.volRatio>1.5?"#00e5a0":"#777" }}>{coin.volRatio?.toFixed(1)}x</b></span>
      </div>
      <button style={S.tradeBtn} onClick={e => { e.stopPropagation(); onTrade(); }}>⚡ Trade Setup</button>
    </div>
  );
}

function ScannerRow({ row, rank, onDeepDive }) {
  const isAnomaly = row.anomaly.type !== "NORMAL";
  return (
    <div style={{ ...S.scanRow, background: isAnomaly ? `${row.anomaly.color}06` : "transparent", borderColor: isAnomaly ? `${row.anomaly.color}20` : "rgba(255,255,255,0.04)" }}>
      <span style={{ flex: 1.2, display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ color:"#333", fontSize:11, minWidth:20 }}>#{rank}</span>
        <strong style={{ color:"#e2e8f0" }}>{row.short}</strong>
        <span style={{ fontSize:10, color:"#444" }}>USDT</span>
      </span>
      <span style={{ flex:1 }}>
        <span style={{ ...S.anomalyChip, color: row.anomaly.color, borderColor: row.anomaly.color+"40", background: row.anomaly.color+"10" }}>
          {row.anomaly.icon} {row.anomaly.type}
        </span>
      </span>
      <span style={{ flex:1, textAlign:"right", fontSize:13, color:"#e2e8f0" }}>
        ${row.price < 0.01 ? row.price.toFixed(6) : row.price < 1 ? row.price.toFixed(4) : row.price.toFixed(2)}
      </span>
      <span style={{ flex:1, textAlign:"right", fontSize:13, fontWeight:700, color: row.change>=0?"#00e5a0":"#ff4466" }}>
        {row.change>=0?"+":""}{row.change.toFixed(2)}%
      </span>
      <span style={{ flex:1.2, textAlign:"right", fontSize:12, color:"#888" }}>
        ${row.volume >= 1e9 ? (row.volume/1e9).toFixed(2)+"B" : (row.volume/1e6).toFixed(1)+"M"}
      </span>
      <span style={{ flex:1, textAlign:"right", fontSize:11, color:"#555" }}>
        {(row.trades/1000).toFixed(0)}K
      </span>
      <span style={{ flex:0.8, textAlign:"center" }}>
        <button style={S.deepDiveBtn} onClick={onDeepDive}>▶ Analisis</button>
      </span>
    </div>
  );
}

function SignalDetail({ coin, onValidate, onTrade }) {
  const [open, setOpen] = useState(false);
  const c = coin.priceChange || 0;
  const sl = coin.signal?.type === "LONG" ? (coin.last * (1 - coin.slPct/100)).toFixed(4) : (coin.last * (1 + coin.slPct/100)).toFixed(4);
  const tp1 = coin.signal?.type === "LONG" ? (coin.last * (1 + coin.tpPct/100)).toFixed(4) : (coin.last * (1 - coin.tpPct/100)).toFixed(4);
  const tp2 = coin.signal?.type === "LONG" ? (coin.last * (1 + coin.tpPct/100*2)).toFixed(4) : (coin.last * (1 - coin.tpPct/100*2)).toFixed(4);
  const rr  = (coin.tpPct / coin.slPct).toFixed(2);

  return (
    <div style={S.sigCard}>
      <div style={S.sigHeader} onClick={() => setOpen(!open)}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ fontWeight:700, fontSize:16, color:"#e2e8f0", minWidth:60 }}>{coin.short}</span>
          <div style={{ ...S.sigChip, background:coin.signal?.color+"18", border:`1px solid ${coin.signal?.color}35`, color:coin.signal?.color }}>
            {coin.signal?.emoji} {coin.signal?.type}
          </div>
          {coin.anomaly?.type !== "NORMAL" && (
            <div style={{ ...S.sigChip, background:coin.anomaly?.color+"10", border:`1px solid ${coin.anomaly?.color}30`, color:coin.anomaly?.color }}>
              {coin.anomaly?.icon} {coin.anomaly?.type}
            </div>
          )}
          <span style={{ fontSize:14, color:"#888" }}>${coin.last?.toLocaleString(undefined,{maximumFractionDigits:4})}</span>
          <span style={{ color:c>=0?"#00e5a0":"#ff4466", fontSize:13 }}>{c>=0?"+":""}{c.toFixed(2)}%</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:16 }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4 }}>
            <span style={{ fontSize:11, color:"#00e5a0" }}>{coin.score}/100</span>
            <div style={{ width:100, height:3, background:"rgba(255,255,255,0.06)", borderRadius:2, overflow:"hidden" }}>
              <div style={{ width:`${coin.score}%`, height:"100%", background: coin.score>65?"#00e5a0":coin.score<35?"#ff4466":"#fbbf24", borderRadius:2 }}/>
            </div>
          </div>
          <span style={{ color:"#333", fontSize:18 }}>{open?"▲":"▼"}</span>
        </div>
      </div>

      {open && (
        <div style={S.sigBody}>
          {/* Indicators grid */}
          <div style={S.indGrid}>
            {[
              ["RSI (14)", coin.rsi, coin.rsi<30?"Oversold 🟢":coin.rsi>70?"Overbought 🔴":"Neutral", coin.rsi<30?"#00e5a0":coin.rsi>70?"#ff4466":"#e2e8f0"],
              ["MACD", coin.macd, parseFloat(coin.macd)>0?"Bullish ↑":"Bearish ↓", parseFloat(coin.macd)>0?"#00e5a0":"#ff4466"],
              ["EMA 20", `$${parseFloat(coin.ema20)?.toLocaleString(undefined,{maximumFractionDigits:4})}`, coin.last>parseFloat(coin.ema20)?"Price Above ✓":"Price Below ✗", "#e2e8f0"],
              ["EMA 50", `$${parseFloat(coin.ema50)?.toLocaleString(undefined,{maximumFractionDigits:4})}`, coin.last>parseFloat(coin.ema50)?"Bullish":"Bearish", "#e2e8f0"],
              ["EMA 200", `$${parseFloat(coin.ema200)?.toLocaleString(undefined,{maximumFractionDigits:4})}`, coin.last>parseFloat(coin.ema200)?"Bull Market":"Bear Market", "#e2e8f0"],
              ["BB Width", `${coin.bb?.width?.toFixed(2)}%`, coin.bb?.width>5?"Volatile":"Squeeze", coin.bb?.width>5?"#fbbf24":"#e2e8f0"],
              ["Vol Ratio", `${coin.volRatio?.toFixed(2)}x`, coin.volRatio>1.5?"Surge 🔥":"Normal", coin.volRatio>1.5?"#00e5a0":"#777"],
              ["ATR", `$${coin.atr?.toFixed(4)}`, "Volatility Unit", "#e2e8f0"],
            ].map(([label, val, note, color]) => (
              <div key={label} style={S.indItem}>
                <span style={{ fontSize:10, color:"#444", letterSpacing:1 }}>{label}</span>
                <span style={{ fontSize:15, fontWeight:700, color }}>{val}</span>
                <span style={{ fontSize:11, color:"#555" }}>{note}</span>
              </div>
            ))}
          </div>

          {/* Trade setup */}
          {coin.signal?.type !== "NEUTRAL" && (
            <div style={S.tradeSetup}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <h4 style={{ fontSize:13, color:coin.signal.color, letterSpacing:1, margin:0 }}>
                  {coin.signal.type === "LONG" ? "📈 SETUP LONG (ATR-based)" : "📉 SETUP SHORT (ATR-based)"}
                </h4>
                <div style={{ display:"flex", gap:8 }}>
                  <button style={S.validateBtn} onClick={onValidate}>◈ DeepSeek Validate</button>
                  <button style={{ ...S.validateBtn, color:"#fbbf24", borderColor:"#fbbf2440" }} onClick={onTrade}>⚡ Execute</button>
                </div>
              </div>
              <div style={S.tradeGrid}>
                {[
                  ["Entry", `$${coin.last?.toFixed(4)}`, "#e2e8f0"],
                  ["TP1 (+"+coin.tpPct+"%)", `$${tp1}`, "#00e5a0"],
                  ["TP2 (+"+(coin.tpPct*2).toFixed(2)+"%)", `$${tp2}`, "#00e5a080"],
                  ["Stop Loss (-"+coin.slPct+"%)", `$${sl}`, "#ff4466"],
                  ["R:R Ratio", `1:${rr}`, rr>=2?"#00e5a0":"#fbbf24"],
                  ["ATR", `$${coin.atr?.toFixed(4)}`, "#888"],
                ].map(([l,v,c]) => (
                  <div key={l} style={{ display:"flex", flexDirection:"column", gap:4, fontSize:13 }}>
                    <span style={{ color:"#555", fontSize:11 }}>{l}</span>
                    <strong style={{ color:c }}>{v}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ entry }) {
  const c = parseFloat(entry.priceDiff || 0);
  return (
    <div style={S.histRow}>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <strong style={{ color:"#e2e8f0", minWidth:55 }}>{(entry.symbol||"").replace("USDT","")}</strong>
        <span style={{ ...S.sigChip, background:entry.signal==="LONG"?"#00e5a020":"#ff446620", color:entry.signal==="LONG"?"#00e5a0":"#ff4466", border:`1px solid ${entry.signal==="LONG"?"#00e5a040":"#ff446640"}` }}>
          {entry.signal==="LONG"?"▲":"▼"} {entry.signal}
        </span>
        <span style={{ fontSize:11, color:"#444" }}>Sc:{entry.score}</span>
      </div>
      <div style={{ display:"flex", gap:16, fontSize:12 }}>
        <span style={{ color:"#666" }}>Entry: <b style={{ color:"#888" }}>${parseFloat(entry.price||0).toFixed(4)}</b></span>
        {entry.closedPrice && <span style={{ color:"#666" }}>Close: <b style={{ color:c>=0?"#00e5a080":"#ff446680" }}>${parseFloat(entry.closedPrice).toFixed(4)}</b></span>}
        {entry.priceDiff  && <span style={{ color:c>=0?"#00e5a0":"#ff4466" }}>{c>=0?"+":""}{c.toFixed(2)}%</span>}
      </div>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4 }}>
        <span style={{ fontSize:11, color:"#333" }}>{new Date(entry.timestamp).toLocaleString("id-ID")}</span>
        <span style={{ fontSize:12, fontWeight:700, color:entry.outcome==="win"?"#00e5a0":entry.outcome==="loss"?"#ff4466":"#555" }}>
          {entry.outcome==="win"?"✅ WIN":entry.outcome==="loss"?"❌ LOSS":"⏳ Pending"}
        </span>
      </div>
    </div>
  );
}

function TradeModal({ coin, onClose }) {
  const [amount, setAmount]   = useState("100");
  const [leverage, setLev]    = useState("5");
  const [executing, setExec]  = useState(false);
  const [result, setResult]   = useState(null);

  const executeTrade = async () => {
    setExec(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol:   coin.symbol,
          side:     coin.signal?.type,          // "LONG" | "SHORT"
          amount:   parseFloat(amount),
          leverage: parseInt(leverage),
          slPct:    parseFloat(coin.slPct),
          tpPct:    parseFloat(coin.tpPct),
        }),
      });
      const data = await res.json();
      setResult(data);
    } catch(e) {
      setResult({ error: e.message });
    }
    setExec(false);
  };

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:20 }}>
          <h3 style={{ color:coin.signal?.color, fontSize:16, margin:0 }}>
            ⚡ Execute {coin.signal?.type} — {coin.short}
          </h3>
          <button style={{ background:"none", border:"none", color:"#555", cursor:"pointer", fontSize:18 }} onClick={onClose}>✕</button>
        </div>

        <div style={S.tradeGrid}>
          {[
            ["Entry Price", `$${coin.last?.toFixed(4)}`, "#e2e8f0"],
            ["Signal Score", `${coin.score}/100`, "#00e5a0"],
            ["Stop Loss", `-${coin.slPct}%`, "#ff4466"],
            ["Take Profit", `+${coin.tpPct}%`, "#00e5a0"],
          ].map(([l,v,c]) => (
            <div key={l} style={{ display:"flex", flexDirection:"column", gap:4, padding:"10px 14px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:6 }}>
              <span style={{ fontSize:11, color:"#555" }}>{l}</span>
              <strong style={{ color:c }}>{v}</strong>
            </div>
          ))}
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginTop:16 }}>
          <div>
            <label style={{ fontSize:11, color:"#555", letterSpacing:1 }}>AMOUNT (USDT)</label>
            <input value={amount} onChange={e=>setAmount(e.target.value)}
              style={{ ...S.chatInput, marginTop:6, width:"100%", boxSizing:"border-box" }} />
          </div>
          <div>
            <label style={{ fontSize:11, color:"#555", letterSpacing:1 }}>LEVERAGE</label>
            <div style={{ display:"flex", gap:6, marginTop:6 }}>
              {["1","3","5","10","20"].map(l => (
                <button key={l} onClick={()=>setLev(l)}
                  style={{ ...S.filterBtn, ...(leverage===l?S.filterBtnActive:{}), flex:1, padding:"8px 4px" }}>{l}x</button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop:16, padding:"12px 16px", background:"rgba(255,200,0,0.04)", border:"1px solid rgba(255,200,0,0.1)", borderRadius:8, fontSize:12, color:"#777" }}>
          ⚠ Eksekusi via <b style={{ color:"#fbbf24" }}>Binance Futures API</b>. Pastikan environment variable BINANCE_API_KEY dan BINANCE_SECRET_KEY sudah dikonfigurasi di backend. Cek SETUP.md untuk instruksi lengkap.
        </div>

        {result && (
          <div style={{ marginTop:12, padding:"12px 16px", background: result.error?"rgba(255,68,102,0.05)":"rgba(0,229,160,0.05)", border:`1px solid ${result.error?"#ff446630":"#00e5a030"}`, borderRadius:8, fontSize:12 }}>
            {result.error ? `❌ Error: ${result.error}` : `✅ Order berhasil! ID: ${result.orderId || JSON.stringify(result)}`}
          </div>
        )}

        <button style={{ ...S.scanBtn, width:"100%", marginTop:16, opacity: !BACKEND_URL ? 0.4 : 1 }}
          onClick={executeTrade} disabled={executing || !BACKEND_URL}>
          {executing ? "◌ Executing..." : !BACKEND_URL ? "Backend belum dikonfigurasi" : `⚡ Execute ${coin.signal?.type} — $${amount} x${leverage}L`}
        </button>
      </div>
    </div>
  );
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  STYLES                                                     ║
// ╚══════════════════════════════════════════════════════════════╝
const S = {
  root: { minHeight:"100vh", background:"#060810", color:"#e2e8f0", fontFamily:"'JetBrains Mono','Courier New',monospace", position:"relative", overflow:"hidden" },
  scanline: { position:"fixed", inset:0, background:"repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)", pointerEvents:"none", zIndex:1 },
  gridBg: { position:"fixed", inset:0, backgroundImage:"linear-gradient(rgba(0,229,160,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,160,0.025) 1px,transparent 1px)", backgroundSize:"48px 48px", pointerEvents:"none", zIndex:0 },
  glowOrb1: { position:"fixed", top:-300, left:-200, width:700, height:700, borderRadius:"50%", background:"radial-gradient(circle,rgba(0,229,160,0.05) 0%,transparent 70%)", pointerEvents:"none", zIndex:0 },
  glowOrb2: { position:"fixed", bottom:-300, right:-200, width:600, height:600, borderRadius:"50%", background:"radial-gradient(circle,rgba(167,139,250,0.04) 0%,transparent 70%)", pointerEvents:"none", zIndex:0 },
  header: { position:"relative", zIndex:10, display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 24px", background:"rgba(6,8,16,0.95)", borderBottom:"1px solid rgba(0,229,160,0.08)", backdropFilter:"blur(16px)" },
  headerLeft: { display:"flex", alignItems:"center", gap:16 },
  logo: { display:"flex", alignItems:"center", gap:10 },
  logoText: { fontSize:20, fontWeight:700, color:"#00e5a0", letterSpacing:5 },
  logoSub: { fontSize:9, color:"#2a4a3a", letterSpacing:3, marginTop:1 },
  statusRow: { display:"flex", alignItems:"center", gap:6 },
  pulseDot: { width:7, height:7, borderRadius:"50%", background:"#00e5a0", boxShadow:"0 0 0 0 rgba(0,229,160,0.4)", animation:"pulse 2s infinite", display:"inline-block" },
  liveText: { fontSize:10, color:"#00e5a0", letterSpacing:2 },
  agentBadge: { fontSize:11, padding:"4px 10px", border:"1px solid", borderRadius:4, letterSpacing:1 },
  headerRight: { display:"flex", alignItems:"center", gap:12 },
  statBadge: { display:"flex", flexDirection:"column", alignItems:"center", padding:"5px 12px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:6 },
  statLabel: { fontSize:9, color:"#444", letterSpacing:1 },
  statVal: { fontSize:13, fontWeight:700 },
  refreshBtn: { padding:"8px 16px", background:"rgba(0,229,160,0.08)", border:"1px solid rgba(0,229,160,0.25)", borderRadius:6, color:"#00e5a0", cursor:"pointer", fontSize:13, letterSpacing:1 },
  nav: { position:"relative", zIndex:10, display:"flex", gap:4, padding:"8px 24px", background:"rgba(6,8,16,0.9)", borderBottom:"1px solid rgba(255,255,255,0.04)" },
  navBtn: { padding:"8px 18px", background:"transparent", border:"1px solid transparent", borderRadius:6, color:"#444", cursor:"pointer", fontSize:12, letterSpacing:0.5, position:"relative" },
  navBtnActive: { background:"rgba(0,229,160,0.06)", border:"1px solid rgba(0,229,160,0.18)", color:"#00e5a0" },
  alertBadge: { position:"absolute", top:-4, right:-4, background:"#ff4466", color:"#fff", fontSize:9, borderRadius:10, padding:"1px 5px", fontWeight:700 },
  main: { position:"relative", zIndex:10, padding:"24px 24px 100px" },
  sectionTitle: { fontSize:16, color:"#00e5a0", marginBottom:20, letterSpacing:3, margin:"0 0 20px" },
  topRow: { display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:16, marginBottom:20 },
  topCard: { padding:18, background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10 },
  perfCard: { padding:18, background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10 },
  cardTitle: { fontSize:11, letterSpacing:2, marginBottom:14, marginTop:0 },
  topItem: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 0", borderBottom:"1px solid rgba(255,255,255,0.03)" },
  alertBanner: { display:"flex", alignItems:"center", gap:10, padding:"10px 16px", background:"rgba(251,191,36,0.04)", border:"1px solid rgba(251,191,36,0.1)", borderRadius:8, marginBottom:20, flexWrap:"wrap" },
  alertTitle: { fontSize:12, color:"#fbbf24", letterSpacing:1, fontWeight:700 },
  alertChip: { fontSize:11, padding:"3px 10px", border:"1px solid", borderRadius:4 },
  coinGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))", gap:12 },
  loadingBox: { gridColumn:"1/-1", display:"flex", flexDirection:"column", alignItems:"center", padding:60 },
  spinner: { width:36, height:36, border:"2px solid rgba(0,229,160,0.15)", borderTopColor:"#00e5a0", borderRadius:"50%", animation:"spin 1s linear infinite" },
  coinCard: { padding:16, background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10, cursor:"pointer", transition:"border-color 0.2s" },
  coinCardTop: { display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 },
  coinSymbol: { fontSize:17, fontWeight:700, color:"#e2e8f0" },
  sigChip: { fontSize:10, padding:"3px 9px", borderRadius:20, fontWeight:600, letterSpacing:1 },
  scoreRow: { display:"flex", alignItems:"center", gap:8, marginBottom:10 },
  scoreBarBg: { flex:1, height:3, background:"rgba(255,255,255,0.05)", borderRadius:2, overflow:"hidden" },
  scoreBarFill: { height:"100%", borderRadius:2, transition:"width 0.5s" },
  tradeBtn: { width:"100%", marginTop:10, padding:"7px 0", background:"rgba(251,191,36,0.06)", border:"1px solid rgba(251,191,36,0.15)", borderRadius:6, color:"#fbbf24", cursor:"pointer", fontSize:11, letterSpacing:1 },
  filterBar: { display:"flex", flexWrap:"wrap", gap:20, marginBottom:16, padding:"14px 18px", background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10 },
  filterGroup: { display:"flex", alignItems:"center", gap:6 },
  filterLabel: { fontSize:10, color:"#444", letterSpacing:1, marginRight:2 },
  filterBtn: { padding:"5px 12px", background:"transparent", border:"1px solid rgba(255,255,255,0.06)", borderRadius:4, color:"#555", cursor:"pointer", fontSize:11 },
  filterBtnActive: { background:"rgba(0,229,160,0.08)", border:"1px solid rgba(0,229,160,0.25)", color:"#00e5a0" },
  scanStats: { display:"flex", gap:24, marginBottom:12, fontSize:12, color:"#555" },
  scanStatItem: {},
  scanBtn: { padding:"9px 20px", background:"rgba(0,229,160,0.1)", border:"1px solid rgba(0,229,160,0.3)", borderRadius:6, color:"#00e5a0", cursor:"pointer", fontSize:13, letterSpacing:1 },
  scanTableHead: { display:"flex", alignItems:"center", padding:"10px 16px", background:"rgba(0,229,160,0.03)", borderBottom:"1px solid rgba(0,229,160,0.08)", fontSize:10, color:"#444", letterSpacing:2, marginBottom:4 },
  scanRow: { display:"flex", alignItems:"center", padding:"12px 16px", border:"1px solid", borderRadius:6, marginBottom:4, transition:"background 0.2s" },
  anomalyChip: { fontSize:11, padding:"3px 9px", border:"1px solid", borderRadius:4, fontWeight:600 },
  deepDiveBtn: { padding:"5px 12px", background:"rgba(0,229,160,0.06)", border:"1px solid rgba(0,229,160,0.2)", borderRadius:4, color:"#00e5a0", cursor:"pointer", fontSize:11 },
  sigCard: { background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10, marginBottom:8, overflow:"hidden" },
  sigHeader: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 20px", cursor:"pointer" },
  sigBody: { padding:"16px 20px 20px", borderTop:"1px solid rgba(255,255,255,0.04)" },
  indGrid: { display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:14 },
  indItem: { padding:12, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.04)", borderRadius:8, display:"flex", flexDirection:"column", gap:4 },
  tradeSetup: { padding:16, background:"rgba(0,229,160,0.03)", border:"1px solid rgba(0,229,160,0.1)", borderRadius:8 },
  tradeGrid: { display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginTop:10 },
  validateBtn: { padding:"5px 12px", background:"rgba(0,229,160,0.06)", border:"1px solid rgba(0,229,160,0.2)", borderRadius:4, color:"#00e5a0", cursor:"pointer", fontSize:11 },
  histStats: { display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:20 },
  hStat: { padding:"14px 18px", background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:8, display:"flex", flexDirection:"column", gap:6 },
  histRow: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"13px 18px", background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.04)", borderRadius:8, marginBottom:6, flexWrap:"wrap", gap:12 },
  agentInfo: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:20 },
  agentBox: { padding:"12px 16px", background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:8, display:"flex", flexDirection:"column", gap:4 },
  chatBox: { height:420, overflowY:"auto", padding:20, background:"rgba(255,255,255,0.01)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:10, marginBottom:12, display:"flex", flexDirection:"column", gap:14 },
  chatMsg: { padding:"12px 16px", borderRadius:8, maxWidth:"86%" },
  chatBot: { background:"rgba(0,229,160,0.04)", border:"1px solid rgba(0,229,160,0.1)", alignSelf:"flex-start" },
  chatUser: { background:"rgba(167,139,250,0.06)", border:"1px solid rgba(167,139,250,0.12)", alignSelf:"flex-end" },
  chatRole: { fontSize:9, color:"#444", letterSpacing:2, marginBottom:4, display:"block" },
  chatText: { fontSize:13, lineHeight:1.7, color:"#bbb", whiteSpace:"pre-wrap", margin:0 },
  chatInputRow: { display:"flex", gap:10 },
  chatInput: { flex:1, padding:"11px 16px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:8, color:"#e2e8f0", fontSize:13, fontFamily:"inherit", outline:"none" },
  sendBtn: { padding:"11px 18px", background:"rgba(0,229,160,0.12)", border:"1px solid rgba(0,229,160,0.25)", borderRadius:8, color:"#00e5a0", cursor:"pointer", fontSize:16 },
  quickPrompts: { display:"flex", gap:8, flexWrap:"wrap", marginTop:10 },
  quickBtn: { padding:"5px 12px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:16, color:"#555", cursor:"pointer", fontSize:11 },
  modalOverlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center" },
  modal: { background:"#0d1117", border:"1px solid rgba(0,229,160,0.15)", borderRadius:14, padding:28, width:"min(560px, 90vw)", maxHeight:"90vh", overflowY:"auto" },
  footer: { position:"fixed", bottom:0, left:0, right:0, padding:"9px 24px", background:"rgba(6,8,16,0.98)", borderTop:"1px solid rgba(255,255,255,0.04)", display:"flex", gap:14, alignItems:"center", fontSize:10, color:"#444", zIndex:20, letterSpacing:1 },
};

const CSS_ANIMATIONS = `
  @keyframes pulse { 0%,100% { box-shadow:0 0 0 0 rgba(0,229,160,0.4); } 50% { box-shadow:0 0 0 6px rgba(0,229,160,0); } }
  @keyframes spin   { to { transform:rotate(360deg); } }
`;
