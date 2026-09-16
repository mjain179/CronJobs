/**
 * updateShippizTrackingStatus.js
 *
 * Standalone script (intended for cron, twice daily).
 *
 * SCHEMA
 * ------
 * tracking_fresh carries ONE Shippiz column, `shippiz_shipment_id`, holding the
 * shipment that produced the tracking number on that row. The per-leg columns
 * an earlier draft used (shippiz_console_outgoing_shipment_id and friends,
 * device_incoming_status, the *_label columns, the per-leg POD and
 * delivered-date columns) no longer exist — this script must never reference
 * them.
 *
 * That means one shipment per tracking_fresh row, not four legs:
 *
 *   shippiz_shipment_id -> status            (overall shipping status)
 *                       -> proof_of_delivery
 *                       -> delivery_date
 *
 * Which tracking number the id belongs to depends on how the row was last
 * written. The label creators set it alongside an OUTBOUND tracking number on
 * an initial or replacement shipment, and alongside a RETURN tracking number on
 * a standalone dashboard return. We resolve outbound first, fall back to the
 * return number, and record which column we used — because that decides whether
 * this delivery is allowed to stamp insurance_fresh.
 *
 * WORK QUEUE
 * ----------
 * Every run rebuilds the work queue from SQL — one line per shipment that needs
 * checking — and writes it to disk as a CSV. Each entry is removed from the CSV
 * as soon as it is resolved (status checked, and either skipped or written).
 * Entries whose lookup or write fails transiently stay in the CSV with an
 * incremented attempt count and are retried up to MAX_PASSES times.
 *
 * IMPORTANT: the queue is ALWAYS rebuilt from SQL. A leftover CSV from an
 * interrupted run is used only to carry attempt counts forward, never as a
 * substitute for the rebuild. An earlier version resumed the leftover CSV in
 * place of rebuilding, which meant a single permanently-failing shipment froze
 * the entire sync — every other shipment silently stopped being checked.
 *
 * ERROR CLASSIFICATION
 * --------------------
 * Not every failure is worth retrying:
 *
 *   - transient (429, 502/503/504, timeouts, network faults) -> stays in the
 *     queue and is retried within this run
 *   - permanent (4xx, 500 — Shippiz returns a deterministic 500 for some
 *     shipments) -> recorded once and dropped from this run's queue. Retrying
 *     it two more times in the same 90 seconds cannot succeed; it will be
 *     picked up again on the next run.
 *   - no trackingStatus at all -> NOT an error. A label that exists but has
 *     never been scanned has no tracking data yet, which is the normal state of
 *     a return label for weeks. Resolved as a no-op, counted, never emailed.
 *
 * FAILURE STATE AND QUARANTINE
 * ----------------------------
 * Consecutive failed runs per shipment are tracked in
 * shippiz_tracking_state.json. After MAX_FAILED_RUNS the entry is quarantined:
 * still reported, but no longer queued, so no single shipment can consume the
 * run budget forever. Use --include-quarantined to retry them, or
 * --reset-state to clear the file.
 *
 * The failure report emailed to ALERT_EMAIL is written to its own timestamped
 * CSV. The live work queue is always cleared at the end of a run — it is
 * scratch state, not an alert artifact.
 *
 * STATUS RULES
 * ------------
 *   - a row whose `status` already reads "delivered" (any case) is never queued
 *   - if the Shippiz status EQUALS the current status, the row is dropped from
 *     the queue and NOTHING is written to either table
 *   - only an actual change writes to tracking_fresh + tracking
 *
 * PROOF OF DELIVERY
 * -----------------
 * When the new status reads "delivered", the UPS POD is fetched, rendered to
 * PDF, uploaded to Google Drive, and the link written to
 * tracking_fresh.proof_of_delivery along with delivery_date. The status is also
 * mirrored into story_fresh / story (story_id = tracking_id, type 'tracking'),
 * as updateTrackingOrderField does in ordersDBTools.js — with one deliberate
 * difference: the story status is a ONE-WAY RATCHET. Once a story reads
 * delivered it is never walked back.
 *
 * This matters because issuing a replacement or return label resets
 * tracking_fresh.status to CREATED, and under Shippo the next carrier scan on
 * that new parcel would drag story_fresh.status off DELIVERED with it, losing
 * the initial delivery milestone that claims read. tracking_fresh.status stays
 * the live answer for "where is the current parcel"; story_fresh.status becomes
 * "did this patient's device ever arrive".
 *
 * insurance_fresh is stamped only when the tracking number we tracked was an
 * OUTBOUND one, and only while its delivered_date and proof_of_delivery are
 * both still empty — so a return delivery can never overwrite the initial
 * shipment's POD, and neither can a re-run.
 *
 * Run from the NodeServer directory so the relative credential paths resolve:
 *   cd /home/develop/ShippingWebServer/NodeServer
 *   node scripts/updateShippizTrackingStatus.js
 *
 * Flags:
 *   --dry-run               fetch and report, write nothing, send no email,
 *                           touch no state on disk
 *   --limit=N               only queue the N most recent tracking_fresh rows
 *   --fresh                 ignore any leftover CSV from an interrupted run
 *   --include-quarantined   also queue shipments that have been quarantined
 *   --reset-state           clear the persisted failure/quarantine state first
 */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const nodemailer = require("nodemailer");
const wkhtmltopdf = require("wkhtmltopdf");
const { google } = require("googleapis");
const { Pool } = require("pg");

// ----------------------------------------------------------------- config

const SHIPPIZ_BASE_URL = "https://api.shippiz.com/api/v1";
const TRACK_PATH = "/shipments";
const UPDATED_BY = "service@motusnova.com";
const ALERT_EMAIL = "manav.jain@motusnova.com";
const ALERT_FROM = "service@motusnova.com";

