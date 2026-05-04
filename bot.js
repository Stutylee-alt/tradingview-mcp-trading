/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */
 
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from "fs";
import crypto from "crypto";
 
// ─── Onboarding ───────────────────────────────────────────────────────────────
 
function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);
 
  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — please create one and fill in your credentials.\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }
 
  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }
 
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}
 
// ─── Config ────────────────────────────────────────────────────────────────
 
const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};
 
const DATA_DIR = process.env.DATA_DIR || ".";
const dataPath = (f) => `${DATA_DIR}/${f}`;
 
const LOG_FILE = dataPath("safety-check-log.json");
 
// ─── Decision Logging ────────────────────────────────────────────────────────
 
function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
 
function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}
 
function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}
 
// ─── Market Data (Binance public API — free, no auth) ───────────────────────
 
async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1m", "1M": "1m",
    "2m": "1m", "2M": "1m",
    "3m": "3m", "3M": "3m",
    "5m": "5m", "5M": "5m",
    "15m": "15m", "15M": "15m",
    "30m": "30m", "30M": "30m",
    "1H": "1h", "1h": "1h",
    "2H": "2h", "2h": "2h",
    "4H": "4h", "4h": "4h",
    "1D": "1d", "1d": "1d",
    "1W": "1w", "1w": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";
 
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
 
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}
 
// ─── Indicator Calculations ──────────────────────────────────────────────────
 
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}
 
// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}
 
// ─── Safety Check ───────────────────────────────────────────────────────────
 
function runSafetyCheck(price, prevClose, sma20, sma20Prev, sma200, vwap) {
  const results = [];
 
  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };
 
  console.log("\n── Safety Check ─────────────────────────────────────────\n");
 
  const crossoverBullish = prevClose < sma20Prev && price > sma20;
  const crossoverBearish = prevClose > sma20Prev && price < sma20;
  const bullishTrend = price > sma200 && price > vwap;
  const bearishTrend = price < sma200 && price < vwap;
 
  if (bullishTrend) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");
 
    check(
      "Price above 200 SMA (uptrend)",
      `> ${sma200.toFixed(2)}`,
      price.toFixed(2),
      price > sma200,
    );
 
    check(
      "Price above VWAP (Trend Friend — buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );
 
    check(
      "20 SMA bullish crossover (entry signal)",
      `prev < ${sma20Prev.toFixed(2)}, now > ${sma20.toFixed(2)}`,
      `${prevClose.toFixed(2)} → ${price.toFixed(2)}`,
      crossoverBullish,
    );
  } else if (bearishTrend) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");
 
    check(
      "Price below 200 SMA (downtrend)",
      `< ${sma200.toFixed(2)}`,
      price.toFixed(2),
      price < sma200,
    );
 
    check(
      "Price below VWAP (Trend Friend — sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );
 
    check(
      "20 SMA bearish crossover (entry signal)",
      `prev > ${sma20Prev.toFixed(2)}, now < ${sma20.toFixed(2)}`,
      `${prevClose.toFixed(2)} → ${price.toFixed(2)}`,
      crossoverBearish,
    );
  } else {
    console.log("  Bias: NEUTRAL — SMA200 and VWAP not aligned. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Price aligned with SMA200 and VWAP",
      actual: "Neutral",
      pass: false,
    });
  }
 
  const allPass = results.every((r) => r.pass);
  // Hold while price remains above all three indicators (exit trigger)
  const bullishBias = price > sma20 && price > sma200 && price > vwap;
  const bearishBias = price < sma20 && price < sma200 && price < vwap;
  return { results, allPass, bullishBias, bearishBias };
}
 
// ─── Trade Limits ────────────────────────────────────────────────────────────
 
function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
 
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");
 
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return { allowed: false, reason: `Max trades per day reached (${todayCount}/${CONFIG.maxTradesPerDay})` };
  }
 
  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );
 
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );
 
  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return { allowed: false, reason: `Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}` };
  }
 
  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );
 
  return { allowed: true, reason: "" };
}
 
// ─── BitGet Execution ────────────────────────────────────────────────────────
 
function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}
 
async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";
 
  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });
 
  const signature = signBitGet(timestamp, "POST", path, body);
 
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });
 
  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }
 
  return data.data;
}
 
// ─── Position Tracking ───────────────────────────────────────────────────────
 
const POSITIONS_FILE = dataPath("positions.json");
 
function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) {
    return { openPosition: null, runningBalance: CONFIG.portfolioValue };
  }
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}
 
function savePositions(data) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
}
 
// ─── Trade CSV ───────────────────────────────────────────────────────────────
 
const CSV_FILE = dataPath("trades.csv");
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Symbol",
  "Decision",
  "Side",
  "Entry Price",
  "Exit Price",
  "Quantity",
  "P&L USD",
  "Running Balance USD",
  "Price",
  "SMA20",
  "SMA200",
  "VWAP",
  "Mode",
  "Block Reason",
  "Notes",
].join(",");
 
