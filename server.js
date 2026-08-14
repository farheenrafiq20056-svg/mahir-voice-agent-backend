require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const { DateTime } = require('luxon');

const app = express();
app.use(express.json());

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID; // e.g. abcdef123@group.calendar.google.com
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';
const BUSINESS_START_HOUR = parseInt(process.env.BUSINESS_START_HOUR || '8', 10); // 8 AM
const BUSINESS_END_HOUR = parseInt(process.env.BUSINESS_END_HOUR || '19', 10);   // 7 PM
const DEFAULT_DURATION_MIN = parseInt(process.env.DEFAULT_DURATION_MIN || '60', 10);

// ---- Google Auth (Service Account) ----
// 1. Create a service account in Google Cloud Console, enable Calendar API.
// 2. Download the JSON key, put its contents in GOOGLE_SERVICE_ACCOUNT_KEY env var (as a single-line JSON string).
// 3. Share your Google Calendar with the service account's email, "Make changes to events" permission.
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// ---- Helpers ----
// Parses the "date" argument, trying several common formats since the AI
// model doesn't always send strict ISO "yyyy-MM-dd".
function parseDatePart(dateStr) {
  const cleaned = String(dateStr).trim();
  const formatsToTry = [
    'yyyy-MM-dd',       // "2026-08-17"
    'yyyy/MM/dd',       // "2026/08/17"
    'MM/dd/yyyy',       // "08/17/2026"
    'M/d/yyyy',         // "8/17/2026"
    'MMMM d, yyyy',      // "August 17, 2026"
    'MMMM d yyyy',       // "August 17 2026"
    'MMM d, yyyy',       // "Aug 17, 2026"
    'MMM d yyyy',        // "Aug 17 2026"
    'MMMM d',             // "August 17" (no year — see fallback below)
    'MMM d',              // "Aug 17"
  ];

  for (const fmt of formatsToTry) {
    let dt = DateTime.fromFormat(cleaned, fmt, { zone: TIMEZONE });
    if (dt.isValid) {
      // If the format had no year (e.g. "August 17"), luxon defaults to year 0 —
      // fix that by assuming the current year, rolling to next year if that date already passed.
      if (!fmt.includes('yyyy')) {
        const now = DateTime.now().setZone(TIMEZONE);
        dt = dt.set({ year: now.year });
        if (dt < now.startOf('day')) dt = dt.plus({ years: 1 });
      }
      return { year: dt.year, month: dt.month, day: dt.day };
    }
  }
  return null;
}

// Parses the "time" argument, trying several common formats.
function parseTimePart(timeStr) {
  const cleaned = String(timeStr).trim();
  const formatsToTry = [
    'HH:mm',      // "15:00"
    'H:mm',       // "5:00"
    'h:mm a',     // "3:00 PM"
    'h:mma',      // "3:00PM"
    'ha',         // "3PM"
    'h a',        // "3 PM"
    'HH:mm:ss',   // "15:00:00"
  ];

  for (const fmt of formatsToTry) {
    const dt = DateTime.fromFormat(cleaned, fmt, { zone: TIMEZONE });
    if (dt.isValid) return { hour: dt.hour, minute: dt.minute };
  }
  return null;
}

// Correctly interprets "date" + "time" as wall-clock time IN the business's timezone
// (e.g. "2026-08-14" + "17:00" means 5 PM Eastern, NOT 5 PM UTC), and handles DST automatically.
// Parses date and time independently for robustness, then combines them.
function toZonedDateTime(date, time) {
  const dateParts = parseDatePart(date);
  const timeParts = parseTimePart(time);

  if (!dateParts || !timeParts) {
    return DateTime.invalid('unparseable_date_or_time');
  }

  return DateTime.fromObject(
    { year: dateParts.year, month: dateParts.month, day: dateParts.day, hour: timeParts.hour, minute: timeParts.minute },
    { zone: TIMEZONE }
  );
}

function addMinutes(dt, minutes) {
  return dt.plus({ minutes });
}

