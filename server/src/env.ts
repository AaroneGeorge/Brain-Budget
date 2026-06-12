import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// .env lives at the repo root, two levels up from server/src (or server/scripts).
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });
