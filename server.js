const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE; // bookings table
const PORT = process.env.PORT || 3000;

const CALC_TABLE = "tblOUD5hWhHfVJgRV";
const LONG_HIRE_THRESHOLD_DAYS = 25;
const LONG_HIRE_DISCOUNT_RATE = 0.05;
const FULL_INSURANCE_PER_DAY = 30;
const DEPOSIT_RATE = 0.15;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
  console.error("Missing required environment variables.");
  console.error("Please set AIRTABLE_TOKEN, AIRTABLE_BASE_ID and AIRTABLE_TABLE in .env");
  process.exit(1);
}

function toCurrencyNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function inclusiveDays(startStr, endStr) {
  const start = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid start or end date.");
  }

  const diffMs = end.getTime() - start.getTime();
  const days = Math.floor(diffMs / 86400000) + 1;

  if (days < 1) {
    throw new Error("End date must be on or after start date.");
  }

  return days;
}

function mapBookingRecord(fields) {
  return {
    "Van Type": fields["Van Type"] || "",
    "Van": fields["Van"] || "",
    "PickUp": fields["PickUp"] || "",
    "DropOff": fields["DropOff"] || "",
    "Start": fields["Start"] || "",
    "End": fields["End"] || "",
    "Label": fields["Label"] || ""
  };
}

async function airtableFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Airtable API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

async function fetchAllAirtableRecords(tableIdOrName, mapper) {
  let records = [];
  let offset = null;

  do {
    const params = new URLSearchParams();
    if (offset) {
      params.append("offset", offset);
    }

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableIdOrName}?` +
      params.toString();

    const data = await airtableFetch(url);

    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  return records.map(function (record) {
    return mapper(record.fields || {}, record.id);
  });
}

async function createCalcRecord(start, end, vanType) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(CALC_TABLE)}`;

  const data = await airtableFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      fields: {
        "Start": start,
        "End": end,
        "Van Type": vanType,
        "Run": true
      }
    })
  });

  return data;
}

async function getCalcRecord(recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(CALC_TABLE)}/${recordId}`;
  return airtableFetch(url);
}

async function waitForVanCost(recordId, maxAttempts = 12, delayMs = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    const rec = await getCalcRecord(recordId);
    const fields = rec.fields || {};
    const vanCost = fields["Van Cost"];

    if (vanCost !== undefined && vanCost !== null && vanCost !== "") {
      return rec;
    }

    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new Error("Pricing timeout: Airtable did not return Van Cost in time.");
}

app.get("/healthz", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "airtable-json-feed",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/bookings", async (req, res) => {
  try {
    const bookings = await fetchAllAirtableRecords(
      AIRTABLE_TABLE,
      function (fields) {
        return mapBookingRecord(fields);
      }
    );

    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load bookings from Airtable",
      details: err.message
    });
  }
});

app.post("/api/quote", async (req, res) => {
  try {
    const { start, end, vanType } = req.body || {};

    if (!start || !end || !vanType) {
      return res.status(400).json({
        error: "Missing required fields",
        details: "Please provide start, end and vanType."
      });
    }

    const days = inclusiveDays(start, end);

    // 1) Create Calc2026 record so Airtable calculates Van Cost
    const created = await createCalcRecord(start, end, vanType);
    const recordId = created.id;

    if (!recordId) {
      throw new Error("Failed to create Calc2026 record.");
    }

    // 2) Wait until Airtable automation/script has written Van Cost
    const pricedRecord = await waitForVanCost(recordId);
    const fields = pricedRecord.fields || {};

    const vanCost = toCurrencyNumber(fields["Van Cost"]);
    const vehiclePriceStandardIncluded = round2(vanCost);

    // 3) Long hire discount
    const longHireDiscount =
      days >= LONG_HIRE_THRESHOLD_DAYS
        ? round2(vehiclePriceStandardIncluded * LONG_HIRE_DISCOUNT_RATE)
        : 0;

    // 4) Full insurance option
    const fullInsurance = round2(days * FULL_INSURANCE_PER_DAY);

    // 5) Totals
    const totalStandard = round2(vehiclePriceStandardIncluded - longHireDiscount);
    const totalFull = round2(totalStandard + fullInsurance);

    // 6) Deposit required
    const depositStandard = round2(totalStandard * DEPOSIT_RATE);
    const depositFull = round2(totalFull * DEPOSIT_RATE);

    res.json({
      start,
      end,
      vanType,
      days,
      vehiclePriceStandardIncluded,
      longHireDiscount,
      fullInsurance,
      totalStandard,
      totalFull,
      depositStandard,
      depositFull,
      calcRecordId: recordId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Quote calculation failed",
      details: err.message
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "calendar.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});