const fs = require('fs');
const db = require('./db');

const SOURCE_ID = 24;
const hotels = JSON.parse(
  fs.readFileSync('./book4trip-hotel-master.json', 'utf8')
);

async function main() {
  console.log(`BOOK4TRIP HOTEL IMPORT START`);
  console.log(`HOTELS: ${hotels.length}`);

  let imported = 0;
  let skipped = 0;

  for (const h of hotels) {
    const destination = await db.query(
      `SELECT id, country_id
       FROM supplier_destinations
       WHERE source_id = $1
         AND destination_value = $2
       LIMIT 1`,
      [SOURCE_ID, h.DestinationValue]
    );

    if (!destination.rows.length) {
      skipped++;
      continue;
    }

    await db.query(
      `INSERT INTO supplier_hotels
       (source_id, country_id, destination_id, hotel_name, hotel_code, supplier_hotel_id, raw_data, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT DO NOTHING`,
      [
        SOURCE_ID,
        destination.rows[0].country_id,
        destination.rows[0].id,
        h.HotelName,
        h.HotelId,
        h.HotelId,
        JSON.stringify(h)
      ]
    );

    imported++;

    if (imported % 1000 === 0) {
      console.log(`HOTELS IMPORTED: ${imported} / ${hotels.length}`);
    }
  }

  console.log(`BOOK4TRIP HOTEL IMPORT COMPLETE`);
  console.log(`IMPORTED: ${imported}`);
  console.log(`SKIPPED: ${skipped}`);

  process.exit(0);
}

main().catch(err => {
  console.error('BOOK4TRIP HOTEL IMPORT ERROR:', err);
  process.exit(1);
});