const CSV_PATH = path.join(__dirname, "shippiz_tracking_queue.csv");
const STATE_PATH = path.join(__dirname, "shippiz_tracking_state.json");

// --- proof of delivery (UPS + Google Drive) ---
const UPS_CREDENTIALS_PATH = path.join(__dirname, "ups.json");
const GDRIVE_CREDENTIALS_PATH = path.join(__dirname, "credentials_manav.json");
const GDRIVE_POD_FOLDER_ID = process.env.GDRIVE_POD_FOLDER_ID;
const UPS_TOKEN_URL = "https://wwwcie.ups.com/security/v1/oauth/token";
const UPS_TRACK_URL = "https://onlinetools.ups.com/api/track/v1/details";

const MAX_PASSES = 3;                  // retries of the whole queue, within one run
const MAX_FAILED_RUNS = 6;             // consecutive failed runs before quarantine
const DELAY_BETWEEN_CALLS_MS = 250;
const DELAY_BETWEEN_PASSES_MS = 5000;
const REQUEST_TIMEOUT_MS = 20000;

// HTTP statuses worth retrying inside a single run. Anything else — including
// a 500, which Shippiz returns deterministically for some shipments — is
// permanent for the duration of this run.
const TRANSIENT_HTTP_STATUSES = [408, 425, 429, 502, 503, 504];

// Once a status matches one of these the shipment is finished and never queued again.
const TERMINAL_STATUSES = ["delivered"];
const EXCLUDED_TRACKING_IDS = [560256];

// The single Shippiz shipment tracked per tracking_fresh row. Kept as a config
// object rather than inlined so that re-introducing per-leg columns later is a
// data change, not a rewrite.
const SHIPMENT = {
    name: "shipment",
    idColumn: "shippiz_shipment_id",
    statusColumn: "status",
    podColumn: "proof_of_delivery",
    deliveredDateColumn: "delivery_date",
    // `status` is the overall shipping status, so it is mirrored into
    // story_fresh / story (story_id = tracking_id).
    updatesStory: true,
};

// Tracking-number resolution, in priority order. Outbound first: on an initial
// or replacement shipment the label creators write both device_ and console_
// tracking numbers to the same value, so either identifies the outbound parcel.
// return_tracking_number is the fallback for a standalone dashboard return.
const OUTBOUND_TRACKING_COLUMNS = ["device_tracking_number", "console_tracking_number"];
const RETURN_TRACKING_COLUMN = "return_tracking_number";

// Columns carried forward into each tracking log row so the snapshot is complete.
// Every one of these must exist on both tracking_fresh and tracking.
const SNAPSHOT_COLUMNS = [
    "device_tracking_number",
    "console_tracking_number",
    "return_tracking_number",
    "shippiz_shipment_id",
    "proof_of_delivery",
    "delivery_date",
    "status",
];

const CSV_HEADERS = [
    "tracking_id", "contact_id", "profile_id", "patient_name", "leg", "shipment_id",
    "tracking_number", "tracking_column", "current_status", "has_pod",
    "attempts", "last_error",
];

// The emailed report carries two extra columns the work queue does not need.
const FAILURE_HEADERS = [...CSV_HEADERS, "failed_runs", "disposition"];

// ----------------------------------------------------------------- setup

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FRESH = args.includes("--fresh");
const INCLUDE_QUARANTINED = args.includes("--include-quarantined");
const RESET_STATE = args.includes("--reset-state");
const limitArg = args.find((a) => a.startsWith("--limit="));
const ROW_LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

const orders_db_credentials = JSON.parse(
    fs.readFileSync("./game_db_credentials.json")
);

