const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');

// Active SSE clients for price streaming
const sseClients = new Map();
let streamInterval = null;

function startPriceStream() {
    if (streamInterval) return;
    streamInterval = setInterval(async () => {
        if (sseClients.size === 0) return;
        const symbols = new Set();
        sseClients.forEach(({ watchList }) => watchList.forEach(s => symbols.add(s)));

        for (const sym of symbols) {
            try {
                const quote = await webull.getQuote(sym);
                const payload = JSON.stringify({ type: 'quote', ...quote, ts: Date.now() });
                sseClients.forEach((client) => {
                    if (client.watchList.has(sym)) {
                        client.res.write(`data: ${payload}\n\n`);
                    }
                });
            } catch { /* silent */ }
        }
    }, 5000);
}

// GET /api/options/quote/:symbol
router.get('/quote/:symbol', async (req, res) => {
    try {
        const quote = await webull.getQuote(req.params.symbol.toUpperCase());
        res.json({ ok: true, data: quote });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/options/expiries/:symbol
router.get('/expiries/:symbol', async (req, res) => {
    try {
        const result = await webull.getOptionExpiryDates(req.params.symbol.toUpperCase());
        res.json({ ok: true, data: result });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/options/chain/:symbol?expiry=2026-06-20
router.get('/chain/:symbol', async (req, res) => {
    const { symbol } = req.params;
    const { expiry } = req.query;
    try {
        const chain = await webull.getOptionChain(symbol.toUpperCase(), expiry || null);
        res.json({ ok: true, data: chain });
    } catch (err) {
        console.error('[Options Chain Error]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/options/stream?symbols=IWM,SPY
router.get('/stream', (req, res) => {
    const symbols = (req.query.symbols || 'IWM').toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
    const clientId = `${Date.now()}_${Math.random()}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'connected', clientId, symbols })}\n\n`);

    sseClients.set(clientId, { res, watchList: new Set(symbols) });
    startPriceStream();

    req.on('close', () => {
        sseClients.delete(clientId);
        if (sseClients.size === 0 && streamInterval) {
            clearInterval(streamInterval);
            streamInterval = null;
        }
    });
});

module.exports = router;
