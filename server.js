/* ATUAL - servidor de pedidos (Node 18+, sem dependências)
   Uso:  node server.js
   Variáveis opcionais: PORT=3000  ADMIN_PASSWORD=suasenha  INFINITE_TAG=alais-gomes-dos-santos
   Abra:  http://localhost:3000/  (loja)   e   http://localhost:3000/admin  (painel) */
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const KEY = process.env.ADMIN_PASSWORD || 'atual2026';
const TAG = process.env.INFINITE_TAG || 'alais-gomes-dos-santos';
const API = process.env.INFINITE_API || 'https://api.checkout.infinitepay.io';
const DIR = __dirname, DBDIR = path.join(DIR, 'data'), DB = path.join(DBDIR, 'pedidos.json');
fs.mkdirSync(DBDIR, { recursive: true });
let pedidos = []; try { pedidos = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
const salvar = () => fs.writeFileSync(DB + '.tmp', JSON.stringify(pedidos, null, 1)) || fs.renameSync(DB + '.tmp', DB);
const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const limpa = (v, n = 120) => String(v == null ? '' : v).replace(/[<>]/g, '').slice(0, n);
const resp = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, x-admin-key', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' }); res.end(JSON.stringify(obj)); };
const corpo = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 200000) { req.destroy(); no(new Error('grande')); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { ok({}); } }); });
const admin = req => req.headers['x-admin-key'] === KEY;
const limite = {}; // anti-abuso simples: 20 pedidos por IP por hora
function okLimite(ip) { const h = Math.floor(Date.now() / 3600000), k = ip + h; limite[k] = (limite[k] || 0) + 1; return limite[k] <= 20; }

/* confirma com a InfinitePay (não confiamos só no que chega no webhook) */
async function verificaPagamento(nsu, tn, slug) {
  const r = await fetch(API + '/payment_check', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: TAG, order_nsu: nsu, transaction_nsu: tn, slug }) });
  const d = await r.json(); return d;
}
async function confirma(nsu, tn, slug) {
  const p = pedidos.find(x => x.id === nsu);
  if (!p) return { code: 404, msg: 'pedido não encontrado' };
  if (p.status === 'Pago' && p.pagoAuto) return { code: 200, msg: 'já confirmado' };
  let d; try { d = await verificaPagamento(nsu, tn, slug); } catch (e) { return { code: 502, msg: 'não foi possível verificar na InfinitePay' }; }
  if (!(d && d.success && d.paid)) return { code: 202, msg: 'pagamento ainda não confirmado' };
  const pagoCent = d.paid_amount != null ? d.paid_amount : d.amount;
  p.status = 'Pago'; p.pagoAuto = true; p.valor = pagoCent / 100; p.parcelas = d.installments || 1;
  p.captura = d.capture_method || 'credit_card'; p.pagoEm = new Date().toISOString(); p.transacao = tn || '';
  p.divergente = Math.round(p.total * 100) > pagoCent;
  p.obs = 'Pago automaticamente via InfinitePay' + (p.parcelas > 1 ? ' em ' + p.parcelas + 'x' : '') + (p.divergente ? ' · ATENÇÃO: valor pago menor que o pedido' : '');
  salvar(); return { code: 200, msg: 'confirmado' };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (req.method === 'OPTIONS') return resp(res, 204, {});
    if (p === '/api/pedido' && req.method === 'POST') {
      if (!okLimite(req.socket.remoteAddress)) return resp(res, 429, { erro: 'muitas tentativas' });
      const b = await corpo(req); const c = b.cliente || {};
      const itens = (Array.isArray(b.itens) ? b.itens : []).slice(0, 40).map(i => ({ nome: limpa(i.nome), cor: limpa(i.cor, 40), tam: limpa(i.tam, 20), qtd: Math.max(1, Math.min(99, +i.qtd || 1)), preco: Math.max(0, +i.preco || 0) }));
      const nsu = limpa(b.nsu, 40);
      if (!nsu || !itens.length || limpa(c.nome).length < 2) return resp(res, 400, { erro: 'dados inválidos' });
      if (pedidos.some(x => x.id === nsu)) return resp(res, 200, { ok: true });
      const total = Math.round(itens.reduce((s, i) => s + i.preco * i.qtd, 0) * 100) / 100; // total recalculado pelos itens
      pedidos.push({ id: nsu, data: hoje(), criado: new Date().toISOString(), nome: limpa(c.nome), wa: limpa(c.wa, 20), cpf: limpa(c.cpf, 14),
        itens, total, valor: total, pag: b.metodo === 'pix' ? 'Pix' : 'Cartão', status: 'Aguardando pagamento', obs: b.metodo === 'pix' ? 'Pix: aguardando comprovante' : 'Cartão: aguardando pagamento na InfinitePay' });
      salvar(); return resp(res, 201, { ok: true });
    }
    if (p === '/api/webhook' && req.method === 'POST') {
      const b = await corpo(req);
      const nsu = limpa(b.order_nsu, 40), tn = limpa(b.transaction_nsu, 80), slug = limpa(b.invoice_slug || b.slug, 80);
      const r = await confirma(nsu, tn, slug); return resp(res, r.code === 404 ? 400 : r.code === 502 ? 400 : 200, { message: r.msg });
    }
    if (p === '/api/confirmar' && req.method === 'POST') {
      const b = await corpo(req); const r = await confirma(limpa(b.order_nsu, 40), limpa(b.transaction_nsu, 80), limpa(b.slug, 80)); return resp(res, r.code, { message: r.msg });
    }
    if (p.startsWith('/api/pedidos')) {
      if (!admin(req)) return resp(res, 401, { erro: 'não autorizado' });
      if (p === '/api/pedidos' && req.method === 'GET') return resp(res, 200, pedidos);
      const id = decodeURIComponent(p.split('/')[3] || ''); const i = pedidos.findIndex(x => x.id === id);
      if (i < 0) return resp(res, 404, { erro: 'não encontrado' });
      if (req.method === 'PATCH') { const b = await corpo(req); ['status', 'nome', 'wa', 'cpf', 'obs'].forEach(k => { if (b[k] != null) pedidos[i][k] = limpa(b[k], 200); }); salvar(); return resp(res, 200, pedidos[i]); }
      if (req.method === 'DELETE') { pedidos.splice(i, 1); salvar(); return resp(res, 200, { ok: true }); }
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return arq(res, 'index.html');
    if (req.method === 'GET' && (p === '/admin' || p === '/admin.html')) return arq(res, 'admin.html');
    resp(res, 404, { erro: 'não encontrado' });
  } catch (e) { resp(res, 500, { erro: 'erro interno' }); }
});
function arq(res, nome) { fs.readFile(path.join(DIR, nome), (e, d) => { if (e) return resp(res, 404, { erro: 'arquivo ausente: ' + nome }); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); }); }
server.listen(PORT, () => console.log('ATUAL no ar: http://localhost:' + PORT + '  |  painel: /admin'));
