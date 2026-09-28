// Récupère les leads perdus entre le 21 et le 28 sept 2026 (URL du tool capture_lead effacée
// dans VAPI → le serveur n'a jamais reçu les demandes). Les coordonnées sont dans les
// transcriptions VAPI : on les rejoue sur /capture_lead (Railway) pour que les courriels partent,
// avec une note claire « LEAD RÉCUPÉRÉ ». Un seul envoi par numéro de téléphone (le plus récent).
//
//   railway run node scripts/recover-lost-leads-2026-09-28.mjs            → liste seulement (dry-run)
//   railway run node scripts/recover-lost-leads-2026-09-28.mjs --send     → envoie vraiment
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) { console.error('VAPI_PRIVATE_KEY absente'); process.exit(2); }
const SEND = process.argv.includes('--send');
const BASE = 'https://vapi-production-0c30.up.railway.app';
const H = { Authorization: `Bearer ${KEY}` };
const fmt = iso => new Date(iso).toLocaleString('fr-CA', { timeZone: 'America/Toronto', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const mask = n => (n || '?').replace(/^(\+?1?\d{3})\d{3}(\d{4})$/, '$1***$2');

const start = new Date('2026-09-21T04:00:00Z'), end = new Date();
const calls = await (await fetch(`https://api.vapi.ai/call?createdAtGe=${start.toISOString()}&createdAtLe=${end.toISOString()}&limit=1000`, { headers: H })).json();
if (!Array.isArray(calls)) { console.error('réponse VAPI inattendue', JSON.stringify(calls).slice(0, 200)); process.exit(1); }

// 1) Extraire, par appel, le DERNIER capture_lead (le plus complet), seulement si aucun résultat OK
const found = [];
for (const c of calls) {
  const msgs = c.messages || [];
  const results = msgs.filter(m => m.role === 'tool_call_result' && m.name === 'capture_lead').map(m => String(m.result || ''));
  if (results.some(r => !/No result returned/i.test(r))) continue;      // celui-là a marché → rien à récupérer
  let last = null;
  for (const m of msgs) if (m.role === 'tool_calls') for (const tc of (m.toolCalls || [])) if (tc.function?.name === 'capture_lead') {
    let a = tc.function.arguments; try { a = typeof a === 'string' ? JSON.parse(a) : a; } catch { a = null; }
    if (a && a.name && a.phone) last = a;
  }
  if (!last) continue;
  if (/\bTEST\b/i.test(last.name)) continue;                              // mes sondes
  found.push({ callId: c.id, at: c.startedAt, caller: c.customer?.number || '', args: last });
}
// 2) Un seul envoi par numéro (le plus récent), en mentionnant les autres appels
found.sort((a, b) => new Date(a.at) - new Date(b.at));
const byPhone = new Map();
for (const f of found) {
  const d = String(f.args.phone).replace(/\D/g, '').slice(-10);
  const prev = byPhone.get(d);
  // Fusion : le plus récent gagne, mais un champ vide est comblé par un appel précédent
  // (ex. l'adresse dite au premier appel et pas au troisième).
  const merged = { ...(prev?.args || {}) };
  for (const [k, v] of Object.entries(f.args)) if (v != null && String(v).trim()) merged[k] = v;
  byPhone.set(d, { ...f, args: merged, earlier: prev ? [...prev.earlier, prev.at] : [] });
}
const leads = [...byPhone.values()];
console.log(`${found.length} capture_lead perdus dans ${calls.length} appels → ${leads.length} lead(s) unique(s) à récupérer${SEND ? '' : ' (DRY-RUN, ajoute --send pour envoyer)'}\n`);

for (const l of leads) {
  const a = l.args;
  const line = `${fmt(l.at)} — ${a.name} — tél ${mask(String(a.phone).replace(/\D/g, ''))} — ${a.address ? 'adresse ✔' : 'adresse ∅'} — ${a.project_type || '(projet ?)'}${l.earlier.length ? ` — aussi appelé le ${l.earlier.map(fmt).join(', ')}` : ''}`;
  if (!SEND) { console.log('  ·', line); continue; }
  const notes = `⚠️ LEAD RÉCUPÉRÉ — appel du ${fmt(l.at)}. L'envoi original a échoué (URL de l'outil effacée dans VAPI le 21 sept, corrigée le 28 sept). Vérifier si le client a déjà été rappelé.`
    + (l.earlier.length ? ` Même client aussi le ${l.earlier.map(fmt).join(' et le ')}.` : '')
    + (a.notes ? ` Notes de Barry : ${a.notes}` : '');
  const body = { message: { type: 'tool-calls', toolCalls: [{ id: 'recover_' + l.callId.slice(0, 8), type: 'function', function: { name: 'capture_lead', arguments: {
    name: a.name, phone: String(a.phone), address: a.address || '', email: a.email || '', project_type: a.project_type || '', budget: a.budget || '', timeline: a.timeline || '', notes, channel: 'voix (récupéré)',
  } } }], call: { id: l.callId, customer: { number: l.caller } } } };
  const t0 = Date.now();
  const r = await fetch(BASE + '/capture_lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const res = j.results?.[0]?.result || {};
  console.log(`  ${res.saved ? 'ENVOYÉ ' : 'ÉCHEC  '} (${Date.now() - t0} ms) ${line}${res.saved ? '' : ' → ' + JSON.stringify(res).slice(0, 120)}`);
  await new Promise(r => setTimeout(r, 1500));
}
