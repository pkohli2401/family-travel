// Minimal PostgREST helpers using the service role key (server only).
const URL_ = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers(extra) {
  return Object.assign({ apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json' }, extra || {});
}

async function listDocs(collection) {
  const r = await fetch(`${URL_()}/rest/v1/docs?collection=eq.${encodeURIComponent(collection)}&select=id,data&limit=5000`, { headers: headers() });
  if (!r.ok) throw new Error('list failed ' + r.status);
  return (await r.json()).map((x) => Object.assign({}, x.data, { id: x.id }));
}

async function getDoc(collection, id) {
  const r = await fetch(`${URL_()}/rest/v1/docs?collection=eq.${encodeURIComponent(collection)}&id=eq.${encodeURIComponent(id)}&select=data`, { headers: headers() });
  if (!r.ok) throw new Error('get failed ' + r.status);
  const a = await r.json();
  return a[0] ? a[0].data : null;
}

async function upsertDoc(collection, id, data) {
  const r = await fetch(`${URL_()}/rest/v1/docs?on_conflict=collection,id`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ collection, id, data }),
  });
  if (!r.ok) throw new Error('write failed ' + r.status);
}

function newId(prefix) {
  return (prefix || '') + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

module.exports = { listDocs, getDoc, upsertDoc, newId, headers, URL_, KEY };
