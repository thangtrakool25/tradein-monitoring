
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const crypto = require("crypto");

const app = express();

app.use(express.json({
  limit: "25mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const DATA_FILE = path.join(__dirname, "tradein-data.json");
const HISTORY_FILE = path.join(__dirname, "notification-history.json");

const SLA = {
  KTS: 15,
  ADD: 15,
  COMPASIA: 10
};

// ช่วงอายุ Invoice แบบไม่ซ้ำกัน
const AGE_BUCKETS = [
  { key: "1-15", label: "1-15 Day", min: 1, max: 15 },
  { key: "16-20", label: "16-20 Day", min: 16, max: 20 },
  { key: "21-30", label: "21-30 Day", min: 21, max: 30 },
  { key: "31-40", label: "31-40 Day", min: 31, max: 40 },
  { key: "41-50", label: "41-50 Day", min: 41, max: 50 },
  { key: "51-60", label: "51-60 Day", min: 51, max: 60 },
  { key: "over-60", label: ">60 Day", min: 61, max: Infinity }
];

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { items: [], importedAt: null };
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return {
      items: Array.isArray(data.items) ? data.items : [],
      importedAt: data.importedAt || null
    };
  } catch (error) {
    console.error("Cannot read trade-in data:", error.message);
    return { items: [], importedAt: null };
  }
}

function elapsedDays(importedAt) {
  if (!importedAt) return 0;

  const imported = new Date(importedAt);

  if (Number.isNaN(imported.getTime())) return 0;

  return Math.max(
    0,
    Math.floor((Date.now() - imported.getTime()) / 86400000)
  );
}

function currentItems(data) {
  const elapsed = elapsedDays(data.importedAt);

  return (data.items || []).map(item => {
    const supplier = String(item.supplier || "");
    const sla = SLA[supplier.toUpperCase()] || null;

    const age = Number.isFinite(Number(item.age)) &&
      item.age !== "" &&
      item.age != null
      ? Number(item.age) + elapsed
      : null;

    const rawAgeOfInv =
      item.ageOfInv ?? item.age_ofINV ?? item.age_ofInv;

    const ageOfInv =
      rawAgeOfInv !== "" &&
      rawAgeOfInv != null &&
      Number.isFinite(Number(rawAgeOfInv))
        ? Number(rawAgeOfInv) + elapsed
        : null;

    const state = item.state === "returned"
      ? "returned"
      : !sla || age == null
        ? "unknown"
        : age > sla
          ? "late"
          : age >= sla - 3
            ? "near"
            : "normal";

    return {
      ...item,
      noINV: String(item.noINV || ""),
      product_sn: String(item.product_sn || item.serial || ""),
      age,
      ageOfInv,
      sla,
      over: age != null && sla != null
        ? Math.max(0, age - sla)
        : null,
      state
    };
  });
}

function getAgeBucket(age) {
  if (
    age === null ||
    age === undefined ||
    age === "" ||
    !Number.isFinite(Number(age))
  ) {
    return null;
  }

  return AGE_BUCKETS.find(bucket =>
    Number(age) >= bucket.min &&
    Number(age) <= bucket.max
  ) || null;
}

// ========================================
// LINE WEBHOOK
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

  for (const event of (req.body.events || [])) {
    if (event.source?.type === "group") {
      console.log("LINE GROUP ID:", event.source.groupId);
    }

    if (event.source?.type === "room") {
      console.log("LINE ROOM ID:", event.source.roomId);
    }
  }

  res.status(200).send("OK");
});

// ========================================
// GROUP ITEMS FOR LINE
// ========================================

function groupItems(items) {
  const grouped = {};

  for (const item of items) {
    const key = `${item.supplier} / ${item.branch}`;

    if (!grouped[key]) {
      grouped[key] = {
        count: 0,
        state: item.state,
        maxOver: 0
      };
    }

    grouped[key].count++;

    grouped[key].maxOver = Math.max(
      grouped[key].maxOver,
      item.over || 0
    );

    if (item.state === "late") {
      grouped[key].state = "late";
    }
  }

  return Object.entries(grouped).map(([name, value]) =>
    `• ${name}: ${value.count} รายการ${
      value.state === "late"
        ? ` (เกินสูงสุด ${value.maxOver} วัน)`
        : " (ใกล้ครบกำหนด)"
    }`
  );
}

// ========================================
// NOTIFICATION HISTORY
// ========================================

function saveNotificationHistory(record) {
  let history = [];

  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(
        fs.readFileSync(HISTORY_FILE, "utf8")
      );
    } catch (_) {
      history = [];
    }
  }

  history.unshift(record);

  fs.writeFileSync(
    HISTORY_FILE,
    JSON.stringify(history.slice(0, 200), null, 2)
  );
}

// ========================================
// SEND LINE
// ========================================

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
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        to,
        messages: [{
          type: "text",
          text: message.slice(0, 4900)
        }]
      })
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`LINE API ${response.status}: ${body}`);
  }

  saveNotificationHistory({
    createdAt: new Date().toISOString(),
    heading,
    count: items.length,
    details: lines
  });

  return { sent: true, configured: true };
}

// ========================================
// API: GET DATA
// ========================================

app.get("/api/data", (req, res) => {
  const data = readData();

  res.json({
    items: currentItems(data),
    importedAt: data.importedAt
  });
});

// ========================================
// API: PIVOT REPORT
// ========================================

app.get("/api/report/pivot", (req, res) => {
  const data = readData();

  const items = currentItems(data).filter(item =>
    item.state !== "returned" &&
    String(item.product_sn || "").trim()
  );

  const branches = [
    ...new Set(
      items.map(item =>
        String(item.branch || "ไม่ระบุสาข").trim() || "ไม่ระบุสาข"
      )
    )
  ].sort((a, b) => a.localeCompare(b, "th"));

  const buckets = AGE_BUCKETS.map(bucket => {
    const bucketItems = items.filter(item =>
      getAgeBucket(item.ageOfInv)?.key === bucket.key
    );

    const branchCounts = branches.map(branch => ({
      branch,
      count: bucketItems.filter(item =>
        (String(item.branch || "ไม่ระบุสาข").trim() || "ไม่ระบุสาข") === branch
      ).length
    })).filter(row => row.count > 0);

    return {
      key: bucket.key,
      label: bucket.label,
      count: bucketItems.length,
      branches: branchCounts
    };
  });

  res.json({
    buckets,
    branches,
    total: items.filter(item => getAgeBucket(item.ageOfInv)).length,
    unclassified: items.filter(item =>
      !getAgeBucket(item.ageOfInv)
    ).length,
    importedAt: data.importedAt
  });
});

// ========================================
// API: PIVOT DETAILS
// ========================================

app.get("/api/report/details", (req, res) => {
  const { bucket, branch } = req.query;

  if (!bucket || !branch) {
    return res.status(400).json({
      error: "กรุณาระบุ bucket และ branch"
    });
  }

  const data = readData();

  const items = currentItems(data)
    .filter(item => {
      if (
        item.state === "returned" ||
        !String(item.product_sn || "").trim()
      ) {
        return false;
      }

      const itemBranch =
        String(item.branch || "ไม่ระบุสาข").trim() || "ไม่ระบุสาข";

      return (
        getAgeBucket(item.ageOfInv)?.key === bucket &&
        (branch === "__ALL__" || itemBranch === branch)
      );
    })
    .map(item => ({
      noINV: item.noINV || "-",
      product_sn: item.product_sn,
      branch: item.branch || "ไม่ระบุสาข",
      supplier: item.supplier || "-",
      ageOfInv: item.ageOfInv,
      age: item.age,
      date: item.date || null
    }));

  res.json({
    items,
    count: items.length,
    bucket,
    branch
  });
});

// ========================================
// API: IMPORT EXCEL DATA
// ========================================

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

  const candidates = items.filter(item =>
    item.state === "near" || item.state === "late"
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

  } catch (error) {
    res.status(502).json({
      saved: true,
      alertsSent: false,
      lineConfigured: true,
      error: error.message
    });
  }
});

// ========================================
// API: MANUAL LINE ALERT
// ========================================

app.post("/api/line-alert", async (req, res) => {
  try {
    const result = await pushLine(
      Array.isArray(req.body.items) ? req.body.items : [],
      "🚨 TRADE-IN SLA ALERT"
    );

    res.json(result);

  } catch (error) {
    res.status(502).json({
      error: error.message
    });
  }
});

// ========================================
// API: NOTIFICATION HISTORY
// ========================================

app.get("/api/notifications", (req, res) => {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return res.json([]);
    }

    return res.json(
      JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"))
    );

  } catch (_) {
    return res.status(500).json({
      error: "Cannot read notification history"
    });
  }
});

// ========================================
// DAILY SLA REMINDER: 08:00 BANGKOK
// ========================================

cron.schedule(
  "0 8 * * *",
  async () => {
    try {
      const items = currentItems(readData()).filter(item =>
        item.state === "near" || item.state === "late"
      );

      if (items.length) {
        await pushLine(
          items,
          "📊 TRADE-IN DAILY SLA REMINDER"
        );
      }

    } catch (error) {
      console.error(
        "Daily Trade-In alert failed:",
        error.message
      );
    }
  },
  {
    timezone: "Asia/Bangkok"
  }
);

// ========================================
// START SERVER
// ========================================

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Trade-In Monitoring running on port ${port}`);
});
