const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Normal CDF for Black-Scholes Greeks
function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422820 * Math.exp(-x * x / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
    return x > 0 ? 1 - p : p;
}

function normPdf(x) {
    return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

function blackScholes(S, K, T, r, sigma, type) {
    if (T <= 0 || sigma <= 0) return { price: Math.max(0, type === 'call' ? S - K : K - S), delta: type === 'call' ? 1 : -1, gamma: 0, theta: 0, vega: 0, iv: sigma };
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    const phi = normPdf(d1);
    let price, delta;
    if (type === 'call') {
        price = S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
        delta = normCdf(d1);
    } else {
        price = K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
        delta = normCdf(d1) - 1;
    }
    const gamma = phi / (S * sigma * Math.sqrt(T));
    const theta = (-(S * phi * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCdf(type === 'call' ? d2 : -d2)) / 365;
    const vega = S * phi * Math.sqrt(T) / 100;
    return { price: Math.max(0, price), delta: parseFloat(delta.toFixed(4)), gamma: parseFloat(gamma.toFixed(5)), theta: parseFloat(theta.toFixed(4)), vega: parseFloat(vega.toFixed(4)), iv: sigma };
}

class WebullService {
    constructor() {
        this.apiKey = process.env.WEBULL_API_KEY;
        this.secretKey = process.env.WEBULL_SECRET_KEY;
        this.apiUrl = `https://${process.env.WEBULL_API_URL || 'quotes-gw.webull.com'}`;
        this.quotesUrl = 'https://quotes-gw.webull.com/api';
        this._loadCredentials();
        this._tickerCache = {};
        this._quoteCache = {};
        this._cacheTTL = 10000; // 10s for quotes
    }

    _loadCredentials() {
        try {
            const tokenPath = path.join(__dirname, '../conf/token.txt');
            const lines = fs.readFileSync(tokenPath, 'utf8').trim().split('\n');
            this.did = (lines[0] || '').trim();
            this.userId = (lines[1] || '').trim();
            this.accountType = (lines[2] || 'NORMAL').trim();
        } catch {
            this.did = 'd12fcc94521540dd906c94bee3209507';
            this.userId = '1780393541256';
            this.accountType = 'NORMAL';
        }
    }

    _sign(timestamp) {
        return crypto
            .createHmac('sha256', this.secretKey || '')
            .update(this.apiKey + timestamp)
            .digest('base64');
    }

    _authHeaders() {
        const timestamp = Date.now().toString();
        return {
            'api-key': this.apiKey,
            'timestamp': timestamp,
            'sign': this._sign(timestamp),
            'did': this.did,
            'hl': 'en',
            'os': 'web',
            'platform': 'web',
            'ver': '3.40.11',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://app.webull.com/',
            'Origin': 'https://app.webull.com'
        };
    }

    async getTickerId(symbol) {
        const sym = symbol.toUpperCase();
        if (this._tickerCache[sym]) return this._tickerCache[sym];
        try {
            const res = await axios.get(`${this.quotesUrl}/search/pc/tickers`, {
                params: { keyword: sym, pageIndex: 1, pageSize: 20 },
                headers: this._authHeaders(),
                timeout: 5000
            });
            const tickers = res.data?.data || [];
            const match = tickers.find(t => t.ticker?.symbol === sym && t.ticker?.listStatus === 1);
            const id = match?.ticker?.tickerId || null;
            if (id) this._tickerCache[sym] = id;
            return id;
        } catch {
            return null;
        }
    }

    async getQuote(symbol) {
        const sym = symbol.toUpperCase();
        const cached = this._quoteCache[sym];
        if (cached && Date.now() - cached.ts < this._cacheTTL) return cached.data;

        const basePrices = { IWM: 218.45, SPY: 528.37, QQQ: 452.91, AAPL: 189.52, TSLA: 174.83, NVDA: 875.43, AMZN: 185.67, MSFT: 415.22 };
        const basePrice = basePrices[sym] || 150 + Math.random() * 200;

        try {
            const tickerId = await this.getTickerId(sym);
            if (!tickerId) throw new Error('No ticker ID');

            const res = await axios.get(`${this.quotesUrl}/quote/tickerRealTimes/v5/${tickerId}`, {
                headers: this._authHeaders(),
                timeout: 5000
            });
            const d = res.data;
            const price = parseFloat(d?.close || d?.lastPrice || d?.preClose || basePrice);
            const result = {
                symbol: sym,
                price,
                change: parseFloat(d?.change || 0),
                changeRatio: parseFloat(d?.changeRatio || 0),
                open: parseFloat(d?.open || price),
                high: parseFloat(d?.high || price * 1.01),
                low: parseFloat(d?.low || price * 0.99),
                volume: parseInt(d?.volume || 0),
                source: 'live'
            };
            this._quoteCache[sym] = { data: result, ts: Date.now() };
            return result;
        } catch {
            const change = (Math.random() - 0.48) * 4;
            const result = {
                symbol: sym,
                price: parseFloat((basePrice + change).toFixed(2)),
                change: parseFloat(change.toFixed(2)),
                changeRatio: parseFloat((change / basePrice).toFixed(5)),
                open: parseFloat((basePrice - 0.5).toFixed(2)),
                high: parseFloat((basePrice + 2.1).toFixed(2)),
                low: parseFloat((basePrice - 1.8).toFixed(2)),
                volume: Math.floor(25000000 + Math.random() * 15000000),
                source: 'mock'
            };
            this._quoteCache[sym] = { data: result, ts: Date.now() };
            return result;
        }
    }

    async getOptionExpiryDates(symbol) {
        try {
            const tickerId = await this.getTickerId(symbol.toUpperCase());
            if (!tickerId) throw new Error('No ticker ID');
            const res = await axios.get(`${this.quotesUrl}/quote/option/expireDateList/${tickerId}`, {
                headers: this._authHeaders(),
                timeout: 5000
            });
            const dates = res.data || [];
            if (dates.length > 0) return { tickerId, dates, source: 'live' };
            throw new Error('Empty dates');
        } catch {
            return { tickerId: null, dates: this._mockExpiryDates(), source: 'mock' };
        }
    }

    _mockExpiryDates() {
        const dates = [];
        const now = new Date();
        const fridays = [];
        const d = new Date(now);
        d.setDate(d.getDate() + (5 - d.getDay() + 7) % 7 || 7);
        for (let i = 0; i < 12; i++) {
            fridays.push(d.toISOString().split('T')[0]);
            d.setDate(d.getDate() + 7);
        }
        // Add monthly expirations (3rd Friday)
        for (let m = 0; m < 6; m++) {
            const md = new Date(now.getFullYear(), now.getMonth() + m + 1, 1);
            md.setDate(md.getDate() + (5 - md.getDay() + 7) % 7 + 14);
            const ds = md.toISOString().split('T')[0];
            if (!fridays.includes(ds)) fridays.push(ds);
        }
        return fridays.sort();
    }

    async getOptionChain(symbol, expireDate = null) {
        const sym = symbol.toUpperCase();
        const quote = await this.getQuote(sym);
        const S = quote.price;
        const { tickerId, dates, source } = await this.getOptionExpiryDates(sym);
        const selectedExpiry = expireDate || dates[2] || dates[0];

        if (tickerId && source === 'live') {
            try {
                const res = await axios.get(`${this.quotesUrl}/quote/option/chain/query/${tickerId}`, {
                    params: { count: 200, direction: 'all', expireDate: selectedExpiry },
                    headers: this._authHeaders(),
                    timeout: 8000
                });
                const raw = res.data?.data || res.data || [];
                if (raw.length > 0) {
                    return this._normalizeChain(raw, sym, S, selectedExpiry, dates, 'live');
                }
            } catch { /* fall through to mock */ }
        }

        return this._generateMockChain(sym, S, selectedExpiry, dates);
    }

    _normalizeChain(raw, symbol, underlyingPrice, expiry, expiryDates, source) {
        const rows = raw.map(row => ({
            strike: parseFloat(row.strikePrice || row.call?.strikePrice || 0),
            call: this._normalizeContract(row.call, 'call'),
            put: this._normalizeContract(row.put, 'put')
        })).filter(r => r.strike > 0).sort((a, b) => a.strike - b.strike);

        const ivList = rows.flatMap(r => [r.call?.iv, r.put?.iv]).filter(Boolean);
        const atmIv = ivList.length ? ivList.reduce((a, b) => a + b, 0) / ivList.length : 0.18;

        return { symbol, underlyingPrice, expiry, expiryDates, rows, atmIv: parseFloat(atmIv.toFixed(4)), source };
    }

    _normalizeContract(c, type) {
        if (!c) return null;
        return {
            bid: parseFloat(c.bid || 0),
            ask: parseFloat(c.ask || 0),
            last: parseFloat(c.close || c.lastPrice || 0),
            iv: parseFloat(c.iv || c.impliedVolatility || 0),
            delta: parseFloat(c.delta || 0),
            gamma: parseFloat(c.gamma || 0),
            theta: parseFloat(c.theta || 0),
            vega: parseFloat(c.vega || 0),
            volume: parseInt(c.volume || c.latestPriceVol || 0),
            oi: parseInt(c.openInterest || 0)
        };
    }

    _generateMockChain(symbol, S, expiry, expiryDates) {
        const now = new Date();
        const exp = new Date(expiry);
        const T = Math.max((exp - now) / (365 * 24 * 3600 * 1000), 0.003);
        const r = 0.053;
        const baseIv = { IWM: 0.175, SPY: 0.145, QQQ: 0.195, AAPL: 0.265, TSLA: 0.585, NVDA: 0.485, AMZN: 0.305, MSFT: 0.225 }[symbol] || 0.25;

        const strikeStep = S < 50 ? 1 : S < 150 ? 2.5 : S < 300 ? 5 : 10;
        const atmStrike = Math.round(S / strikeStep) * strikeStep;
        const strikes = [];
        for (let i = -20; i <= 20; i++) {
            strikes.push(parseFloat((atmStrike + i * strikeStep).toFixed(2)));
        }

        const rows = strikes.map(K => {
            const moneyness = Math.log(S / K);
            const ivSkew = baseIv * (1 + 0.15 * Math.abs(moneyness) - 0.1 * moneyness);
            const callGs = blackScholes(S, K, T, r, ivSkew, 'call');
            const putGs = blackScholes(S, K, T, r, ivSkew * 1.02, 'put');
            const callSpread = Math.max(0.01, callGs.price * 0.03 + 0.05);
            const putSpread = Math.max(0.01, putGs.price * 0.03 + 0.05);

            return {
                strike: K,
                call: {
                    bid: parseFloat(Math.max(0.01, callGs.price - callSpread / 2).toFixed(2)),
                    ask: parseFloat((callGs.price + callSpread / 2).toFixed(2)),
                    last: parseFloat(callGs.price.toFixed(2)),
                    iv: parseFloat(ivSkew.toFixed(4)),
                    delta: callGs.delta,
                    gamma: callGs.gamma,
                    theta: callGs.theta,
                    vega: callGs.vega,
                    volume: Math.floor(Math.random() * 2000 + 100) * Math.max(1, Math.round(1 / (1 + 2 * Math.abs(moneyness)))),
                    oi: Math.floor(Math.random() * 8000 + 500)
                },
                put: {
                    bid: parseFloat(Math.max(0.01, putGs.price - putSpread / 2).toFixed(2)),
                    ask: parseFloat((putGs.price + putSpread / 2).toFixed(2)),
                    last: parseFloat(putGs.price.toFixed(2)),
                    iv: parseFloat((ivSkew * 1.02).toFixed(4)),
                    delta: putGs.delta,
                    gamma: putGs.gamma,
                    theta: putGs.theta,
                    vega: putGs.vega,
                    volume: Math.floor(Math.random() * 2500 + 150) * Math.max(1, Math.round(1 / (1 + 2 * Math.abs(moneyness)))),
                    oi: Math.floor(Math.random() * 10000 + 800)
                }
            };
        });

        const atmIv = baseIv;
        return { symbol, underlyingPrice: S, expiry, expiryDates, rows, atmIv, source: 'mock' };
    }

    async getPositions() {
        try {
            const posPath = path.join(__dirname, '../data/positions.json');
            const data = JSON.parse(fs.readFileSync(posPath, 'utf8'));
            return data;
        } catch {
            return { positions: [], history: [] };
        }
    }

    async savePositions(data) {
        const posPath = path.join(__dirname, '../data/positions.json');
        fs.writeFileSync(posPath, JSON.stringify(data, null, 2));
    }

    // IV Rank mock: compares current IV to 52-week range
    getIvRank(symbol) {
        const ranks = { IWM: 42, SPY: 38, QQQ: 51, AAPL: 29, TSLA: 72, NVDA: 65, AMZN: 44, MSFT: 35 };
        return ranks[symbol.toUpperCase()] || Math.floor(Math.random() * 60 + 20);
    }
}

module.exports = new WebullService();
