// Afficheur du client lors du transfert CHAUD vers le magasin.
//   Avec un transfert chaud, VAPI place un nouvel appel vers le 819-617-1695 : par défaut le
//   magasin voit le numéro de Barry. Ce script met callerId = "{{customer.number}}" sur la
//   destination magasin des deux outils de transfert (Mathieu inchangé).
//   ⚠️ Twilio n'accepte comme afficheur sortant qu'un numéro possédé ou vérifié : il se peut
//   qu'il refuse le numéro du client. Dans ce cas, le transfert ÉCHOUE immédiatement et Barry
//   dit la phrase de repli en moins de 5 s → relancer avec --revert pour revenir à l'état actuel.
//
//   railway run node scripts/vapi-callerid-2026-10-15.mjs            → applique callerId client
//   railway run node scripts/vapi-callerid-2026-10-15.mjs --revert   → retire callerId (afficheur = Barry)
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) { console.error('VAPI_PRIVATE_KEY absente (lancer via `railway run`)'); process.exit(2); }
const REVERT = process.argv.includes('--revert');
const STORE = '+18196171695';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method, p, body) {
  const r = await fetch('https://api.vapi.ai' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} HTTP ${r.status}: ${t.slice(0, 700)}`);
  return t ? JSON.parse(t) : null;
}
const tools = await api('GET', '/tool');
for (const name of ['transfer_call_to_Human', 'transfer_call_to_Human_EN']) {
  const t = tools.find(x => x.function?.name === name);
  if (!t) { console.log('ECHEC', name, 'introuvable'); continue; }
  const destinations = (t.destinations || []).map(d => {
    if (d.number !== STORE) return d;
    const { callerId, ...rest } = d;
    return REVERT ? rest : { ...rest, callerId: '{{customer.number}}' };
  });
  try {
    const r = await api('PATCH', `/tool/${t.id}`, { function: t.function, messages: t.messages, destinations });
    const s = r.destinations.find(d => d.number === STORE);
    console.log(`OK    ${name} — magasin : callerId=${s.callerId || '(défaut : numéro de Barry)'} mode=${s.transferPlan?.mode} timeout=${s.transferPlan?.timeout ?? '-'} repli=${s.transferPlan?.fallbackPlan ? 'oui' : 'non'}`);
  } catch (e) { console.log(`ECHEC ${name} — ${e.message}`); }
}
console.log(REVERT ? '\nRevenu à l\'afficheur de Barry.' : '\nFais maintenant un appel test : demande « parler à quelqu\'un » et regarde l\'afficheur du téléphone du magasin.\nSi Barry dit tout de suite « Personne n\'est disponible… » (sans sonnerie), Twilio a refusé : relance avec --revert.');