const pool = new Pool({
    host: orders_db_credentials.host,
    user: orders_db_credentials.user,
    database: orders_db_credentials.database,
    password: orders_db_credentials.password,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => console.log(`Unexpected PG error: ${err}`));

const shippizClient = axios.create({
    baseURL: SHIPPIZ_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { "x-api-key": process.env.SHIPPIZ_API_KEY },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

function isTerminal(status) {
    if (!status) return false;
    const s = String(status).trim().toLowerCase();
    return TERMINAL_STATUSES.some((t) => s.includes(t));
}

/** Stable identity for one tracked shipment, used to key the state file. */
function legKey(item) {
    return `${item.tracking_id}:${item.leg}`;
}

/**
 * Pick the tracking number that goes with this row's shippiz_shipment_id, and
 * report which column it came from. The column matters: only an outbound
 * number may stamp insurance_fresh.
 */
function resolveTrackingNumber(row) {
    for (const col of OUTBOUND_TRACKING_COLUMNS) {
        const v = row[col];
        if (v && String(v).trim() !== "") {
            return { trackingNumber: String(v).trim(), column: col };
        }
    }
    const ret = row[RETURN_TRACKING_COLUMN];
    if (ret && String(ret).trim() !== "") {
        return { trackingNumber: String(ret).trim(), column: RETURN_TRACKING_COLUMN };
    }
    return { trackingNumber: "", column: "" };
}

function isOutboundColumn(column) {
    return OUTBOUND_TRACKING_COLUMNS.includes(column);
}

/**
 * How a shipment is named in the log. Leads with the profile id because that is
 * what the shipping dashboard and the UID barcode use, so a log line can be
 * pasted straight into a lookup. tracking_id trails it for joining to the
 * tables. Falls back gracefully when the name or profile can't be resolved.
 */
function describeItem(item) {
    const who = item.profile_id ? `UID${item.profile_id}` : `contact ${item.contact_id}`;
    const name = item.patient_name ? ` ${item.patient_name}` : "";
    return `${who}${name} [tracking ${item.tracking_id}]`;
}

/**
 * Has this row already been stamped with a delivery? Proof of delivery and the
 * delivery date are WRITE-ONCE on both tracking_fresh and insurance_fresh: the
 * first delivery recorded for a patient is the one that counts, and a later
 * return or replacement delivery must never overwrite it.
 *
 * Checked against tracking_fresh (the `row`/`current` shape) and separately
 * against insurance_fresh, because the two can legitimately be stamped at
 * different times on rows that predate this script.
 */
function hasPodAlready(row) {
    if (!row) return false;
    if (row.delivery_date != null) return true;
    return row.proof_of_delivery != null && String(row.proof_of_delivery).trim() !== "";
}

// ------------------------------------------------------------------- csv

function csvEscape(value) {
    if (value === null || value === undefined) return "";
    // Flatten newlines: the reader is line-based, so an embedded newline in
    // (say) an error message would otherwise split one record across two lines
    // and corrupt the queue on the next run.
    const s = String(value).replace(/\r?\n/g, " ").trim();
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Minimal RFC-4180 line parser — handles quoted fields containing commas. */
function csvParseLine(line) {
    const out = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            out.push(field); field = "";
        } else field += c;
    }
    out.push(field);
    return out;
}

function writeCsv(filePath, headers, items) {
    const lines = [headers.join(",")];
    for (const it of items) {
        lines.push(headers.map((h) => csvEscape(it[h])).join(","));
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function writeQueue(items) {
    // A dry run must leave the on-disk queue exactly as it found it.
    if (DRY_RUN) return;
    writeCsv(CSV_PATH, CSV_HEADERS, items);
}

function readQueue() {
    if (!fs.existsSync(CSV_PATH)) return null;
    const raw = fs.readFileSync(CSV_PATH, "utf8").trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    const headers = csvParseLine(lines[0]);
    return lines.slice(1).filter(Boolean).map((line) => {
        const cells = csvParseLine(line);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
        obj.attempts = parseInt(obj.attempts, 10) || 0;
        obj.has_pod = obj.has_pod === "true" || obj.has_pod === "1";
        return obj;
    });
}

function clearQueue() {
    if (DRY_RUN) return;
    if (fs.existsSync(CSV_PATH)) fs.unlinkSync(CSV_PATH);
}

/**
 * The emailed failure report — a separate, timestamped file. Keeping this
 * distinct from CSV_PATH is deliberate: the work queue is scratch state and is
 * always cleared, so a failure can never block the next run's rebuild.
 */
function writeFailureReport(items) {
    const reportPath = path.join(
        __dirname,
        `shippiz_tracking_failures_${new Date().toISOString().slice(0, 10)}.csv`
    );
    writeCsv(reportPath, FAILURE_HEADERS, items);
    return reportPath;
}

// ------------------------------------------------------------ failure state

/**
 * Persisted per-shipment failure history:
 *
 *   { "560256:shipment": {
 *       tracking_id, leg, shipment_id,
 *       attempts, failed_runs, last_error,
 *       first_failed_at, last_failed_at, quarantined } }
 *
 * failed_runs counts consecutive RUNS that ended unresolved, not individual
 * attempts, so the quarantine threshold means the same thing whether a shipment
 * is failing transiently (3 attempts/run) or permanently (1 attempt/run).
 */
function readState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeState(state) {
    if (DRY_RUN) return;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function clearState() {
    if (DRY_RUN) return;
    if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
}

// ----------------------------------------------------------------- shippiz

/** Is this HTTP status worth another attempt inside the same run? */
function isTransientHttpStatus(code) {
    if (!code) return true;                 // timeout / DNS / connection reset
    return TRANSIENT_HTTP_STATUSES.includes(code);
}

/**
 * GET /shipments/{shipment_id}
 *
 * Returns exactly one of:
 *   { status, statusDescription }   - tracking data available
 *   { noTrackingData: true }        - label exists, carrier has no scan yet
 *   { error, transient }            - lookup failed; transient decides retry
 *
 * Never throws — the outcome is recorded on the queue item by the caller.
 */
async function fetchTrackingStatus(shipment_id) {
    try {
        const res = await shippizClient.get(`${TRACK_PATH}/${shipment_id}`);
        const body = res.data || {};
        const shipment = body.shipmentAfterUpdate || body.shipment || body;
        const tracking = shipment?.trackingStatus?.status;
        const overall = shipment?.status;

        // trackingStatus.status can be an empty string on shipments the carrier
        // hasn't reported on yet; the live state lives on the top-level `status`.
        const status = (tracking && String(tracking).trim()) || (overall && String(overall).trim()) || null;

        if (!status) {
            return { noTrackingData: true };
        }
        return {
            status,
            statusDescription: shipment?.trackingStatus?.statusDescription ?? null,
        };
    } catch (err) {
        const code = err.response?.status;
        const detail = err.response?.data
            ? JSON.stringify(err.response.data).slice(0, 200)
            : (err.code || err.message);
        return {
            error: `HTTP ${code || "?"}: ${detail}`,
            transient: isTransientHttpStatus(code),
        };
    }
}


// --------------------------------------------------------- proof of delivery

/**
 * The POD path mirrors proofOfDeliveryFunctions.js exactly: UPS OAuth ->
 * /track/v1/details with returnPOD -> base64-decode the HTML -> inject the
 * beneficiary block -> wkhtmltopdf -> upload to Google Drive -> public link.
 */

let upsCredentials = null;
function getUpsCredentials() {
    if (!upsCredentials) {
        upsCredentials = JSON.parse(fs.readFileSync(UPS_CREDENTIALS_PATH));
    }
    return upsCredentials;
}

/**
 * Adds beneficiary name, quantity and description right after the
 * "Package Weight" div, falling back to appending at the end.
 */
function modifyHtmlContent(decodedHtml, name, peripheralType) {
    let modifiedHtml = decodedHtml;

    let description = "E0739 Motus ";
    if (peripheralType && peripheralType.toLowerCase().includes("hand")) {
        description += "Hand";
    } else if (peripheralType && peripheralType.toLowerCase().includes("foot")) {
        description += "Foot";
    } else {
        description += "Hand/Foot";
    }
    description += " - Rehab System with interactive interface providing active assistance in rehabilitation therapy, includes all components and accessories, motors, microprocessors, sensors.";

    const quantity = 1;

    const newDivsFormatted = `
<div class="centered-div">Beneficiary's name: ${name}</div>
<div class="centered-div">Quantity: ${quantity}</div>
<div class="centered-div">Description: ${description}</div>`;

    const packageWeightDivRegex = /<div[^>]*class="centered-div"[^>]*>([^<]*Package Weight[^<]*)<\/div>/i;
    const packageWeightMatch = packageWeightDivRegex.exec(modifiedHtml);

    if (packageWeightMatch) {
        const insertPosition = packageWeightMatch.index + packageWeightMatch[0].length;
        modifiedHtml =
            modifiedHtml.slice(0, insertPosition) +
            newDivsFormatted +
            modifiedHtml.slice(insertPosition);
    } else {
        log('  no "Package Weight" div found in POD html — appending at end');
        modifiedHtml += newDivsFormatted;
    }

    return modifiedHtml;
}

/** UPS OAuth client-credentials token. */
async function getUpsAccessToken() {
    const { client_id, client_secret } = getUpsCredentials();
    const response = await axios.post(UPS_TOKEN_URL, "grant_type=client_credentials", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        auth: { username: client_id, password: client_secret },
        timeout: REQUEST_TIMEOUT_MS,
    });
    return response.data.access_token;
}

/** Beneficiary name + peripheral type for the POD document. */
async function getPodContext(contact_id) {
    const text = `
        SELECT (c.first_name || ' ' || c.last_name) AS billing_name,
               CASE
                 WHEN i.product = 'MotusFoot' THEN 'foot'
                 WHEN i.product = 'MotusHand' THEN 'hand'
                 ELSE i.product
               END AS peripheral_type
        FROM tracking_fresh t
        LEFT JOIN contacts_fresh c  ON t.contact_id  = c.contact_id
        LEFT JOIN insurance_fresh i ON t.insurance_id = i.insurance_id
        WHERE t.contact_id = $1
        ORDER BY t.created_at DESC
        LIMIT 1
    `;
    const row = (await pool.query(text, [contact_id])).rows[0] || {};
    return {
        name: (row.billing_name || `contact_${contact_id}`).trim(),
        peripheralType: row.peripheral_type || "hand",
    };
}

/**
 * Fetch the POD for one tracking number, render it, upload to Drive, and
 * return the public link. Throws on any failure — the caller records the
 * error on the queue item so the shipment is retried next pass.
 */
async function generatePodLink(trackingNumber, contact_id) {
    if (!GDRIVE_POD_FOLDER_ID) {
        throw new Error("GDRIVE_POD_FOLDER_ID is not set");
    }

    const access_token = await getUpsAccessToken();

    const response = await axios.get(`${UPS_TRACK_URL}/${trackingNumber}`, {
        headers: {
            transId: "t1",
            transactionSrc: "Proof of Delivery",
            Authorization: `Bearer ${access_token}`,
        },
        params: {
            locale: "en_US",
            returnSignature: "true",
            returnMilestones: "true",
            returnPOD: "true",
        },
        timeout: REQUEST_TIMEOUT_MS,
    });

    const pod_content =
        response.data?.trackResponse?.shipment?.[0]?.package?.[0]?.deliveryInformation?.pod?.content;
    if (!pod_content) {
        throw new Error("UPS response contains no proof of delivery content");
    }

    const decoded_html = Buffer.from(pod_content, "base64").toString("utf-8");

    const { name, peripheralType } = await getPodContext(contact_id);
    const modifiedHtml = modifyHtmlContent(decoded_html, name, peripheralType);

    // Unique filename: the cron may process several shipments for the same
    // patient in one run, and `${name}POD.pdf` would collide.
    const pdf_file_name = path.join(
        os.tmpdir(),
        `${String(name).replace(/[^A-Za-z0-9]/g, "_")}_${trackingNumber}_POD.pdf`
    );

    await new Promise((resolve, reject) => {
        wkhtmltopdf(
            modifiedHtml,
            { output: pdf_file_name, enableLocalFileAccess: true },
            (err) => (err ? reject(err) : resolve())
        );
    });

    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: GDRIVE_CREDENTIALS_PATH,
            scopes: ["https://www.googleapis.com/auth/drive.file"],
        });
        const drive = google.drive({ version: "v3", auth });

        const file = await drive.files.create({
            resource: { name: path.basename(pdf_file_name), parents: [GDRIVE_POD_FOLDER_ID] },
            media: { mimeType: "application/pdf", body: fs.createReadStream(pdf_file_name) },
            fields: "id, webViewLink",
        });

        await drive.permissions.create({
            fileId: file.data.id,
            requestBody: { role: "reader", type: "anyone" },
        });

        log(`    POD uploaded to Drive: ${file.data.id}`);
        return file.data.webViewLink;
    } finally {
        // Always clean up the local PDF, upload succeeded or not.
        try { fs.unlinkSync(pdf_file_name); } catch { /* already gone */ }
    }
}

// ---------------------------------------------------------------------- db

async function buildQueueFromDB() {
    const params = [];
    let excludeClause = "";
    if (EXCLUDED_TRACKING_IDS.length > 0) {
        params.push(EXCLUDED_TRACKING_IDS);
        excludeClause = `AND NOT (tracking_id = ANY($${params.length}))`;
    }

    // The patient name and profile id are resolved here, once, rather than per
    // row at log time. profile_id is the newProfile story hanging off this
    // row's insurance_id — the same id the dashboard and the UID barcode use.
    const text = `
        SELECT t.tracking_id, t.contact_id, ${SNAPSHOT_COLUMNS.map((c) => `t.${c}`).join(", ")},
               NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS patient_name,
               prof.profile_id
        FROM tracking_fresh t
        LEFT JOIN contacts_fresh c ON c.contact_id = t.contact_id
        LEFT JOIN LATERAL (
            SELECT sf.destination AS profile_id
            FROM story_fresh sf
            WHERE sf.origin = t.insurance_id
              AND sf.type IN ('newProfile', 'newClinicProfile', 'internalProfile')
            ORDER BY sf.story_id DESC
            LIMIT 1
        ) prof ON true
        WHERE t.shippiz_shipment_id IS NOT NULL
        ${excludeClause.replace("tracking_id", "t.tracking_id")}
        ORDER BY t.created_at DESC
        ${ROW_LIMIT ? `LIMIT ${Number(ROW_LIMIT)}` : ""}
    `;
    const rows = (await pool.query(text, params)).rows;

    const items = [];
    let terminalSkipped = 0;

    for (const row of rows) {
        if (isTerminal(row[SHIPMENT.statusColumn])) {
            terminalSkipped++;
            continue;
        }

        const { trackingNumber, column } = resolveTrackingNumber(row);

        items.push({
            tracking_id: row.tracking_id,
            contact_id: row.contact_id,
            profile_id: row.profile_id ?? "",
            patient_name: row.patient_name ?? "",
            leg: SHIPMENT.name,
            shipment_id: row[SHIPMENT.idColumn],
            tracking_number: trackingNumber,
            tracking_column: column,
            current_status: row[SHIPMENT.statusColumn] ?? "",
            has_pod: hasPodAlready(row),
            attempts: 0,
            last_error: "",
        });
    }

    log(`${rows.length} tracking_fresh row(s) scanned -> ${items.length} shipment(s) queued, ${terminalSkipped} already delivered`);
    return items;
}

/**
 * Write the new status, and — when the shipment has just been delivered — its
 * proof-of-delivery link and delivery date.
 *
 * The tracking_fresh row is re-read inside the transaction so the log snapshot
 * reflects anything updated earlier in this run.
 *
 * insurance_fresh is stamped only when the tracked number was an OUTBOUND one,
 * and only while its delivered_date and proof_of_delivery are both still empty
 * — the same guard the label creators use, so a return delivery can never
 * overwrite the initial shipment's POD.
 */
async function writeLegStatus(item, newStatus, podLink = null) {
    const leg = SHIPMENT;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const current = (await client.query(
            `SELECT tracking_id, contact_id, insurance_id, ${SNAPSHOT_COLUMNS.join(", ")}
             FROM tracking_fresh WHERE tracking_id = $1 FOR UPDATE`,
            [item.tracking_id]
        )).rows[0];

        if (!current) throw new Error(`tracking_id ${item.tracking_id} no longer exists`);

        // One timestamp for the whole transaction, so tracking_fresh, the
        // tracking log row and insurance_fresh all record the same instant.
        const deliveredAt = podLink ? new Date() : null;

        // Re-check under the row lock. runPass already skipped the POD fetch for
        // rows that were stamped at queue-build time, but the row can change
        // between then and here — this is the authoritative write-once gate for
        // tracking_fresh.
        const trackingAlreadyStamped = hasPodAlready(current);

        const setPairs = { [leg.statusColumn]: newStatus, username: UPDATED_BY };
        if (podLink && !trackingAlreadyStamped) {
            setPairs[leg.podColumn] = podLink;
            setPairs[leg.deliveredDateColumn] = deliveredAt;
        } else if (podLink) {
            log(`    tracking_fresh already stamped — POD/delivery_date left untouched`);
        }
        const setCols = Object.keys(setPairs);
        const setClause = setCols.map((c, i) => `${c} = $${i + 1}`).join(", ");

        await client.query(
            `UPDATE tracking_fresh SET ${setClause} WHERE tracking_id = $${setCols.length + 1}`,
            [...setCols.map((c) => setPairs[c]), item.tracking_id]
        );

        // story_fresh / story mirror the overall shipping status, but never
        // regress a DELIVERED story. story_id is the same value as tracking_id.
        // A replacement or return label resets tracking_fresh.status to CREATED;
        // the initial delivery milestone on the story must survive that, because
        // claims read it. Terminal -> terminal is still written so the timestamp
        // and username stay current.
        if (leg.updatesStory) {
            const storyStatus = (await client.query(
                `SELECT status FROM story_fresh WHERE story_id = $1 FOR UPDATE`,
                [item.tracking_id]
            )).rows[0]?.status;

            if (isTerminal(storyStatus) && !isTerminal(newStatus)) {
                log(`    story_fresh already ${storyStatus} — not regressed to ${newStatus}`);
            } else {
                await client.query(
                    `UPDATE story_fresh SET status = $1, username = $2, created_at = NOW()
                     WHERE story_id = $3`,
                    [newStatus, UPDATED_BY, item.tracking_id]
                );
                await client.query(
                    `INSERT INTO story (story_id, status, username) VALUES ($1, $2, $3)`,
                    [item.tracking_id, newStatus, UPDATED_BY]
                );
                log(`    story_fresh -> ${newStatus}`);
            }
        }

        // insurance_fresh: outbound deliveries only, and only if BOTH the POD
        // and the delivered date are still empty. Existing data is never touched.
        const trackedOutbound = isOutboundColumn(item.tracking_column);

        if (podLink && trackedOutbound && current.insurance_id) {
            const insRow = (await client.query(
                `SELECT delivered_date, proof_of_delivery
                 FROM insurance_fresh WHERE insurance_id = $1 FOR UPDATE`,
                [current.insurance_id]
            )).rows[0];

            // Same write-once rule, evaluated against insurance_fresh's own
            // column names (delivered_date rather than delivery_date).
            const alreadyHasPod = hasPodAlready(
                insRow && { delivery_date: insRow.delivered_date, proof_of_delivery: insRow.proof_of_delivery }
            );

            if (insRow && !alreadyHasPod) {
                await client.query(
                    `UPDATE insurance_fresh
                     SET proof_of_delivery = $1, delivered_date = $2, username = $3
                     WHERE insurance_id = $4`,
                    [podLink, deliveredAt, UPDATED_BY, current.insurance_id]
                );
                await client.query(
                    `INSERT INTO insurance (insurance_id, proof_of_delivery, username, created_at)
                     VALUES ($1, $2, $3, NOW())`,
                    [current.insurance_id, podLink, UPDATED_BY]
                );
                log(`    insurance_fresh ${current.insurance_id} stamped with POD + delivered_date`);
            } else if (!insRow) {
                log(`    insurance_fresh ${current.insurance_id} not found — nothing stamped`);
            } else {
                log(`    insurance_fresh ${current.insurance_id} already has POD/delivered date — left untouched`);
            }
        } else if (podLink && !trackedOutbound) {
            log(`    tracked number was a return (${item.tracking_column || "unknown"}) — insurance_fresh left untouched`);
        }

        const merged = { ...current, [leg.statusColumn]: newStatus };
        if (podLink && !trackingAlreadyStamped) {
            merged[leg.podColumn] = podLink;
            merged[leg.deliveredDateColumn] = deliveredAt;
        }
        const insertCols = ["tracking_id", "contact_id", "insurance_id", ...SNAPSHOT_COLUMNS, "username", "created_at"];
        const insertValues = [
            current.tracking_id,
            current.contact_id,
            current.insurance_id,
            ...SNAPSHOT_COLUMNS.map((c) => merged[c] ?? null),
            UPDATED_BY,
            new Date(),
        ];
        const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(",");

        await client.query(
            `INSERT INTO tracking (${insertCols.join(", ")}) VALUES (${placeholders})`,
            insertValues
        );

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// ----------------------------------------------------------------- email

function loadMailCredentials() {
    // emailTo.js resolves this from utils/; this script runs from NodeServer/.
    const candidates = ["./mail_credentials.json", "../mail_credentials.json"];
    for (const p of candidates) {
        try { return JSON.parse(fs.readFileSync(p)); } catch { /* try next */ }
    }
    throw new Error(`mail_credentials.json not found (tried ${candidates.join(", ")})`);
}

/**
 * Email the failure report as a CSV attachment. Uses its own transporter
 * because utils/emailTo.js does not support attachments.
 *
 * Only shipments that are still being retried, or that have JUST been
 * quarantined, reach this function — one quarantined days ago is logged but not
 * re-sent, so a single unfixable shipment cannot mail the same alert twice a
 * day forever.
 */
async function emailFailureReport(items, reportPath, quarantinedTotal) {
    const mailCredentials = loadMailCredentials();
    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: mailCredentials.email, pass: mailCredentials.password },
    });

    const shown = items.slice(0, 25);
    const rowsHtml = shown.map((it) =>
        `<tr><td>${it.tracking_id}</td><td>${it.leg}</td><td>${it.shipment_id}</td>` +
        `<td>${it.attempts}</td><td>${it.failed_runs}</td>` +
        `<td>${it.disposition}</td><td>${it.last_error}</td></tr>`
    ).join("");

    const body = `<body>
      Shippiz tracking sync finished with ${items.length} shipment(s) needing attention.
      <br /><br />
      Every other shipment was still checked — a failure here no longer blocks the queue.
      <br /><br />
      The full report is attached as CSV. First ${shown.length} shown below:
      <br /><br />
      <table border="1" cellpadding="4" cellspacing="0">
        <tr><th>tracking_id</th><th>leg</th><th>shipment_id</th><th>attempts</th>
            <th>failed_runs</th><th>disposition</th><th>last_error</th></tr>
        ${rowsHtml}
      </table>
      <br />
      Quarantined shipments in total (no longer queued): ${quarantinedTotal}
      <br />
      Re-queue them with: node scripts/updateShippizTrackingStatus.js --include-quarantined
      <br /><br />
      Host: ${os.hostname()}
      <br />
      </body>`;

    const mailOptions = {
        from: ALERT_FROM,
        to: ALERT_EMAIL,
        subject: `Shippiz tracking sync: ${items.length} shipment(s) needing attention`,
        html: body,
        attachments: [{ filename: path.basename(reportPath), path: reportPath }],
    };

    await new Promise((resolve) => {
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) log(`Failed to send alert email: ${error}`);
            else log(`Alert email sent to ${ALERT_EMAIL}: ${info.response}`);
            resolve();
        });
    });
    transporter.close();
}

