const fs = require('fs');

const path = 'C:\\Users\\USER\\Downloads\\backup-2026-05-07T03-43-48.json';
const data = JSON.parse(fs.readFileSync(path, 'utf-8'));

const esc = s => String(s).replace(/'/g, "''");

const bs = data.tables.booking_status || [];
const values = bs.map(r => `('${esc(r.name)}','${esc(r.apply_date)}')`).join(',\n  ');

const sql1Only = `WITH backup_pairs(name, apply_date) AS (
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

fs.writeFileSync('C:\\Users\\USER\\Downloads\\sql1_check_booking_status.sql', sql1Only, 'utf-8');
console.log('Wrote: C:\\Users\\USER\\Downloads\\sql1_check_booking_status.sql');
console.log('Size:', Buffer.byteLength(sql1Only), 'bytes');