function initCsv() {
  if (existsSync(CSV_FILE)) {
    // Archive old format if it has the old headers
    const firstLine = readFileSync(CSV_FILE, "utf8").split("\n")[0];
    if (!firstLine.includes("Decision")) {
      const archiveName = dataPath(`trades-archive-${Date.now()}.csv`);
      renameSync(CSV_FILE, archiveName);
      console.log(`📦 Old trades.csv archived to ${archiveName}`);
    }
  }
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  }
}
 
function writeDecisionRow({
  decision,
  symbol,
  side = "",
  entryPrice = null,
  exitPrice = null,
  quantity = null,
  pnl = null,
  runningBalance,
  price = null,
  sma20 = null,
  sma200 = null,
  vwap = null,
  timestamp,
  mode,
  blockReason = "",
  notes = "",
}) {
  const now = new Date(timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const fmt = (v, dp = 2) => v !== null && v !== undefined ? v.toFixed(dp) : "";
 
  const row = [
    date,
    time,
    symbol,
    decision,
    side,
    fmt(entryPrice),
    fmt(exitPrice),
    fmt(quantity, 6),
    fmt(pnl),
    fmt(runningBalance),
    fmt(price),
    fmt(sma20),
    fmt(sma200),
    fmt(vwap),
    mode,
    `"${blockReason}"`,
    `"${notes}"`,
  ].join(",");
 
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`📄 Decision logged [${decision}] → ${CSV_FILE}`);
}
 
// ─── Tax Summary ─────────────────────────────────────────────────────────────
 
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }
 
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).filter((l) => l.trim()).map((l) => l.split(","));
 
  const sells = rows.filter((r) => r[3] === "SELL");
  const buys = rows.filter((r) => r[3] === "BUY");
  const paper = rows.filter((r) => r[14] === "PAPER");
  const live = rows.filter((r) => r[14] === "LIVE");
 
  const totalPnl = sells.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);
  const wins = sells.filter((r) => parseFloat(r[8] || 0) > 0).length;
  const losses = sells.filter((r) => parseFloat(r[8] || 0) <= 0).length;
 
  let currentBalance = CONFIG.portfolioValue;
  if (sells.length > 0) {
    currentBalance = parseFloat(sells[sells.length - 1][9]);
  }
 
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Starting balance       : $${CONFIG.portfolioValue.toFixed(2)}`);
  console.log(`  Current balance        : $${currentBalance.toFixed(2)}`);
  console.log(`  Total realised P&L     : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
  console.log(`  ─────────────────────────────────────────────────────`);
  console.log(`  Total entries (BUY)    : ${buys.length}`);
  console.log(`  Total exits (SELL)     : ${sells.length}`);
  console.log(`  Winning trades         : ${wins}`);
  console.log(`  Losing trades          : ${losses}`);
  if (sells.length > 0) {
    console.log(`  Win rate               : ${((wins / sells.length) * 100).toFixed(0)}%`);
  }
  console.log(`  ─────────────────────────────────────────────────────`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Live trades            : ${live.length}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}
 
// ─── Main ────────────────────────────────────────────────────────────────────
 