// -------------------------------------------------------------------- main

/**
 * Process every item in the queue once.
 *
 * Resolved items are dropped. Transiently-failed items stay in `remaining` and
 * are retried next pass. Permanently-failed items are moved to `permanent` and
 * are NOT retried in this run — they carry over to the next run instead. The
 * CSV is rewritten after every item so a crash mid-pass loses nothing.
 */
async function runPass(queue, passNumber, counts, permanent) {
    // One API call per distinct shipment id per pass.
    const cache = new Map();
    const remaining = [];

    for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        item.attempts = (item.attempts || 0) + 1;

        let result;
        if (cache.has(item.shipment_id)) {
            result = cache.get(item.shipment_id);
        } else {
            counts.apiCalls++;
            result = await fetchTrackingStatus(item.shipment_id);
            cache.set(item.shipment_id, result);
            await sleep(DELAY_BETWEEN_CALLS_MS);
        }

        if (result.error) {
            item.last_error = result.error;
            if (result.transient) {
                log(`  ${describeItem(item)}: ${result.error}`);
                remaining.push(item);
            } else {
                // Deterministic for this shipment — two more identical calls in
                // the next 90 seconds cannot help. Carry it to the next run.
                counts.permanent++;
                log(`  ${describeItem(item)}: ${result.error} (permanent — not retried this run)`);
                permanent.push(item);
            }
            writeQueue([...remaining, ...queue.slice(i + 1)]);
            continue;
        }

        // Label created but never scanned -> resolved as a no-op, nothing written.
        if (result.noTrackingData) {
            counts.noData++;
            writeQueue([...remaining, ...queue.slice(i + 1)]);
            continue;
        }

        // Status unchanged -> resolved, and nothing is written to either table.
        if (item.current_status && String(item.current_status) === String(result.status)) {
            counts.unchanged++;
            writeQueue([...remaining, ...queue.slice(i + 1)]);
            continue;
        }

        const transition = `${item.current_status || "(null)"} -> ${result.status}` +
            (result.statusDescription ? ` [${result.statusDescription}]` : "");
        log(`  STATUS ${describeItem(item)}: ${transition}`);
        counts.changes.push({ label: describeItem(item), transition });

        if (DRY_RUN) {
            if (isTerminal(result.status)) {
                if (item.has_pod) {
                    log(`    DRY RUN — already has a POD, would skip the POD fetch`);
                } else {
                    log(`    DRY RUN — would fetch POD for ${item.tracking_number || "(no tracking number)"}` +
                        ` via ${item.tracking_column || "(no column)"}`);
                }
            }
            counts.changed++;
            writeQueue([...remaining, ...queue.slice(i + 1)]);
            continue;
        }

        // Newly delivered -> fetch the proof of delivery before writing, so the
        // status and the POD land in the same transaction. A POD failure keeps
        // the shipment queued rather than marking it delivered without a POD.
        let podLink = null;
        if (isTerminal(result.status)) {
            // Already stamped -> the POD is write-once, so skip the whole UPS +
            // Drive round trip rather than fetching a file we would discard.
            // This is what stops a return delivery clobbering the initial
            // shipment's POD, and it avoids the junk Drive upload too.
            if (item.has_pod) {
                log(`  ${describeItem(item)} delivered, but already has a POD — status only, POD skipped`);
                counts.podSkipped++;
            } else if (!item.tracking_number) {
                item.last_error = "delivered but no tracking number on the row";
                log(`  ${describeItem(item)}: ${item.last_error}`);
                // Nothing about this will change on a retry — it needs a human.
                permanent.push(item);
                writeQueue([...remaining, ...queue.slice(i + 1)]);
                continue;
            } else {
                try {
                    log(`  ${describeItem(item)} delivered — fetching POD for ${item.tracking_number} (${item.tracking_column})`);
                    podLink = await generatePodLink(item.tracking_number, item.contact_id);
                    counts.pods++;
                } catch (err) {
                    item.last_error = `pod: ${err.message}`;
                    log(`  POD failed for ${describeItem(item)}: ${err.message}`);
                    remaining.push(item);
                    writeQueue([...remaining, ...queue.slice(i + 1)]);
                    continue;
                }
            }
        }

        try {
            await writeLegStatus(item, result.status, podLink);
            counts.changed++;
            writeQueue([...remaining, ...queue.slice(i + 1)]);
        } catch (err) {
            item.last_error = `db write: ${err.message}`;
            log(`  write failed for ${describeItem(item)}: ${err}`);
            remaining.push(item);
            writeQueue([...remaining, ...queue.slice(i + 1)]);
        }
    }

    writeQueue(remaining);
    return remaining;
}