function withinBusinessHours(dt) {
  if (!dt.isValid) return false;
  const hour = dt.hour; // hour in the DateTime's own zone (already set to TIMEZONE)
  return hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

// Vapi sends tool calls wrapped in a specific format. This helper extracts
// arguments regardless of whether it's a raw JSON body or Vapi's tool-call envelope.
function extractArgs(req) {
  if (req.body?.message?.toolCalls?.length) {
    // Vapi's function-call webhook format
    const call = req.body.message.toolCalls[0];
    return {
      args: call.function?.arguments || {},
      toolCallId: call.id,
    };
  }
  return { args: req.body, toolCallId: null };
}

function respond(res, toolCallId, resultObj) {
  const resultText = typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj);
  if (toolCallId) {
    // Vapi expects this envelope for tool call responses
    return res.json({
      results: [{ toolCallId, result: resultText }],
    });
  }
  return res.json(resultObj);
}

// ---- 1. CHECK AVAILABILITY ----
app.post('/check-availability', async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  try {
    const { date, time, duration_minutes } = args; // date: "2026-08-15", time: "14:00"
    console.log('check-availability received args:', JSON.stringify(args));
    const start = toZonedDateTime(date, time);

    if (!start.isValid) {
      console.error('check-availability: could not parse date/time:', JSON.stringify({ date, time }));
      return respond(res, toolCallId, {
        available: false,
        reason: 'invalid_time_format',
        message: `I couldn't understand that date/time (got date="${date}", time="${time}"). Please ask the customer to restate it clearly, e.g. "August 18th at 3 PM."`,
      });
    }

    const durationMin = duration_minutes || DEFAULT_DURATION_MIN;
    const end = addMinutes(start, durationMin);

    if (!withinBusinessHours(start)) {
      return respond(res, toolCallId, {
        available: false,
        reason: 'outside_business_hours',
        message: `That time is outside our business hours (${BUSINESS_START_HOUR}:00–${BUSINESS_END_HOUR}:00).`,
      });
    }

    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toUTC().toISO(),
        timeMax: end.toUTC().toISO(),
        timeZone: TIMEZONE,
        items: [{ id: CALENDAR_ID }],
      },
    });

    const busySlots = freeBusy.data.calendars[CALENDAR_ID].busy;
    const isAvailable = busySlots.length === 0;

    let alternatives = [];
    if (!isAvailable) {
      alternatives = await findAlternativeSlots(date, durationMin, 3);
    }

    return respond(res, toolCallId, {
      available: isAvailable,
      requestedStart: start.toUTC().toISO(),
      requestedEnd: end.toUTC().toISO(),
      alternatives, // array of { time: "15:00" } style suggestions
    });
  } catch (err) {
    console.error(err);
    return respond(res, toolCallId, { available: false, error: 'internal_error' });
  }
});

// Simple alternative-slot finder: scans the same day in 30-min increments
async function findAlternativeSlots(date, durationMin, maxResults) {
  const slots = [];
  for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
    for (const minute of [0, 30]) {
      const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const start = toZonedDateTime(date, timeStr);
      const end = addMinutes(start, durationMin);
      const freeBusy = await calendar.freebusy.query({
        requestBody: {
          timeMin: start.toUTC().toISO(),
          timeMax: end.toUTC().toISO(),
          timeZone: TIMEZONE,
          items: [{ id: CALENDAR_ID }],
        },
      });
      const busy = freeBusy.data.calendars[CALENDAR_ID].busy;
      if (busy.length === 0) {
        slots.push(timeStr);
        if (slots.length >= maxResults) return slots;
      }
    }
  }
  return slots;
}

