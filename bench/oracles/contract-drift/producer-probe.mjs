import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const producerRoot = resolve(process.argv[2]);
const input = JSON.parse(process.argv[3]);
const before = structuredClone(input);
const module = await import(
  `${pathToFileURL(resolve(producerRoot, "event.mjs")).href}?probe=${Date.now()}`
);
const raw = module.encodeOrderEvent(input);
process.stdout.write(
  `${JSON.stringify({
    raw,
    inputUnchanged: JSON.stringify(input) === JSON.stringify(before),
    exports: Object.keys(module).sort(),
    arity: module.encodeOrderEvent.length,
  })}\n`,
);
