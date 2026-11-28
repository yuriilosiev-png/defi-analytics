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
const PRICE_REARM_PCT = 0.005;            // режим «каждый раз»: цена должна отойти от уровня на 0.5%, чтобы алерт снова взвёлся (без спама на границе)
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

// Режим срабатывания: once — один раз (до ручного перевзвода), every — каждый раз при новом пересечении,
// remind — только для HF: напоминание каждые 3 часа, пока ниже порога. Без поля — прежнее поведение.
function cleanRep(r, type) {
  if (r === 'once' || r === 'every') return r;
  if (r === 'remind' && type === 'hf') return r;
  return type === 'hf' ? 'remind' : 'every';
}
function cleanVer(v) { v = Math.floor(Number(v)); return v > 0 && v < 1e9 ? v : 0; }
function cleanAlerts(list) {
  const out = [];
  (Array.isArray(list) ? list : []).slice(0, MAX_ALERTS).forEach(a => {
    if (!a || typeof a !== 'object') return;
    const id = String(a.id || '').slice(0, 40); if (!id) return;
    if (a.type === 'hf') {
      const below = Number(a.below); if (!(below > 1 && below < 10)) return;
      out.push({ id, on: a.on !== false, type: 'hf', below, rep: cleanRep(a.rep, 'hf'), snd: a.snd !== false, ver: cleanVer(a.ver) });
    } else if (a.type === 'price') {
      const asset = String(a.asset || '').toUpperCase(); if (!ASSET_SYMBOL[asset]) return;
      const dir = a.dir === 'below' ? 'below' : 'above';
      const price = Number(a.price); if (!(price > 0)) return;
      out.push({ id, on: a.on !== false, type: 'price', asset, dir, price, rep: cleanRep(a.rep, 'price'), snd: a.snd !== false, ver: cleanVer(a.ver) });
    }
  });
  return out;
}

