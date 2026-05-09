const fs = require('fs');

const path = 'C:\\Users\\USER\\Downloads\\backup-2026-05-07T03-43-48.json';
const data = JSON.parse(fs.readFileSync(path, 'utf-8'));

console.log('=== METADATA ===');
console.log('generated_at:', data.generated_at);
console.log('generated_by:', data.generated_by);
console.log('');

console.log('=== TABLE ROW COUNTS ===');
const tables = data.tables || {};
for (const [name, rows] of Object.entries(tables)) {
  if (Array.isArray(rows)) {
    console.log(`${name}: ${rows.length}`);
  } else {
    console.log(`${name}: <error: ${JSON.stringify(rows)}>`);
  }
}
console.log('');

console.log('=== booking_status SAMPLE ROW ===');
const bs = tables.booking_status || [];
if (bs.length > 0) {
  console.log(JSON.stringify(bs[0], null, 2));
}
console.log('');

console.log('=== booking_status (name, apply_date) UNIQUE COUNT ===');
const pairs = new Set();
for (const r of bs) {
  pairs.add(`${r.name}||${r.apply_date}`);
}
console.log(`unique pairs: ${pairs.size}`);
console.log(`total rows: ${bs.length}`);
console.log('');

console.log('=== manual_bookings SAMPLE ROW ===');
const mb = tables.manual_bookings || [];
if (mb.length > 0) {
  console.log(JSON.stringify(mb[0], null, 2));
}
