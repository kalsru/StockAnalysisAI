const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');

// POST /api/screener
// Body: { symbols, minIv, maxIv, minDelta, maxDelta, minOi, minVolume, type, dteMin, dteMax }
router.post('/', async (req, res) => {
    const {
        symbols = ['IWM', 'SPY', 'QQQ'],
        minIv = 0.15, maxIv = 1.0,
        minDelta = 0.10, maxDelta = 0.50,
        minOi = 100, minVolume = 10,
        type = 'all', // 'call', 'put', 'all'
        dteMin = 7, dteMax = 60
    } = req.body;

    try {
        const results = [];
        const now = new Date();

        for (const symbol of symbols.slice(0, 5)) {
            try {
                const chain = await webull.getOptionChain(symbol.toUpperCase(), null);
                const { rows, underlyingPrice, expiryDates } = chain;

                for (const expiry of (expiryDates || []).slice(0, 4)) {
                    const dte = Math.round((new Date(expiry) - now) / 86400000);
                    if (dte < dteMin || dte > dteMax) continue;

                    for (const row of rows) {
                        const sides = [];
                        if (type !== 'put' && row.call) sides.push({ side: 'call', contract: row.call });
                        if (type !== 'call' && row.put) sides.push({ side: 'put', contract: row.put });

                        for (const { side, contract } of sides) {
                            if (!contract) continue;
                            const absDelta = Math.abs(contract.delta);
                            if (
                                contract.iv >= minIv && contract.iv <= maxIv &&
                                absDelta >= minDelta && absDelta <= maxDelta &&
                                contract.oi >= minOi && contract.volume >= minVolume
                            ) {
                                const mid = parseFloat(((contract.bid + contract.ask) / 2).toFixed(2));
                                const spread = parseFloat((contract.ask - contract.bid).toFixed(2));
                                const spreadPct = mid > 0 ? parseFloat((spread / mid * 100).toFixed(1)) : 0;
                                results.push({
                                    symbol: symbol.toUpperCase(),
                                    type: side.toUpperCase(),
                                    strike: row.strike,
                                    expiry,
                                    dte,
                                    bid: contract.bid,
                                    ask: contract.ask,
                                    mid,
                                    spread,
                                    spreadPct,
                                    iv: parseFloat((contract.iv * 100).toFixed(1)),
                                    delta: parseFloat(contract.delta.toFixed(3)),
                                    gamma: parseFloat((contract.gamma || 0).toFixed(5)),
                                    theta: parseFloat((contract.theta || 0).toFixed(3)),
                                    vega: parseFloat((contract.vega || 0).toFixed(3)),
                                    volume: contract.volume,
                                    oi: contract.oi,
                                    underlyingPrice,
                                    moneyness: parseFloat(((row.strike / underlyingPrice - 1) * 100).toFixed(2))
                                });
                            }
                        }
                    }
                }
            } catch { /* skip this symbol */ }
        }

        // Sort by IV descending
        results.sort((a, b) => b.iv - a.iv);
        res.json({ ok: true, data: results.slice(0, 100), count: results.length });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
