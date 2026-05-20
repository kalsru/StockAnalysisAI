const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');

// GET /api/positions
router.get('/', async (req, res) => {
    try {
        const data = await webull.getPositions();
        // Enrich open positions with current pricing
        for (const pos of data.positions) {
            try {
                const quote = await webull.getQuote(pos.symbol);
                pos.currentUnderlyingPrice = quote.price;
                // Simple P&L estimation based on position type
                if (pos.type === 'PUT_SPREAD' || pos.type === 'CREDIT_PUT_SPREAD') {
                    const elapsed = (Date.now() - new Date(pos.openDate).getTime()) / (1000 * 3600 * 24);
                    const decayFactor = Math.min(elapsed / 30, 1);
                    pos.currentValue = parseFloat((pos.netCredit * (1 - decayFactor * 0.6)).toFixed(2));
                    pos.pnl = parseFloat(((pos.netCredit - pos.currentValue) * 100).toFixed(2));
                } else if (pos.type === 'COVERED_CALL') {
                    const elapsed = (Date.now() - new Date(pos.openDate).getTime()) / (1000 * 3600 * 24);
                    const decayFactor = Math.min(elapsed / 14, 1);
                    pos.currentValue = parseFloat((pos.netCredit * (1 - decayFactor * 0.65)).toFixed(2));
                    pos.pnl = parseFloat(((pos.netCredit - pos.currentValue) * 100).toFixed(2));
                }
            } catch { /* keep position without live data */ }
        }
        res.json({ ok: true, data });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /api/positions - Add new position
router.post('/', async (req, res) => {
    try {
        const { symbol, type, legs, netCredit, maxProfit, maxLoss } = req.body;
        if (!symbol || !type || !legs) return res.status(400).json({ ok: false, error: 'symbol, type, and legs required' });

        const data = await webull.getPositions();
        const newPos = {
            id: `pos_${Date.now()}`,
            symbol: symbol.toUpperCase(),
            type,
            legs,
            netCredit: parseFloat(netCredit || 0),
            maxProfit: parseFloat(maxProfit || 0),
            maxLoss: maxLoss ? parseFloat(maxLoss) : null,
            openDate: new Date().toISOString().split('T')[0],
            status: 'OPEN',
            currentValue: null,
            pnl: null
        };
        data.positions.push(newPos);
        await webull.savePositions(data);
        res.status(201).json({ ok: true, data: newPos });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// PUT /api/positions/:id - Update (close) a position
router.put('/:id', async (req, res) => {
    try {
        const data = await webull.getPositions();
        const idx = data.positions.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ ok: false, error: 'Position not found' });

        const pos = data.positions[idx];
        const { status, pnl, closePrice } = req.body;

        if (status === 'CLOSED') {
            const closedPos = {
                ...pos,
                status: 'CLOSED',
                closeDate: new Date().toISOString().split('T')[0],
                pnl: parseFloat(pnl || pos.pnl || 0)
            };
            data.history.unshift(closedPos);
            data.positions.splice(idx, 1);
        } else {
            data.positions[idx] = { ...pos, ...req.body };
        }

        await webull.savePositions(data);
        res.json({ ok: true, data: data.positions[idx] || { closed: true } });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// DELETE /api/positions/:id
router.delete('/:id', async (req, res) => {
    try {
        const data = await webull.getPositions();
        const idx = data.positions.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ ok: false, error: 'Position not found' });
        data.positions.splice(idx, 1);
        await webull.savePositions(data);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
