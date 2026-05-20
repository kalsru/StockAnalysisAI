const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');

// GET /api/analytics/summary
router.get('/summary', async (req, res) => {
    try {
        const { positions, history } = await webull.getPositions();
        const closedPnl = history.reduce((sum, h) => sum + (h.pnl || 0), 0);
        const openPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
        const winners = history.filter(h => (h.pnl || 0) > 0);
        const losers = history.filter(h => (h.pnl || 0) <= 0);
        const avgWin = winners.length ? winners.reduce((s, h) => s + h.pnl, 0) / winners.length : 0;
        const avgLoss = losers.length ? losers.reduce((s, h) => s + h.pnl, 0) / losers.length : 0;

        res.json({
            ok: true,
            data: {
                totalPnl: parseFloat((closedPnl + openPnl).toFixed(2)),
                realizedPnl: parseFloat(closedPnl.toFixed(2)),
                unrealizedPnl: parseFloat(openPnl.toFixed(2)),
                openPositions: positions.length,
                closedTrades: history.length,
                winRate: history.length ? parseFloat((winners.length / history.length * 100).toFixed(1)) : 0,
                avgWin: parseFloat(avgWin.toFixed(2)),
                avgLoss: parseFloat(avgLoss.toFixed(2)),
                profitFactor: avgLoss !== 0 ? parseFloat(Math.abs(avgWin / avgLoss).toFixed(2)) : 0,
                expectancy: parseFloat(((winners.length / history.length || 0) * avgWin + (losers.length / history.length || 0) * avgLoss).toFixed(2))
            }
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/analytics/pnl - P&L curve over time
router.get('/pnl', async (req, res) => {
    try {
        const { history } = await webull.getPositions();
        const sorted = [...history].sort((a, b) => new Date(a.closeDate || a.openDate) - new Date(b.closeDate || b.openDate));
        let cumulative = 0;
        const points = sorted.map(h => {
            cumulative += (h.pnl || 0);
            return {
                date: h.closeDate || h.openDate,
                pnl: h.pnl || 0,
                cumulative: parseFloat(cumulative.toFixed(2)),
                symbol: h.symbol,
                type: h.type
            };
        });
        // Pad with today if no recent entry
        if (points.length === 0 || new Date(points[points.length - 1].date) < new Date(Date.now() - 86400000)) {
            points.push({ date: new Date().toISOString().split('T')[0], pnl: 0, cumulative, symbol: null, type: null });
        }
        res.json({ ok: true, data: points });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/analytics/ivrank?symbols=IWM,SPY,QQQ
router.get('/ivrank', async (req, res) => {
    try {
        const symbols = (req.query.symbols || 'IWM,SPY,QQQ,AAPL,TSLA').toUpperCase().split(',').map(s => s.trim());
        const results = await Promise.all(symbols.map(async sym => {
            const quote = await webull.getQuote(sym);
            const ivRank = webull.getIvRank(sym);
            return { symbol: sym, price: quote.price, ivRank, change: quote.change, changeRatio: quote.changeRatio };
        }));
        res.json({ ok: true, data: results });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/analytics/greeks - Aggregate Greeks for open positions
router.get('/greeks', async (req, res) => {
    try {
        const { positions } = await webull.getPositions();
        // Mock aggregate Greeks - in production these come from live pricing
        const portfolioGreeks = {
            delta: parseFloat((Math.random() * 0.4 - 0.2).toFixed(3)),
            gamma: parseFloat((Math.random() * 0.02).toFixed(4)),
            theta: parseFloat((-Math.random() * 15 - 5).toFixed(2)),
            vega: parseFloat((-Math.random() * 50 - 10).toFixed(2))
        };
        res.json({ ok: true, data: { positions: positions.length, greeks: portfolioGreeks } });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
