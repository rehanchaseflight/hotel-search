const fs = require('fs');

for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

const db = require('./db');

const SOURCE_ID = 24;
const hotels = JSON.parse(fs.readFileSync('./book4trip-hotel-master.json', 'utf8'));
const BATCH = 1000;

async function main() {
  console.log('BOOK4TRIP FAST HOTEL IMPORT START');
  console.log(`HOTELS: ${hotels.length}`);

  await db.query('BEGIN');

  try {
    await db.query(
      'DELETE FROM supplier_hotels WHERE source_id = $1',
      [SOURCE_ID]
    );

    for (let i = 0; i < hotels.length; i += BATCH) {
      const batch = hotels.slice(i, i + BATCH);

      await db.query(
        `INSERT INTO supplier_hotels
         (source_id, country_id, destination_id, hotel_name, hotel_code, supplier_hotel_id, raw_data, active)
         SELECT
           $1,
           d.country_id,
           d.id,
           x.hotel_name,
           x.hotel_id,
           x.hotel_id,
           x.raw_data,
           true
         FROM jsonb_to_recordset($2::jsonb) AS x(
           country_code text,
           country_name text,
           destination_name text,
           destination_value text,
           hotel_name text,
           hotel_id text,
           raw_data jsonb
         )
         JOIN supplier_destinations d
           ON d.source_id = $1
          AND d.destination_value = x.destination_value`,
        [
          SOURCE_ID,
          JSON.stringify(batch.map(h => ({
            country_code: h.CountryCode,
            country_name: h.CountryName,
            destination_name: h.DestinationName,
            destination_value: h.DestinationValue,
            hotel_name: h.HotelName,
            hotel_id: String(h.HotelId),
            raw_data: h
          })))
        ]
      );

      console.log(`HOTELS IMPORTED: ${Math.min(i + BATCH, hotels.length)} / ${hotels.length}`);
    }

    await db.query('COMMIT');
    console.log('BOOK4TRIP FAST HOTEL IMPORT COMPLETE');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  process.exit(0);
}

main().catch(e => {
  console.error('BOOK4TRIP FAST HOTEL IMPORT ERROR:', e.message);
  process.exit(1);
});
