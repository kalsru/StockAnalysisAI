const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildStrikePrompt(ticker, strategyPref, chain, quote, ivRank) {
    const S = quote.price;
    const T = chain.expiry;
    const atmIdx = chain.rows.reduce((bi, r, i) =>
        Math.abs(r.strike - S) < Math.abs(chain.rows[bi].strike - S) ? i : bi, 0);

    // Send ATM ±15 strikes so Claude has full context
    const window = chain.rows.slice(Math.max(0, atmIdx - 15), atmIdx + 16);
    const strikeTable = window.map(r => {
        const c = r.call, p = r.put;
        return `${r.strike.toFixed(2).padStart(7)} | CALL bid=${(c?.bid??'--')} ask=${(c?.ask??'--')} iv=${c?.iv?(c.iv*100).toFixed(1)+'%':'--'} delta=${c?.delta??'--'} theta=${c?.theta??'--'} oi=${c?.oi??0} vol=${c?.volume??0} | PUT bid=${(p?.bid??'--')} ask=${(p?.ask??'--')} iv=${p?.iv?(p.iv*100).toFixed(1)+'%':'--'} delta=${p?.delta??'--'} theta=${p?.theta??'--'} oi=${p?.oi??0} vol=${p?.volume??0}`;
    }).join('\n');

    return `You are an expert options trader analyzing live market data to select the single best option strike for a trade.

LIVE MARKET DATA:
- Ticker: ${ticker}
- Current Price: $${S}
- Daily Change: ${quote.change >= 0 ? '+' : ''}${quote.change} (${(quote.changeRatio*100).toFixed(2)}%)
- Expiry: ${T}
- ATM IV: ${(chain.atmIv*100).toFixed(1)}%
- IV Rank: ${ivRank}% (${ivRank > 60 ? 'HIGH — favor selling premium' : ivRank > 35 ? 'MODERATE' : 'LOW — favor buying options'})
- Strategy Preference: ${strategyPref}

OPTIONS CHAIN (ATM ±15 strikes):
 STRIKE  | ──────────────── CALLS ──────────────────────────── | ──────────────── PUTS ──────────────────────────────
${strikeTable}

TASK: Select the single BEST strike (or strike pair for spreads) for this trade.
Consider:
1. Delta positioning — what delta gives the best risk/reward for this strategy?
2. Bid/ask spread — avoid illiquid strikes (wide spread or zero OI/volume)
3. Theta decay — higher theta favors short premium
4. IV smile — which strikes have inflated IV worth selling or cheap IV worth buying?
5. Probability of profit — use delta as proxy for ITM probability

Respond ONLY with valid JSON, no markdown, no explanation outside JSON:
{
  "recommendedStrategy": "clear strategy name",
  "strategyType": "CREDIT_SPREAD|DEBIT_SPREAD|IRON_CONDOR|COVERED_CALL|LONG_CALL|LONG_PUT|CASH_SECURED_PUT|STRADDLE|STRANGLE",
  "legs": [
    {"action": "BUY|SELL", "type": "CALL|PUT", "strike": 0.00, "expiry": "${T}", "contracts": 1, "bid": 0.00, "ask": 0.00, "delta": 0.00, "iv": 0.00, "whyThisStrike": "specific reason referencing the data"}
  ],
  "netCredit": 0.00,
  "maxProfit": 0.00,
  "maxLoss": 0.00,
  "breakeven": 0.00,
  "probabilityOfProfit": "XX%",
  "ivRankAssessment": "LOW|MEDIUM|HIGH|ELEVATED",
  "marketBias": "BULLISH|BEARISH|NEUTRAL",
  "riskRewardRatio": "1:X",
  "strikeSelectionRationale": "2-3 sentences explaining specifically WHY these strikes were chosen over alternatives — reference actual bid/ask, delta, OI, theta from the data",
  "alternativeStrike": {"strike": 0.00, "type": "CALL|PUT", "reason": "why this is the runner-up"},
  "keyRisks": ["risk1", "risk2", "risk3"],
  "idealExitPlan": "specific exit criteria with prices",
  "confidenceScore": 75
}`;
}

// POST /api/agent/position-chat
router.post('/position-chat', async (req, res) => {
    const { message, positions = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required.' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set.' });

    // Build rich position context
    let posContext = 'No open positions.';
    if (positions.length) {
        posContext = positions.map(p => {
            const lines = [
                `Symbol: ${p.symbol} | Strategy: ${p.type} | Mkt Value: $${p.marketValue} | Unrealized P&L: ${p.unrealizedPnl >= 0 ? '+' : ''}$${p.unrealizedPnl} (${(p.unrealizedPnlRate * 100).toFixed(2)}%)`
            ];
            if (Array.isArray(p.legs)) {
                p.legs.forEach(l => {
                    if (l.instrumentType === 'EQUITY') {
                        lines.push(`  STOCK leg: ${p.qty} shares @ cost $${l.costPrice}/sh, last $${l.lastPrice}, unreal P&L $${l.unrealizedPnl}`);
                    } else if (l.instrumentType === 'OPTION') {
                        lines.push(`  OPTION leg: ${l.optionType} strike $${l.strike} exp ${l.expiry}, ${p.contracts} contracts @ cost $${l.costPrice}/contract, last $${l.lastPrice}, unreal P&L $${l.unrealizedPnl}`);
                    }
                });
            }
            return lines.join('\n');
        }).join('\n\n');
    }

    // Fetch live quotes for position symbols
    const symbols = [...new Set(positions.map(p => p.symbol).filter(Boolean))];
    const quoteLines = [];
    for (const sym of symbols) {
        try {
            const q = await webull.getQuote(sym);
            quoteLines.push(`${sym}: $${q.price} (${q.change >= 0 ? '+' : ''}${q.change}, ${(q.changeRatio * 100).toFixed(2)}%)`);
        } catch { /* skip */ }
    }

    const systemPrompt = `You are an expert options trading analyst with deep knowledge of risk management, options Greeks, and position management strategies.

The user has the following LIVE open positions (data from Webull):
${posContext}

LIVE MARKET QUOTES:
${quoteLines.join('\n') || 'Unavailable'}

Answer the user's question concisely and specifically using the actual position data above. Be direct — give specific numbers, specific strikes, specific actions. If recommending an adjustment or exit, explain exactly how to execute it. Keep responses under 250 words unless detail is specifically needed.`;

    try {
        const message_resp = await client.messages.create({
            model: 'claude-opus-4-7',
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }]
        });
        res.json({ reply: message_resp.content[0].text });
    } catch (e) {
        console.error('[Position Chat]', e.message);
        res.status(500).json({ error: e.message });
    }
});

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
        const ivRank = webull.getIvRank(sym);

        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set in .env' });
        }

        const prompt = buildStrikePrompt(sym, strategyPreference, chain, quote, ivRank);

        const message = await client.messages.create({
            model: 'claude-opus-4-7',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }]
        });

        const raw = message.content[0].text.trim();
        // Strip any accidental markdown fences
        const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const analysis = JSON.parse(jsonStr);
        analysis._source = 'claude-opus-4-7';

        res.json({
            ticker: sym,
            currentPrice: quote.price,
            change: quote.change,
            changeRatio: quote.changeRatio,
            atmIv: chain.atmIv,
            ivRank,
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
