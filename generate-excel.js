/**
 * Generates a formatted Excel file from trades.csv
 * Run: node generate-excel.js
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import ExcelJS from "exceljs";

const DATA_DIR   = process.env.DATA_DIR || ".";
const dataPath   = (f) => `${DATA_DIR}/${f}`;

const CSV_FILE   = dataPath("trades.csv");
const EXCEL_FILE = dataPath("trades.xlsx");

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

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

// ─── Colours ─────────────────────────────────────────────────────────────────

const COLOURS = {
  headerBg:     "FF1F3864",  // dark navy
  headerText:   "FFFFFFFF",  // white
  winBg:        "FFD6F5E3",  // soft green
  winText:      "FF1B5E20",  // dark green
  lossBg:       "FFFCE8E6",  // soft red
  lossText:     "FFB71C1C",  // dark red
  breakevenBg:  "FFFFF9C4",  // soft yellow
  breakevenText:"FF827717",  // dark amber
  buyBg:        "FFEAF1FB",  // soft blue (open entry, no exit yet)
  summaryBg:    "FFF0F4FA",  // light slate for summary labels
  summaryVal:   "FFFAFAFA",  // near-white for summary values
  gridLine:     "FFD9D9D9",
};

function solidFill(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function borderAll(colour = COLOURS.gridLine) {
  const side = { style: "thin", color: { argb: colour } };
  return { top: side, bottom: side, left: side, right: side };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generateExcel() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — run the bot first to generate trade data.");
    process.exit(1);
  }

  const raw = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  if (raw.length < 2) {
    console.log("No trade rows in trades.csv yet.");
    process.exit(0);
  }

  const rows = raw.slice(1).map(parseCsvLine);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claude Trading Bot";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Trades", {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { tabColor: { argb: "FF1F3864" } },
  });

  // ─── Column definitions ───────────────────────────────────────────────────

  sheet.columns = [
    { key: "date",       width: 13  },
    { key: "time",       width: 11  },
    { key: "symbol",     width: 11  },
    { key: "side",       width: 8   },
    { key: "entryPrice", width: 14  },
    { key: "exitPrice",  width: 13  },
    { key: "quantity",   width: 13  },
    { key: "pnl",        width: 13  },
    { key: "balance",    width: 21  },
    { key: "mode",       width: 9   },
    { key: "notes",      width: 34  },
  ];

  // ─── Header row ───────────────────────────────────────────────────────────

  const HEADERS = [
    "Date", "Time (UTC)", "Symbol", "Side",
    "Entry Price", "Exit Price", "Quantity",
    "P&L USD", "Running Balance USD", "Mode", "Notes",
  ];

  const headerRow = sheet.addRow(HEADERS);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLOURS.headerText }, size: 11 };
    cell.fill = solidFill(COLOURS.headerBg);
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
    cell.border = borderAll(COLOURS.headerBg);
  });

  // ─── Data rows ────────────────────────────────────────────────────────────

  for (const cols of rows) {
    const [date, time, symbol, side, entryPriceRaw, exitPriceRaw,
           quantityRaw, pnlRaw, balanceRaw, mode, notesRaw] = cols;

    const entryPrice = entryPriceRaw ? parseFloat(entryPriceRaw) : null;
    const exitPrice  = exitPriceRaw  ? parseFloat(exitPriceRaw)  : null;
    const quantity   = quantityRaw   ? parseFloat(quantityRaw)   : null;
    const pnl        = pnlRaw        ? parseFloat(pnlRaw)        : null;
    const balance    = balanceRaw    ? parseFloat(balanceRaw)    : null;
    const notes      = (notesRaw || "").replace(/^"|"$/g, "");

    const dataRow = sheet.addRow([
      date, time, symbol, side,
      entryPrice, exitPrice, quantity,
      pnl, balance, mode, notes,
    ]);

    // Row background based on outcome
    let rowBg = null;
    if (side === "SELL" && pnl !== null) {
      rowBg = pnl > 0 ? COLOURS.winBg : pnl < 0 ? COLOURS.lossBg : COLOURS.breakevenBg;
    } else if (side === "BUY") {
      rowBg = COLOURS.buyBg;
    }

    dataRow.eachCell({ includeEmpty: true }, (cell) => {
      if (rowBg) cell.fill = solidFill(rowBg);
      cell.border = borderAll();
      cell.alignment = { vertical: "middle" };
    });

    // Number formats
    if (entryPrice !== null) {
      const c = dataRow.getCell(5);
      c.numFmt = "$#,##0.00";
      c.alignment = { horizontal: "right" };
    }
    if (exitPrice !== null) {
      const c = dataRow.getCell(6);
      c.numFmt = "$#,##0.00";
      c.alignment = { horizontal: "right" };
    }
    if (quantity !== null) {
      const c = dataRow.getCell(7);
      c.numFmt = "0.000000";
      c.alignment = { horizontal: "right" };
    }
    if (pnl !== null) {
      const c = dataRow.getCell(8);
      c.numFmt = '$#,##0.00;[Red]-$#,##0.00';
      c.alignment = { horizontal: "right" };
      if (side === "SELL") {
        c.font = {
          bold: true,
          color: {
            argb: pnl > 0 ? COLOURS.winText : pnl < 0 ? COLOURS.lossText : COLOURS.breakevenText,
          },
        };
      }
    }
    if (balance !== null) {
      const c = dataRow.getCell(9);
      c.numFmt = "$#,##0.00";
      c.alignment = { horizontal: "right" };
    }

    // Centre-align Side and Mode
    dataRow.getCell(4).alignment  = { horizontal: "center" };
    dataRow.getCell(10).alignment = { horizontal: "center" };

    dataRow.height = 18;
  }

  // ─── Summary section ──────────────────────────────────────────────────────

  const sellRows = rows.filter((r) => r[3] === "SELL");
  const pnlValues = sellRows.map((r) => parseFloat(r[7] || 0));
  const wins = pnlValues.filter((p) => p > 0).length;
  const losses = pnlValues.filter((p) => p < 0).length;
  const totalPnl = pnlValues.reduce((a, b) => a + b, 0);
  const winRate = sellRows.length > 0 ? wins / sellRows.length : 0;
  const startingBalance = parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000");
  const finalBalance =
    sellRows.length > 0
      ? parseFloat(sellRows[sellRows.length - 1][8])
      : startingBalance;

  sheet.addRow([]);  // spacer

  const summaryRows = [
    ["Total Trades",        sellRows.length,  "0",                          null],
    ["Wins",                wins,             "0",                          COLOURS.winText],
    ["Losses",              losses,           "0",                          COLOURS.lossText],
    ["Win Rate",            winRate,          "0.0%",                       null],
    ["Total P&L",           totalPnl,         '$#,##0.00;[Red]-$#,##0.00', totalPnl >= 0 ? COLOURS.winText : COLOURS.lossText],
    ["Final Balance",       finalBalance,     "$#,##0.00",                  "FF1F3864"],
  ];

  for (const [label, value, numFmt, valueColour] of summaryRows) {
    const row = sheet.addRow([label, "", "", "", "", "", "", value]);
    row.height = 20;

    // Label cell (col A)
    const labelCell = row.getCell(1);
    labelCell.font = { bold: true, color: { argb: "FF333333" } };
    labelCell.fill = solidFill(COLOURS.summaryBg);
    labelCell.alignment = { horizontal: "right", vertical: "middle" };
    labelCell.border = borderAll();

    // Merge cols B–G as empty space
    for (let c = 2; c <= 7; c++) {
      const cell = row.getCell(c);
      cell.fill = solidFill(COLOURS.summaryBg);
      cell.border = borderAll();
    }

    // Value cell (col H = P&L column)
    const valCell = row.getCell(8);
    valCell.value = value;
    valCell.numFmt = numFmt;
    valCell.font = { bold: true, color: { argb: valueColour || "FF333333" } };
    valCell.fill = solidFill(COLOURS.summaryVal);
    valCell.alignment = { horizontal: "right", vertical: "middle" };
    valCell.border = borderAll();

    // Remaining cols
    for (let c = 9; c <= 11; c++) {
      const cell = row.getCell(c);
      cell.fill = solidFill(COLOURS.summaryBg);
      cell.border = borderAll();
    }
  }

  // ─── Legend ───────────────────────────────────────────────────────────────

  sheet.addRow([]);
  sheet.addRow([]);

  const legend = [
    ["", "LEGEND"],
    ["", "Blue row",   "Open position (entry logged, not yet closed)"],
    ["", "Green row",  "Closed trade — profit"],
    ["", "Red row",    "Closed trade — loss"],
    ["", "Yellow row", "Closed trade — breakeven"],
  ];

  for (const [, label, desc] of legend) {
    const row = sheet.addRow(["", label, desc || ""]);
    if (label === "LEGEND") {
      row.getCell(2).font = { bold: true, size: 10, color: { argb: "FF1F3864" } };
    } else {
      const bgMap = {
        "Blue row":   COLOURS.buyBg,
        "Green row":  COLOURS.winBg,
        "Red row":    COLOURS.lossBg,
        "Yellow row": COLOURS.breakevenBg,
      };
      row.getCell(2).fill = solidFill(bgMap[label] || "FFFFFFFF");
      row.getCell(2).font = { size: 10 };
      row.getCell(2).border = borderAll();
      row.getCell(3).font = { size: 10, italic: true, color: { argb: "FF555555" } };
    }
    row.height = 17;
  }

  // ─── Write file ───────────────────────────────────────────────────────────

  await workbook.xlsx.writeFile(EXCEL_FILE);

  console.log(`\n✅ Excel file created: ${EXCEL_FILE}`);
  console.log(`\n   Summary:`);
  console.log(`   Total trades   : ${sellRows.length}`);
  console.log(`   Win rate       : ${(winRate * 100).toFixed(0)}%`);
  console.log(`   Total P&L      : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
  console.log(`   Final balance  : $${finalBalance.toFixed(2)}\n`);
}

generateExcel().catch((err) => {
  console.error("Error generating Excel file:", err);
  process.exit(1);
});
