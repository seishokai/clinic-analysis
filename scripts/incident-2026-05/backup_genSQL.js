const fs = require('fs');

const path = 'C:\\Users\\USER\\Downloads\\backup-2026-05-07T03-43-48.json';
const data = JSON.parse(fs.readFileSync(path, 'utf-8'));

// SQL文字列エスケープ
const esc = s => String(s).replace(/'/g, "''");

// === SQL 1: booking_status 行存在チェック ===
const bs = data.tables.booking_status || [];
const values = bs.map(r => `('${esc(r.name)}','${esc(r.apply_date)}')`).join(',\n  ');

const sql1 = `-- ===== SQL 1: booking_status 行存在チェック =====
-- バックアップ(${data.generated_at})に存在し、現DBに存在しない (name, apply_date) を検出
WITH backup_pairs(name, apply_date) AS (
  VALUES
  ${values}
)
SELECT bp.name, bp.apply_date
FROM backup_pairs bp
LEFT JOIN booking_status bs
  ON bs.name = bp.name AND bs.apply_date = bp.apply_date
WHERE bs.id IS NULL
ORDER BY bp.apply_date DESC;
`;

// === SQL 2: 全テーブル行数比較 ===
const tableCounts = {};
for (const [name, rows] of Object.entries(data.tables)) {
  if (Array.isArray(rows) && name !== 'change_log_recent') {
    tableCounts[name] = rows.length;
  }
}

const countQueries = Object.keys(tableCounts).map(t =>
  `SELECT '${t}' AS table_name, ${tableCounts[t]} AS backup_count, (SELECT COUNT(*) FROM ${t}) AS current_count`
).join('\nUNION ALL\n');

const sql2 = `-- ===== SQL 2: 全テーブル行数比較 =====
${countQueries}
ORDER BY table_name;
`;

// === SQL 3: manual_bookings 行存在チェック ===
const mb = data.tables.manual_bookings || [];
const mbValues = mb.map(r => `(${r.id})`).join(',\n  ');
const sql3 = `-- ===== SQL 3: manual_bookings 行存在チェック (id ベース) =====
WITH backup_ids(id) AS (
  VALUES
  ${mbValues}
)
SELECT bi.id
FROM backup_ids bi
LEFT JOIN manual_bookings mb ON mb.id = bi.id
WHERE mb.id IS NULL;
`;

// === SQL 4: bf_history 行存在チェック ===
const bh = data.tables.bf_history || [];
const bhValues = bh.map(r => `(${r.id})`).join(',\n  ');
const sql4 = `-- ===== SQL 4: bf_history 行存在チェック (id ベース) =====
WITH backup_ids(id) AS (
  VALUES
  ${bhValues}
)
SELECT bi.id
FROM backup_ids bi
LEFT JOIN bf_history bh ON bh.id = bi.id
WHERE bh.id IS NULL;
`;

const allSql = sql2 + '\n' + sql1 + '\n' + sql3 + '\n' + sql4;
fs.writeFileSync('C:\\Users\\USER\\Downloads\\check_missing_rows.sql', allSql, 'utf-8');

console.log('Generated SQL file:');
console.log('  C:\\Users\\USER\\Downloads\\check_missing_rows.sql');
console.log('');
console.log('Sizes:');
console.log(`  booking_status pairs: ${bs.length}`);
console.log(`  manual_bookings ids: ${mb.length}`);
console.log(`  bf_history ids: ${bh.length}`);
console.log(`  Total file size: ${Buffer.byteLength(allSql)} bytes`);
