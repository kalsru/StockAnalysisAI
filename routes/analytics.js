const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');

// GET /api/analytics/summary — live account KPIs from Webull
router.get('/summary', async (req, res) => {
    try {
        const [balanceResult, localData] = await Promise.all([
            webull.getAccountBalance(),
            webull.getLocalPositions()
        ]);

        const history = localData.history || [];
        const closedPnl = history.reduce((sum, h) => sum + (h.pnl || 0), 0);
        const winners = history.filter(h => (h.pnl || 0) > 0);
        const losers = history.filter(h => (h.pnl || 0) <= 0);
        const avgWin = winners.length ? winners.reduce((s, h) => s + h.pnl, 0) / winners.length : 0;
        const avgLoss = losers.length ? losers.reduce((s, h) => s + h.pnl, 0) / losers.length : 0;

        // Use live balance if available, otherwise fall back to local
        let accountData = {};
        if (balanceResult) {
            // Webull returns account_currency_assets array; use first USD entry
            const usd = (balanceResult.account_currency_assets || []).find(a => a.currency === 'USD') || {};
            accountData = {
                netLiquidation: parseFloat(usd.net_liquidation_value || balanceResult.total_net_liquidation_value || 0),
                totalMarketValue: parseFloat(usd.market_value || balanceResult.total_market_value || 0),
                cashBalance: parseFloat(usd.cash_balance || balanceResult.total_cash_balance || 0),
                unrealizedPnl: parseFloat(usd.unrealized_profit_loss || balanceResult.total_unrealized_profit_loss || 0),
                dayPnl: parseFloat(usd.day_profit_loss || balanceResult.total_day_profit_loss || 0),
                buyingPower: parseFloat(usd.option_buying_power || 0),
                dayBuyingPower: parseFloat(usd.day_buying_power || 0),
                maintenanceMargin: parseFloat(balanceResult.maintenance_margin || 0),
                source: balanceResult.source || 'webull'
            };
        }

        res.json({
            ok: true,
            data: {
                // Live account data
                ...accountData,
                // Trade statistics from local history
                realizedPnl: parseFloat(closedPnl.toFixed(2)),
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

// GET /api/analytics/pnl - P&L curve from local trade history
router.get('/pnl', async (req, res) => {
    try {
        const { history } = await webull.getLocalPositions();
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

// GET /api/analytics/greeks - Portfolio greeks from live positions
router.get('/greeks', async (req, res) => {
    try {
        const liveResult = await webull.getAccountPositions();
        const positions = (liveResult?.positions || []);

        // Aggregate unrealized P&L as proxy for theta/delta exposure
        const totalUnrealized = positions.reduce((s, p) => s + parseFloat(p.unrealizedProfitLoss || 0), 0);
        const optionPositions = positions.filter(p => p.assetType === 'OPTION' || p.instrumentType === 'OPTION');

        res.json({
            ok: true,
            data: {
                positions: positions.length,
                optionPositions: optionPositions.length,
                totalUnrealizedPnl: parseFloat(totalUnrealized.toFixed(2)),
                source: liveResult?.source || 'local'
            }
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
