// Remote MCP endpoint so Claude chats can read trips and add suggestions or bookings.
// Connect it in Claude as a custom connector: https://<your-app>/api/mcp?key=<MCP_KEY>
const { listDocs, upsertDoc, getDoc, newId } = require('./_lib/db');

const TYPES = ['flight', 'hotel', 'restaurant', 'transport', 'activity', 'suggestion'];
const itemProps = {
  tripId: { type: 'string', description: 'Trip id from list_trips' },
  title: { type: 'string' },
  date: { type: 'string', description: 'YYYY-MM-DD' },
  time: { type: 'string', description: 'HH:MM 24h, optional' },
  endDate: { type: 'string' },
  endTime: { type: 'string' },
  location: { type: 'string' },
  confirmation: { type: 'string' },
  travelers: { type: 'string' },
  notes: { type: 'string' },
};

const TOOLS = [
  { name: 'list_trips', description: 'List all trips in the family travel log.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_items', description: 'List bookings and suggestions, optionally for one trip.', inputSchema: { type: 'object', properties: { tripId: { type: 'string' } } } },
  {
    name: 'add_suggestion',
    description: 'Add an idea (restaurant, activity, outing) to a trip. It is shown under the Suggestion category and clearly marked as not booked. Use this for recommendations from chat.',
    inputSchema: { type: 'object', properties: itemProps, required: ['tripId', 'title', 'date'] },
  },
  {
    name: 'add_booking',
    description: 'Add a confirmed booking (flight, hotel, restaurant, transport or activity) to a trip.',
    inputSchema: { type: 'object', properties: Object.assign({ type: { type: 'string', enum: TYPES.filter((t) => t !== 'suggestion') } }, itemProps), required: ['tripId', 'type', 'title', 'date'] },
  },
  {
    name: 'update_item',
    description: 'Change fields on an existing item (for example turn a suggestion into a booking by setting type and confirmation).',
    inputSchema: { type: 'object', properties: Object.assign({ id: { type: 'string' }, type: { type: 'string', enum: TYPES } }, itemProps), required: ['id'] },
  },
];

const clean = (o, keys) => {
  const out = {};
  keys.forEach((k) => { if (o[k] !== undefined && o[k] !== null) out[k] = String(o[k]); });
  return out;
};
const FIELDS = ['tripId', 'title', 'date', 'time', 'endDate', 'endTime', 'location', 'confirmation', 'travelers', 'notes'];

async function callTool(name, a) {
  a = a || {};
  if (name === 'list_trips') return await listDocs('trips');
  if (name === 'list_items') {
    const all = await listDocs('items');
    return a.tripId ? all.filter((i) => i.tripId === a.tripId) : all;
  }
  if (name === 'add_suggestion') {
    const trips = await listDocs('trips');
    if (!trips.find((t) => t.id === a.tripId)) throw new Error('Unknown tripId. Call list_trips first.');
    const d = Object.assign({ time: '', location: '', confirmation: '', travelers: '' }, clean(a, FIELDS));
    d.type = 'suggestion';
    d.notes = 'SUGGESTION, not booked. ' + (d.notes || '');
    d.source = 'chat';
    const id = newId('sug-');
    await upsertDoc('items', id, d);
    return { id, added: d };
  }
  if (name === 'add_booking') {
    if (!TYPES.includes(a.type) || a.type === 'suggestion') throw new Error('type must be flight, hotel, restaurant, transport or activity');
    const d = Object.assign({ time: '', location: '', confirmation: '', travelers: '', notes: '' }, clean(a, FIELDS));
    d.type = a.type;
    d.source = 'chat';
    const id = newId('bk-');
    await upsertDoc('items', id, d);
    return { id, added: d };
  }
  if (name === 'update_item') {
    const cur = await getDoc('items', a.id);
    if (!cur) throw new Error('No item with that id.');
    const patch = clean(a, FIELDS);
    if (a.type && TYPES.includes(a.type)) patch.type = a.type;
    await upsertDoc('items', a.id, Object.assign({}, cur, patch));
    return { id: a.id, updated: patch };
  }
  throw new Error('Unknown tool: ' + name);
}

async function handle(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    return ok({ protocolVersion: (params && params.protocolVersion) || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'family-travel', version: '1.0.0' } });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const out = await callTool(params.name, params.arguments);
      return ok({ content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      return ok({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] });
    }
  }
  if (id === undefined) return null; // notification
  return err(-32601, 'Method not found');
}

module.exports = async (req, res) => {
  if (!process.env.MCP_KEY || req.query.key !== process.env.MCP_KEY) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (req.method !== 'POST') { res.status(405).setHeader('Allow', 'POST').end(); return; }
  const body = req.body;
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map(handle))).filter(Boolean);
  if (!out.length) { res.status(202).end(); return; }
  res.status(200).json(Array.isArray(body) ? out : out[0]);
};
