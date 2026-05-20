const axios = require('axios');

// ── Indicator math ────────────────────────────────────────────────────────────

function sma(arr, period) {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        if (i < period - 1) { out.push(null); continue; }
        out.push(arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
    }
    return out;
}

function ema(arr, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] == null) { out.push(null); continue; }
        if (prev == null) {
            // Seed with SMA of first `period` values
            if (i < period - 1) { out.push(null); continue; }
            prev = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
            out.push(parseFloat(prev.toFixed(4)));
        } else {
            prev = arr[i] * k + prev * (1 - k);
            out.push(parseFloat(prev.toFixed(4)));
        }
    }
    return out;
}

function rsi(closes, period = 14) {
    const changes = closes.map((v, i) => i === 0 ? 0 : v - closes[i - 1]);
    const out = Array(closes.length).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        if (changes[i] > 0) avgGain += changes[i];
        else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period; avgLoss /= period;
    for (let i = period; i < closes.length; i++) {
        if (i > period) {
            const gain = changes[i] > 0 ? changes[i] : 0;
            const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out[i] = parseFloat((100 - 100 / (1 + rs)).toFixed(2));
    }
    return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const macdLine = emaFast.map((v, i) => v != null && emaSlow[i] != null ? parseFloat((v - emaSlow[i]).toFixed(4)) : null);
    const validMacd = macdLine.filter(v => v != null);
    const sigLine = ema(validMacd, signal);
    // Re-align signal to full length
    const sigFull = Array(macdLine.length).fill(null);
    let si = 0;
    macdLine.forEach((v, i) => { if (v != null) { sigFull[i] = sigLine[si++]; } });
    const histogram = macdLine.map((v, i) => v != null && sigFull[i] != null ? parseFloat((v - sigFull[i]).toFixed(4)) : null);
    return { macdLine, signalLine: sigFull, histogram };
}

function bollingerBands(closes, period = 20, stdDev = 2) {
    const mid = sma(closes, period);
    const upper = [], lower = [];
    for (let i = 0; i < closes.length; i++) {
        if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
        const slice = closes.slice(i - period + 1, i + 1);
        const mean = mid[i];
        const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
        const sd = Math.sqrt(variance);
        upper.push(parseFloat((mean + stdDev * sd).toFixed(4)));
        lower.push(parseFloat((mean - stdDev * sd).toFixed(4)));
    }
    return { mid, upper, lower };
}

// ── Fetch + compute ───────────────────────────────────────────────────────────

async function getTechnicalData(symbol) {
    const sym = symbol.toUpperCase();
    const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}`, {
        params: { interval: '1d', range: '1y' },
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 8000
    });

    const result = res.data?.chart?.result?.[0];
    if (!result) throw new Error('No data from Yahoo');

    const timestamps = result.timestamp;
    const q = result.indicators.quote[0];
    const closes = q.close.map(v => v ? parseFloat(v.toFixed(4)) : null);
    const highs  = q.high.map(v => v ? parseFloat(v.toFixed(4)) : null);
    const lows   = q.low.map(v => v ? parseFloat(v.toFixed(4)) : null);
    const vols   = q.volume;

    const validCloses = closes.filter(Boolean);
    const last    = validCloses[validCloses.length - 1];
    const prev    = validCloses[validCloses.length - 2];

    // Indicators
    const rsi14   = rsi(closes.filter(Boolean), 14);
    const sma20   = sma(closes.filter(Boolean), 20);
    const sma50   = sma(closes.filter(Boolean), 50);
    const sma200  = sma(closes.filter(Boolean), 200);
    const { macdLine, signalLine, histogram } = macd(closes.filter(Boolean));
    const bb      = bollingerBands(closes.filter(Boolean), 20, 2);

    const last_rsi    = rsi14[rsi14.length - 1];
    const last_sma20  = sma20[sma20.length - 1];
    const last_sma50  = sma50[sma50.length - 1];
    const last_sma200 = sma200[sma200.length - 1];
    const last_macd   = macdLine[macdLine.length - 1];
    const last_signal = signalLine[signalLine.length - 1];
    const last_hist   = histogram[histogram.length - 1];
    const prev_hist   = histogram[histogram.length - 2];
    const last_bbUpper = bb.upper[bb.upper.length - 1];
    const last_bbMid   = bb.mid[bb.mid.length - 1];
    const last_bbLower = bb.lower[bb.lower.length - 1];

    // Support / resistance (recent 20-day high/low)
    const recent = closes.filter(Boolean).slice(-20);
    const recentHighs = highs.filter(Boolean).slice(-20);
    const recentLows  = lows.filter(Boolean).slice(-20);
    const resistance  = parseFloat(Math.max(...recentHighs).toFixed(2));
    const support     = parseFloat(Math.min(...recentLows).toFixed(2));

    // 52-week high/low
    const wk52High = parseFloat(Math.max(...highs.filter(Boolean)).toFixed(2));
    const wk52Low  = parseFloat(Math.min(...lows.filter(Boolean)).toFixed(2));

    // Average volume (20-day)
    const avgVol20 = Math.round(vols.filter(Boolean).slice(-20).reduce((a, b) => a + b, 0) / 20);

    // Trend signals
    const aboveSma20  = last > last_sma20;
    const aboveSma50  = last > last_sma50;
    const aboveSma200 = last > last_sma200;
    const macdBullish = last_macd > last_signal;
    const macdCrossUp = last_hist > 0 && prev_hist <= 0;
    const macdCrossDown = last_hist < 0 && prev_hist >= 0;
    const bbPosition  = last_bbUpper && last_bbLower
        ? parseFloat(((last - last_bbLower) / (last_bbUpper - last_bbLower) * 100).toFixed(1))
        : 50;

    // Overall technical signal
    let bullishSignals = 0, bearishSignals = 0;
    if (aboveSma20)   bullishSignals++;  else bearishSignals++;
    if (aboveSma50)   bullishSignals++;  else bearishSignals++;
    if (aboveSma200)  bullishSignals++;  else bearishSignals++;
    if (macdBullish)  bullishSignals++;  else bearishSignals++;
    if (last_rsi > 50) bullishSignals++; else bearishSignals++;

    const trendBias = bullishSignals >= 4 ? 'BULLISH' : bearishSignals >= 4 ? 'BEARISH' : 'NEUTRAL';

    return {
        symbol: sym, price: last, prevClose: prev,
        indicators: {
            rsi14: last_rsi,
            sma20: last_sma20, sma50: last_sma50, sma200: last_sma200,
            macd: last_macd, macdSignal: last_signal, macdHistogram: last_hist,
            bbUpper: last_bbUpper, bbMid: last_bbMid, bbLower: last_bbLower, bbPosition
        },
        levels: { support, resistance, wk52High, wk52Low },
        signals: { aboveSma20, aboveSma50, aboveSma200, macdBullish, macdCrossUp, macdCrossDown, trendBias },
        volume: { avgVol20 },
        bullishSignals, bearishSignals
    };
}

// ── Options sentiment ─────────────────────────────────────────────────────────

function getOptionsSentiment(chain) {
    const rows = chain.rows || [];
    let callVol = 0, putVol = 0, callOi = 0, putOi = 0;
    let otmCallIvSum = 0, otmCallCount = 0;
    let otmPutIvSum  = 0, otmPutCount  = 0;
    const S = chain.underlyingPrice;

    for (const row of rows) {
        if (row.call) { callVol += row.call.volume || 0; callOi += row.call.oi || 0; }
        if (row.put)  { putVol  += row.put.volume  || 0; putOi  += row.put.oi  || 0; }
        // OTM skew: 5% OTM strikes
        if (row.strike > S * 1.03 && row.strike < S * 1.10 && row.call?.iv) {
            otmCallIvSum += row.call.iv; otmCallCount++;
        }
        if (row.strike < S * 0.97 && row.strike > S * 0.90 && row.put?.iv) {
            otmPutIvSum  += row.put.iv;  otmPutCount++;
        }
    }

    const pcRatioVol = callVol > 0 ? parseFloat((putVol / callVol).toFixed(3)) : null;
    const pcRatioOI  = callOi  > 0 ? parseFloat((putOi  / callOi).toFixed(3)) : null;
    const avgOtmCallIv = otmCallCount ? otmCallIvSum / otmCallCount : 0;
    const avgOtmPutIv  = otmPutCount  ? otmPutIvSum  / otmPutCount  : 0;
    const ivSkew = avgOtmCallIv && avgOtmPutIv
        ? parseFloat((avgOtmPutIv / avgOtmCallIv).toFixed(3)) : null;

    // Sentiment signal
    let sentiment = 'NEUTRAL';
    if (pcRatioVol != null) {
        if (pcRatioVol > 1.2) sentiment = 'BEARISH';
        else if (pcRatioVol < 0.7) sentiment = 'BULLISH';
    }
    if (ivSkew != null && ivSkew > 1.15) sentiment = sentiment === 'BEARISH' ? 'VERY BEARISH' : 'BEARISH';

    return {
        callVolume: callVol, putVolume: putVol,
        callOI: callOi, putOI: putOi,
        pcRatioVolume: pcRatioVol,
        pcRatioOI: pcRatioOI,
        ivSkew,
        avgOtmCallIv: parseFloat((avgOtmCallIv * 100).toFixed(2)),
        avgOtmPutIv:  parseFloat((avgOtmPutIv  * 100).toFixed(2)),
        sentiment,
        atmIv: parseFloat((chain.atmIv * 100).toFixed(2))
    };
}

module.exports = { getTechnicalData, getOptionsSentiment };
