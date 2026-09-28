// CORRECTIF URGENT — remet l'URL serveur du tool capture_lead dans VAPI.
//
// Cause : le script du 2026-09-21 a envoyé PATCH /tool avec seulement { function } ;
// VAPI a alors effacé le bloc `server` (url + timeout). Depuis, VAPI n'a nulle part
// où envoyer les leads → « No result returned » et AUCUN courriel de lead.
// Les autres tools n'ont jamais été re-PATCHés, leur URL est intacte.
//
// DEPUIS LA RACINE DU REPO :
//   railway run node scripts/vapi-fix-capture-lead-2026-09-28.mjs
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) { console.error('VAPI_PRIVATE_KEY absente (lancer via `railway run`)'); process.exit(2); }
const BASE = 'https://vapi-production-0c30.up.railway.app';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method, p, body) {
  const r = await fetch('https://api.vapi.ai' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} HTTP ${r.status}: ${t.slice(0, 600)}`);
  return t ? JSON.parse(t) : null;
}
const tools = await api('GET', '/tool');
const expected = { capture_lead: '/capture_lead', search_shopify_products: '/search_shopify_products', search_shopify_orders: '/search_shopify_orders', send_sms: '/send_sms_tool' };
for (const [name, route] of Object.entries(expected)) {
  const t = tools.find(x => x.function?.name === name);
  if (!t) { console.log(`?? ${name} : tool introuvable`); continue; }
  const url = BASE + route;
  if (t.server?.url === url && t.server?.timeoutSeconds) { console.log(`OK    ${name} — server déjà correct (${t.server.url}, ${t.server.timeoutSeconds} s)`); continue; }
  // On renvoie function + server ensemble (jamais l'un sans l'autre) : c'est ce qui manquait.
  const r = await api('PATCH', `/tool/${t.id}`, { function: t.function, server: { url, timeoutSeconds: 20 } });
  console.log(`FIXÉ  ${name} — server = ${r.server?.url} (${r.server?.timeoutSeconds} s) | champs: ${Object.keys(r.function?.parameters?.properties || {}).join(', ')}`);
}
