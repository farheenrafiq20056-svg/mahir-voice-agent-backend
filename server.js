require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');

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
function toISO(date, time) {
  // date: "2026-08-15", time: "14:00" (24hr) -> returns a Date object anchored to TIMEZONE
  return new Date(`${date}T${time}:00`);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function withinBusinessHours(startDate) {
  const hour = startDate.getHours();
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
    const start = toISO(date, time);
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
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
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
      requestedStart: start.toISOString(),
      requestedEnd: end.toISOString(),
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
      const start = toISO(date, timeStr);
      const end = addMinutes(start, durationMin);
      const freeBusy = await calendar.freebusy.query({
        requestBody: {
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
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

    const start = toISO(date, time);
    const durationMin = duration_minutes || DEFAULT_DURATION_MIN;
    const end = addMinutes(start, durationMin);

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${service} - ${customer_name}`,
        description: `Issue: ${issue_description}\nAddress: ${address}\nPhone: ${phone}`,
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
        // Store structured data for later lookup (reschedule/cancel by phone)
        extendedProperties: {
          private: { phone, service, customer_name },
        },
      },
    });

    return respond(res, toolCallId, {
      success: true,
      eventId: event.data.id,
      bookingReference: event.data.id.slice(0, 8).toUpperCase(),
      start: start.toISOString(),
    });
  } catch (err) {
    console.error(err);
    return respond(res, toolCallId, { success: false, error: 'internal_error' });
  }
});

// ---- Shared: find upcoming appointment(s) by phone number ----
async function findAppointmentsByPhone(phone) {
  const now = new Date();
  const sixMonthsOut = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 180);
  const result = await calendar.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: [`phone=${phone}`],
    timeMin: now.toISOString(),
    timeMax: sixMonthsOut.toISOString(),
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

    const start = toISO(new_date, new_time);
    const durationMin = duration_minutes || DEFAULT_DURATION_MIN;
    const end = addMinutes(start, durationMin);

    if (!withinBusinessHours(start)) {
      return respond(res, toolCallId, { success: false, reason: 'outside_business_hours' });
    }

    // check the new slot is free first
    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
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
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      },
    });

    return respond(res, toolCallId, { success: true, eventId: updated.data.id, newStart: start.toISOString() });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
