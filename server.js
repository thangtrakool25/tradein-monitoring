
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const crypto = require("crypto");

const app = express();

// เก็บ Raw Body สำหรับตรวจสอบ LINE Webhook Signature
app.use(express.json({
  limit: "25mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const DATA_FILE = path.join(__dirname, "tradein-data.json");

const SLA = {
  KTS: 15,
  ADD: 15,
  COMPASIA: 10
};

// ========================================
// LINE WEBHOOK: รับ Group ID
// ========================================

app.post("/callback", (req, res) => {
  const signature = req.headers["x-line-signature"];
  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!signature || !secret || !req.rawBody) {
    return res.status(401).send("Unauthorized");
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");

  const hashBuffer = Buffer.from(hash);
  const signatureBuffer = Buffer.from(signature);

  if (
    hashBuffer.length !== signatureBuffer.length ||
    !crypto.timingSafeEqual(hashBuffer, signatureBuffer)
  ) {
    return res.status(401).send("Invalid signature");
  }

  const events = req.body.events || [];

  for (const event of events) {
    if (event.source && event.source.type === "group") {
      const groupId = event.source.groupId;

      console.log("==================================");
      console.log("LINE GROUP ID:", groupId);
      console.log("==================================");
    }

    if (event.source && event.source.type === "room") {
      console.log("LINE ROOM ID:", event.source.roomId);
    }
  }

  res.status(200).send("OK");
});

// ========================================
// TRADE-IN SLA ALERT
// ========================================

function groupItems(items) {
  const grouped = {};

  for (const x of items) {
    const key = `${x.supplier} / ${x.branch}`;

    if (!grouped[key]) {
      grouped[key] = {
        count: 0,
        state: x.state,
        maxOver: 0
      };
    }

    grouped[key].count++;

    if (x.over > grouped[key].maxOver) {
      grouped[key].maxOver = x.over || 0;
    }

    if (x.state === "late") {
      grouped[key].state = "late";
    }
  }

  return Object.entries(grouped).map(([name, v]) =>
    `• ${name}: ${v.count} รายการ${
      v.state === "late"
        ? ` (เกินสูงสุด ${v.maxOver} วัน)`
        : " (ใกล้ครบกำหนด)"
    }`
  );
}

async function pushLine(items, heading) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_TO_ID;

  if (!token || !to) {
    return { sent: false, configured: false };
  }

  if (!items.length) {
    return { sent: false, configured: true };
  }

  const lines = groupItems(items);

  const message =
    `${heading}\n` +
    `พบ ${items.length} รายการ\n` +
    `${lines.join("\n")}\n\n` +
    `กรุณาตรวจสอบ Trade-In Monitoring`;

  const response = await fetch(
    "https://api.line.me/v2/bot/message/push",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        to,
        messages: [
          {
            type: "text",
            text: message.slice(0, 4900)
          }
        ]
      })
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`LINE API ${response.status}: ${body}`);
  }

  return { sent: true, configured: true };
}

// ========================================
// DATA
// ========================================

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { items: [], importedAt: null };
  }

  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function currentItems(data) {
  const importedAt = data.importedAt
    ? new Date(data.importedAt)
    : new Date();

  const elapsed = Math.max(
    0,
    Math.floor(
      (Date.now() - importedAt.getTime()) / 86400000
    )
  );

  return (data.items || []).map(x => {
    const supplier = String(x.supplier || "");
    const sla = SLA[supplier.toUpperCase()] || null;
    const age = Number(x.age || 0) + elapsed;

    const state =
      x.state === "returned"
        ? "returned"
        : !sla
          ? "unknown"
          : age > sla
            ? "late"
            : age >= sla - 3
              ? "near"
              : "normal";

    return {
      ...x,
      age,
      sla,
      over: Math.max(0, age - (sla || age)),
      state
    };
  });
}

// ========================================
// API
// ========================================

app.get("/api/data", (req, res) => {
  const data = readData();

  res.json({
    items: currentItems(data),
    importedAt: data.importedAt
  });
});

app.post("/api/import", async (req, res) => {
  const items = Array.isArray(req.body.items)
    ? req.body.items
    : [];

  if (!items.length) {
    return res.status(400).json({ error: "No items" });
  }

  const data = {
    items,
    importedAt: new Date().toISOString()
  };

  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(data, null, 2)
  );

  const candidates = items.filter(
    x => x.state === "near" || x.state === "late"
  );

  try {
    const result = await pushLine(
      candidates,
      "🚨 TRADE-IN SLA ALERT"
    );

    res.json({
      saved: true,
      alertsSent: result.sent,
      lineConfigured: result.configured,
      alertCount: candidates.length
    });
  } catch (e) {
    res.status(502).json({
      saved: true,
      alertsSent: false,
      lineConfigured: true,
      error: e.message
    });
  }
});

app.post("/api/line-alert", async (req, res) => {
  try {
    const result = await pushLine(
      Array.isArray(req.body.items) ? req.body.items : [],
      "🚨 TRADE-IN SLA ALERT"
    );

    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ========================================
// DAILY SLA REMINDER: 08:00 Bangkok
// ========================================

cron.schedule(
  "0 8 * * *",
  async () => {
    try {
      const data = readData();

      const items = currentItems(data).filter(
        x => x.state === "near" || x.state === "late"
      );

      if (items.length) {
        await pushLine(
          items,
          "📊 TRADE-IN DAILY SLA REMINDER"
        );
      }
    } catch (e) {
      console.error(
        "Daily Trade-In alert failed:",
        e.message
      );
    }
  },
  { timezone: "Asia/Bangkok" }
);

// ========================================
// START SERVER
// ========================================

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(
    `Trade-In Monitoring running on port ${port}`
  );
});
