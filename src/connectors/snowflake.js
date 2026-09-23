// Snowflake SQL API v2. Docs: https://docs.snowflake.com/en/developer-guide/sql-api/reference
// Reads product usage (the product's own warehouse tables) and writes one row per hub action.
import { send } from './http.js';

const cfg = () => ({
  account: process.env.SNOWFLAKE_ACCOUNT, // e.g. myorg-myaccount
  token: process.env.SNOWFLAKE_TOKEN, // programmatic access token or key-pair JWT
  tokenType: process.env.SNOWFLAKE_TOKEN_TYPE || 'PROGRAMMATIC_ACCESS_TOKEN',
  warehouse: process.env.SNOWFLAKE_WAREHOUSE || 'GTM_WH',
  database: process.env.SNOWFLAKE_DATABASE || 'ANALYTICS',
  role: process.env.SNOWFLAKE_ROLE || 'GTM_HUB',
});
export const isLive = () => Boolean(cfg().account && cfg().token);

// Snowflake bindings are positional: { "1": { type, value }, ... }
const bindings = (values) =>
  Object.fromEntries(values.map((v, i) => [String(i + 1), { type: typeof v === 'number' ? 'FIXED' : 'TEXT', value: String(v) }]));

function statement(action, sql, values, mockRows, summary) {
  const c = cfg();
  return send({
    system: 'snowflake',
    action,
    summary,
    method: 'POST',
    url: `https://${c.account || 'reeco'}.snowflakecomputing.com/api/v2/statements`,
    headers: { Authorization: `Bearer ${c.token}`, 'X-Snowflake-Authorization-Token-Type': c.tokenType },
    body: { statement: sql, timeout: 30, warehouse: c.warehouse, database: c.database, role: c.role, bindings: bindings(values) },
    live: isLive(),
    mockResponse: () => {
      const rows = typeof mockRows === 'function' ? mockRows() : mockRows;
      const cols = rows[0] ? Object.keys(rows[0]) : [];
      return {
        statementHandle: crypto.randomUUID(),
        message: 'Statement executed successfully.',
        resultSetMetaData: { numRows: rows.length, rowType: cols.map((name) => ({ name: name.toUpperCase() })) },
        data: rows.map((r) => cols.map((k) => String(r[k]))),
      };
    },
  });
}

// Turns the SQL API's column/row arrays into objects.
export function rowsOf(entry) {
  const meta = entry.response?.resultSetMetaData?.rowType ?? [];
  return (entry.response?.data ?? []).map((row) =>
    Object.fromEntries(meta.map((col, i) => [col.name.toLowerCase(), row[i]]))
  );
}

export function queryUsage(hubspotCompanyId, mockRow) {
  return statement(
    'Query product usage',
    `SELECT properties_live, active_users, pos_30d, invoices_ai_30d, spend_30d, vendors_connected, last_active
       FROM PRODUCT.ACCOUNT_USAGE_DAILY
      WHERE hubspot_company_id = ?
      ORDER BY snapshot_date DESC
      LIMIT 1`,
    [hubspotCompanyId],
    () => [mockRow()],
    'Pulled the latest product usage and platform status'
  );
}

export function trackEvent(event, accountId, actor, props = {}) {
  return statement(
    `Log event ${event}`,
    'INSERT INTO GTM.HUB_EVENTS (event, account_id, actor, props, occurred_at) SELECT ?, ?, ?, PARSE_JSON(?), CURRENT_TIMESTAMP()',
    [event, accountId ?? '', actor ?? 'system', JSON.stringify(props)],
    [],
    'Recorded it for reporting'
  );
}
