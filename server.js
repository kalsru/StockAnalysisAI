require('dotenv').config();
const express = require('express');
const app = express();

const agentRoutes = require('./routes/agent');
const optionsRoutes = require('./routes/options');
const positionsRoutes = require('./routes/positions');
const analyticsRoutes = require('./routes/analytics');
const screenerRoutes = require('./routes/screener');

const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public'));

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

app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`  Webull Options Analyzer v2.0`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  API Key: ${process.env.WEBULL_API_KEY ? 'configured' : 'not set'}`);
    console.log(`  GCP Project: ${process.env.GCP_PROJECT_ID}`);
    console.log(`=================================================`);
});
