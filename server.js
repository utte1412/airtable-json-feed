const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.static(__dirname));

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;
const PORT = process.env.PORT || 3000;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
  console.error("Missing required environment variables.");
  console.error("Please set AIRTABLE_TOKEN, AIRTABLE_BASE_ID and AIRTABLE_TABLE in .env");
  process.exit(1);
}

function mapRecord(fields) {
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

async function fetchAllAirtableRecords() {
  let records = [];
  let offset = null;

  do {
    const params = new URLSearchParams();
    if (offset) {
      params.append("offset", offset);
    }

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}?` +
      params.toString();

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Airtable API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  return records.map(function (record) {
    return mapRecord(record.fields || {});
  });
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
    const bookings = await fetchAllAirtableRecords();
    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load bookings from Airtable",
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