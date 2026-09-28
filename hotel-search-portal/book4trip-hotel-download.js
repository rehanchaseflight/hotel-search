const fs = require("fs");

const BASE = "https://www.book4trip.com";

const destinations = JSON.parse(
  fs.readFileSync("book4trip-destination-master.json", "utf8")
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const hotels = [];
  const errors = [];
  const empty = [];

  console.log("BOOK4TRIP HOTEL DOWNLOAD START");
  console.log("DESTINATIONS:", destinations.length);

  for (let i = 0; i < destinations.length; i++) {
    const destination = destinations[i];

    if (!destination.DestinationValue) continue;

    try {
      const response = await fetch(
        `${BASE}/ajax/ajax_hotel_list.php?sel_city=${encodeURIComponent(destination.DestinationValue)}`
      );

      if (!response.ok) {
        errors.push({
          CountryCode: destination.CountryCode,
          CountryName: destination.CountryName,
          DestinationName: destination.DestinationName,
          DestinationValue: destination.DestinationValue,
          Status: response.status
        });

        console.log(
          `[${i + 1}/${destinations.length}] ERROR ${destination.DestinationName} ${response.status}`
        );

        continue;
      }

      const html = await response.text();

      const matches = [
        ...html.matchAll(
          /new Option\('((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)'(?:,\s*true)?\)/g
        )
      ];

      const rows = matches.filter(
        x => x[1] !== "- Please select a hotel -"
      );

      if (!rows.length) {
        empty.push({
          CountryCode: destination.CountryCode,
          CountryName: destination.CountryName,
          DestinationName: destination.DestinationName,
          DestinationValue: destination.DestinationValue
        });
      }

      for (const x of rows) {
        hotels.push({
          CountryCode: destination.CountryCode,
          CountryName: destination.CountryName,
          DestinationName: destination.DestinationName,
          DestinationValue: destination.DestinationValue,
          HotelName: x[1],
          HotelId: x[2]
        });
      }

      console.log(
        `[${i + 1}/${destinations.length}] ${destination.DestinationName}: ${rows.length}`
      );

      fs.writeFileSync("book4trip-hotel-master.json", JSON.stringify(hotels, null, 2), "utf8");
      fs.writeFileSync("book4trip-hotel-errors.json", JSON.stringify(errors, null, 2), "utf8");
      fs.writeFileSync("book4trip-hotel-empty.json", JSON.stringify(empty, null, 2), "utf8");
      await sleep(100);
    } catch (error) {
      errors.push({
        CountryCode: destination.CountryCode,
        CountryName: destination.CountryName,
        DestinationName: destination.DestinationName,
        DestinationValue: destination.DestinationValue,
        Error: error.message
      });

      console.log(
        `[${i + 1}/${destinations.length}] ERROR ${destination.DestinationName}: ${error.message}`
      );
    }
  }

  fs.writeFileSync(
    "book4trip-hotel-master.json",
    JSON.stringify(hotels, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    "book4trip-hotel-errors.json",
    JSON.stringify(errors, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    "book4trip-hotel-empty.json",
    JSON.stringify(empty, null, 2),
    "utf8"
  );

  console.log("");
  console.log("BOOK4TRIP HOTEL DOWNLOAD COMPLETE");
  console.log("HOTELS:", hotels.length);
  console.log("ERROR DESTINATIONS:", errors.length);
  console.log("EMPTY DESTINATIONS:", empty.length);
}

main().catch(error => {
  console.error("FATAL:", error);
  process.exit(1);
});