function repMode(a) { return a.rep || (a.type === 'hf' ? 'remind' : 'every'); }
function id_changed(prevVer, a) { return prevVer[a.id] !== undefined && prevVer[a.id] !== (a.ver || 0); }

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
      hints: cleanHints(body.hints, wallets),
      lang: body.lang === 'en' ? 'en' : 'ru',
      fired: (prev && prev.fired) || {},      // состояние срабатываний переносим, чтобы синхронизация не вызывала повторов
      updated: Date.now(),
    };
    // Перевзвод: пользователь переключил/поправил алерт (ver изменился) или удалил его — забываем прежнее срабатывание
    const prevVer = {}; ((prev && prev.alerts) || []).forEach(a => { prevVer[a.id] = a.ver || 0; });
    const ids = new Set(sub.alerts.map(a => a.id));
    Object.keys(sub.fired).forEach(id => { if (!ids.has(id)) delete sub.fired[id]; });
    sub.alerts.forEach(a => { if (id_changed(prevVer, a)) delete sub.fired[a.id]; });
    await env.DEFI_KV.put(key, JSON.stringify(sub));
    const latched = sub.alerts.filter(a => repMode(a) === 'once' && sub.fired[a.id] !== undefined).map(a => a.id);
    return json({ ok: true, alerts: sub.alerts.length, wallets: wallets.length, latched });
  }
  if (url.pathname === '/unsubscribe') {
    await env.DEFI_KV.delete(key);
    return json({ ok: true });
  }
  if (url.pathname === '/test') {
    const sub = await env.DEFI_KV.get(key, 'json');
    const ru = !sub || sub.lang !== 'en';
    const r = await sendPush(env, token, ru ? 'Тест' : 'Test', ru ? 'Пуш-уведомления DeFi Analytics работают' : 'DeFi Analytics push notifications work', 'test', body.sound !== false);
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
async function sendPush(env, token, title, body, tag, snd) {
  try {
    const at = await getAccessToken(env);
    const r = await fetch('https://fcm.googleapis.com/v1/projects/' + at.project + '/messages:send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + at.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, data: { title, body, tag: tag || '', sound: snd === false ? '0' : '1' }, android: { priority: 'HIGH' } } }),
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text, gone: r.status === 404 || /UNREGISTERED|NOT_FOUND/.test(text) };
  } catch (e) {
    return { ok: false, status: 0, text: String(e && e.message || e), gone: false };
  }
}

// ───────────────────────── данные ─────────────────────────
// Бесплатный тариф: 50 подзапросов на запуск. Считаем свои и не выходим за 44 (остаток — на пуши).
let _subreq = 0; const SUBREQ_MAX = 44;
function resetBudget() { _subreq = 0; }
async function fetchJson(url, ms = 6000, init) {
  if (++_subreq > SUBREQ_MAX) throw new Error('budget');
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

// ───────────────────────── HF остальных протоколов ─────────────────
// Приложение присылает подсказки (hints) по каждому кошельку: где у него реально есть позиции.
// Так воркер не сканирует 256 суб-аккаунтов Euler и все рынки Compound, а проверяет только нужное.
//   hints[wallet] = { m:1, c:[{k:'arbitrum', a:'0xComet'}], e:[{k:'ethereum', s:'0xSub', v:'0xVault'}] }
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
function cleanHints(h, wallets) {
  const out = {}; if (!h || typeof h !== 'object') return out;
  wallets.forEach(w => {
    const x = h[w] || h[w.toLowerCase()]; if (!x || typeof x !== 'object') return;
    const o = {};
    if (x.m) o.m = 1;
    const c = (Array.isArray(x.c) ? x.c : []).filter(i => i && AAVE_NETWORKS[i.k] && ADDR_RE.test(String(i.a))).slice(0, 8).map(i => ({ k: i.k, a: String(i.a) }));
    const e = (Array.isArray(x.e) ? x.e : []).filter(i => i && AAVE_NETWORKS[i.k] && ADDR_RE.test(String(i.s)) && ADDR_RE.test(String(i.v))).slice(0, 8).map(i => ({ k: i.k, s: String(i.s), v: String(i.v) }));
    if (c.length) o.c = c; if (e.length) o.e = e;
    if (o.m || o.c || o.e) out[w.toLowerCase()] = o;
  });
  return out;
}
const hx = (h, i) => BigInt('0x' + h.slice(2 + i * 64, 2 + (i + 1) * 64));
const hxAddr = (h, i) => '0x' + h.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
const pad32 = a => a.slice(2).toLowerCase().padStart(64, '0');
const u256 = n => BigInt(n).toString(16).padStart(64, '0');
const ZERO_ADDR = '0x' + '0'.repeat(40);
async function rpcBatch(rpcs, calls) {
  const res = new Array(calls.length).fill(null);
  for (let from = 0; from < calls.length; from += 25) {
    const part = calls.slice(from, from + 25);
    for (const url of rpcs) {
      try {
        const j = await fetchJson(url, 8000, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(part.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }))) });
        if (Array.isArray(j)) {
          let got = false;
          j.forEach(r => { if (r && r.result && r.result !== '0x' && part[r.id]) { res[from + r.id] = r.result; got = true; } });
          if (got) break;
        }
      } catch (e) { if (e && e.message === 'budget') return res; }
    }
  }
  return res;
}

