// Helper spawned by dateFormat.test.js under a hostile TZ. Must stay a
// separate process: Node resolves the local timezone once at startup, so
// mutating process.env.TZ inside the test run does not reproduce the bug.
const { mmddyy, mmddyyUnderscored } = require("../../src/utils");

const dateStr = process.argv[2];

process.stdout.write(
  JSON.stringify({
    tz: process.env.TZ || null,
    mmddyy: mmddyy(dateStr),
    mmddyyUnderscored: mmddyyUnderscored(dateStr),
    // What the pre-fix code did, kept as a control so the test proves the
    // hostile TZ is actually in effect rather than silently passing.
    legacy: (() => {
      const dt = new Date(dateStr);
      const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
      const dd = dt.getDate().toString().padStart(2, "0");
      const yy = dt.getFullYear().toString().slice(-2);
      return `${mm}${dd}${yy}`;
    })(),
  }),
);
