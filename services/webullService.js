const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Black-Scholes (for options chain fallback only) ───────────────────────
function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422820 * Math.exp(-x * x / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
    return x > 0 ? 1 - p : p;
}
function normPdf(x) { return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI); }
function blackScholes(S, K, T, r, sigma, type) {
    if (T <= 0 || sigma <= 0) return { price: Math.max(0, type === 'call' ? S - K : K - S), delta: type === 'call' ? 1 : -1, gamma: 0, theta: 0, vega: 0 };
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    const phi = normPdf(d1);
    let price, delta;
    if (type === 'call') { price = S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2); delta = normCdf(d1); }
    else { price = K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1); delta = normCdf(d1) - 1; }
    return {
        price: Math.max(0, price),
        delta: parseFloat(delta.toFixed(4)),
        gamma: parseFloat((phi / (S * sigma * Math.sqrt(T))).toFixed(5)),
        theta: parseFloat(((-(S * phi * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCdf(type === 'call' ? d2 : -d2)) / 365).toFixed(4)),
        vega: parseFloat((S * phi * Math.sqrt(T) / 100).toFixed(4))
    };
}

class WebullService {
    constructor() {
        this.BASE = 'https://api.webull.com';
        this.appKey = process.env.WEBULL_API_KEY;
        this.appSecret = process.env.WEBULL_SECRET_KEY;
        this._quoteCache = {};
        this._cacheTTL = 15000;
        this._loadCredentials();
    }

    _loadCredentials() {
        // Env vars take priority (production); fall back to local token.txt (dev)
        if (process.env.WEBULL_DID && process.env.WEBULL_ACCESS_TOKEN) {
            this.did = process.env.WEBULL_DID;
            this.userId = process.env.WEBULL_USER_ID || '';
            this.accessToken = process.env.WEBULL_ACCESS_TOKEN;
            this.accountId = 'P6HOL7BRA6U2AVL0F680BATI48';
            return;
        }
        try {
            const lines = fs.readFileSync(path.join(__dirname, '../conf/token.txt'), 'utf8').trim().split('\n').map(l => l.trim());
            this.did = lines[0] || '';
            this.userId = lines[1] || '';
            this.accessToken = lines[3] || '';
            this.accountId = 'P6HOL7BRA6U2AVL0F680BATI48';
        } catch {
            this.did = ''; this.userId = ''; this.accessToken = ''; this.accountId = '';
        }
    }

    _sign(path, queryParams, headers, body) {
        const sigParams = {
            'host': 'api.webull.com',
            'x-app-key': headers['x-app-key'],
            'x-signature-algorithm': headers['x-signature-algorithm'],
            'x-signature-nonce': headers['x-signature-nonce'],
            'x-signature-version': headers['x-signature-version'],
            'x-timestamp': headers['x-timestamp'],
            ...queryParams
        };
        const str1 = Object.keys(sigParams).sort().map(k => `${k}=${sigParams[k]}`).join('&');
        let str3 = `${path}&${str1}`;
        if (body && Object.keys(body).length > 0) {
            str3 += '&' + crypto.createHash('md5').update(JSON.stringify(body)).digest('hex').toUpperCase();
        }
        return crypto.createHmac('sha1', this.appSecret + '&').update(encodeURIComponent(str3)).digest('base64');
    }

    _headers(apiPath, query = {}, body = null) {
        const ts = new Date().toISOString().split('.')[0] + 'Z';
        const nonce = crypto.randomBytes(16).toString('hex');
        const h = {
            'x-app-key': this.appKey,
            'x-timestamp': ts,
            'x-signature-algorithm': 'HMAC-SHA1',
            'x-signature-version': '1.0',
            'x-signature-nonce': nonce,
            'x-version': 'v2',
            'x-access-token': this.accessToken,
            'Content-Type': 'application/json'
        };
        h['x-signature'] = this._sign(apiPath, query, h, body);
        return h;
    }

    async _get(apiPath, query = {}) {
        const res = await axios.get(this.BASE + apiPath, {
            params: query,
            headers: this._headers(apiPath, query),
            timeout: 10000
        });
        return res.data;
    }