async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");
 
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);
 
  const log = loadLog();
  const { allowed, reason: limitReason } = checkTradeLimits(log);
  if (!allowed) {
    const positions = loadPositions();
    writeDecisionRow({
      decision: "BLOCKED",
      symbol: CONFIG.symbol,
      runningBalance: positions.runningBalance,
      timestamp: new Date().toISOString(),
      mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
      blockReason: limitReason,
    });
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }
 
  // Fetch candle data
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);
 
  // Calculate indicators
  const sma20     = calcSMA(closes, 20);
  const sma200    = calcSMA(closes, 200);
  const sma20Prev = calcSMA(closes.slice(0, -1), 20);
  const prevClose = closes[closes.length - 2];
  const vwap      = calcVWAP(candles);
 
  console.log(`  SMA(20):  $${sma20 ? sma20.toFixed(2) : "N/A"}`);
  console.log(`  SMA(200): $${sma200 ? sma200.toFixed(2) : "N/A"}`);
  console.log(`  VWAP:     $${vwap ? vwap.toFixed(2) : "N/A"}`);
 
  if (vwap === null || sma200 === null) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }
 
  const { results, allPass, bullishBias } = runSafetyCheck(price, prevClose, sma20, sma20Prev, sma200, vwap);
 
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );
 
  // ─── Position Management ──────────────────────────────────────────────────
 
  const positions = loadPositions();
 
  console.log("\n── Decision ─────────────────────────────────────────────\n");
 
  if (positions.openPosition) {
    // We're in a trade — check if we should exit
    const pos = positions.openPosition;
    const unrealisedPnl = (price - pos.entryPrice) * pos.quantity;
 
    if (!bullishBias) {
      // Bias has shifted — exit the position
      const pnl = (price - pos.entryPrice) * pos.quantity;
      const newBalance = positions.runningBalance + pnl;
      const pnlStr = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
 
      console.log(`📤 CLOSING POSITION — bias no longer bullish`);
      console.log(`   Entry:   $${pos.entryPrice.toFixed(2)}`);
      console.log(`   Exit:    $${price.toFixed(2)}`);
      console.log(`   Qty:     ${pos.quantity.toFixed(6)}`);
      console.log(`   P&L:     ${pnlStr}`);
      console.log(`   Balance: $${newBalance.toFixed(2)}`);
 
      writeDecisionRow({
        decision: "SELL",
        symbol: CONFIG.symbol,
        side: "SELL",
        entryPrice: pos.entryPrice,
        exitPrice: price,
        quantity: pos.quantity,
        pnl,
        runningBalance: newBalance,
        price,
        sma20,
        sma200,
        vwap,
        timestamp: new Date().toISOString(),
        mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
        notes: "Exit — bias no longer bullish",
      });
 
      positions.openPosition = null;
      positions.runningBalance = newBalance;
      savePositions(positions);
    } else {
      // Still bullish — hold
      console.log(`📊 HOLDING POSITION`);
      console.log(`   Entry: $${pos.entryPrice.toFixed(2)} | Now: $${price.toFixed(2)}`);
      console.log(`   Unrealised P&L: ${unrealisedPnl >= 0 ? "+" : ""}$${unrealisedPnl.toFixed(2)}`);
      console.log(`   Balance (excl. open trade): $${positions.runningBalance.toFixed(2)}`);
 
      writeDecisionRow({
        decision: "HOLD",
        symbol: CONFIG.symbol,
        side: "BUY",
        entryPrice: pos.entryPrice,
        quantity: pos.quantity,
        runningBalance: positions.runningBalance,
        price,
        sma20,
        sma200,
        vwap,
        timestamp: new Date().toISOString(),
        mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
        notes: `Unrealised P&L: ${unrealisedPnl >= 0 ? "+" : ""}$${unrealisedPnl.toFixed(2)}`,
      });
    }
  } else {
    // No open position — check if we should enter
    if (!allPass) {
      const failed = results.filter((r) => !r.pass).map((r) => r.label);
      console.log(`🚫 TRADE BLOCKED`);
      console.log(`   Failed conditions:`);
      failed.forEach((f) => console.log(`   - ${f}`));
 
      writeDecisionRow({
        decision: "BLOCKED",
        symbol: CONFIG.symbol,
        runningBalance: positions.runningBalance,
        price,
        sma20,
        sma200,
        vwap,
        timestamp: new Date().toISOString(),
        mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
        blockReason: failed.join("; "),
      });
    } else {
      // All conditions met — enter a trade
      const quantity = tradeSize / price;
 
      if (CONFIG.paperTrading) {
        console.log(`✅ ALL CONDITIONS MET`);
        console.log(`\n📋 PAPER TRADE — BUY ${quantity.toFixed(6)} ${CONFIG.symbol} @ $${price.toFixed(2)}`);
        console.log(`   Size: $${tradeSize.toFixed(2)} | Balance: $${positions.runningBalance.toFixed(2)}`);
        console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
 
        positions.openPosition = {
          symbol: CONFIG.symbol,
          entryPrice: price,
          quantity,
          tradeSize,
          entryTime: new Date().toISOString(),
        };
        savePositions(positions);
 
        writeDecisionRow({
          decision: "BUY",
          symbol: CONFIG.symbol,
          side: "BUY",
          entryPrice: price,
          quantity,
          runningBalance: positions.runningBalance,
          price,
          sma20,
          sma200,
          vwap,
          timestamp: new Date().toISOString(),
          mode: "PAPER",
          notes: "Entry — all conditions met",
        });
      } else {
        console.log(`✅ ALL CONDITIONS MET`);
        console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`);
        try {
          const order = await placeBitGetOrder(CONFIG.symbol, "buy", tradeSize, price);
 
          positions.openPosition = {
            symbol: CONFIG.symbol,
            entryPrice: price,
            quantity,
            tradeSize,
            entryTime: new Date().toISOString(),
            orderId: order.orderId,
          };
          savePositions(positions);
 
          writeDecisionRow({
            decision: "BUY",
            symbol: CONFIG.symbol,
            side: "BUY",
            entryPrice: price,
            quantity,
            runningBalance: positions.runningBalance,
            price,
            sma20,
            sma200,
            vwap,
            timestamp: new Date().toISOString(),
            mode: "LIVE",
            notes: `Order ${order.orderId}`,
          });
 
          console.log(`✅ ORDER PLACED — ${order.orderId}`);
        } catch (err) {
          console.log(`❌ ORDER FAILED — ${err.message}`);
        }
      }
    }
  }
 
  // Save decision log
  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { sma20, sma200, vwap },
    conditions: results,
    allPass,
    orderPlaced: allPass && !positions.openPosition,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
 
  console.log("═══════════════════════════════════════════════════════════\n");
}
 
if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
 
