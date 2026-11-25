/**
 * DeFi Analytics — Cloudflare Worker для пуш-алертов (FCM).
 *
 * Отдельный воркер, с воркером Options Analyst (P2) не связан.
 *
 * Настройка (Cloudflare Dashboard → Workers & Pages → Create → Worker "defi-alerts"):
 *   1. Вставить этот файл как код воркера.
 *   2. Settings → Bindings → KV namespace: переменная DEFI_KV (создать новый namespace "defi-alerts-kv").
 *   3. Settings → Variables and Secrets → Secret: FCM_SERVICE_ACCOUNT = весь JSON ключа сервисного
 *      аккаунта Firebase (Project settings → Service accounts → Generate new private key).
 *   4. Settings → Trigger Events → Cron Triggers: добавить  *\/5 * * * *  (каждые 5 минут).
 *
 * Эндпоинты:
 *   GET  /health                → {ok:true}
 *   POST /sync   {token, wallets:[0x…], alerts:[…], lang}  → сохраняет подписку целиком
 *   POST /unsubscribe {token}   → удаляет подписку
 *   POST /test   {token}        → шлёт тестовый пуш и возвращает ответ FCM
 *
 * Формат алерта:
 *   {id, on:true, type:'hf',    below:1.5}
 *   {id, on:true, type:'price', asset:'BTC', dir:'above'|'below', price:70000}
 */

