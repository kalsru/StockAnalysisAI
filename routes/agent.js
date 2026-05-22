const express = require('express');
const router = express.Router();
const webull = require('../services/webullService');
const { getTechnicalData, getOptionsSentiment } = require('../services/technicalService');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildStrikePrompt(ticker, strategyPref, chain, quote, ivRank, tech, sentiment) {
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

    const techSection = tech ? `
TECHNICAL ANALYSIS (1-year daily):
- RSI(14): ${tech.indicators.rsi14} ${tech.indicators.rsi14 > 70 ? '⚠ OVERBOUGHT' : tech.indicators.rsi14 < 30 ? '⚠ OVERSOLD' : ''}
- SMA20: $${tech.indicators.sma20} | SMA50: $${tech.indicators.sma50} | SMA200: $${tech.indicators.sma200}
- Price vs MAs: ${tech.signals.aboveSma20?'ABOVE':'BELOW'} SMA20, ${tech.signals.aboveSma50?'ABOVE':'BELOW'} SMA50, ${tech.signals.aboveSma200?'ABOVE':'BELOW'} SMA200
- MACD: ${tech.indicators.macd?.toFixed(3)} | Signal: ${tech.indicators.macdSignal?.toFixed(3)} | Histogram: ${tech.indicators.macdHistogram?.toFixed(3)} ${tech.signals.macdCrossUp?'🔼 BULLISH CROSS':tech.signals.macdCrossDown?'🔽 BEARISH CROSS':''}
- Bollinger Bands: Upper $${tech.indicators.bbUpper} | Mid $${tech.indicators.bbMid} | Lower $${tech.indicators.bbLower} | Price at ${tech.indicators.bbPosition}% of band
- Support: $${tech.levels.support} | Resistance: $${tech.levels.resistance}
- 52-week High: $${tech.levels.wk52High} | 52-week Low: $${tech.levels.wk52Low}
- Trend Bias: ${tech.signals.trendBias} (${tech.bullishSignals}/5 bullish signals)` : '';

    const sentSection = sentiment ? `
OPTIONS SENTIMENT:
- Put/Call Volume Ratio: ${sentiment.pcRatioVolume} ${sentiment.pcRatioVolume > 1.2 ? '(BEARISH flow)' : sentiment.pcRatioVolume < 0.7 ? '(BULLISH flow)' : '(NEUTRAL)'}
- Put/Call OI Ratio: ${sentiment.pcRatioOI}
- Call Volume: ${sentiment.callVolume?.toLocaleString()} | Put Volume: ${sentiment.putVolume?.toLocaleString()}
- OTM Call IV: ${sentiment.avgOtmCallIv}% | OTM Put IV: ${sentiment.avgOtmPutIv}%
- IV Skew (Put/Call): ${sentiment.ivSkew} ${sentiment.ivSkew > 1.15 ? '(elevated put skew — hedging demand)' : '(normal)'}
- Options Sentiment Signal: ${sentiment.sentiment}` : '';

    return `You are an expert options trader. Analyze the full dataset below — technical indicators, options sentiment, and live chain data — to select the BEST strike for this trade.

LIVE MARKET DATA:
- Ticker: ${ticker}
- Current Price: $${S}
- Daily Change: ${quote.change >= 0 ? '+' : ''}${quote.change} (${(quote.changeRatio*100).toFixed(2)}%)
- Expiry: ${T}
- ATM IV: ${(chain.atmIv*100).toFixed(1)}%
- IV Rank: ${ivRank}% (${ivRank > 60 ? 'HIGH — favor selling premium' : ivRank > 35 ? 'MODERATE' : 'LOW — favor buying options'})
- Strategy Preference: ${strategyPref}
${techSection}
${sentSection}

OPTIONS CHAIN (ATM ±15 strikes):
 STRIKE  | ────────────────── CALLS ──────────────────────── | ────────────────── PUTS ──────────────────────────
${strikeTable}

TASK: Using ALL data above (technical trend, sentiment, AND chain data), select the BEST strike(s).
- Align with the technical trend — don't fight the tape
- Incorporate sentiment signal into your bias
- Choose strikes with good liquidity (OI > 500, tight bid/ask)
- Explain how technicals and sentiment informed the strike choice

Respond ONLY with valid JSON, no markdown:
{
  "recommendedStrategy": "clear strategy name",
  "strategyType": "CREDIT_SPREAD|DEBIT_SPREAD|IRON_CONDOR|COVERED_CALL|LONG_CALL|LONG_PUT|CASH_SECURED_PUT|STRADDLE|STRANGLE",
  "legs": [
    {"action": "BUY|SELL", "type": "CALL|PUT", "strike": 0.00, "expiry": "${T}", "contracts": 1, "bid": 0.00, "ask": 0.00, "delta": 0.00, "iv": 0.00, "whyThisStrike": "specific reason referencing bid/ask, delta, OI, technical levels"}
  ],
  "netCredit": 0.00,
  "maxProfit": 0.00,
  "maxLoss": 0.00,
  "breakeven": 0.00,
  "probabilityOfProfit": "XX%",
  "ivRankAssessment": "LOW|MEDIUM|HIGH|ELEVATED",
  "marketBias": "BULLISH|BEARISH|NEUTRAL",
  "riskRewardRatio": "1:X",
  "technicalSummary": "2 sentences on what RSI, MACD, MAs and price action say",
  "sentimentSummary": "1-2 sentences on what put/call ratio and IV skew indicate",
  "strikeSelectionRationale": "2-3 sentences explaining how technicals + sentiment + chain data led to these specific strikes",
  "alternativeStrike": {"strike": 0.00, "type": "CALL|PUT", "reason": "runner-up and why"},
  "keyRisks": ["risk1", "risk2", "risk3"],
  "idealExitPlan": "specific exit criteria with prices",
  "confidenceScore": 75
}`;
}