// Compound v3: HF = Σ(коллатерал_USD × liquidateCollateralFactor) / долг_USD  (по каждому рынку-Comet)
async function hfCompound(rb, key, wallet, comets) {
  const rpc = AAVE_NETWORKS[key].rpc, ua = pad32(wallet), out = [];
  const r1 = await rb(rpc, comets.flatMap(c => [
    { to: c, data: '0x374c49b4' + ua }, { to: c, data: '0xa46fe83b' }, { to: c, data: '0xe7dad6bd' }, { to: c, data: '0x44c1e5eb' }]));
  const ms = [];
  comets.forEach((c, i) => {
    const bor = r1[i * 4], n = r1[i * 4 + 1], feed = r1[i * 4 + 2], sc = r1[i * 4 + 3];
    if (!bor || !n || !feed || !sc) return;
    if (hx(bor, 0) === 0n) return;                                      // нет долга
    ms.push({ c, bor: Number(hx(bor, 0)), n: Number(hx(n, 0)), feed: hxAddr(feed, 0), scale: Number(hx(sc, 0)), assets: [] });
  });
  if (!ms.length) return out;
  const c2 = [];
  ms.forEach(m => { c2.push({ to: m.c, data: '0x41976e09' + pad32(m.feed) }); for (let i = 0; i < m.n; i++) c2.push({ to: m.c, data: '0xc8c7fe6b' + u256(i) }); });
  const r2 = await rb(rpc, c2); let k = 0;
  ms.forEach(m => {
    m.basePrice = r2[k] ? Number(hx(r2[k], 0)) / 1e8 : 0; k++;
    for (let i = 0; i < m.n; i++) { const h = r2[k++]; if (h && h.length >= 2 + 64 * 8) m.assets.push({ asset: hxAddr(h, 1), feed: hxAddr(h, 2), scale: Number(hx(h, 3)), lcf: Number(hx(h, 5)) / 1e18 }); }
  });
  const c3 = [];
  ms.forEach(m => m.assets.forEach(a => { c3.push({ to: m.c, data: '0x5c2549ee' + ua + pad32(a.asset) }); c3.push({ to: m.c, data: '0x41976e09' + pad32(a.feed) }); }));
  const r3 = c3.length ? await rb(rpc, c3) : []; k = 0;
  ms.forEach(m => {
    let w = 0; m.assets.forEach(a => { const b = r3[k], p = r3[k + 1]; k += 2; if (b && p) w += Number(hx(b, 0)) / a.scale * (Number(hx(p, 0)) / 1e8) * a.lcf; });
    const debt = m.bor / m.scale * m.basePrice;
    if (debt > 0.01 && m.basePrice > 0) out.push({ net: 'Compound ' + AAVE_NETWORKS[key].name, hf: w / debt });
  });
  return out;
}
// Euler v2: accountLiquidity(sub, true) → (collateralValue, liabilityValue) в единице учёта; HF = coll / liab
async function hfEuler(rb, key, items) {
  const rpc = AAVE_NETWORKS[key].rpc;
  const r = await rb(rpc, items.map(i => ({ to: i.v, data: '0xa824bf67' + pad32(i.s) + u256(1) })));
  const out = [];
  r.forEach(h => { if (!h || h.length < 2 + 128) return; const coll = hx(h, 0), liab = hx(h, 1); if (liab > 0n) out.push({ net: 'Euler ' + AAVE_NETWORKS[key].name, hf: Number(coll) / Number(liab) }); });
  return out;
}
const MORPHO_GQL = 'https://blue-api.morpho.org/graphql';
const MORPHO_QUERY = 'query($addr:String!){userByAddress(address:$addr){marketPositions{market{uniqueKey lltv collateralAsset{symbol decimals priceUsd} loanAsset{symbol decimals priceUsd}}collateral borrowAssets supplyAssets}}}';
async function hfMorpho(wallet, fetchFn = fetchJson) {
  const j = await fetchFn(MORPHO_GQL, 8000, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: MORPHO_QUERY, variables: { addr: wallet } }) });
  const mp = j && j.data && j.data.userByAddress && j.data.userByAddress.marketPositions; const out = [];
  (mp || []).forEach(x => {
    const m = x.market || {}, ca = m.collateralAsset || {}, la = m.loanAsset || {};
    const col = parseFloat(x.collateral || 0) / Math.pow(10, parseInt(ca.decimals || 18)) * parseFloat(ca.priceUsd || 0);
    const bor = parseFloat(x.borrowAssets || 0) / Math.pow(10, parseInt(la.decimals || 18)) * parseFloat(la.priceUsd || 0);
    if (col > 0 && bor > 0.01) out.push({ net: 'Morpho', hf: col * (parseFloat(m.lltv || 0) / 1e18) / bor });
  });
  return out;
}
// Минимальный HF по всем протоколам кошелька: Aave (все сети) + то, что показали подсказки приложения
async function getAllHealth(wallet, hint, rb = rpcBatch, morphoFetch = fetchJson) {
  const all = [];
  try { const a = await getHealthFactor(wallet); if (a) all.push(a); } catch (e) {}
  if (hint) {
    const jobs = [];
    if (hint.m) jobs.push(hfMorpho(wallet, morphoFetch));
    const byC = {}; (hint.c || []).forEach(i => { (byC[i.k] = byC[i.k] || []).push(i.a); });
    Object.keys(byC).forEach(k => jobs.push(hfCompound(rb, k, wallet, byC[k])));
    const byE = {}; (hint.e || []).forEach(i => { (byE[i.k] = byE[i.k] || []).push(i); });
    Object.keys(byE).forEach(k => jobs.push(hfEuler(rb, k, byE[k])));
    (await Promise.all(jobs.map(p => p.catch(() => [])))).forEach(l => l.forEach(x => all.push(x)));
  }
  const ok = all.filter(x => x && isFinite(x.hf) && x.hf > 0);
  return ok.length ? ok.reduce((m, x) => (x.hf < m.hf ? x : m)) : null;
}

