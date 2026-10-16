'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnv(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const LANGSEARCH_API_KEY = process.env.LANGSEARCH_API_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || ''; // Optional legacy fallback
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const APP_TOKEN = process.env.APP_TOKEN || '';
const SEARCH_INTERVAL_MS = Math.max(1, Number(process.env.SEARCH_INTERVAL_HOURS || 6)) * 60 * 60 * 1000;
const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'leads.json');
const PUBLIC_DIR = __dirname;
const MAX_BODY = 1024 * 1024;
const services = {
  topsoil: { label: 'Topsoil supply', queries: ['"topsoil" OR "top soil" supplier request Lagos Nigeria', '"topsoil supply" Lagos project OR contractor'] },
  landscaping: { label: 'Landscaping', queries: ['landscaping project OR contractor OR tender Lagos Nigeria', 'estate landscaping grounds maintenance request Lagos'] },
  haulage: { label: 'Haulage', queries: ['haulage services request construction materials Lagos Nigeria', 'transport logistics contract supplier request Lagos Nigeria'] },
  procurement: { label: 'Procurement & logistics', queries: ['supplier request procurement logistics Lagos Nigeria', 'request for quotation materials supply Lagos Nigeria'] },
  'site support': { label: 'Site support', queries: ['construction site support contractor tender Lagos Nigeria', 'civil engineering construction project supplier Lagos Nigeria'] }
};
let schedulerTimer = null;
let lastRun = null;
let lastRunError = null;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function ensureDb() { fs.mkdirSync(DB_DIR, { recursive: true }); if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]\n'); }
function readLeads() { ensureDb(); try { const x = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return Array.isArray(x) ? x : []; } catch { return []; } }
function writeLeads(leads) { ensureDb(); const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(leads, null, 2) + '\n'); fs.renameSync(tmp, DB_FILE); }
function json(res, status, data) { const body = JSON.stringify(data); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); }
function safeUrl(raw) { try { const u = new URL(raw); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } }
function normalize(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim(); }
function canonicalLink(raw) { const u = safeUrl(raw); if (!u) return ''; const x = new URL(u); x.hash = ''; for (const k of [...x.searchParams.keys()]) if (/^(utm_|gclid|fbclid)/i.test(k)) x.searchParams.delete(k); return x.href.replace(/\/$/, ''); }
function classify(result, service, mode) {
  const text = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
  const activeTerms = /request for quotation|rfq|tender|invitation to bid|seeking suppliers|supplier needed|looking for.*(topsoil|landscap|haulage)|requirement for|supply of|procurement notice|bids? invited|expression of interest|call for tender|vendor registration/.test(text);
  const projectTerms = /project|development|estate|construction|renovation|landscaping|grounds maintenance|football pitch|sports field|garden installation/.test(text);
  let intent = activeTerms ? 'Active Buyer' : projectTerms ? 'Project Opportunity' : 'Potential Client';
  if (mode === 'active' && intent !== 'Active Buyer') return null;
  if (mode === 'potential' && intent === 'Active Buyer') return null;
  const relevanceTerms = service === 'topsoil' ? /topsoil|top soil|soil|lawn|garden|turf|landscap/ : service === 'landscaping' ? /landscap|garden|grounds|lawn|estate|turf|football pitch/ : service === 'haulage' ? /haulage|transport|logistics|delivery|fleet|materials/ : service === 'procurement' ? /procurement|supplier|quotation|rfq|logistics|supply/ : /construction|site support|civil engineering|contractor|project/;
  if (!relevanceTerms.test(text)) return null;
  let score = 20;
  score += activeTerms ? 40 : projectTerms ? 25 : 10;
  score += /lagos|lekki|ajah|ikeja|ikorodu|ogun|nigeria/.test(text) ? 20 : 5;
  score += result.date ? 10 : 0;
  score = Math.min(100, score);
  const priority = score >= 75 ? 'High' : score >= 50 ? 'Medium' : 'Low';
  return { intent, score, priority, activeTerms };
}
function queriesFor({ location = 'Lagos, Nigeria', mode = 'both', selectedServices = [], extraQuery = '' } = {}) {
  const chosen = selectedServices.length ? selectedServices : ['topsoil', 'landscaping'];
  const q = [];
  for (const key of chosen) {
    const s = services[key]; if (!s) continue;
    const picks = mode === 'active' ? s.queries.slice(0, 1) : mode === 'potential' ? s.queries.slice(1, 2) : s.queries;
    for (const query of picks) q.push({ service: key, query: `${query} ${location}`.trim() });
  }
  if (extraQuery) q.unshift({ service: chosen[0] || 'topsoil', query: `${extraQuery} ${location}`.trim() });
  return q.slice(0, 8);
}
async function searchLangSearch(query) {
  if (!LANGSEARCH_API_KEY) throw new Error('LangSearch is not configured. Add LANGSEARCH_API_KEY to the server .env file and restart the server.');
  const response = await fetch('https://api.langsearch.com/v1/web-search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LANGSEARCH_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, count: 10, freshness: 'noLimit' }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`LangSearch returned HTTP ${response.status}`);
  const data = await response.json();
  if (String(data.code) !== '200') throw new Error(data.message || 'LangSearch returned an unsuccessful response.');
  const pages = data.data?.webPages?.value || [];
  return pages.map(r => ({ title: String(r.name || '').slice(0, 300), link: safeUrl(r.url), snippet: String(r.snippet || r.text || '').slice(0, 1200), date: String(r.datePublished || '').slice(0, 80), sourceName: (() => { try { return new URL(r.url).hostname.replace(/^www\./, '').slice(0, 200); } catch { return ''; } })() })).filter(r => r.link && r.title);
}
async function searchSerpApi(query) {
  if (!SERPAPI_KEY) throw new Error('SerpApi is not configured.');
  const u = new URL('https://serpapi.com/search.json'); u.searchParams.set('engine', 'google'); u.searchParams.set('q', query); u.searchParams.set('api_key', SERPAPI_KEY); u.searchParams.set('num', '10');
  const response = await fetch(u, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`SerpApi returned HTTP ${response.status}`);
  const data = await response.json(); if (data.error) throw new Error(data.error);
  return (data.organic_results || []).map(r => ({ title: String(r.title || '').slice(0, 300), link: safeUrl(r.link), snippet: String(r.snippet || '').slice(0, 1200), date: String(r.date || '').slice(0, 80), sourceName: String(r.source || '').slice(0, 200) })).filter(r => r.link && r.title);
}
async function searchWeb(query) {
  if (LANGSEARCH_API_KEY) return searchLangSearch(query);
  if (SERPAPI_KEY) return searchSerpApi(query);
  throw new Error('Live search is not configured. Add LANGSEARCH_API_KEY to the server .env file and restart the server. Get a free key from LangSearch.');
}

async function optionalAiAnalysis(lead) {
  if (!OPENAI_API_KEY) return lead;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [ { role: 'system', content: 'You classify public web results as sales leads for a Lagos-based supplier of topsoil, landscaping, haulage, procurement/logistics and site support. Do not infer explicit buying intent unless the provided evidence clearly states a request. Return JSON: {"intent":"Active Buyer|Project Opportunity|Potential Client|Unverified","reason":"short factual explanation","service":"short label","score":0-100}. Use only supplied evidence; never invent facts.' }, { role: 'user', content: JSON.stringify({ title: lead.sourceTitle, snippet: lead.need, service: lead.service, location: lead.location }) } ] }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) return lead;
    const data = await response.json(); const content = data.choices?.[0]?.message?.content; if (!content) return lead;
    const parsed = JSON.parse(content); const allowed = ['Active Buyer', 'Project Opportunity', 'Potential Client', 'Unverified'];
    if (allowed.includes(parsed.intent)) lead.intent = parsed.intent;
    if (typeof parsed.reason === 'string') lead.aiReason = parsed.reason.slice(0, 500);
    if (Number.isFinite(Number(parsed.score))) lead.score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    if (typeof parsed.service === 'string' && parsed.service.trim()) lead.service = parsed.service.slice(0, 100);
  } catch { /* deterministic classification remains available if AI is unavailable */ }
  lead.priority = lead.score >= 75 ? 'High' : lead.score >= 50 ? 'Medium' : 'Low';
  return lead;
}
async function runDiscovery(options = {}) {
  const location = String(options.location || 'Lagos, Nigeria').slice(0, 100);
  const mode = ['both', 'active', 'potential'].includes(options.mode) ? options.mode : 'both';
  const selectedServices = Array.isArray(options.services) ? options.services.filter(s => s in services) : ['topsoil', 'landscaping'];
  const queryList = queriesFor({ location, mode, selectedServices, extraQuery: String(options.extraQuery || '').slice(0, 180) });
  if (!LANGSEARCH_API_KEY && !SERPAPI_KEY) throw new Error('Live search is not configured. Add LANGSEARCH_API_KEY to the server .env file and restart the server. Get a free key from LangSearch.');
  const all = []; const failures = [];
  for (const item of queryList) {
    try { const results = await searchWeb(item.query); for (const r of results) { const c = classify(r, item.service, mode); if (!c) continue; all.push({ ...r, ...c, service: services[item.service].label, query: item.query }); } }
    catch (e) { failures.push({ query: item.query, error: e.message }); }
  }
  const existing = readLeads(); const existingKeys = new Set(existing.filter(x => !x.archived).flatMap(x => [x.sourceKey, normalize(x.name)].filter(Boolean)));
  const seen = new Set(); const added = []; let duplicates = 0;
  for (const r of all) {
    const key = canonicalLink(r.link); if (!key) { duplicates++; continue; }
    const domain = new URL(key).hostname.replace(/^www\./, '');
    const displayName = r.sourceName || domain; const nameKey = normalize(displayName);
    if (seen.has(key) || existingKeys.has(key) || (nameKey && seen.has(nameKey)) || (nameKey && existingKeys.has(nameKey))) { duplicates++; continue; }
    seen.add(key); if (nameKey) seen.add(nameKey);
    let lead = { id: crypto.randomUUID(), name: displayName, service: r.service, location, intent: r.intent, priority: r.priority, score: r.score, status: 'Verification pending', email: '', phone: '', followup: '', source: key, sourceKey: key, sourceTitle: r.title, need: r.snippet, notes: `Discovered via public web search. Query: ${r.query}${r.date ? `; source date: ${r.date}` : ''}`, sourceDate: r.date || '', discoveredAt: new Date().toISOString(), createdAt: new Date().toISOString(), archived: false };
    lead = await optionalAiAnalysis(lead);
    added.push(lead); existingKeys.add(key);
  }
  if (added.length) writeLeads([...added, ...existing]);
  lastRun = { at: new Date().toISOString(), queriesRun: queryList.length, results: all.length, newLeads: added.length, duplicates, failures };
  lastRunError = failures.length === queryList.length ? failures[0]?.error || 'All searches failed' : null;
  if (queryList.length && failures.length === queryList.length) throw new Error(`All ${queryList.length} search queries failed. ${lastRunError}`);
  return { ...lastRun, leads: added };
}
function authorized(req) { return !APP_TOKEN || req.headers['x-app-token'] === APP_TOKEN; }
function readBody(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', c => { data += c; if (data.length > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); } }); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON body')); } }); req.on('error', reject); }); }
function validateLead(input, prior = {}) {
  const x = { ...prior, ...input };
  x.name = String(x.name || '').trim().slice(0, 250); if (!x.name) throw new Error('Business / prospect name is required.');
  x.service = String(x.service || 'Multiple services').slice(0, 100); x.location = String(x.location || '').slice(0, 150);
  const intents = ['Active Buyer', 'Project Opportunity', 'Potential Client', 'Unverified']; if (!intents.includes(x.intent)) x.intent = 'Unverified';
  const statuses = ['New', 'Verification pending', 'Qualified', 'Contacted', 'Interested', 'Quotation requested', 'Quotation sent', 'Won', 'Lost', 'Not a fit']; if (!statuses.includes(x.status)) x.status = 'New';
  if (!['High', 'Medium', 'Low'].includes(x.priority)) x.priority = 'Medium'; x.score = Math.max(0, Math.min(100, Number(x.score) || 0));
  x.source = x.source ? safeUrl(x.source) : ''; if (input.source && !x.source) throw new Error('Source URL must use HTTPS.');
  x.email = String(x.email || '').slice(0, 250); x.phone = String(x.phone || '').slice(0, 80); x.followup = String(x.followup || '').slice(0, 20);
  x.need = String(x.need || '').slice(0, 3000); x.notes = String(x.notes || '').slice(0, 5000); x.archived = Boolean(x.archived);
  return x;
}
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const pathname = decodeURIComponent(url.pathname);
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, version: '2.0.0', searchConfigured: Boolean(LANGSEARCH_API_KEY || SERPAPI_KEY), searchProvider: LANGSEARCH_API_KEY ? 'LangSearch' : SERPAPI_KEY ? 'SerpApi (legacy)' : 'Not configured', langSearchConfigured: Boolean(LANGSEARCH_API_KEY), aiConfigured: Boolean(OPENAI_API_KEY), schedulerRunning: Boolean((LANGSEARCH_API_KEY || SERPAPI_KEY) && schedulerTimer), databaseReady: true, lastRun, lastRunError, intervalHours: Number(process.env.SEARCH_INTERVAL_HOURS || 6), authRequired: Boolean(APP_TOKEN) });
  if (pathname.startsWith('/api/') && !authorized(req)) return json(res, 401, { error: 'Access token required or incorrect. Enter the server APP_TOKEN in Settings.' });
  if (req.method === 'GET' && pathname === '/api/leads') return json(res, 200, { leads: readLeads().filter(l => !l.archived) });
  if (req.method === 'POST' && pathname === '/api/leads') {
    try { const body = await readBody(req); const now = new Date().toISOString(); const lead = validateLead(body); lead.id = crypto.randomUUID(); lead.createdAt = now; lead.updatedAt = now; lead.archived = false; const rows = readLeads(); rows.unshift(lead); writeLeads(rows); return json(res, 201, { lead }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  const leadMatch = pathname.match(/^\/api\/leads\/([a-f0-9-]+)$/i);
  if (leadMatch && req.method === 'PATCH') {
    try { const body = await readBody(req); const rows = readLeads(); const idx = rows.findIndex(l => l.id === leadMatch[1] && !l.archived); if (idx < 0) return json(res, 404, { error: 'Lead not found.' }); const lead = validateLead(body, rows[idx]); lead.id = rows[idx].id; lead.createdAt = rows[idx].createdAt; lead.updatedAt = new Date().toISOString(); rows[idx] = lead; writeLeads(rows); return json(res, 200, { lead }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (leadMatch && req.method === 'DELETE') { const rows = readLeads(); const idx = rows.findIndex(l => l.id === leadMatch[1] && !l.archived); if (idx < 0) return json(res, 404, { error: 'Lead not found.' }); rows[idx].archived = true; rows[idx].updatedAt = new Date().toISOString(); writeLeads(rows); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && pathname === '/api/discover') { try { const body = await readBody(req); return json(res, 200, await runDiscovery(body)); } catch (e) { lastRunError = e.message; return json(res, 503, { error: e.message }); } }
  if (req.method === 'GET' && pathname === '/api/run-status') return json(res, 200, { lastRun, lastRunError });
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) { const b = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" }); return res.end(b); }
  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'API route not found.' });
  return json(res, 404, { error: 'Not found.' });
}
const server = http.createServer((req, res) => { handler(req, res).catch(e => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Internal server error.' }); else res.end(); }); });
function startScheduler() { if (!LANGSEARCH_API_KEY && !SERPAPI_KEY) { console.log('Scheduler idle: configure LANGSEARCH_API_KEY in .env to enable scheduled live discovery.'); return; } schedulerTimer = setInterval(async () => { try { console.log('Scheduled discovery started'); const result = await runDiscovery({ location: process.env.DEFAULT_LOCATION || 'Lagos, Nigeria', mode: 'both', services: ['topsoil', 'landscaping', 'haulage', 'procurement', 'site support'] }); console.log(`Scheduled discovery complete: ${result.newLeads} new leads`); } catch (e) { lastRunError = e.message; console.error('Scheduled discovery failed:', e.message); } }, SEARCH_INTERVAL_MS); schedulerTimer.unref(); console.log(`Scheduled discovery enabled: every ${Number(process.env.SEARCH_INTERVAL_HOURS || 6)} hours. First run occurs on the next interval or when manually triggered.`); }
if (require.main === module) { ensureDb(); server.listen(PORT, HOST, () => { console.log(`Transglobe AI Buyer Finder V2 running at http://${HOST}:${PORT}`); startScheduler(); }); }
module.exports = { server, classify, queriesFor, validateLead, canonicalLink, runDiscovery, readLeads, writeLeads, searchLangSearch };
