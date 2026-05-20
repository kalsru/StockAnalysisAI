const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');
const { VertexAI } = require('@google-cloud/vertexai');

const projectID = process.env.GCP_PROJECT_ID || 'mock-project';
let vertex_ai = null;
let generativeModel = null;

function getModel() {
    if (!generativeModel) {
        try {
            vertex_ai = new VertexAI({ project: projectID, location: 'us-central1' });
            generativeModel = vertex_ai.getGenerativeModel({
                model: 'gemini-1.5-pro',
                generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 2048 }
            });
        } catch { /* model unavailable */ }
    }
    return generativeModel;
}

function buildPrompt(ticker, strategy, chain, quote) {
    const atm = chain.rows.find(r => Math.abs(r.strike - quote.price) === Math.min(...chain.rows.map(r => Math.abs(r.strike - quote.price))));
    const atmIvPct = (chain.atmIv * 100).toFixed(1);
    const ivRank = webull.getIvRank(ticker);

    return `You are a professional options trading analyst. Analyze the following real-time options data and produce a JSON recommendation.

MARKET DATA:
- Ticker: ${ticker}
- Current Price: $${quote.price}
- Daily Change: ${quote.change > 0 ? '+' : ''}${quote.change} (${(quote.changeRatio * 100).toFixed(2)}%)
- ATM Strike: $${atm?.strike || 'N/A'}
- ATM IV: ${atmIvPct}%
- IV Rank: ${ivRank}%
- Expiry analyzed: ${chain.expiry}
- ATM Call — Bid/Ask: $${atm?.call?.bid || 0}/$${atm?.call?.ask || 0}, Delta: ${atm?.call?.delta || 0}, Theta: ${atm?.call?.theta || 0}
- ATM Put — Bid/Ask: $${atm?.put?.bid || 0}/$${atm?.put?.ask || 0}, Delta: ${atm?.put?.delta || 0}, Theta: ${atm?.put?.theta || 0}

STRATEGY PREFERENCE: ${strategy}

NEARBY STRIKES (5 above and below ATM):
${chain.rows.slice(Math.max(0, chain.rows.findIndex(r => r.strike === atm?.strike) - 5), chain.rows.findIndex(r => r.strike === atm?.strike) + 6).map(r =>
    `  $${r.strike}: Call IV ${(r.call?.iv * 100 || 0).toFixed(1)}% Δ${r.call?.delta || 0} | Put IV ${(r.put?.iv * 100 || 0).toFixed(1)}% Δ${r.put?.delta || 0}`
).join('\n')}

Provide a JSON response with these exact fields:
{
  "recommendedStrategy": "strategy name",
  "strategyType": "CREDIT_SPREAD | DEBIT_SPREAD | IRON_CONDOR | COVERED_CALL | LONG_CALL | LONG_PUT | CASH_SECURED_PUT",
  "legs": [{"action": "BUY|SELL", "type": "CALL|PUT", "strike": 0, "expiry": "date", "contracts": 1, "price": 0}],
  "netCredit": 0,
  "maxProfit": 0,
  "maxLoss": 0,
  "breakeven": 0,
  "probabilityOfProfit": "XX%",
  "ivRankAssessment": "LOW|MEDIUM|HIGH|ELEVATED",
  "marketBias": "BULLISH|BEARISH|NEUTRAL",
  "riskRewardRatio": "1:X",
  "analysisRationale": "2-3 sentence explanation referencing the actual data",
  "keyRisks": ["risk1", "risk2"],
  "idealExitPlan": "description of exit strategy",
  "confidenceScore": 0
}`;
}

