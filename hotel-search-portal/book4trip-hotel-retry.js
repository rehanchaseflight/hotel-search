const fs = require("fs");

const BASE = "https://www.book4trip.com";

const errors = JSON.parse(
  fs.readFileSync("book4trip-hotel-retry-errors.json", "utf8")
);

const hotels = fs.existsSync("book4trip-hotel-master.json")
  ? JSON.parse(fs.readFileSync("book4trip-hotel-master.json", "utf8"))
  : [];

const empty = fs.existsSync("book4trip-hotel-empty.json")
  ? JSON.parse(fs.readFileSync("book4trip-hotel-empty.json", "utf8"))
  : [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("BOOK4TRIP FAILED DESTINATION RETRY START");
  console.log("FAILED DESTINATIONS:", errors.length);
  console.log("EXISTING HOTELS:", hotels.length);

  const remainingErrors = [];
  const retryEmpty = [];

  for (let i = 0; i < errors.length; i++) {
    const destination = errors[i];

    try {
      const response = await fetch(
        `${BASE}/ajax/ajax_hotel_list.php?sel_city=${encodeURIComponent(destination.DestinationValue)}`
      );

      if (!response.ok) {
        remainingErrors.push({
          ...destination,
          RetryStatus: response.status
        });

        console.log(
          `[${i + 1}/${errors.length}] ERROR ${destination.DestinationName} HTTP ${response.status}`
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
        retryEmpty.push(destination);

        console.log(
          `[${i + 1}/${errors.length}] EMPTY ${destination.DestinationName}`
        );
      } else {
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
          `[${i + 1}/${errors.length}] ${destination.DestinationName}: ${rows.length}`
        );
      }

      if ((i + 1) % 100 === 0) {
        fs.writeFileSync(
          "book4trip-hotel-master.json",
          JSON.stringify(hotels, null, 2),
          "utf8"
        );

        fs.writeFileSync(
          "book4trip-hotel-retry-errors.json",
          JSON.stringify(remainingErrors, null, 2),
          "utf8"
        );

        fs.writeFileSync(
          "book4trip-hotel-retry-empty.json",
          JSON.stringify(retryEmpty, null, 2),
          "utf8"
        );
      }

      await sleep(150);
    } catch (error) {
      remainingErrors.push({
        ...destination,
        RetryError: error.message
      });

      console.log(
        `[${i + 1}/${errors.length}] FETCH ERROR ${destination.DestinationName}: ${error.message}`
      );
    }
  }

  fs.writeFileSync(
    "book4trip-hotel-master.json",
    JSON.stringify(hotels, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    "book4trip-hotel-retry-errors.json",
    JSON.stringify(remainingErrors, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    "book4trip-hotel-retry-empty.json",
    JSON.stringify(retryEmpty, null, 2),
    "utf8"
  );

  console.log("");
  console.log("BOOK4TRIP FAILED DESTINATION RETRY COMPLETE");
  console.log("TOTAL HOTELS:", hotels.length);
  console.log("RETRY EMPTY:", retryEmpty.length);
  console.log("RETRY ERRORS:", remainingErrors.length);
}

main().catch(error => {
  console.error("FATAL:", error);
  process.exit(1);
});