    async _post(apiPath, body = {}) {
        const res = await axios.post(this.BASE + apiPath, body, {
            headers: this._headers(apiPath, {}, body),
            timeout: 10000
        });
        return res.data;
    }

    // ─── Quote (Yahoo Finance — fast & reliable for market data) ────────────
    async getQuote(symbol) {
        const sym = symbol.toUpperCase();
        const cached = this._quoteCache[sym];
        if (cached && Date.now() - cached.ts < this._cacheTTL) return cached.data;
        try {
            const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}`, {
                params: { interval: '1d', range: '1d' },
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: 6000
            });
            const m = res.data?.chart?.result?.[0]?.meta;
            if (!m?.regularMarketPrice) throw new Error('No data');
            const price = parseFloat(m.regularMarketPrice);
            const prev = parseFloat(m.chartPreviousClose || price);
            const change = parseFloat((price - prev).toFixed(2));
            const result = {
                symbol: sym, price, change,
                changeRatio: parseFloat((change / prev).toFixed(5)),
                open: parseFloat(m.regularMarketOpen || price),
                high: parseFloat(m.regularMarketDayHigh || price),
                low: parseFloat(m.regularMarketDayLow || price),
                volume: parseInt(m.regularMarketVolume || 0),
                source: 'yahoo'
            };
            this._quoteCache[sym] = { data: result, ts: Date.now() };
            return result;
        } catch {
            const fallback = { IWM: 273.00, SPY: 587.50, QQQ: 478.20, AAPL: 211.45, TSLA: 342.80, NVDA: 1085.60, AMZN: 224.30, MSFT: 448.70 };
            const base = fallback[sym] || 150;
            const change = parseFloat(((Math.random() - 0.48) * base * 0.01).toFixed(2));
            const result = { symbol: sym, price: parseFloat((base + change).toFixed(2)), change, changeRatio: parseFloat((change / base).toFixed(5)), open: base, high: parseFloat((base * 1.005).toFixed(2)), low: parseFloat((base * 0.995).toFixed(2)), volume: 0, source: 'fallback' };
            this._quoteCache[sym] = { data: result, ts: Date.now() };
            return result;
        }
    }

    // ─── Expiry dates (Webull securitiesapi — works with DID) ────────────────
    async getOptionExpiryDates(symbol) {
        const tickerIds = { IWM: 913354523, SPY: 913243251, QQQ: 913323997, AAPL: 913254235, TSLA: 913255598, NVDA: 913323846, AMZN: 913245571, MSFT: 913315119 };
        const tickerId = tickerIds[symbol.toUpperCase()];
        if (tickerId) {
            try {
                const res = await axios.get(`https://securitiesapi.webull.com/api/quote/option/expireDateList/${tickerId}`, {
                    headers: { 'did': this.did, 'hl': 'en', 'os': 'web', 'platform': 'web', 'ver': '3.40.11', 'User-Agent': 'Mozilla/5.0' },
                    timeout: 6000
                });
                if (res.data?.length > 0) return { tickerId, dates: res.data, source: 'webull' };
            } catch { /* fall through */ }
        }
        return { tickerId: tickerId || null, dates: this._mockExpiryDates(), source: 'mock' };
    }

    _mockExpiryDates() {
        const now = new Date();
        const d = new Date(now);
        d.setDate(d.getDate() + (5 - d.getDay() + 7) % 7 || 7);
        const dates = [];
        for (let i = 0; i < 12; i++) { dates.push(d.toISOString().split('T')[0]); d.setDate(d.getDate() + 7); }
        for (let m = 0; m < 6; m++) {
            const md = new Date(now.getFullYear(), now.getMonth() + m + 1, 1);
            md.setDate(md.getDate() + (5 - md.getDay() + 7) % 7 + 14);
            const ds = md.toISOString().split('T')[0];
            if (!dates.includes(ds)) dates.push(ds);
        }
        return dates.sort();
    }

    // ─── Options chain ────────────────────────────────────────────────────────
    async getOptionChain(symbol, expireDate = null) {
        const sym = symbol.toUpperCase();
        const [quote, { tickerId, dates }] = await Promise.all([this.getQuote(sym), this.getOptionExpiryDates(sym)]);
        const S = quote.price;
        const selectedExpiry = expireDate || dates[2] || dates[0];

        if (tickerId) {
            try {
                const res = await axios.get(`https://securitiesapi.webull.com/api/quote/option/chain/query/${tickerId}`, {
                    params: { count: 200, direction: 'all', expireDate: selectedExpiry },
                    headers: { 'did': this.did, 'hl': 'en', 'os': 'web', 'platform': 'web', 'ver': '3.40.11', 'User-Agent': 'Mozilla/5.0' },
                    timeout: 8000
                });
                const raw = res.data?.data || res.data || [];
                if (Array.isArray(raw) && raw.length > 0) {
                    return this._normalizeChain(raw, sym, S, selectedExpiry, dates, 'webull');
                }
            } catch { /* fall through */ }
        }

        return this._generateMockChain(sym, S, selectedExpiry, dates);
    }

    _normalizeChain(raw, symbol, underlyingPrice, expiry, expiryDates, source) {
        const rows = raw.map(row => ({
            strike: parseFloat(row.strikePrice || row.call?.strikePrice || 0),
            call: this._normalizeContract(row.call),
            put: this._normalizeContract(row.put)
        })).filter(r => r.strike > 0).sort((a, b) => a.strike - b.strike);

        const ivList = rows.flatMap(r => [r.call?.iv, r.put?.iv]).filter(Boolean);
        const atmIv = ivList.length ? ivList.reduce((a, b) => a + b, 0) / ivList.length : 0.18;

        const S = underlyingPrice;
        const T = Math.max((new Date(expiry) - new Date()) / (365 * 24 * 3600 * 1000), 0.003);

        // Back-fill BS values for any real contract missing bid/ask/greeks (e.g. after hours)
        for (const row of rows) {
            const K = row.strike;
            const mono = Math.log(S / K);
            for (const [side, type] of [[row.call, 'call'], [row.put, 'put']]) {
                if (!side) continue;
                const iv = side.iv || atmIv * (1 + 0.15 * Math.abs(mono) - 0.1 * mono);
                if (side.bid == null || side.ask == null || side.delta == null) {
                    const bs = blackScholes(S, K, T, 0.053, iv, type);
                    const spread = Math.max(0.01, bs.price * 0.03 + 0.05);
                    if (side.bid == null)   side.bid   = parseFloat(Math.max(0.01, bs.price - spread/2).toFixed(2));
                    if (side.ask == null)   side.ask   = parseFloat((bs.price + spread/2).toFixed(2));
                    if (side.last == null)  side.last  = parseFloat(bs.price.toFixed(2));
                    if (side.delta == null) side.delta = bs.delta;
                    if (side.gamma == null) side.gamma = bs.gamma;
                    if (side.theta == null) side.theta = bs.theta;
                    if (side.vega == null)  side.vega  = bs.vega;
                }
            }
        }

        // Fill in $1-increment strikes for ATM ±$10 range using Black-Scholes
        const existingStrikes = new Set(rows.map(r => r.strike));
        const atmLo = Math.floor(S) - 10;
        const atmHi = Math.ceil(S) + 10;
        for (let K = atmLo; K <= atmHi; K++) {
            const Kf = parseFloat(K.toFixed(2));
            if (existingStrikes.has(Kf)) continue;
            const mono = Math.log(S / Kf);
            const iv = atmIv * (1 + 0.15 * Math.abs(mono) - 0.1 * mono);
            const cg = blackScholes(S, Kf, T, 0.053, iv, 'call');
            const pg = blackScholes(S, Kf, T, 0.053, iv * 1.02, 'put');
            const cs = Math.max(0.01, cg.price * 0.03 + 0.05);
            const ps = Math.max(0.01, pg.price * 0.03 + 0.05);
            rows.push({
                strike: Kf,
                call: { bid: parseFloat(Math.max(0.01, cg.price - cs/2).toFixed(2)), ask: parseFloat((cg.price + cs/2).toFixed(2)), last: parseFloat(cg.price.toFixed(2)), iv: parseFloat(iv.toFixed(4)), delta: cg.delta, gamma: cg.gamma, theta: cg.theta, vega: cg.vega, volume: 0, oi: 0 },
                put:  { bid: parseFloat(Math.max(0.01, pg.price - ps/2).toFixed(2)), ask: parseFloat((pg.price + ps/2).toFixed(2)), last: parseFloat(pg.price.toFixed(2)), iv: parseFloat((iv*1.02).toFixed(4)), delta: pg.delta, gamma: pg.gamma, theta: pg.theta, vega: pg.vega, volume: 0, oi: 0 }
            });
            existingStrikes.add(Kf);
        }
        rows.sort((a, b) => a.strike - b.strike);

        return { symbol, underlyingPrice, expiry, expiryDates, rows, atmIv: parseFloat(atmIv.toFixed(4)), source };
    }

    _normalizeContract(c) {
        if (!c) return null;
        return {
            bid: c.bid != null && c.bid !== '' ? parseFloat(c.bid) : null,
            ask: c.ask != null && c.ask !== '' ? parseFloat(c.ask) : null,
            last: c.close != null && c.close !== '' ? parseFloat(c.close) : (c.lastPrice != null ? parseFloat(c.lastPrice) : null),
            iv: parseFloat(c.iv || c.impliedVolatility || 0),
            delta: c.delta != null && c.delta !== '' ? parseFloat(c.delta) : null,
            gamma: c.gamma != null && c.gamma !== '' ? parseFloat(c.gamma) : null,
            theta: c.theta != null && c.theta !== '' ? parseFloat(c.theta) : null,
            vega: c.vega != null && c.vega !== '' ? parseFloat(c.vega) : null,
            volume: parseInt(c.volume || c.latestPriceVol || 0),
            oi: parseInt(c.openInterest || 0)
        };
    }

    _generateMockChain(symbol, S, expiry, expiryDates) {
        const T = Math.max((new Date(expiry) - new Date()) / (365 * 24 * 3600 * 1000), 0.003);
        const baseIv = { IWM: 0.175, SPY: 0.145, QQQ: 0.195, AAPL: 0.265, TSLA: 0.585, NVDA: 0.485, AMZN: 0.305, MSFT: 0.225 }[symbol] || 0.25;
        const outerStep = S < 50 ? 1 : S < 150 ? 2.5 : S < 300 ? 5 : 10;
        const atmLo = Math.floor(S) - 10;
        const atmHi = Math.ceil(S) + 10;

        // Build strike list: $1 increments for ATM±$10, outer step beyond that
        const strikes = new Set();
        for (let K = atmLo; K <= atmHi; K++) strikes.add(parseFloat(K.toFixed(2)));
        const outerAtm = Math.round(S / outerStep) * outerStep;
        for (let i = -30; i <= 30; i++) {
            const K = parseFloat((outerAtm + i * outerStep).toFixed(2));
            if (K > 0) strikes.add(K);
        }

        const rows = [...strikes].sort((a, b) => a - b).map(K => {
            const mono = Math.log(S / K);
            const iv = baseIv * (1 + 0.15 * Math.abs(mono) - 0.1 * mono);
            const cg = blackScholes(S, K, T, 0.053, iv, 'call');
            const pg = blackScholes(S, K, T, 0.053, iv * 1.02, 'put');
            const cs = Math.max(0.01, cg.price * 0.03 + 0.05);
            const ps = Math.max(0.01, pg.price * 0.03 + 0.05);
            return {
                strike: K,
                call: { bid: parseFloat(Math.max(0.01, cg.price - cs/2).toFixed(2)), ask: parseFloat((cg.price + cs/2).toFixed(2)), last: parseFloat(cg.price.toFixed(2)), iv: parseFloat(iv.toFixed(4)), delta: cg.delta, gamma: cg.gamma, theta: cg.theta, vega: cg.vega, volume: Math.floor(Math.random() * 2000 + 100), oi: Math.floor(Math.random() * 8000 + 500) },
                put:  { bid: parseFloat(Math.max(0.01, pg.price - ps/2).toFixed(2)), ask: parseFloat((pg.price + ps/2).toFixed(2)), last: parseFloat(pg.price.toFixed(2)), iv: parseFloat((iv*1.02).toFixed(4)), delta: pg.delta, gamma: pg.gamma, theta: pg.theta, vega: pg.vega, volume: Math.floor(Math.random() * 2500 + 150), oi: Math.floor(Math.random() * 10000 + 800) }
            };
        });
        return { symbol, underlyingPrice: S, expiry, expiryDates, rows, atmIv: baseIv, source: 'mock' };
    }

    // ─── Live account data from Webull OpenAPI ────────────────────────────────
    async getAccountBalance() {
        try {
            const data = await this._get('/openapi/assets/balance', { account_id: this.accountId });
            return { ...data, source: 'webull' };
        } catch (e) {
            console.error('[Webull] Balance failed:', e.response?.data || e.message);
            return null;
        }
    }

    async getAccountPositions() {
        try {
            const data = await this._get('/openapi/assets/positions', { account_id: this.accountId });
            return { positions: Array.isArray(data) ? data : [], source: 'webull' };
        } catch (e) {
            console.error('[Webull] Positions failed:', e.response?.data || e.message);
            return { positions: [], source: 'error' };
        }
    }

    async getTradeHistory({ pageSize = 100 } = {}) {
        try {
            const data = await this._get('/openapi/trade/order/history', {
                account_id: this.accountId,
                page_size: pageSize
            });
            // Response: array of combo orders, each with an `orders[]` array of sub-orders
            const combos = Array.isArray(data) ? data : [];
            console.log(`[Webull] Trade history: ${combos.length} combo orders`);
            return { combos, source: 'webull' };
        } catch (e) {
            console.error('[Webull] Trade history failed:', e.response?.data || e.message);
            return { combos: [], source: 'error', error: e.message };
        }
    }

    // Return the full raw trade history data — for inspection
    async probeTradeEndpoints() {
        try {
            const data = await this._get('/openapi/trade/order/history', {
                account_id: this.accountId,
                page_size: 50
            });
            return { ok: true, raw: data };
        } catch (e) {
            return { ok: false, error: e.response?.data || e.message };
        }
    }

    // Probe Webull endpoints for cash transactions / deposits / transfers
    async probeCashEndpoints() {
        const candidates = [
            '/openapi/assets/cash/history',
            '/openapi/assets/cash',
            '/openapi/assets/transactions',
            '/openapi/assets/transaction/history',
            '/openapi/account/cash/history',
            '/openapi/account/transactions',
            '/openapi/account/transfer/history',
            '/openapi/account/funding/history',
            '/openapi/account/funds/history',
            '/openapi/cash/transaction',
            '/openapi/cash/history',
            '/openapi/transfer/history',
            '/openapi/funding/history',
            '/openapi/trade/cash/history',
            '/openapi/assets/balance/history',
            '/openapi/assets/deposit/history',
            '/openapi/account/deposit/history',
        ];
        const results = {};
        for (const path of candidates) {
            try {
                const data = await this._get(path, { account_id: this.accountId, page_size: 10 });
                results[path] = {
                    ok: true,
                    sample: JSON.stringify(data).slice(0, 500),
                    type: Array.isArray(data) ? `array(${data.length})` : typeof data
                };
            } catch (e) {
                const status = e.response?.status;
                const errMsg = e.response?.data?.error_msg || e.response?.data?.message || e.message;
                results[path] = { ok: false, status, error: errMsg };
            }
        }
        return results;
    }

    // ─── Local position file (manual trades) ─────────────────────────────────
    async getLocalPositions() {
        try {
            return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/positions.json'), 'utf8'));
        } catch { return { positions: [], history: [] }; }
    }

    async saveLocalPositions(data) {
        fs.writeFileSync(path.join(__dirname, '../data/positions.json'), JSON.stringify(data, null, 2));
    }

    getIvRank(symbol) {
        const ranks = { IWM: 42, SPY: 38, QQQ: 51, AAPL: 29, TSLA: 72, NVDA: 65, AMZN: 44, MSFT: 35 };
        return ranks[symbol.toUpperCase()] || Math.floor(Math.random() * 60 + 20);
    }
}

module.exports = new WebullService();