/**
 * Fold this run's outcome into the persisted state: bump failed_runs for
 * shipments that are still unresolved, quarantine anything past the threshold,
 * and drop entries that resolved so their history starts clean next time.
 */
function updateState(previousState, attemptedKeys, unresolved) {
    const now = new Date().toISOString();
    const nextState = {};
    const newlyQuarantined = [];

    // Keep quarantine records for entries this run did not touch (e.g. --limit).
    for (const [key, entry] of Object.entries(previousState)) {
        if (entry?.quarantined && !attemptedKeys.has(key)) nextState[key] = entry;
    }

    for (const item of unresolved) {
        const key = legKey(item);
        const prev = previousState[key] || {};
        const failedRuns = (prev.failed_runs || 0) + 1;
        const quarantined = failedRuns >= MAX_FAILED_RUNS;

        nextState[key] = {
            tracking_id: item.tracking_id,
            leg: item.leg,
            shipment_id: item.shipment_id,
            attempts: item.attempts || 0,
            failed_runs: failedRuns,
            last_error: item.last_error || "",
            first_failed_at: prev.first_failed_at || now,
            last_failed_at: now,
            quarantined,
        };

        item.failed_runs = failedRuns;
        item.disposition = quarantined ? "quarantined" : "retrying";

        if (quarantined && !prev.quarantined) newlyQuarantined.push(item);
    }

    return { nextState, newlyQuarantined };
}

