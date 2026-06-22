import fs from "node:fs";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function appendJsonl(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = data.timestamp ? data : { timestamp: nowIso(), ...data };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return row;
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return { rows: [], invalid: 0 };
  let invalid = 0;
  const rows = fs
    .readFileSync(file, "utf8")
    .split(/\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        invalid += 1;
        return null;
      }
    })
    .filter(Boolean);
  return { rows, invalid };
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
