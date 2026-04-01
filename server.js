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
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE; // bookings table from .env
const PORT = process.env.PORT || 3000;

// Pricing / quote config
const CALC_TABLE = "tblOUD5hWhHfVJgRV";
const LONG_HIRE_THRESHOLD_DAYS = 25;
const LONG_HIRE_DISCOUNT_RATE = 0.05;
const FULL_INSURANCE_PER_DAY = 30;
const DEPOSIT_RATE = 0.15;

// Request storage
// For now we store requests in Calc2026 as well, because those fields definitely exist.
// If later you create a separate Requests table, only this constant and field map need changing.
const REQUEST_TABLE = CALC_TABLE;

// Confirmed Airtable fields in Calc2026
const REQUEST_FIELDS = {
  start: "Start",
  end: "End",
  pickup: "PickUp",
  dropoff: "DropOff",
  vanType: "Van Type",

  customerName: "Name",
  customerEmail: "Email",
  
  // OPTIONAL quote output fields if you later create them in Airtable
  totalStandard: null,
  totalFull: null,
  depositStandard: null,
  depositFull: null,
  longHireDiscount: null,
  fullInsurance: null,
  vehiclePriceStandardIncluded: null
};

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
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CALC_TABLE}`;

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
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CALC_TABLE}/${recordId}`;
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

function buildRequestFields(payload) {
  const fields = {};

  if (REQUEST_FIELDS.start && payload.start) {
    fields[REQUEST_FIELDS.start] = payload.start;
  }

  if (REQUEST_FIELDS.end && payload.end) {
    fields[REQUEST_FIELDS.end] = payload.end;
  }

  if (REQUEST_FIELDS.pickup && payload.pickup) {
    fields[REQUEST_FIELDS.pickup] = payload.pickup;
  }

  if (REQUEST_FIELDS.dropoff && payload.dropoff) {
    fields[REQUEST_FIELDS.dropoff] = payload.dropoff;
  }

  if (REQUEST_FIELDS.vanType && payload.vanType) {
    fields[REQUEST_FIELDS.vanType] = payload.vanType;
  }

  // Optional fields — only used if you later define them above
  if (REQUEST_FIELDS.customerName && payload.customerName) {
    fields[REQUEST_FIELDS.customerName] = payload.customerName;
  }

  if (REQUEST_FIELDS.customerEmail && payload.customerEmail) {
    fields[REQUEST_FIELDS.customerEmail] = payload.customerEmail;
  }

  if (REQUEST_FIELDS.totalStandard && payload.totalStandard != null) {
    fields[REQUEST_FIELDS.totalStandard] = payload.totalStandard;
  }

  if (REQUEST_FIELDS.totalFull && payload.totalFull != null) {
    fields[REQUEST_FIELDS.totalFull] = payload.totalFull;
  }

  if (REQUEST_FIELDS.depositStandard && payload.depositStandard != null) {
    fields[REQUEST_FIELDS.depositStandard] = payload.depositStandard;
  }

  if (REQUEST_FIELDS.depositFull && payload.depositFull != null) {
    fields[REQUEST_FIELDS.depositFull] = payload.depositFull;
  }

  if (REQUEST_FIELDS.longHireDiscount && payload.longHireDiscount != null) {
    fields[REQUEST_FIELDS.longHireDiscount] = payload.longHireDiscount;
  }

  if (REQUEST_FIELDS.fullInsurance && payload.fullInsurance != null) {
    fields[REQUEST_FIELDS.fullInsurance] = payload.fullInsurance;
  }

  if (REQUEST_FIELDS.vehiclePriceStandardIncluded && payload.vehiclePriceStandardIncluded != null) {
    fields[REQUEST_FIELDS.vehiclePriceStandardIncluded] = payload.vehiclePriceStandardIncluded;
  }

  return fields;
}

async function createRequestRecord(payload) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${REQUEST_TABLE}`;

  const fields = buildRequestFields(payload);

  const data = await airtableFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields })
  });

  return data;
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

    const created = await createCalcRecord(start, end, vanType);
    const recordId = created.id;

    if (!recordId) {
      throw new Error("Failed to create Calc record.");
    }

    const pricedRecord = await waitForVanCost(recordId);
    const fields = pricedRecord.fields || {};

    const vanCost = toCurrencyNumber(fields["Van Cost"]);
    const vehiclePriceStandardIncluded = round2(vanCost);

    const longHireDiscount =
      days >= LONG_HIRE_THRESHOLD_DAYS
        ? round2(vehiclePriceStandardIncluded * LONG_HIRE_DISCOUNT_RATE)
        : 0;

    const fullInsurance = round2(days * FULL_INSURANCE_PER_DAY);

    const totalStandard = round2(vehiclePriceStandardIncluded - longHireDiscount);
    const totalFull = round2(totalStandard + fullInsurance);

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

app.post("/api/request", async (req, res) => {
  try {
    const {
      start,
      end,
      vanType,
      pickup,
      dropoff,
      customerName,
      customerEmail,
      days,
      vehiclePriceStandardIncluded,
      longHireDiscount,
      fullInsurance,
      totalStandard,
      totalFull,
      depositStandard,
      depositFull
    } = req.body || {};

    if (!start || !end || !vanType || !pickup || !dropoff) {
      return res.status(400).json({
        error: "Missing required request fields",
        details: "Please provide start, end, vanType, pickup and dropoff."
      });
    }

    const created = await createRequestRecord({
      start,
      end,
      vanType,
      pickup,
      dropoff,
      customerName,
      customerEmail,
      days,
      vehiclePriceStandardIncluded,
      longHireDiscount,
      fullInsurance,
      totalStandard,
      totalFull,
      depositStandard,
      depositFull
    });

    res.json({
      ok: true,
      message: "Request saved successfully.",
      requestRecordId: created.id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Request could not be saved",
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