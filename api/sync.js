// Pulls the TripIt calendar feed into the log. Runs daily (Vercel cron) or when an owner/editor taps "Save and sync".
const { listDocs, getDoc, upsertDoc, newId, headers, URL_, KEY } = require('./_lib/db');

const TZ = {
  BOS: 'America/New_York', EWR: 'America/New_York', JFK: 'America/New_York', LGA: 'America/New_York', MIA: 'America/New_York', DJT: 'America/New_York', PBI: 'America/New_York', MCO: 'America/New_York', ATL: 'America/New_York', DCA: 'America/New_York', IAD: 'America/New_York', PHL: 'America/New_York', YYZ: 'America/Toronto', YTZ: 'America/Toronto',
  ORD: 'America/Chicago', XNA: 'America/Chicago', DFW: 'America/Chicago', IAH: 'America/Chicago', DEN: 'America/Denver', PHX: 'America/Phoenix', LAX: 'America/Los_Angeles', SFO: 'America/Los_Angeles', SEA: 'America/Los_Angeles',
  LHR: 'Europe/London', LGW: 'Europe/London', CDG: 'Europe/Paris', FRA: 'Europe/Berlin', AMS: 'Europe/Amsterdam', ZRH: 'Europe/Zurich', DXB: 'Asia/Dubai', DOH: 'Asia/Qatar', DEL: 'Asia/Kolkata', BOM: 'Asia/Kolkata',
  BKK: 'Asia/Bangkok', CNX: 'Asia/Bangkok', HND: 'Asia/Tokyo', NRT: 'Asia/Tokyo', SIN: 'Asia/Singapore', HKG: 'Asia/Hong_Kong', SYD: 'Australia/Sydney',
};