function mockAnalysis(ticker, strategy, chain, quote) {
    const isIncome = strategy.toLowerCase().includes('income') || strategy.toLowerCase().includes('credit');
    const isNeutral = strategy.toLowerCase().includes('neutral') || strategy.toLowerCase().includes('condor');
    const atm = chain.rows.find(r => Math.abs(r.strike - quote.price) === Math.min(...chain.rows.map(r => Math.abs(r.strike - quote.price))));
    const shortPut = chain.rows.find(r => r.strike < quote.price * 0.965);
    const longPut = chain.rows.find(r => r.strike < quote.price * 0.94);
    const shortCall = chain.rows.find(r => r.strike > quote.price * 1.03);
    const ivRank = webull.getIvRank(ticker);

    if (isIncome && !isNeutral) {
        const credit = parseFloat(((shortPut?.put?.bid || 1.5) - (longPut?.put?.ask || 0.50)).toFixed(2));
        const width = shortPut && longPut ? shortPut.strike - longPut.strike : 5;
        return {
            recommendedStrategy: `${ticker} Credit Put Spread`,
            strategyType: 'CREDIT_SPREAD',
            legs: [
                { action: 'SELL', type: 'PUT', strike: shortPut?.strike || Math.round(quote.price * 0.965), expiry: chain.expiry, contracts: 1, price: shortPut?.put?.bid || 1.50 },
                { action: 'BUY', type: 'PUT', strike: longPut?.strike || Math.round(quote.price * 0.94), expiry: chain.expiry, contracts: 1, price: longPut?.put?.ask || 0.50 }
            ],
            netCredit: credit,
            maxProfit: parseFloat((credit * 100).toFixed(2)),
            maxLoss: parseFloat(((width - credit) * 100).toFixed(2)),
            breakeven: parseFloat(((shortPut?.strike || quote.price * 0.965) - credit).toFixed(2)),
            probabilityOfProfit: `${Math.round(68 + (ivRank - 50) * 0.1)}%`,
            ivRankAssessment: ivRank > 60 ? 'HIGH' : ivRank > 40 ? 'MEDIUM' : 'LOW',
            marketBias: 'BULLISH',
            riskRewardRatio: `1:${(width / credit - 1).toFixed(1)}`,
            analysisRationale: `IV Rank of ${ivRank}% ${ivRank > 50 ? 'is elevated, making premium selling favorable' : 'suggests moderate premium pricing'}. The put spread at $${shortPut?.strike || 'ATM-3%'} / $${longPut?.strike || 'ATM-6%'} collects $${credit} credit with a ${Math.round(65 + (50 - ivRank) * 0.2)}% probability of profit based on current delta positioning. Theta decay of $${Math.abs((atm?.put?.theta || -0.08) * 100).toFixed(0)}/day supports the trade.`,
            keyRisks: [`Sharp move below $${longPut?.strike || Math.round(quote.price * 0.94)} triggers max loss`, 'IV expansion increases mark-to-market loss', 'Earnings or macro event risk'],
            idealExitPlan: `Close at 50% of max profit ($${(credit * 50).toFixed(2)}) or at 21 DTE. Stop if debit to close exceeds 2x credit received.`,
            confidenceScore: Math.min(85, 50 + ivRank * 0.4)
        };
    } else if (isNeutral) {
        const credit = parseFloat(((shortPut?.put?.bid || 1.2) + (shortCall?.call?.bid || 1.1) - 0.80).toFixed(2));
        return {
            recommendedStrategy: `${ticker} Iron Condor`,
            strategyType: 'IRON_CONDOR',
            legs: [
                { action: 'SELL', type: 'PUT', strike: shortPut?.strike || Math.round(quote.price * 0.965), expiry: chain.expiry, contracts: 1, price: shortPut?.put?.bid || 1.20 },
                { action: 'BUY', type: 'PUT', strike: longPut?.strike || Math.round(quote.price * 0.94), expiry: chain.expiry, contracts: 1, price: longPut?.put?.ask || 0.35 },
                { action: 'SELL', type: 'CALL', strike: shortCall?.strike || Math.round(quote.price * 1.03), expiry: chain.expiry, contracts: 1, price: shortCall?.call?.bid || 1.10 },
                { action: 'BUY', type: 'CALL', strike: Math.round(quote.price * 1.055), expiry: chain.expiry, contracts: 1, price: 0.30 }
            ],
            netCredit: credit,
            maxProfit: parseFloat((credit * 100).toFixed(2)),
            maxLoss: parseFloat(((5 - credit) * 100).toFixed(2)),
            breakeven: parseFloat((quote.price).toFixed(2)),
            probabilityOfProfit: `${Math.round(52 + ivRank * 0.15)}%`,
            ivRankAssessment: ivRank > 60 ? 'HIGH' : ivRank > 40 ? 'MEDIUM' : 'LOW',
            marketBias: 'NEUTRAL',
            riskRewardRatio: `1:${((5 - credit) / credit).toFixed(1)}`,
            analysisRationale: `With IV Rank at ${ivRank}%, the iron condor captures the volatility premium from both sides. The range between $${shortPut?.strike || 'ATM-3%'} and $${shortCall?.strike || 'ATM+3%'} captures approximately ${Math.round(68 + ivRank * 0.1)}% of expected outcomes based on current ATM IV of ${(chain.atmIv * 100).toFixed(1)}%.`,
            keyRisks: ['Directional gap through either short strike', 'IV expansion increases mark-to-market losses', 'Pin risk near expiration'],
            idealExitPlan: `Close at 25% of max profit or if either short strike is tested. Roll untested side for additional credit if market moves.`,
            confidenceScore: Math.min(78, 45 + ivRank * 0.4)
        };
    } else {
        return {
            recommendedStrategy: `${ticker} Long Call`,
            strategyType: 'LONG_CALL',
            legs: [
                { action: 'BUY', type: 'CALL', strike: atm?.strike || Math.round(quote.price), expiry: chain.expiry, contracts: 1, price: atm?.call?.ask || 3.20 }
            ],
            netCredit: -(atm?.call?.ask || 3.20),
            maxProfit: 999,
            maxLoss: parseFloat(((atm?.call?.ask || 3.20) * 100).toFixed(2)),
            breakeven: parseFloat(((atm?.strike || quote.price) + (atm?.call?.ask || 3.20)).toFixed(2)),
            probabilityOfProfit: `${Math.round(Math.abs(atm?.call?.delta || 0.50) * 100)}%`,
            ivRankAssessment: ivRank > 60 ? 'HIGH' : ivRank > 40 ? 'MEDIUM' : 'LOW',
            marketBias: 'BULLISH',
            riskRewardRatio: 'Unlimited upside',
            analysisRationale: `Directional call at the ATM strike ($${atm?.strike}) with delta of ${atm?.call?.delta || 0.50}. Current IV of ${(chain.atmIv * 100).toFixed(1)}% ${ivRank > 50 ? 'is elevated so theta decay is a headwind — consider a spread to reduce cost' : 'is reasonable for a long position'}. Breakeven at $${((atm?.strike || quote.price) + (atm?.call?.ask || 3.20)).toFixed(2)}.`,
            keyRisks: ['IV crush reduces value even if stock moves in your favor', `Premium of $${((atm?.call?.ask || 3.20) * 100).toFixed(0)} is the max loss`, 'Time decay accelerates in final 21 DTE'],
            idealExitPlan: `Take 50% profit target or close at 21 DTE. Cut loss at 50% of premium paid.`,
            confidenceScore: Math.max(35, 65 - ivRank * 0.3)
        };
    }
}

