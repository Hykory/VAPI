// Vérifie côté Twilio ce qui arrive aux appels transférés vers +18196171695 (poste SIP 104).
// Identifiants injectés par `railway run`, jamais affichés.
const SID = process.env.TWILIO_ACCOUNT_SID, TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) { console.error('creds Twilio absentes'); process.exit(2); }
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');
async function page(url, acc = []) {
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`Twilio HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  acc.push(...(j.calls || []));
  return j.next_page_uri ? page('https://api.twilio.com' + j.next_page_uri, acc) : acc;
}
const base = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json?PageSize=500&StartTime%3E=2026-09-07&StartTime%3C=2026-09-14`;
const all = await page(base);
const fmt = d => new Date(d).toLocaleString('fr-CA', { timeZone: 'America/Toronto', weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const mask = n => (n || '').replace(/^(\+1\d{3})\d{3}(\d{4})$/, '$1***$2');
console.log('appels Twilio total semaine:', all.length);
const byTo = {}; for (const c of all) { const k = c.to.startsWith('sip:') ? 'SIP:' + c.to.split('@')[0] : c.to; byTo[k] = (byTo[k] || 0) + 1; }
console.log('par destination:', JSON.stringify(byTo));
const sip = all.filter(c => c.to.startsWith('sip:')).sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
const st = {}; for (const c of sip) st[c.status] = (st[c.status] || 0) + 1;
console.log('\n== Jambes SIP (sonnerie du poste) ==', JSON.stringify(st));
for (const c of sip) console.log(` ${fmt(c.start_time)}  ${c.status.padEnd(10)} durée=${String(c.duration).padStart(3)}s  de ${mask(c.from_formatted || c.from)}  parent=${(c.parent_call_sid || '').slice(-6)}`);
const toTransfer = all.filter(c => c.to === '+18196171695').sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
const st2 = {}; for (const c of toTransfer) st2[c.status] = (st2[c.status] || 0) + 1;
console.log('\n== Appels entrants sur le numéro de transfert +18196171695 ==', toTransfer.length, JSON.stringify(st2));
for (const c of toTransfer) console.log(` ${fmt(c.start_time)}  ${c.status.padEnd(10)} durée=${String(c.duration).padStart(3)}s  de ${mask(c.from)}  dir=${c.direction}`);
const toMat = all.filter(c => c.to === '+18194127147');
console.log('\n== Vers Mathieu +18194127147 ==', toMat.map(c => `${fmt(c.start_time)} ${c.status} ${c.duration}s`).join(' | '));
