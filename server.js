import { app } from "./api.js";
import { configDotenv } from "dotenv";

configDotenv({ debug: true });

const PORT = process.env.PORT || 3000

app.listen(Number(PORT), () => {
  console.log(`Server listening on port http://localhost:${PORT}`)
})