async function main() {
    if (!process.env.SHIPPIZ_API_KEY) {
        log("FATAL: SHIPPIZ_API_KEY is not set");
        process.exitCode = 1;
        return;
    }

    log(`Shippiz tracking sync starting${DRY_RUN ? " (DRY RUN — no writes, no email, no state changes)" : ""}`);

    if (RESET_STATE) {
        clearState();
        log("Failure state cleared (--reset-state)");
    }

    const state = RESET_STATE ? {} : readState();

    // The queue is ALWAYS rebuilt from the database. This is the fix for the
    // failure mode where one unresolvable shipment left a CSV on disk and every
    // subsequent run processed only that shipment, silently freezing every
    // other one at its last known status.
    let queue = await buildQueueFromDB();

    // Carry failure history forward, and hold back quarantined entries.
    const quarantinedHeld = [];
    queue = queue.filter((item) => {
        const entry = state[legKey(item)];
        if (!entry) return true;
        item.attempts = entry.attempts || 0;
        item.last_error = entry.last_error || "";
        if (entry.quarantined && !INCLUDE_QUARANTINED) {
            quarantinedHeld.push(item);
            return false;
        }
        return true;
    });

    if (quarantinedHeld.length > 0) {
        log(`${quarantinedHeld.length} quarantined shipment(s) held back — re-run with --include-quarantined to retry:`);
        for (const it of quarantinedHeld.slice(0, 10)) {
            log(`    ${describeItem(it)}: ${it.last_error}`);
        }
    }

    // A leftover CSV means the last run was interrupted. Use it only to keep
    // attempt counts honest — never as a replacement for the rebuild above.
    const leftover = FRESH ? null : readQueue();
    if (leftover && leftover.length > 0) {
        const prior = new Map(leftover.map((i) => [legKey(i), i]));
        let merged = 0;
        for (const item of queue) {
            const p = prior.get(legKey(item));
            if (!p) continue;
            item.attempts = Math.max(item.attempts || 0, p.attempts || 0);
            item.last_error = p.last_error || item.last_error;
            merged++;
        }
        log(`Leftover queue from an interrupted run: ${leftover.length} entr(ies), ${merged} merged into the rebuilt queue`);
    }

    if (queue.length === 0) {
        log("Nothing to check.");
        clearQueue();
        return;
    }

    writeQueue(queue);

    // Snapshot the keys this run is responsible for, before the passes mutate
    // the queue array — updateState needs them to expire stale records.
    const attemptedKeys = new Set(queue.map(legKey));

    const counts = { apiCalls: 0, changed: 0, unchanged: 0, noData: 0, pods: 0, podSkipped: 0, permanent: 0, changes: [] };
    const permanent = [];

    for (let pass = 1; pass <= MAX_PASSES && queue.length > 0; pass++) {
        log(`--- pass ${pass}/${MAX_PASSES}: ${queue.length} shipment(s) ---`);
        queue = await runPass(queue, pass, counts, permanent);
        if (queue.length > 0 && pass < MAX_PASSES) {
            log(`${queue.length} shipment(s) unresolved, retrying in ${DELAY_BETWEEN_PASSES_MS}ms`);
            await sleep(DELAY_BETWEEN_PASSES_MS);
        }
    }

    const unresolved = [...queue, ...permanent];

    // Name every patient that actually moved. The counters answer "did anything
    // happen"; this answers "to whom", which is what you need when a status
    // looks wrong the next morning.
    if (counts.changes.length > 0) {
        log(`${counts.changes.length} status change(s) this run:`);
        for (const c of counts.changes) log(`    ${c.label}: ${c.transition}`);
    } else {
        log("No status changes this run.");
    }

    log(
        `Done. api_calls=${counts.apiCalls} changed=${counts.changed} ` +
        `pods=${counts.pods} pods_skipped=${counts.podSkipped} ` +
        `unchanged=${counts.unchanged} no_tracking_data=${counts.noData} ` +
        `permanent_errors=${counts.permanent} unresolved=${unresolved.length}`
    );

    // The work queue is scratch state and is always cleared, so nothing can
    // block the next run's rebuild.
    clearQueue();

    if (unresolved.length === 0) {
        writeState(updateState(state, attemptedKeys, []).nextState);
        log("All shipments resolved — queue cleared.");
        return;
    }

    const { nextState, newlyQuarantined } = updateState(state, attemptedKeys, unresolved);
    writeState(nextState);

    const quarantinedTotal = Object.values(nextState).filter((e) => e.quarantined).length;

    // Alert on shipments still being retried plus anything that just crossed
    // the quarantine line. Entries quarantined on an earlier run are
    // deliberately excluded so the same dead shipment does not mail twice a day
    // forever.
    const reportable = unresolved.filter(
        (it) => it.disposition === "retrying" || newlyQuarantined.includes(it)
    );

    log(`${unresolved.length} shipment(s) unresolved (${newlyQuarantined.length} newly quarantined, ${quarantinedTotal} quarantined in total).`);

    if (reportable.length === 0) {
        log("Nothing new to report — no email sent.");
        return;
    }

    if (DRY_RUN) {
        log(`DRY RUN — would have emailed a report of ${reportable.length} shipment(s) to ${ALERT_EMAIL}`);
        return;
    }

    const reportPath = writeFailureReport(reportable);
    await emailFailureReport(reportable, reportPath, quarantinedTotal);
}

main()
    .catch((err) => {
        log(`FATAL: ${err && err.stack ? err.stack : err}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end().catch(() => {});
    });