// ───────────────────────── проверка алертов (cron) ─────────────────────────
// Чистая функция: решает, что слать, и обновляет sub.fired. Вынесена отдельно для проверки.
function evaluate(sub, ctx, now) {
  const msgs = []; const ru = sub.lang !== 'en';
  sub.fired = sub.fired || {};
  const fmt = n => n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(+n.toFixed(2));
  sub.alerts.forEach(a => {
    if (!a.on) { delete sub.fired[a.id]; return; }
    const mode = repMode(a);
    if (a.type === 'hf') {
      if (ctx.hf == null) return;                       // нет данных — состояние не трогаем
      if (ctx.hf.hf < a.below) {
        const last = sub.fired[a.id];
        if (last === undefined || (mode === 'remind' && now - last >= HF_REPEAT_MS)) {
          sub.fired[a.id] = now;
          msgs.push({ tag: 'hf_' + a.id, snd: a.snd !== false, title: ru ? '⚠️ Health Factor ниже ' + a.below : '⚠️ Health Factor below ' + a.below,
            body: (ru ? 'Сейчас HF ' : 'HF is now ') + ctx.hf.hf.toFixed(2) + ' (' + ctx.hf.net + ')' });
        }
      } else if (mode !== 'once' && ctx.hf.hf >= a.below + HF_REARM_GAP) { delete sub.fired[a.id]; }
    } else if (a.type === 'price') {
      const p = ctx.prices[a.asset]; if (!p) return;
      const hit = a.dir === 'above' ? p >= a.price : p <= a.price;
      if (hit) {
        if (sub.fired[a.id] === undefined) {
          sub.fired[a.id] = now;
          msgs.push({ tag: 'px_' + a.id, snd: a.snd !== false, title: a.asset + (a.dir === 'above' ? ' ≥ $' : ' ≤ $') + fmt(a.price),
            body: (ru ? 'Цена сейчас $' : 'Price is now $') + fmt(p) });
        }
      } else if (mode !== 'once') {
        // отошла от уровня на PRICE_REARM_PCT — снова взводим
        const away = a.dir === 'above' ? p <= a.price * (1 - PRICE_REARM_PCT) : p >= a.price * (1 + PRICE_REARM_PCT);
        if (away) delete sub.fired[a.id];
      }
    }
  });
  return msgs;
}

async function runCron(env) {
  resetBudget();
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
  for (const w of wallets) {
    const hint = (subs.map(x => x.sub.hints && x.sub.hints[w]).find(Boolean)) || null;
    try { hfByWallet[w] = await getAllHealth(w, hint); } catch (e) { hfByWallet[w] = null; }
  }

  const now = Date.now();
  for (const { key, sub } of subs) {
    const hfs = sub.wallets.map(w => hfByWallet[w.toLowerCase()]).filter(Boolean);
    const hf = hfs.length ? hfs.reduce((m, x) => (x.hf < m.hf ? x : m)) : null;
    const before = JSON.stringify(sub.fired);
    const msgs = evaluate(sub, { prices, hf }, now);
    let gone = false;
    for (const m of msgs) {
      const r = await sendPush(env, sub.token, m.title, m.body, m.tag, m.snd);
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
export { evaluate, cleanAlerts, cleanHints, hfCompound, hfEuler, hfMorpho, getAllHealth, rpcBatch };