const AAVE_NETWORKS = {
  ethereum:  { name:'Ethereum',  pool:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', rpc:['https://ethereum.publicnode.com','https://eth.llamarpc.com','https://cloudflare-eth.com'] },
  arbitrum:  { name:'Arbitrum',  pool:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', rpc:['https://arb1.arbitrum.io/rpc','https://arbitrum.publicnode.com','https://arbitrum.llamarpc.com'] },
  polygon:   { name:'Polygon',   pool:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', rpc:['https://polygon-rpc.com','https://polygon.publicnode.com','https://polygon.llamarpc.com'] },
  optimism:  { name:'Optimism',  pool:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', rpc:['https://mainnet.optimism.io','https://optimism.publicnode.com','https://optimism.llamarpc.com'] },
  base:      { name:'Base',      pool:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', rpc:['https://mainnet.base.org','https://base.publicnode.com','https://base.llamarpc.com'] },
  avalanche: { name:'Avalanche', pool:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', rpc:['https://api.avax.network/ext/bc/C/rpc','https://avalanche-c-chain.publicnode.com'] },
  bnb:       { name:'BNB Chain', pool:'0x6807dc923806fE8Fd134338EABCA509979a7e0cB', rpc:['https://bsc-dataseed.binance.org','https://bsc.publicnode.com'] },
  gnosis:    { name:'Gnosis',    pool:'0xb50201558B00496A145fE76f7424749556E326D8', rpc:['https://rpc.gnosischain.com','https://gnosis.publicnode.com'] },
};

const ASSET_SYMBOL = { BTC:'BTCUSDT', ETH:'ETHUSDT', SOL:'SOLUSDT', BNB:'BNBUSDT', AVAX:'AVAXUSDT', LINK:'LINKUSDT',
                       AAVE:'AAVEUSDT', UNI:'UNIUSDT', ARB:'ARBUSDT', OP:'OPUSDT', POL:'POLUSDT' };

const HF_REPEAT_MS   = 3 * 3600 * 1000;   // пока HF ниже порога — напоминание раз в 3 часа
const HF_REARM_GAP   = 0.05;              // HF должен подняться выше порога на эту величину, чтобы алерт «перезарядился»
const MAX_ALERTS     = 20;
const MAX_WALLETS    = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function subKey(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return 'sub:' + [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanAlerts(list) {
  const out = [];
  (Array.isArray(list) ? list : []).slice(0, MAX_ALERTS).forEach(a => {
    if (!a || typeof a !== 'object') return;
    const id = String(a.id || '').slice(0, 40); if (!id) return;
    if (a.type === 'hf') {
      const below = Number(a.below); if (!(below > 1 && below < 10)) return;
      out.push({ id, on: a.on !== false, type: 'hf', below });
    } else if (a.type === 'price') {
      const asset = String(a.asset || '').toUpperCase(); if (!ASSET_SYMBOL[asset]) return;
      const dir = a.dir === 'below' ? 'below' : 'above';
      const price = Number(a.price); if (!(price > 0)) return;
      out.push({ id, on: a.on !== false, type: 'price', asset, dir, price });
    }
  });
  return out;
}

// ───────────────────────── HTTP ─────────────────────────
async function handleFetch(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  if (url.pathname === '/health') return json({ ok: true, ts: Date.now() });
  if (request.method !== 'POST') return json({ ok: false, error: 'not_found' }, 404);

  let body; try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const token = String(body.token || '');
  if (token.length < 50 || token.length > 400) return json({ ok: false, error: 'bad_token' }, 400);
  const key = await subKey(token);

  if (url.pathname === '/sync') {
    const prev = await env.DEFI_KV.get(key, 'json');
    const wallets = (Array.isArray(body.wallets) ? body.wallets : [])
      .map(w => String(w).trim()).filter(w => /^0x[0-9a-fA-F]{40}$/.test(w)).slice(0, MAX_WALLETS);
    const sub = {
      token, wallets,
      alerts: cleanAlerts(body.alerts),
      lang: body.lang === 'en' ? 'en' : 'ru',
      fired: (prev && prev.fired) || {},      // состояние срабатываний переносим, чтобы синхронизация не вызывала повторов
      updated: Date.now(),
    };
    await env.DEFI_KV.put(key, JSON.stringify(sub));
    return json({ ok: true, alerts: sub.alerts.length, wallets: wallets.length });
  }
  if (url.pathname === '/unsubscribe') {
    await env.DEFI_KV.delete(key);
    return json({ ok: true });
  }
  if (url.pathname === '/test') {
    const sub = await env.DEFI_KV.get(key, 'json');
    const ru = !sub || sub.lang !== 'en';
    const r = await sendPush(env, token, ru ? 'Тест' : 'Test', ru ? 'Пуш-уведомления DeFi Analytics работают' : 'DeFi Analytics push notifications work', 'test');
    return json({ ok: r.ok, status: r.status, detail: r.ok ? undefined : String(r.text || '').slice(0, 300) }, r.ok ? 200 : 502);
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

// ───────────────────────── FCM ─────────────────────────
let _tokenCache = null;
function b64url(buf) {
  let s = ''; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function getAccessToken(env) {
  if (_tokenCache && _tokenCache.exp > Date.now() + 60000) return _tokenCache;
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + unsigned + '.' + b64url(sig),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('oauth: ' + JSON.stringify(j).slice(0, 200));
  _tokenCache = { token: j.access_token, project: sa.project_id, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tokenCache;
}
// data-only + priority HIGH: баннер рисует само приложение (так же, как в P2)
async function sendPush(env, token, title, body, tag) {
  try {
    const at = await getAccessToken(env);
    const r = await fetch('https://fcm.googleapis.com/v1/projects/' + at.project + '/messages:send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + at.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, data: { title, body, tag: tag || '' }, android: { priority: 'HIGH' } } }),
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, gone: r.status === 404 || /UNREGISTERED|NOT_FOUND/.test(text) };
  } catch (e) {
    return { ok: false, status: 0, text: String(e && e.message || e), gone: false };
  }
}

// ───────────────────────── данные ─────────────────────────
async function fetchJson(url, ms = 6000, init) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { ...(init || {}), signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function getPrices(assets) {
  const out = {}; const syms = [...new Set(assets.map(a => ASSET_SYMBOL[a]).filter(Boolean))];
  if (!syms.length) return out;
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const j = await fetchJson(host + '/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(syms)));
      j.forEach(x => { out[x.symbol] = parseFloat(x.price); });
      break;
    } catch (e) { /* пробуем следующий хост */ }
  }
  // запасной источник — Coinbase (по одному тикеру)
  for (const s of syms) {
    if (out[s]) continue;
    try { const a = s.replace('USDT', ''); const j = await fetchJson('https://api.coinbase.com/v2/prices/' + a + '-USD/spot'); out[s] = parseFloat(j.data.amount); } catch (e) {}
  }
  const res = {}; Object.keys(ASSET_SYMBOL).forEach(a => { if (out[ASSET_SYMBOL[a]]) res[a] = out[ASSET_SYMBOL[a]]; });
  return res;
}
async function rpcCall(rpcs, to, data) {
  for (const url of rpcs) {
    try {
      const j = await fetchJson(url, 5000, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
      if (j.result && j.result !== '0x') return j.result;
    } catch (e) { /* следующий RPC */ }
  }
  return null;
}
// Pool.getUserAccountData(address) → минимальный HF среди сетей, где есть долг
async function getHealthFactor(wallet) {
  const data = '0xbf92857c' + wallet.slice(2).toLowerCase().padStart(64, '0');
  const res = await Promise.all(Object.values(AAVE_NETWORKS).map(async net => {
    const hex = await rpcCall(net.rpc, net.pool, data);
    if (!hex || hex.length < 386) return null;
    const h = hex.slice(2);
    const debt = BigInt('0x' + h.slice(64, 128));
    const hfRaw = BigInt('0x' + h.slice(320, 384));
    if (debt === 0n) return null;                       // нет долга — HF не важен
    return { net: net.name, hf: Number(hfRaw) / 1e18 };
  }));
  const act = res.filter(Boolean);
  if (!act.length) return null;
  return act.reduce((m, x) => (x.hf < m.hf ? x : m));
}

// ───────────────────────── проверка алертов (cron) ─────────────────────────
// Чистая функция: решает, что слать, и обновляет sub.fired. Вынесена отдельно для проверки.
function evaluate(sub, ctx, now) {
  const msgs = []; const ru = sub.lang !== 'en';
  sub.fired = sub.fired || {};
  const fmt = n => n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(+n.toFixed(2));
  sub.alerts.forEach(a => {
    if (!a.on) { delete sub.fired[a.id]; return; }
    if (a.type === 'hf') {
      if (ctx.hf == null) return;                       // нет данных — состояние не трогаем
      if (ctx.hf.hf < a.below) {
        const last = sub.fired[a.id];
        if (last === undefined || now - last >= HF_REPEAT_MS) {
          sub.fired[a.id] = now;
          msgs.push({ tag: 'hf_' + a.id, title: ru ? '⚠️ Health Factor ниже ' + a.below : '⚠️ Health Factor below ' + a.below,
            body: (ru ? 'Сейчас HF ' : 'HF is now ') + ctx.hf.hf.toFixed(2) + ' (' + ctx.hf.net + ')' });
        }
      } else if (ctx.hf.hf >= a.below + HF_REARM_GAP) { delete sub.fired[a.id]; }
    } else if (a.type === 'price') {
      const p = ctx.prices[a.asset]; if (!p) return;
      const hit = a.dir === 'above' ? p >= a.price : p <= a.price;
      if (hit) {
        if (sub.fired[a.id] === undefined) {
          sub.fired[a.id] = now;
          msgs.push({ tag: 'px_' + a.id, title: a.asset + (a.dir === 'above' ? ' ≥ $' : ' ≤ $') + fmt(a.price),
            body: (ru ? 'Цена сейчас $' : 'Price is now $') + fmt(p) });
        }
      } else { delete sub.fired[a.id]; }
    }
  });
  return msgs;
}

async function runCron(env) {
  const list = await env.DEFI_KV.list({ prefix: 'sub:' });
  const subs = [];
  for (const k of list.keys) { const s = await env.DEFI_KV.get(k.name, 'json'); if (s && s.alerts && s.alerts.length) subs.push({ key: k.name, sub: s }); }
  if (!subs.length) return;

  const assets = new Set(); const wallets = new Set();
  subs.forEach(({ sub }) => sub.alerts.forEach(a => {
    if (!a.on) return;
    if (a.type === 'price') assets.add(a.asset);
    if (a.type === 'hf') sub.wallets.forEach(w => wallets.add(w.toLowerCase()));
  }));
  const prices = await getPrices([...assets]);
  const hfByWallet = {};
  for (const w of wallets) { try { hfByWallet[w] = await getHealthFactor(w); } catch (e) { hfByWallet[w] = null; } }

  const now = Date.now();
  for (const { key, sub } of subs) {
    const hfs = sub.wallets.map(w => hfByWallet[w.toLowerCase()]).filter(Boolean);
    const hf = hfs.length ? hfs.reduce((m, x) => (x.hf < m.hf ? x : m)) : null;
    const before = JSON.stringify(sub.fired);
    const msgs = evaluate(sub, { prices, hf }, now);
    let gone = false;
    for (const m of msgs) {
      const r = await sendPush(env, sub.token, m.title, m.body, m.tag);
      if (r.gone) { gone = true; break; }
      if (!r.ok) { const id = m.tag.replace(/^(hf|px)_/, ''); delete sub.fired[id]; }   // не доставили — повторим на следующем тике
    }
    // На бесплатном тарифе KV лимит 1000 записей в сутки, поэтому пишем только если состояние изменилось
    if (gone) await env.DEFI_KV.delete(key); else if (JSON.stringify(sub.fired) !== before) await env.DEFI_KV.put(key, JSON.stringify(sub));
  }
}

export default {
  fetch: (request, env) => handleFetch(request, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(runCron(env)),
};
export { evaluate, cleanAlerts };
