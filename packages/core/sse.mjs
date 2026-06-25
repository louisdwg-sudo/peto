export function parseSseUsage(buffer) {
  let usage = null;
  const events = String(buffer || "").split(/\n\n+/);
  for (const event of events) {
    const dataLines = event
      .split(/\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .filter(line => line && line !== "[DONE]");
    for (const line of dataLines) {
      try {
        const parsed = JSON.parse(line);
        const candidate = parsed?.response?.usage ?? parsed?.usage;
        if (candidate) usage = candidate;
      } catch {
        // Ignore non-JSON stream fragments.
      }
    }
  }
  return usage;
}
