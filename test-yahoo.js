const axios = require('axios');

async function test() {
    // Use v8 chart endpoint for quote (no crumb needed)
    const qr = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/IWM?interval=1d&range=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const meta = qr.data.chart.result[0].meta;
    console.log('quote price:', meta.regularMarketPrice, 'prev close:', meta.chartPreviousClose);

    // For options, try query2 v8 with no crumb
    const r3 = await axios.get('https://query2.finance.yahoo.com/v8/finance/options/IWM', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });
    const res = r3.data.optionChain.result[0];
    console.log('price:', res.quote.regularMarketPrice);
    console.log('expiries:', res.expirationDates.slice(0,5).map(t => new Date(t*1000).toISOString().split('T')[0]));
    const c = res.options[0].calls[5];
    console.log('sample call:', { strike: c.strike, bid: c.bid, ask: c.ask, iv: c.impliedVolatility, delta: c.delta, volume: c.volume, oi: c.openInterest });
}
test().catch(e => console.error('FAIL:', e.message));
