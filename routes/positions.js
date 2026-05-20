const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');

// Normalize a Webull API position into frontend format
function normalizeWebullPosition(p) {
    const isOptionStrategy = !!(p.option_strategy) || p.instrument_type === 'OPTION';
    const legs = Array.isArray(p.legs) ? p.legs : [];
    const equityLeg = legs.find(l => l.instrument_type === 'EQUITY');
    const optionLeg = legs.find(l => l.instrument_type === 'OPTION');

    // quantity = option contracts for option strategies; actual shares for pure equity
    const contracts = parseFloat(p.quantity || 0);
    const multiplier = optionLeg ? parseFloat(optionLeg.option_contract_multiplier || 100) : 1;
    const shares = isOptionStrategy ? contracts * multiplier : contracts;

    return {
        id: p.position_id || p.symbol,
        symbol: p.symbol || '',
        type: p.option_strategy || (isOptionStrategy ? 'OPTION' : 'STOCK'),
        assetType: isOptionStrategy ? 'OPTION' : 'STOCK',
        qty: shares,                  // actual shares
        contracts,                    // option contracts count
        costPrice: parseFloat(equityLeg?.cost || p.cost_price || 0),
        marketValue: parseFloat(p.market_value || 0),
        lastPrice: parseFloat(p.last_price || 0),
        unrealizedPnl: parseFloat(p.unrealized_profit_loss || 0),
        unrealizedPnlRate: parseFloat(p.unrealized_profit_loss_rate || 0),
        dayPnl: parseFloat(p.day_profit_loss || 0),
        strike: optionLeg ? parseFloat(optionLeg.option_exercise_price || 0) : null,
        expiry: optionLeg?.option_expire_date || null,
        optionType: optionLeg?.option_type || null,
        legs: legs.map(l => {
            const legContracts = contracts;
            const legMultiplier = parseFloat(l.option_contract_multiplier || 100);
            const legShares = l.instrument_type === 'EQUITY' ? legContracts * legMultiplier : legContracts;
            return {
                symbol: l.symbol,
                instrumentType: l.instrument_type,
                costPrice: parseFloat(l.cost || 0),
                lastPrice: parseFloat(l.last_price || 0),
                unrealizedPnl: parseFloat(l.unrealized_profit_loss || 0),
                optionType: l.option_type || null,
                strike: l.option_exercise_price ? parseFloat(l.option_exercise_price) : null,
                expiry: l.option_expire_date || null,
                qty: l.instrument_type === 'EQUITY' ? legShares : legContracts,
                multiplier: l.instrument_type === 'OPTION' ? legMultiplier : null
            };
        }),
        openDate: p.openDate || null,
        status: 'OPEN',
        source: 'webull'
    };
}

// GET /api/positions
router.get('/', async (req, res) => {
    try {
        // Try live Webull positions first
        const liveResult = await webull.getAccountPositions();
        const localData = await webull.getLocalPositions();

        let positions = [];
        let source = 'local';

        if (liveResult && liveResult.positions && liveResult.positions.length > 0) {
            positions = liveResult.positions.map(normalizeWebullPosition);
            source = 'webull';
        } else {
            // Fall back to local positions
            positions = localData.positions || [];
        }

        // Enrich with current quotes
        const symbolSet = [...new Set(positions.map(p => p.symbol).filter(Boolean))];
        const quotes = {};
        await Promise.all(symbolSet.map(async sym => {
            try { quotes[sym] = await webull.getQuote(sym); } catch { /* skip */ }
        }));

        for (const pos of positions) {
            if (quotes[pos.symbol]) {
                pos.currentUnderlyingPrice = quotes[pos.symbol].price;
                pos.underlyingChange = quotes[pos.symbol].change;
                pos.underlyingChangeRatio = quotes[pos.symbol].changeRatio;
            }
        }

        res.json({
            ok: true,
            data: {
                positions,
                history: localData.history || [],
                source
            }
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST /api/positions - Add manual position to local tracker
router.post('/', async (req, res) => {
    try {
        const { symbol, type, legs, netCredit, maxProfit, maxLoss } = req.body;
        if (!symbol || !type || !legs) return res.status(400).json({ ok: false, error: 'symbol, type, and legs required' });

        const data = await webull.getLocalPositions();
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
        await webull.saveLocalPositions(data);
        res.status(201).json({ ok: true, data: newPos });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// PUT /api/positions/:id - Update (close) a local position
router.put('/:id', async (req, res) => {
    try {
        const data = await webull.getLocalPositions();
        const idx = data.positions.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ ok: false, error: 'Position not found' });

        const pos = data.positions[idx];
        const { status, pnl } = req.body;

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

        await webull.saveLocalPositions(data);
        res.json({ ok: true, data: data.positions[idx] || { closed: true } });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// DELETE /api/positions/:id
router.delete('/:id', async (req, res) => {
    try {
        const data = await webull.getLocalPositions();
        const idx = data.positions.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ ok: false, error: 'Position not found' });
        data.positions.splice(idx, 1);
        await webull.saveLocalPositions(data);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