// ---- 2. BOOK APPOINTMENT ----
app.post('/book-appointment', async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  try {
    const {
      customer_name, phone, service, issue_description,
      address, date, time, duration_minutes,
    } = args;

    // Log the raw incoming args so we can diagnose any missing-field issues from Vapi's tool call.
    console.log('book-appointment received args:', JSON.stringify(args));

    const start = toZonedDateTime(date, time);
    if (!start.isValid) {
      console.error('book-appointment: could not parse date/time:', JSON.stringify({ date, time }));
      return respond(res, toolCallId, {
        success: false,
        reason: 'invalid_time_format',
        message: `Could not understand the date/time (date="${date}", time="${time}"). Ask the customer to restate it clearly.`,
      });
    }
    const durationMin = duration_minutes || DEFAULT_DURATION_MIN;
    const end = addMinutes(start, durationMin);

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${service} - ${customer_name}`,
        description: `Issue: ${issue_description}\nAddress: ${address}\nPhone: ${phone || 'NOT PROVIDED'}`,
        start: { dateTime: start.toUTC().toISO(), timeZone: TIMEZONE },
        end: { dateTime: end.toUTC().toISO(), timeZone: TIMEZONE },
        // Store structured data for later lookup (reschedule/cancel by phone)
        extendedProperties: {
          private: { phone: phone || '', service, customer_name },
        },
      },
    });

    return respond(res, toolCallId, {
      success: true,
      eventId: event.data.id,
      bookingReference: event.data.id.slice(0, 8).toUpperCase(),
      start: start.toUTC().toISO(),
    });
  } catch (err) {
    console.error(err);
    return respond(res, toolCallId, { success: false, error: 'internal_error' });
  }
});

// ---- Shared: find upcoming appointment(s) by phone number ----
async function findAppointmentsByPhone(phone) {
  const now = DateTime.now();
  const sixMonthsOut = now.plus({ days: 180 });
  const result = await calendar.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: [`phone=${phone}`],
    timeMin: now.toUTC().toISO(),
    timeMax: sixMonthsOut.toUTC().toISO(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return result.data.items || [];
}

// ---- 3. FIND APPOINTMENT (used by reschedule/cancel to confirm identity) ----
app.post('/find-appointment', async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  try {
    const { phone } = args;
    const events = await findAppointmentsByPhone(phone);
    return respond(res, toolCallId, {
      found: events.length > 0,
      appointments: events.map(e => ({
        eventId: e.id,
        summary: e.summary,
        start: e.start.dateTime,
      })),
    });
  } catch (err) {
    console.error(err);
    return respond(res, toolCallId, { found: false, error: 'internal_error' });
  }
});

// ---- 4. RESCHEDULE APPOINTMENT ----
app.post('/reschedule-appointment', async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  try {
    const { phone, event_id, new_date, new_time, duration_minutes } = args;

    let eventId = event_id;
    if (!eventId) {
      const events = await findAppointmentsByPhone(phone);
      if (events.length === 0) {
        return respond(res, toolCallId, { success: false, reason: 'not_found' });
      }
      eventId = events[0].id; // most recent upcoming appointment
    }

    const start = toZonedDateTime(new_date, new_time);
    if (!start.isValid) {
      console.error('reschedule-appointment: could not parse date/time:', JSON.stringify({ new_date, new_time }));
      return respond(res, toolCallId, {
        success: false,
        reason: 'invalid_time_format',
        message: `Could not understand the new date/time (date="${new_date}", time="${new_time}"). Ask the customer to restate it clearly.`,
      });
    }
    const durationMin = duration_minutes || DEFAULT_DURATION_MIN;
    const end = addMinutes(start, durationMin);

    if (!withinBusinessHours(start)) {
      return respond(res, toolCallId, { success: false, reason: 'outside_business_hours' });
    }

    // check the new slot is free first
    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toUTC().toISO(),
        timeMax: end.toUTC().toISO(),
        timeZone: TIMEZONE,
        items: [{ id: CALENDAR_ID }],
      },
    });
    if (freeBusy.data.calendars[CALENDAR_ID].busy.length > 0) {
      const alternatives = await findAlternativeSlots(new_date, durationMin, 3);
      return respond(res, toolCallId, { success: false, reason: 'slot_taken', alternatives });
    }

    const updated = await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      requestBody: {
        start: { dateTime: start.toUTC().toISO(), timeZone: TIMEZONE },
        end: { dateTime: end.toUTC().toISO(), timeZone: TIMEZONE },
      },
    });

    return respond(res, toolCallId, { success: true, eventId: updated.data.id, newStart: start.toUTC().toISO() });
  } catch (err) {
    console.error(err);
    return respond(res, toolCallId, { success: false, error: 'internal_error' });
  }
});

// ---- 5. CANCEL APPOINTMENT ----
app.post('/cancel-appointment', async (req, res) => {
  const { args, toolCallId } = extractArgs(req);
  try {
    const { phone, event_id } = args;

    let eventId = event_id;
    if (!eventId) {
      const events = await findAppointmentsByPhone(phone);
      if (events.length === 0) {
        return respond(res, toolCallId, { success: false, reason: 'not_found' });
      }
      eventId = events[0].id;
    }

    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
    return respond(res, toolCallId, { success: true });
  } catch (err) {
    console.error(err);
    return respond(res, toolCallId, { success: false, error: 'internal_error' });
  }
});

app.get('/', (req, res) => res.send('Mahir Company voice agent backend is running.'));

// Only run a local listener when NOT on Vercel (Vercel runs this as a serverless function instead)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;