// GET /api/agent/technical/:symbol
router.get('/technical/:symbol', async (req, res) => {
    try {
        const tech = await getTechnicalData(req.params.symbol.toUpperCase());
        res.json({ ok: true, data: tech });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/agent/position-chat
router.post('/position-chat', async (req, res) => {
    const { message, positions = [], image, chain } = req.body;
    if (!message && !image) return res.status(400).json({ error: 'Message or image required.' });
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

    // Build options chain section if provided
    let chainSection = '';
    if (chain && Array.isArray(chain.rows) && chain.rows.length) {
        const S = chain.underlyingPrice;
        const strikeTable = chain.rows.map(r => {
            const c = r.call, p = r.put;
            const atm = Math.abs(r.strike - S) < 0.51 ? ' ← ATM' : '';
            return `$${r.strike.toFixed(2).padStart(7)} | CALL bid=${c?.bid??'--'} ask=${c?.ask??'--'} iv=${c?.iv?(c.iv*100).toFixed(1)+'%':'--'} delta=${c?.delta??'--'} oi=${c?.oi??0} vol=${c?.volume??0} | PUT bid=${p?.bid??'--'} ask=${p?.ask??'--'} iv=${p?.iv?(p.iv*100).toFixed(1)+'%':'--'} delta=${p?.delta??'--'} oi=${p?.oi??0} vol=${p?.volume??0}${atm}`;
        }).join('\n');

        chainSection = `

LIVE OPTIONS CHAIN — ${chain.symbol} (expiry: ${chain.expiry}, price: $${S}, ATM IV: ${chain.atmIv?(chain.atmIv*100).toFixed(1)+'%':'--'}, source: ${chain.source}):
 STRIKE  | ── CALLS ──────────────────────────────── | ── PUTS ──────────────────────────────────
${strikeTable}`;
    }

    const systemPrompt = `You are an expert options trading analyst with deep knowledge of risk management, options Greeks, and position management strategies.

The user has the following LIVE open positions (data from Webull):
${posContext}

LIVE MARKET QUOTES:
${quoteLines.join('\n') || 'Unavailable'}${chainSection}

Answer the user's question concisely and specifically using the actual position and chain data above. Be direct — give specific numbers, specific strikes, specific actions. Reference actual bid/ask, delta, and OI from the chain when relevant. If recommending an adjustment or exit, explain exactly how to execute it. Keep responses under 300 words unless detail is specifically needed.`;

    // Build user message content — support text + optional image
    let userContent;
    if (image && image.startsWith('data:image/')) {
        const matches = image.match(/^data:(image\/\w+);base64,(.+)$/);
        if (matches) {
            const mediaType = matches[1]; // e.g. image/png
            const base64Data = matches[2];
            userContent = [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
                { type: 'text', text: message || 'Please analyze this image in the context of my positions.' }
            ];
        } else {
            userContent = message;
        }
    } else {
        userContent = message;
    }

    try {
        const message_resp = await client.messages.create({
            model: 'claude-opus-4-7',
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: 'user', content: userContent }]
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

        // Fetch technical + sentiment in parallel (non-blocking on failure)
        const [tech, sentiment] = await Promise.all([
            getTechnicalData(sym).catch(e => { console.warn('[Tech]', e.message); return null; }),
            Promise.resolve(getOptionsSentiment(chain))
        ]);

        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set in .env' });
        }

        const prompt = buildStrikePrompt(sym, strategyPreference, chain, quote, ivRank, tech, sentiment);

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
            technical: tech,
            sentiment,
            ...analysis
        });
    } catch (error) {
        console.error('[Agent Error]', error.message);
        res.status(500).json({ error: 'Analysis failed: ' + error.message });
    }
});

module.exports = router;
