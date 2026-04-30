/**
 * Morning Report — runs daily at 8am NZ time via Railway cron
 * Prints to Railway logs: account balance, today's trades, win rate,
 * total P&L, open positions with live unrealised P&L.
 *
 * Run manually: node morning-report.js
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";

const DATA_DIR       = process.env.DATA_DIR || ".";
const dataPath       = (f) => `${DATA_DIR}/${f}`;

const CSV_FILE       = dataPath("trades.csv");
const POSITIONS_FILE = dataPath("positions.json");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) {
    return {
      openPosition: null,
      runningBalance: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
    };
  }
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function loadTrades() {
  if (!existsSync(CSV_FILE)) return [];
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  return lines.slice(1).filter((l) => l.trim()).map(parseCsvLine);
}

async function fetchCurrentPrice(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

function pnlLabel(value) {
  if (value > 0) return `+$${value.toFixed(2)} ✅`;
  if (value < 0) return `-$${Math.abs(value).toFixed(2)} ❌`;
  return `$0.00 —`;
}

function nzTime(isoString) {
  return new Date(isoString).toLocaleString("en-NZ", {
    timeZone: "Pacific/Auckland",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Report ───────────────────────────────────────────────────────────────────

async function run() {
  const now     = new Date();
  const todayUTC = now.toISOString().slice(0, 10);
  const reportTime = now.toLocaleString("en-NZ", {
    timeZone: "Pacific/Auckland",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const { openPosition, runningBalance } = loadPositions();
  const allTrades  = loadTrades();
  const allSells   = allTrades.filter((r) => r[3] === "SELL");
  const allBuys    = allTrades.filter((r) => r[3] === "BUY");
  const todaySells = allSells.filter((r) => r[0] === todayUTC);
  const todayBuys  = allBuys.filter((r)  => r[0] === todayUTC);

  // All-time performance
  const allPnlValues  = allSells.map((r) => parseFloat(r[7] || 0));
  const totalPnl      = allPnlValues.reduce((a, b) => a + b, 0);
  const totalWins     = allPnlValues.filter((p) => p > 0).length;
  const totalLosses   = allPnlValues.filter((p) => p < 0).length;
  const winRate       = allSells.length > 0 ? (totalWins / allSells.length) * 100 : null;

  // Today's performance
  const todayPnlValues = todaySells.map((r) => parseFloat(r[7] || 0));
  const todayPnl       = todayPnlValues.reduce((a, b) => a + b, 0);
  const todayWins      = todayPnlValues.filter((p) => p > 0).length;

  // Fetch live price if there's an open position
  const symbol = process.env.SYMBOL || "BTCUSDT";
  let currentPrice    = null;
  let unrealisedPnl   = null;
  let totalEquity     = runningBalance;

  if (openPosition) {
    currentPrice  = await fetchCurrentPrice(openPosition.symbol || symbol);
    if (currentPrice !== null) {
      unrealisedPnl = (currentPrice - openPosition.entryPrice) * openPosition.quantity;
      totalEquity   = runningBalance + unrealisedPnl;
    }
  }

  const startingBalance = parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000");
  const W = 55;
  const div = "─".repeat(W);

  console.log(`\n${"═".repeat(W)}`);
  console.log(`  🌅  MORNING REPORT`);
  console.log(`  ${reportTime}`);
  console.log(`${"═".repeat(W)}`);

  // ── Account ──────────────────────────────────────────────────────────────
  console.log(`\n  💰  ACCOUNT BALANCE`);
  console.log(`  ${div}`);
  console.log(`  Starting balance :  $${startingBalance.toFixed(2)}`);
  console.log(`  Realised balance :  $${runningBalance.toFixed(2)}`);
  if (unrealisedPnl !== null) {
    console.log(`  Unrealised P&L   :  ${pnlLabel(unrealisedPnl)}`);
    console.log(`  Total equity     :  $${totalEquity.toFixed(2)}`);
  }
  console.log(`  All-time P&L     :  ${pnlLabel(totalPnl)}`);

  // ── Today ─────────────────────────────────────────────────────────────────
  console.log(`\n  📅  TODAY`);
  console.log(`  ${div}`);
  if (todayBuys.length === 0 && todaySells.length === 0) {
    console.log(`  No trades today`);
  } else {
    console.log(`  Entries (BUY)    :  ${todayBuys.length}`);
    console.log(`  Exits (SELL)     :  ${todaySells.length}`);
    if (todaySells.length > 0) {
      console.log(`  Today P&L        :  ${pnlLabel(todayPnl)}`);
      console.log(`  Today wins       :  ${todayWins} / ${todaySells.length}`);
    }
  }

  // ── All-time performance ──────────────────────────────────────────────────
  console.log(`\n  📊  ALL-TIME PERFORMANCE`);
  console.log(`  ${div}`);
  if (allSells.length === 0) {
    console.log(`  No closed trades yet`);
  } else {
    console.log(`  Closed trades    :  ${allSells.length}`);
    console.log(`  Wins / Losses    :  ${totalWins} / ${totalLosses}`);
    console.log(`  Win rate         :  ${winRate.toFixed(0)}%`);
  }

  // ── Open positions ────────────────────────────────────────────────────────
  console.log(`\n  🔓  OPEN POSITIONS`);
  console.log(`  ${div}`);
  if (!openPosition) {
    console.log(`  No open positions`);
  } else {
    console.log(`  Symbol           :  ${openPosition.symbol || symbol}`);
    console.log(`  Entry price      :  $${openPosition.entryPrice.toFixed(2)}`);
    console.log(`  Quantity         :  ${openPosition.quantity.toFixed(6)}`);
    console.log(`  Position size    :  $${openPosition.tradeSize.toFixed(2)}`);
    console.log(`  Opened           :  ${nzTime(openPosition.entryTime)}`);
    if (currentPrice !== null) {
      console.log(`  Current price    :  $${currentPrice.toFixed(2)}`);
      console.log(`  Unrealised P&L   :  ${pnlLabel(unrealisedPnl)}`);
    } else {
      console.log(`  Current price    :  (unavailable)`);
    }
  }

  console.log(`\n${"═".repeat(W)}\n`);
}

run().catch((err) => {
  console.error("Morning report error:", err);
  process.exit(1);
});
