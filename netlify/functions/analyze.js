const https = require("https");

const UNIVERSE = [
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "GOOGL", name: "Alphabet" }
];

const cache = new Map();

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "StockPilotAI/4.0"
        }
      },
      (res) => {
        let raw = "";

        res.setEncoding("utf8");

        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `Market data provider returned HTTP ${res.statusCode}.`
              )
            );
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(
              new Error(
                "Market data provider returned invalid JSON."
              )
            );
          }
        });
      }
    );

    req.setTimeout(15000, () => {
      req.destroy(
        new Error("Market data request timed out.")
      );
    });

    req.on("error", reject);
  });
}

async function dailySeries(symbol, key) {
  const cached = cache.get(symbol);

  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  const url = new URL(
    "https://www.alphavantage.co/query"
  );

  url.searchParams.set(
    "function",
    "TIME_SERIES_DAILY"
  );

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("outputsize", "compact");
  url.searchParams.set("apikey", key);

  const data = await getJson(url.toString());

  if (data.Note) {
    throw new Error(
      "Alpha Vantage is temporarily rate-limiting StockPilot. Please wait about a minute and try again."
    );
  }

  if (data.Information) {
    throw new Error(
      "Alpha Vantage returned an information message instead of market data. Check your API key and API usage limits."
    );
  }

  if (data["Error Message"]) {
    throw new Error(
      `Alpha Vantage could not find market data for ${symbol}.`
    );
  }

  const series = data["Time Series (Daily)"];

  if (!series) {
    throw new Error(
      `Alpha Vantage did not return daily market data for ${symbol}.`
    );
  }

  const rows = Object.entries(series)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, value]) => ({
      date,
      close: Number(value["4. close"]),
      volume: Number(value["5. volume"])
    }))
    .filter(
      (row) =>
        Number.isFinite(row.close) &&
        Number.isFinite(row.volume)
    );

  if (rows.length < 21) {
    throw new Error(
      `Not enough market history was returned for ${symbol}.`
    );
  }

  cache.set(symbol, {
    expires: Date.now() + 60000,
    data: rows
  });

  return rows;
}

function pct(current, previous) {
  return ((current / previous) - 1) * 100;
}

function fmtPct(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function score(rows, risk, timeframe) {
  const latest = rows[0].close;

  const d1 = pct(
    rows[0].close,
    rows[1].close
  );

  const d5 = pct(
    rows[0].close,
    rows[5].close
  );

  const d20 = pct(
    rows[0].close,
    rows[20].close
  );

  const avgVol =
    rows
      .slice(1, 21)
      .reduce((sum, row) => sum + row.volume, 0) / 20;

  const volRatio = avgVol
    ? rows[0].volume / avgVol
    : 1;

  let s = 50;

  if (timeframe === "day") {
    s += Math.max(
      -15,
      Math.min(15, d1 * 3)
    );

    s += Math.max(
      0,
      Math.min(10, (volRatio - 1) * 8)
    );
  }

  if (timeframe === "swing") {
    s += Math.max(
      -12,
      Math.min(15, d5 * 1.8)
    );

    s += Math.max(
      -5,
      Math.min(8, d20 * 0.25)
    );
  }

  if (timeframe === "1-3m") {
    s += Math.max(
      -10,
      Math.min(15, d20 * 0.7)
    );
  }

  if (timeframe === "3-12m") {
    s += Math.max(
      -8,
      Math.min(15, d20 * 0.8)
    );
  }

  if (timeframe === "1y") {
    s += Math.max(
      -6,
      Math.min(15, d20 * 0.5)
    );
  }

  const volatility = Math.abs(d1);

  if (risk === "lower") {
    s -= Math.max(
      0,
      Math.min(12, volatility - 2)
    );
  }

  if (risk === "higher") {
    s += Math.max(
      0,
      Math.min(8, volatility - 1)
    );
  }

  return {
    score: Math.max(
      0,
      Math.min(100, Math.round(s))
    ),
    d1,
    d5,
    d20,
    volRatio,
    price: latest
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "POST") {
    return json(405, {
      error: "Use POST for analysis."
    });
  }

  let input;

  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return json(400, {
      error: "Invalid request body."
    });
  }

  const amount = Number(input.amount);
  const risk = String(
    input.risk || "moderate"
  );

  const timeframe = String(
    input.timeframe || "swing"
  );

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return json(400, {
      error:
        "Enter a valid amount greater than $0."
    });
  }

  const key =
    process.env.ALPHAVANTAGE_API_KEY;

  if (!key) {
    return json(500, {
      error:
        "Market-data API key is not configured. Check ALPHAVANTAGE_API_KEY in Netlify environment variables and redeploy."
    });
  }

  try {
    const all = [];

    for (const stock of UNIVERSE) {
      try {
        const rows = await dailySeries(
          stock.symbol,
          key
        );

        all.push({
          stock,
          metrics: score(
            rows,
            risk,
            timeframe
          )
        });
      } catch (error) {
        console.error(
          `Failed to retrieve ${stock.symbol}:`,
          error.message
        );
      }
    }

    if (all.length === 0) {
      return json(502, {
        error:
          "StockPilot could not retrieve market data right now. Check your Alpha Vantage API key and usage limits, then try again."
      });
    }

    all.sort(
      (a, b) =>
        b.metrics.score -
        a.metrics.score
    );

    const pick = all[0];
    const m = pick.metrics;

    const reasons = [
      `${pick.stock.symbol} has a ${fmtPct(
        m.d20
      )} 20-trading-day price change.`,

      `Its latest daily move is ${fmtPct(
        m.d1
      )}.`,

      `Recent volume is ${m.volRatio.toFixed(
        2
      )}x its 20-day average.`,

      `The score was adjusted for your selected ${risk} risk level and ${timeframe} timeframe.`
    ];

    return json(200, {
      recommendation: {
        symbol: pick.stock.symbol,
        name: pick.stock.name,
        price: m.price,
        asOf: new Date().toISOString(),
        score: m.score,

        returns: {
          day: fmtPct(m.d1),
          fiveDay: fmtPct(m.d5),
          twentyDay: fmtPct(m.d20)
        },

        volumeRatio: `${m.volRatio.toFixed(
          2
        )}x`,

        reasons,

        summary:
          `Based on the current data snapshot and the inputs you selected, ${pick.stock.symbol} had the highest transparent match score among the ${all.length} stocks successfully screened.`
      }
    });
  } catch (error) {
    console.error(
      "StockPilot analysis error:",
      error
    );

    return json(502, {
      error:
        error.message ||
        "Market data could not be retrieved."
    });
  }
};
