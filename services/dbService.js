const sql = require('mssql');

let pool = null;

async function getPool() {
    if (pool) return pool;
    const connStr = process.env.AZURE_SQL_CONNECTION_STRING;
    if (!connStr) throw new Error('AZURE_SQL_CONNECTION_STRING not set');
    pool = await sql.connect(connStr);
    await ensureSchema(pool);
    return pool;
}

async function ensureSchema(pool) {
    await pool.request().query(`
        IF NOT EXISTS (
            SELECT 1 FROM sysobjects WHERE name='daily_pnl' AND xtype='U'
        )
        CREATE TABLE daily_pnl (
            id              INT IDENTITY(1,1) PRIMARY KEY,
            snapshot_date   DATE NOT NULL UNIQUE,
            net_liquidation DECIMAL(18,2) NOT NULL,
            market_value    DECIMAL(18,2) NOT NULL,
            cash_balance    DECIMAL(18,2) NOT NULL,
            unrealized_pnl  DECIMAL(18,2) NOT NULL,
            buying_power    DECIMAL(18,2) NOT NULL,
            recorded_at     DATETIME2 DEFAULT GETUTCDATE()
        )
    `);

    await pool.request().query(`
        IF NOT EXISTS (
            SELECT 1 FROM sysobjects WHERE name='trades' AND xtype='U'
        )
        CREATE TABLE trades (
            id               INT IDENTITY(1,1) PRIMARY KEY,
            order_id         NVARCHAR(64)   NOT NULL UNIQUE,
            symbol           NVARCHAR(16)   NOT NULL,
            instrument_type  NVARCHAR(16)   NULL,
            strategy         NVARCHAR(32)   NULL,
            action           NVARCHAR(8)    NULL,
            intent           NVARCHAR(32)   NULL,
            qty              DECIMAL(18,4)  NULL,
            price            DECIMAL(18,4)  NULL,
            total            DECIMAL(18,2)  NULL,
            cash_flow        DECIMAL(18,2)  NULL,
            trade_date       DATE           NULL,
            trade_datetime   DATETIME2      NULL,
            filled_ms        BIGINT         NULL,
            legs             NVARCHAR(MAX)  NULL,
            source           NVARCHAR(16)   NULL,
            recorded_at      DATETIME2      DEFAULT GETUTCDATE()
        )
    `);
}

async function upsertSnapshot(data) {
    const pool = await getPool();
    const { date, netLiquidation, marketValue, cashBalance, unrealizedPnl, buyingPower } = data;
    await pool.request()
        .input('date',           sql.Date,          date)
        .input('netLiquidation', sql.Decimal(18,2),  netLiquidation)
        .input('marketValue',    sql.Decimal(18,2),  marketValue)
        .input('cashBalance',    sql.Decimal(18,2),  cashBalance)
        .input('unrealizedPnl',  sql.Decimal(18,2),  unrealizedPnl)
        .input('buyingPower',    sql.Decimal(18,2),  buyingPower)
        .query(`
            MERGE daily_pnl AS target
            USING (SELECT @date AS snapshot_date) AS source
            ON target.snapshot_date = source.snapshot_date
            WHEN MATCHED THEN
                UPDATE SET
                    net_liquidation = @netLiquidation,
                    market_value    = @marketValue,
                    cash_balance    = @cashBalance,
                    unrealized_pnl  = @unrealizedPnl,
                    buying_power    = @buyingPower,
                    recorded_at     = GETUTCDATE()
            WHEN NOT MATCHED THEN
                INSERT (snapshot_date, net_liquidation, market_value, cash_balance, unrealized_pnl, buying_power)
                VALUES (@date, @netLiquidation, @marketValue, @cashBalance, @unrealizedPnl, @buyingPower);
        `);
}

