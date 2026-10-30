"use strict";
require("dotenv").config({ path: ".env.local" });

const { app } = require("./server");

const port = Number(process.env.PORT) || 3000;

if (require.main === module) {
  app.listen(port, () =>
    console.log(`Aegis API listening on http://localhost:${port}`),
  );
}
