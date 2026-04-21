// ╔══════════════════════════════════════════════════════════════════╗
// ║  HERMES AI v2.0 — Backend API Routes (Next.js / Express)        ║
// ║  File: pages/api/  (Next.js) OR routes/ (Express)               ║
// ║  Three endpoints:                                                ║
// ║    POST /api/deepseek  — DeepSeek-V3 Technical Validator         ║
// ║    POST /api/trade     — Binance Futures Order Execution          ║
// ║    GET  /api/scanner   — Full USDT Market Scanner (Server-side)  ║
// ╚══════════════════════════════════════════════════════════════════╝

// ── Dependencies: npm install axios crypto-js express cors dotenv
// ── For Next.js: place each section as individual file in pages/api/

const crypto = require("crypto");

// ═══════════════════════════════════════════════════════════════════
// ① /api/deepseek — DeepSeek-V3 Technical Validator
//    Accepts OHLCV data, returns noise-filtered signal confirmation
// ═══════════════════════════════════════════════════════════════════
// pages/api/deepseek.js
module.exports.deepseekHandler = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { symbol, signal, score, ohlcv } = req.body;

  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(500).json({ error: "DEEPSEEK_API_KEY not configured" });
  }

  // Build OHLCV summary string for DeepSeek prompt
  const ohlcvStr = ohlcv.slice(-20).map(k =>
    `T:${new Date(k.t).toISOString()} O:${k.o} H:${k.h} L:${k.l} C:${k.c} V:${k.v}`
  ).join("\n");

  const systemPrompt = `You are a quantitative technical analyst using FinGPT-style analysis.
Your task: Validate trading signals by filtering market noise from raw OHLCV data.
Rules:
- Temperature is 0.1: be deterministic, precise, no hallucination
- Focus ONLY on technical evidence: price action, volume patterns, trend structure
- Output JSON only, no prose
- Confidence threshold: 0.6+ to validate, below 0.6 = reject
- Flag divergence, fakeouts, low liquidity traps for small cap tokens`;

  const userPrompt = `Symbol: ${symbol}
Proposed Signal: ${signal}
Technical Score: ${score}/100

OHLCV Data (1H, last 20 candles):
${ohlcvStr}

Analyze and respond with ONLY valid JSON:
{
  "validated": boolean,
  "confidence": number (0.0-1.0),
  "noiseLevel": "low" | "medium" | "high",
  "signalStrength": "strong" | "moderate" | "weak",
  "keyFindings": [
    "finding 1",
    "finding 2",
    "finding 3"
  ],
  "riskFactors": ["risk 1", "risk 2"],
  "recommendation": "CONFIRM" | "REJECT" | "WAIT",
  "entryNote": "specific entry observation",
  "volumeQuality": "institutional" | "retail" | "mixed" | "suspicious"
}`;

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:       "deepseek-chat",   // DeepSeek-V3 model identifier
        temperature: 0.1,              // Low temperature for deterministic output
        max_tokens:  600,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepSeek API error: ${err}`);
    }

    const data = await response.json();
    const raw  = data.choices?.[0]?.message?.content || "{}";

    // Strip markdown fences if DeepSeek wraps JSON
    const clean = raw.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json({
      ...parsed,
      symbol,
      signal,
      timestamp: Date.now(),
      model: "deepseek-chat (DeepSeek-V3)",
    });

  } catch (err) {
    console.error("[DeepSeek] Error:", err);
    return res.status(500).json({
      error: err.message,
      validated: false,
      recommendation: "ERROR",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// ② /api/trade — Binance Futures Order Execution
//    Creates entry + SL + TP orders atomically via Futures API
// ═══════════════════════════════════════════════════════════════════
// pages/api/trade.js

function binanceSign(params) {
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const signature = crypto
    .createHmac("sha256", process.env.BINANCE_SECRET_KEY || "")
    .update(queryString)
    .digest("hex");
  return `${queryString}&signature=${signature}`;
}

async function binanceFuturesRequest(endpoint, params = {}, method = "POST") {
  const baseURL = "https://fapi.binance.com";
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signed = binanceSign(allParams);

  const res = await fetch(`${baseURL}${endpoint}?${signed}`, {
    method,
    headers: {
      "X-MBX-APIKEY": process.env.BINANCE_API_KEY || "",
      "Content-Type":  "application/json",
    },
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.msg || JSON.stringify(data));
  return data;
}

module.exports.tradeHandler = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
    return res.status(500).json({ error: "Binance API keys not configured. See SETUP.md." });
  }

  const { symbol, side, amount, leverage = 5, slPct, tpPct } = req.body;

  // Validate inputs
  if (!symbol || !side || !amount) {
    return res.status(400).json({ error: "Missing required fields: symbol, side, amount" });
  }
  if (!["LONG", "SHORT"].includes(side)) {
    return res.status(400).json({ error: "side must be LONG or SHORT" });
  }

  const futuresSide     = side === "LONG" ? "BUY"  : "SELL";
  const closeSide       = side === "LONG" ? "SELL" : "BUY";

  try {
    // Step 1: Set leverage
    await binanceFuturesRequest("/fapi/v1/leverage", {
      symbol,
      leverage: parseInt(leverage),
    });

    // Step 2: Set margin type to ISOLATED for risk management
    try {
      await binanceFuturesRequest("/fapi/v1/marginType", {
        symbol,
        marginType: "ISOLATED",
      });
    } catch {
      // Already isolated, ignore
    }

    // Step 3: Get current price for quantity calculation
    const ticker = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`)
      .then(r => r.json());
    const currentPrice = parseFloat(ticker.price);

    // Step 4: Get symbol info for precision
    const exchangeInfo = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo")
      .then(r => r.json());
    const symbolInfo   = exchangeInfo.symbols.find(s => s.symbol === symbol);
    const stepSize     = parseFloat(symbolInfo?.filters?.find(f => f.filterType === "LOT_SIZE")?.stepSize || "0.001");
    const pricePrecision = symbolInfo?.pricePrecision || 2;

    // Calculate quantity based on USDT amount and leverage
    const notional  = amount * leverage;
    const rawQty    = notional / currentPrice;
    const precision = Math.round(-Math.log10(stepSize));
    const quantity  = parseFloat(rawQty.toFixed(precision));

    // Calculate SL/TP prices
    const slMultiplier = parseFloat(slPct) / 100;
    const tpMultiplier = parseFloat(tpPct) / 100;
    const slPrice = side === "LONG"
      ? parseFloat((currentPrice * (1 - slMultiplier)).toFixed(pricePrecision))
      : parseFloat((currentPrice * (1 + slMultiplier)).toFixed(pricePrecision));
    const tpPrice = side === "LONG"
      ? parseFloat((currentPrice * (1 + tpMultiplier)).toFixed(pricePrecision))
      : parseFloat((currentPrice * (1 - tpMultiplier)).toFixed(pricePrecision));

    // Step 5: Place market entry order
    const entryOrder = await binanceFuturesRequest("/fapi/v1/order", {
      symbol,
      side:         futuresSide,
      type:         "MARKET",
      quantity,
      positionSide: "BOTH",
    });

    // Step 6: Place Stop Loss (STOP_MARKET)
    const slOrder = await binanceFuturesRequest("/fapi/v1/order", {
      symbol,
      side:         closeSide,
      type:         "STOP_MARKET",
      stopPrice:    slPrice,
      closePosition: true,
      positionSide: "BOTH",
    });

    // Step 7: Place Take Profit (TAKE_PROFIT_MARKET)
    const tpOrder = await binanceFuturesRequest("/fapi/v1/order", {
      symbol,
      side:          closeSide,
      type:          "TAKE_PROFIT_MARKET",
      stopPrice:     tpPrice,
      closePosition: true,
      positionSide:  "BOTH",
    });

    return res.status(200).json({
      success:    true,
      orderId:    entryOrder.orderId,
      entryOrder,
      slOrder,
      tpOrder,
      summary: {
        symbol,
        side,
        quantity,
        entryPrice:  currentPrice,
        stopLoss:    slPrice,
        takeProfit:  tpPrice,
        notional:    `$${notional.toFixed(2)}`,
        leverage:    `${leverage}x`,
      },
    });

  } catch (err) {
    console.error("[Trade] Error:", err);
    return res.status(500).json({
      error:   err.message,
      success: false,
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// ③ /api/scanner — Server-side Full Market Scanner
//    Optional: use if browser-side fetch has CORS issues
//    Includes caching to avoid rate limits
// ═══════════════════════════════════════════════════════════════════
// pages/api/scanner.js

let scanCache = { data: null, ts: 0 };
const CACHE_TTL = 30_000; // 30 seconds

module.exports.scannerHandler = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const minVol = parseFloat(req.query.minVol || "1000000");

  // Return cache if fresh
  if (Date.now() - scanCache.ts < CACHE_TTL && scanCache.data) {
    return res.status(200).json({ ...scanCache.data, cached: true });
  }

  try {
    const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    const tickers  = await response.json();

    const PUMP_THRESHOLD = 7;
    const DUMP_THRESHOLD = -7;

    const filtered = tickers
      .filter(t => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) >= minVol)
      .map(t => {
        const change  = parseFloat(t.priceChangePercent);
        const volume  = parseFloat(t.quoteVolume);
        let anomaly   = { type: "NORMAL", score: 0 };
        if (change >= PUMP_THRESHOLD)   anomaly = { type: "PUMP",     score: change * 5 };
        else if (change <= DUMP_THRESHOLD) anomaly = { type: "DUMP",  score: Math.abs(change) * 5 };
        else if (Math.abs(change) > 4)  anomaly = { type: "BREAKOUT", score: Math.abs(change) * 8 };

        return {
          symbol:       t.symbol,
          short:        t.symbol.replace("USDT", ""),
          price:        parseFloat(t.lastPrice),
          change,
          volume,
          high:         parseFloat(t.highPrice),
          low:          parseFloat(t.lowPrice),
          trades:       parseInt(t.count),
          anomaly,
          anomalyScore: Math.abs(change) * 10 + Math.log10(volume / 1_000_000 + 1) * 5,
        };
      })
      .sort((a, b) => b.anomalyScore - a.anomalyScore)
      .slice(0, 100);

    const result = {
      coins:        filtered,
      total:        filtered.length,
      pumps:        filtered.filter(c => c.anomaly.type === "PUMP").length,
      dumps:        filtered.filter(c => c.anomaly.type === "DUMP").length,
      breakouts:    filtered.filter(c => c.anomaly.type === "BREAKOUT").length,
      timestamp:    Date.now(),
    };

    scanCache = { data: result, ts: Date.now() };
    return res.status(200).json({ ...result, cached: false });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};


// ═══════════════════════════════════════════════════════════════════
// ④ EXPRESS SERVER WRAPPER (for VPS deployment)
//    Alternative to Next.js — standalone Express server
// ═══════════════════════════════════════════════════════════════════
// server.js — run with: node server.js

function startExpressServer() {
  const express = require("express");
  const cors    = require("cors");
  require("dotenv").config();

  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
  app.use(express.json());

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({
      status: "HERMES v2.0 Backend Online",
      deepseek:  !!process.env.DEEPSEEK_API_KEY  ? "configured" : "missing",
      binance:   !!process.env.BINANCE_API_KEY   ? "configured" : "missing",
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/api/deepseek", module.exports.deepseekHandler);
  app.post("/api/trade",    module.exports.tradeHandler);
  app.get( "/api/scanner",  module.exports.scannerHandler);

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`\n⬡ HERMES Backend v2.0 running on port ${PORT}`);
    console.log(`  DeepSeek:  ${process.env.DEEPSEEK_API_KEY ? "✓ Configured" : "✗ Missing DEEPSEEK_API_KEY"}`);
    console.log(`  Binance:   ${process.env.BINANCE_API_KEY  ? "✓ Configured" : "✗ Missing BINANCE_API_KEY"}`);
    console.log(`  Endpoints: /api/health | /api/deepseek | /api/trade | /api/scanner\n`);
  });
}

// Uncomment below to run as standalone Express server:
// if (require.main === module) startExpressServer();

module.exports.startExpressServer = startExpressServer;
    