// POST /api/agent/analyze
router.post('/analyze', async (req, res) => {
    const { ticker, strategyPreference } = req.body;
    if (!ticker) return res.status(400).json({ error: 'Ticker required.' });

    const sym = ticker.toUpperCase().trim();
    console.log(`[Agent] Analyzing ${sym} — strategy: ${strategyPreference}`);

    try {
        const [quote, chain] = await Promise.all([
            webull.getQuote(sym),
            webull.getOptionChain(sym)
        ]);

        let analysis;
        const model = getModel();
        if (model && projectID !== 'mock-project') {
            try {
                const prompt = buildPrompt(sym, strategyPreference, chain, quote);
                const result = await model.generateContent(prompt);
                const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
                analysis = JSON.parse(text);
                analysis._source = 'gemini';
            } catch (aiErr) {
                console.warn('[Agent] Gemini call failed, using rule-based analysis:', aiErr.message);
                analysis = mockAnalysis(sym, strategyPreference, chain, quote);
                analysis._source = 'rule_based';
            }
        } else {
            analysis = mockAnalysis(sym, strategyPreference, chain, quote);
            analysis._source = 'rule_based';
        }

        res.json({
            ticker: sym,
            currentPrice: quote.price,
            change: quote.change,
            changeRatio: quote.changeRatio,
            atmIv: chain.atmIv,
            ivRank: webull.getIvRank(sym),
            expiry: chain.expiry,
            dataSource: chain.source,
            ...analysis
        });
    } catch (error) {
        console.error('[Agent Error]', error.message);
        res.status(500).json({ error: 'Analysis failed: ' + error.message });
    }
});

module.exports = router;
