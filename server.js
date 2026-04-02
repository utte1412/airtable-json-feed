const express = require("express");
const cors = require("cors");
const path = require("path");
const { Resend } = require("resend");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE; // Bookings table from .env
const PORT = process.env.PORT || 3000;

// Resend
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Bayinvent <quotes@mail.bayinvent.com>";
const EMAIL_TO_INTERNAL = process.env.EMAIL_TO_INTERNAL || "info@bayinvent.com";

// Pricing / quote config
const CALC_TABLE = "tblOUD5hWhHfVJgRV";
const LONG_HIRE_THRESHOLD_DAYS = 25;
const LONG_HIRE_DISCOUNT_RATE = 0.05;
const FULL_INSURANCE_PER_DAY = 30;
const DEPOSIT_RATE = 0.15;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
  console.error("Missing required Airtable environment variables.");
  console.error("Please set AIRTABLE_TOKEN, AIRTABLE_BASE_ID and AIRTABLE_TABLE.");
  process.exit(1);
}

if (!RESEND_API_KEY) {
  console.error("Missing RESEND_API_KEY.");
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

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

function formatDateDisplay(isoDate) {
  const parts = String(isoDate || "").split("-");
  if (parts.length !== 3) return isoDate || "";
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function money(value) {
  return new Intl.NumberFormat("en-NZ", {
    style: "currency",
    currency: "NZD"
  }).format(Number(value || 0));
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

async function airtableDelete(url) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`
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

  return records.map((record) => mapper(record.fields || {}, record.id));
}

async function createCalcRecord(fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CALC_TABLE}`;

  return airtableFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields })
  });
}

async function getCalcRecord(recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CALC_TABLE}/${recordId}`;
  return airtableFetch(url);
}

async function deleteCalcRecord(recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${CALC_TABLE}/${recordId}`;
  return airtableDelete(url);
}

async function waitForVanCost(recordId, maxAttempts = 12, delayMs = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    const rec = await getCalcRecord(recordId);
    const fields = rec.fields || {};
    const vanCost = fields["Van Cost"];

    if (vanCost !== undefined && vanCost !== null && vanCost !== "") {
      return rec;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Pricing timeout: Airtable did not return Van Cost in time.");
}

async function sendCustomerEmail(payload) {
  const subject = "Your Bayinvent Quote Request";

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2a1f; line-height: 1.5;">
      <h2 style="margin-bottom: 12px;">Thank you for your request</h2>
      <p>Hello ${payload.customerName},</p>
      <p>Thanks for contacting Bayinvent. We have received your request and a personalized quote will follow shortly from <strong>The team @ Bayinvent</strong>.</p>

      <h3 style="margin-top: 24px;">Your request details</h3>
      <ul>
        <li><strong>Van Type:</strong> ${payload.vanType}</li>
        <li><strong>Travel Dates:</strong> ${formatDateDisplay(payload.start)} → ${formatDateDisplay(payload.end)}</li>
        <li><strong>Pick up:</strong> ${payload.pickup}</li>
        <li><strong>Drop off:</strong> ${payload.dropoff}</li>
      </ul>

      <p style="margin-top: 20px;">Kind regards,<br><strong>The team @ Bayinvent</strong></p>
    </div>
  `;

  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: [payload.customerEmail],
    subject,
    html
  });

  console.log("Customer email result:", JSON.stringify(result));

  if (result.error) {
    throw new Error(`Customer email failed: ${JSON.stringify(result.error)}`);
  }

  return result;
}

async function sendInternalEmail(payload) {
  const subject = "New Quote Request";

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2a1f; line-height: 1.5;">
      <h2 style="margin-bottom: 12px;">New Quote Request</h2>

      <ul>
        <li><strong>Name:</strong> ${payload.customerName}</li>
        <li><strong>Email:</strong> ${payload.customerEmail}</li>
        <li><strong>Van Type:</strong> ${payload.vanType}</li>
        <li><strong>Travel Dates:</strong> ${formatDateDisplay(payload.start)} → ${formatDateDisplay(payload.end)}</li>
        <li><strong>Days:</strong> ${payload.days}</li>
        <li><strong>Pick up:</strong> ${payload.pickup}</li>
        <li><strong>Drop off:</strong> ${payload.dropoff}</li>
      </ul>

      <h3 style="margin-top: 24px;">Quote Snapshot</h3>
      <ul>
        <li><strong>Vehicle price incl. standard insurance:</strong> ${money(payload.vehiclePriceStandardIncluded)}</li>
        <li><strong>Long hire discount:</strong> ${money(payload.longHireDiscount)}</li>
        <li><strong>Full insurance option:</strong> ${money(payload.fullInsurance)}</li>
        <li><strong>Total standard:</strong> ${money(payload.totalStandard)}</li>
        <li><strong>Total full:</strong> ${money(payload.totalFull)}</li>
        <li><strong>Deposit standard:</strong> ${money(payload.depositStandard)}</li>
        <li><strong>Deposit full:</strong> ${money(payload.depositFull)}</li>
      </ul>
    </div>
  `;

  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: [EMAIL_TO_INTERNAL],
    subject,
    html
  });

  console.log("Internal email result:", JSON.stringify(result));

  if (result.error) {
    throw new Error(`Internal email failed: ${JSON.stringify(result.error)}`);
  }

  return result;
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
    const bookings = await fetchAllAirtableRecords(AIRTABLE_TABLE, (fields) =>
      mapBookingRecord(fields)
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
  let tempRecordId = null;

  try {
    const { start, end, vanType } = req.body || {};

    if (!start || !end || !vanType) {
      return res.status(400).json({
        error: "Missing required fields",
        details: "Please provide start, end and vanType."
      });
    }

    const days = inclusiveDays(start, end);

    const created = await createCalcRecord({
      "Start": start,
      "End": end,
      "Van Type": vanType,
      "Run": true
    });

    tempRecordId = created.id;

    if (!tempRecordId) {
      throw new Error("Failed to create temporary Calc record.");
    }

    const pricedRecord = await waitForVanCost(tempRecordId);
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

    await deleteCalcRecord(tempRecordId);
    tempRecordId = null;

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
      depositFull
    });
  } catch (err) {
    console.error(err);

    if (tempRecordId) {
      try {
        await deleteCalcRecord(tempRecordId);
      } catch (cleanupErr) {
        console.error("Failed to clean up temporary calc record:", cleanupErr);
      }
    }

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

    if (
      !start ||
      !end ||
      !vanType ||
      !pickup ||
      !dropoff ||
      !customerName ||
      !customerEmail
    ) {
      return res.status(400).json({
        error: "Missing required request fields",
        details: "Please provide start, end, vanType, pickup, dropoff, customerName and customerEmail."
      });
    }

    const created = await createCalcRecord({
      "Start": start,
      "End": end,
      "PickUp": pickup,
      "DropOff": dropoff,
      "Van Type": vanType,
      "Name": customerName,
      "Email": customerEmail,
      "Run": true
    });

    await Promise.all([
      sendCustomerEmail({
        start,
        end,
        vanType,
        pickup,
        dropoff,
        customerName,
        customerEmail
      }),
      sendInternalEmail({
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
      })
    ]);

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