async function getPnlHistory(days = 90) {
    const pool = await getPool();
    const result = await pool.request()
        .input('days', sql.Int, days)
        .query(`
            SELECT TOP (@days)
                snapshot_date   AS date,
                net_liquidation AS netLiquidation,
                market_value    AS marketValue,
                cash_balance    AS cashBalance,
                unrealized_pnl  AS unrealizedPnl,
                buying_power    AS buyingPower,
                recorded_at     AS recordedAt
            FROM daily_pnl
            ORDER BY snapshot_date DESC
        `);
    return result.recordset.reverse();
}

// Upsert a batch of flattened trade records (idempotent by order_id)
async function upsertTrades(trades) {
    if (!trades || !trades.length) return 0;
    const pool = await getPool();
    let saved = 0;
    for (const t of trades) {
        try {
            await pool.request()
                .input('order_id',        sql.NVarChar(64),    t.id || '')
                .input('symbol',          sql.NVarChar(16),    t.symbol || '')
                .input('instrument_type', sql.NVarChar(16),    t.instrumentType || null)
                .input('strategy',        sql.NVarChar(32),    t.strategy || null)
                .input('action',          sql.NVarChar(8),     t.action || null)
                .input('intent',          sql.NVarChar(32),    t.intent || null)
                .input('qty',             sql.Decimal(18,4),   t.qty || null)
                .input('price',           sql.Decimal(18,4),   t.price || null)
                .input('total',           sql.Decimal(18,2),   t.total || null)
                .input('cash_flow',       sql.Decimal(18,2),   t.cashFlow || null)
                .input('trade_date',      sql.Date,            t.date ? new Date(t.date) : null)
                .input('trade_datetime',  sql.DateTime2,       t.datetime ? new Date(t.datetime) : null)
                .input('filled_ms',       sql.BigInt,          t.filledMs || null)
                .input('legs',            sql.NVarChar(sql.MAX), t.legs ? JSON.stringify(t.legs) : null)
                .input('source',          sql.NVarChar(16),    t.source || 'webull')
                .query(`
                    MERGE trades AS target
                    USING (SELECT @order_id AS order_id) AS source
                    ON target.order_id = source.order_id
                    WHEN MATCHED THEN
                        UPDATE SET
                            symbol          = @symbol,
                            instrument_type = @instrument_type,
                            strategy        = @strategy,
                            action          = @action,
                            intent          = @intent,
                            qty             = @qty,
                            price           = @price,
                            total           = @total,
                            cash_flow       = @cash_flow,
                            trade_date      = @trade_date,
                            trade_datetime  = @trade_datetime,
                            filled_ms       = @filled_ms,
                            legs            = @legs,
                            source          = @source
                    WHEN NOT MATCHED THEN
                        INSERT (order_id, symbol, instrument_type, strategy, action, intent,
                                qty, price, total, cash_flow, trade_date, trade_datetime,
                                filled_ms, legs, source)
                        VALUES (@order_id, @symbol, @instrument_type, @strategy, @action, @intent,
                                @qty, @price, @total, @cash_flow, @trade_date, @trade_datetime,
                                @filled_ms, @legs, @source);
                `);
            saved++;
        } catch (e) {
            console.error('[DB] upsertTrade failed for', t.id, e.message);
        }
    }
    return saved;
}

// Return all trades from DB ordered oldest-first
async function getAllTrades() {
    const pool = await getPool();
    const result = await pool.request().query(`
        SELECT
            order_id       AS id,
            symbol,
            instrument_type AS instrumentType,
            strategy,
            action,
            intent,
            CAST(qty   AS FLOAT) AS qty,
            CAST(price AS FLOAT) AS price,
            CAST(total AS FLOAT) AS total,
            CAST(cash_flow AS FLOAT) AS cashFlow,
            CONVERT(VARCHAR(10), trade_date, 23) AS date,
            trade_datetime AS datetime,
            filled_ms      AS filledMs,
            legs,
            source
        FROM trades
        ORDER BY filled_ms ASC
    `);
    return result.recordset.map(r => ({
        ...r,
        legs: r.legs ? JSON.parse(r.legs) : [],
        filledMs: Number(r.filledMs)
    }));
}

module.exports = { upsertSnapshot, getPnlHistory, upsertTrades, getAllTrades };
