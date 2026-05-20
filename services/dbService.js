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

module.exports = { upsertSnapshot, getPnlHistory };