const unfold = (t) => t.replace(/\r?\n[ \t]/g, '');
const txt = (s) => String(s || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\').trim();

function local(v, tz) {
  const m = /(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?)?(Z)?/.exec(v || '');
  if (!m) return null;
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: '', allDay: true };
  if (!m[7] || !tz) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: tz || !m[7] ? `${m[4]}:${m[5]}` : '', allDay: false };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}`, allDay: false };
}

function classify(s) {
  const t = s.toLowerCase();
  if (/^[a-z0-9]{2}\s?\d{1,4}\b.*\bto\b/.test(t) || /flight|✈/.test(t)) return 'flight';
  if (/hotel|check[- ]?in|check[- ]?out|inn\b|resort|marriott|hilton|hyatt|villa|airbnb|lodging|stay/.test(t)) return 'hotel';
  if (/dinner|lunch|breakfast|brunch|restaurant|reservation|cafe|grill/.test(t)) return 'restaurant';
  if (/rental|train|rail|amtrak|ferry|transfer|uber|taxi|bus\b/.test(t)) return 'transport';
  return 'activity';
}

function parse(text) {
  const out = [];
  unfold(text).split('BEGIN:VEVENT').slice(1).forEach((block) => {
    block = block.split('END:VEVENT')[0];
    const f = {};
    block.split(/\r?\n/).forEach((line) => {
      const i = line.indexOf(':');
      if (i < 1) return;
      const k = line.slice(0, i).split(';')[0].toUpperCase();
      if (!(k in f)) f[k] = line.slice(i + 1);
    });
    const title = txt(f.SUMMARY) || 'Untitled';
    const type = classify(title);
    let from, to;
    const m = /\b([A-Z]{3})\b\s+to\s+\b([A-Z]{3})\b/.exec(title);
    if (type === 'flight' && m) { from = TZ[m[1]]; to = TZ[m[2]]; }
    const s = local(f.DTSTART, from), e = local(f.DTEND, to);
    if (!s) return;
    if (/^Trip - |, [A-Z][a-z]+ 20\d\d$/.test(title) && s.allDay) return; // trip umbrella entries
    let endDate = e ? e.date : '';
    if (s.allDay && e) { const d = new Date(endDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); endDate = d.toISOString().slice(0, 10); }
    if (s.allDay && type === 'activity' && endDate > s.date) return; // multi-day umbrella entry
    const hotelNoTz = type !== 'flight' && !s.allDay;
    out.push({
      uid: f.UID || '', type, title, date: s.date, time: hotelNoTz ? '' : s.time,
      endDate: endDate && endDate !== s.date ? endDate : '', endTime: hotelNoTz || s.allDay || !e ? '' : e.time,
      location: txt(f.LOCATION), confirmation: '', travelers: '', notes: 'From TripIt', source: 'tripit-import',
    });
  });
  return out;
}

const dayNum = (s) => { const p = s.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000); };
// Match flights by flight number digits only, so "DL638", "Delta 638" and "UA 638" titles all line up on the same date.
const fkey = (t) => { const m = /(?:^|[^0-9])(\d{2,4})(?!\d)/.exec(String(t)); return m ? m[1] : ''; };

async function authorized(req) {
  const h = req.headers.authorization || '';
  const tok = h.replace(/^Bearer\s+/i, '');
  if (!tok) return false;
  if (process.env.CRON_SECRET && tok === process.env.CRON_SECRET) return true;
  const u = await fetch(`${URL_()}/auth/v1/user`, { headers: { apikey: KEY(), Authorization: 'Bearer ' + tok } });
  if (!u.ok) return false;
  const email = ((await u.json()).email || '').toLowerCase();
  const r = await fetch(`${URL_()}/rest/v1/family_members?email=eq.${encodeURIComponent(email)}&select=role`, { headers: headers() });
  const role = r.ok ? ((await r.json())[0] || {}).role : null;
  return role === 'owner' || role === 'editor';
}

module.exports = async (req, res) => {
  try {
    if (!(await authorized(req))) { res.status(401).json({ error: 'unauthorized' }); return; }
    const settings = (await getDoc('settings', 'tripit')) || {};
    if (!settings.feedUrl) { res.status(200).json({ added: 0, note: 'no feed saved' }); return; }
    const r = await fetch(settings.feedUrl);
    if (!r.ok) { res.status(502).json({ error: 'feed fetch failed' }); return; }
    const evs = parse(await r.text());
    const today = new Date().toISOString().slice(0, 10);
    const [items, trips] = await Promise.all([listDocs('items'), listDocs('trips')]);
    const logged = (e) => items.some((i) =>
      (e.uid && i.uid === e.uid) || (i.title === e.title && i.date === e.date) ||
      (e.type === 'flight' && i.type === 'flight' && i.date === e.date && fkey(e.title) && fkey(e.title) === fkey(i.title)) ||
      (e.type === 'hotel' && i.type === 'hotel' && i.date === e.date));
    const fresh = evs.filter((e) => !/^check-?out\b/i.test(e.title) && (e.endDate || e.date) >= today && !logged(e)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const groups = []; const byTrip = {};
    fresh.forEach((e) => {
      const t = trips.find((x) => x.start && x.end && dayNum(e.date) >= dayNum(x.start) - 1 && dayNum(e.date) <= dayNum(x.end) + 1);
      if (t) { (byTrip[t.id] = byTrip[t.id] || []).push(e); return; }
      const g = groups[groups.length - 1];
      if (g && dayNum(e.date) - dayNum(g.last) <= 5) { g.evs.push(e); g.last = e.endDate || e.date; }
      else groups.push({ evs: [e], last: e.endDate || e.date });
    });
    for (const id of Object.keys(byTrip)) for (const e of byTrip[id]) await upsertDoc('items', newId('ti-'), Object.assign({}, e, { tripId: id }));
    for (const g of groups) {
      const tid = newId('trip-');
      await upsertDoc('trips', tid, { name: 'Trip from ' + g.evs[0].date, destination: '', travelers: '', start: g.evs[0].date, end: g.last });
      for (const e of g.evs) await upsertDoc('items', newId('ti-'), Object.assign({}, e, { tripId: tid }));
    }
    await upsertDoc('settings', 'tripit', Object.assign({}, settings, { lastSync: new Date().toISOString(), lastResult: fresh.length ? fresh.length + ' added' : 'nothing new' }));
    res.status(200).json({ added: fresh.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
module.exports.parse = parse;
