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

// Flatten Webull combo order history into individual trade records with full leg detail
// Response shape: [{combo_order_id, combo_type, orders:[{symbol,side,status,instrument_type,option_strategy,position_intent,legs:[...]}]}]
function flattenWebullCombos(combos) {
    const trades = [];
    for (const combo of combos) {
        const subOrders = Array.isArray(combo.orders) ? combo.orders : [];
        for (const o of subOrders) {
            if ((o.status || '').toUpperCase() !== 'FILLED') continue;

            const isEquity = o.instrument_type === 'EQUITY';
            const strategy = o.option_strategy || (isEquity ? 'STOCK' : 'SINGLE');
            const intent   = o.position_intent || (isEquity ? (o.side === 'BUY' ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE') : null);
            const filledQty   = parseFloat(o.filled_quantity || o.total_quantity || 0);
            const filledPrice = parseFloat(o.filled_price || o.avg_filled_price || 0);
            // Total cash flow: equity uses qty*price, options use qty*price*100 (contract multiplier)
            const totalCash = isEquity
                ? filledQty * filledPrice
                : filledQty * filledPrice * 100;

            const legs = (o.legs || []).map(l => ({
                qty: parseFloat(l.quantity || 0),
                side: (l.side || '').toUpperCase(),
                instrumentType: l.option_type ? 'OPTION' : 'EQUITY',
                optionType: l.option_type || null,
                strike: l.strike_price ? parseFloat(l.strike_price) : null,
                expiry: l.option_expire_date || null,
                multiplier: l.option_contract_multiplier ? parseInt(l.option_contract_multiplier) : 1
            }));

            const filledMs = parseInt(o.filled_time || 0);
            trades.push({
                id: o.order_id || combo.combo_order_id,
                symbol: o.symbol || '',
                instrumentType: o.instrument_type,
                strategy,
                action: (o.side || '').toUpperCase(),
                intent,                                  // SELL_TO_OPEN, BUY_TO_CLOSE, etc.
                qty: filledQty,
                price: filledPrice,
                total: parseFloat(totalCash.toFixed(2)),
                cashFlow: parseFloat(((o.side === 'SELL' ? 1 : -1) * totalCash).toFixed(2)),
                date: filledMs ? new Date(filledMs).toISOString().split('T')[0] : null,
                datetime: filledMs ? new Date(filledMs).toISOString() : null,
                filledMs,
                legs,
                source: 'webull'
            });
        }
    }
    return trades.sort((a, b) => b.filledMs - a.filledMs);
}

// GET /api/positions
router.get('/', async (req, res) => {
    try {
        // Fetch live positions + trade history in parallel
        const [liveResult, tradeResult, localData] = await Promise.all([
            webull.getAccountPositions(),
            webull.getTradeHistory({ pageSize: 100 }),
            webull.getLocalPositions()
        ]);

        let positions = [];
        let source = 'local';

        if (liveResult && liveResult.positions && liveResult.positions.length > 0) {
            positions = liveResult.positions.map(normalizeWebullPosition);
            source = 'webull';
        } else {
            positions = localData.positions || [];
        }

        // Build history: prefer live Webull orders, fall back to local file
        let history = localData.history || [];
        if (tradeResult.combos && tradeResult.combos.length > 0) {
            const live = flattenWebullCombos(tradeResult.combos);
            if (live.length > 0) history = live;
        }

        // Enrich open positions with current quotes
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
                history,
                historySource: tradeResult.source,
                source
            }
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/positions/history — standalone trade history endpoint
router.get('/history', async (req, res) => {
    try {
        const pageSize = parseInt(req.query.limit) || 100;
        const result = await webull.getTradeHistory({ pageSize });
        const history = flattenWebullCombos(result.combos || []);
        res.json({ ok: true, data: { history, source: result.source, error: result.error } });
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

// GET /api/positions/probe — find the correct Webull trade history endpoint
router.get('/probe', async (req, res) => {
    try {
        const results = await webull.probeTradeEndpoints();
        res.json({ ok: true, results });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/positions/probe-cash — find the cash transaction endpoint
router.get('/probe-cash', async (req, res) => {
    try {
        const results = await webull.probeCashEndpoints();
        res.json({ ok: true, results });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
