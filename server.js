const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cron = require('node-cron');
const app = express();

const agentRoutes = require('./routes/agent');
const optionsRoutes = require('./routes/options');
const positionsRoutes = require('./routes/positions');
const analyticsRoutes = require('./routes/analytics');
const screenerRoutes = require('./routes/screener');
const webull = require('./services/webullService');
const db = require('./services/dbService');

const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS for dev
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use('/api/agent', agentRoutes);
app.use('/api/options', optionsRoutes);
app.use('/api/positions', positionsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/screener', screenerRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', ts: Date.now(), version: '2.0.0' });
});

// ── Daily snapshot — 8:00 PM ET, weekdays (Mon–Fri) ──────────────────────────
async function runDailySnapshot() {
    console.log('[Cron] Running 8 PM ET daily snapshot...');
    try {
        const balanceResult = await webull.getAccountBalance();
        if (!balanceResult) { console.warn('[Cron] Balance unavailable, skipping snapshot'); return; }
        const usd = (balanceResult.account_currency_assets || []).find(a => a.currency === 'USD') || {};
        const today = new Date().toISOString().split('T')[0];
        await db.upsertSnapshot({
            date:           today,
            netLiquidation: parseFloat(usd.net_liquidation_value || balanceResult.total_net_liquidation_value || 0),
            marketValue:    parseFloat(usd.market_value || balanceResult.total_market_value || 0),
            cashBalance:    parseFloat(usd.cash_balance || balanceResult.total_cash_balance || 0),
            unrealizedPnl:  parseFloat(usd.unrealized_profit_loss || balanceResult.total_unrealized_profit_loss || 0),
            buyingPower:    parseFloat(usd.option_buying_power || 0)
        });
        console.log(`[Cron] Snapshot saved for ${today}`);
    } catch (e) {
        console.error('[Cron] Snapshot failed:', e.message);
    }
}

// 0 20 * * 1-5  =  8:00 PM, Monday–Friday, America/New_York
cron.schedule('0 20 * * 1-5', runDailySnapshot, { timezone: 'America/New_York' });
console.log('[Cron] Daily snapshot scheduled: 8:00 PM ET, Mon–Fri');

app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`  Webull Options Analyzer v2.0`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  API Key: ${process.env.WEBULL_API_KEY ? 'configured' : 'not set'}`);
    console.log(`  GCP Project: ${process.env.GCP_PROJECT_ID}`);
    console.log(`=================================================`);
});
