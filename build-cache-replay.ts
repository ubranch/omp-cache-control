import { join } from "node:path";

for (const name of ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-utils"]) {
	const sdk = await Bun.file(join(import.meta.dir, "node_modules", name, "package.json")).json();
	if (sdk.version !== "18.8.7") throw new Error(`Replay helpers require ${name}@18.8.7; found ${sdk.version}`);
}
const license = await Bun.file(join(import.meta.dir, "node_modules/@oh-my-pi/pi-ai/LICENSE")).text();
const result = await Bun.build({
	entrypoints: [join(import.meta.dir, "cache-control-replay-entry.ts")],
	outdir: import.meta.dir,
	naming: "cache-control-replay.js",
	target: "bun",
	format: "esm",
	banner: `// Generated from pi-ai/pi-utils 18.8.7 by bun run build:cache-replay; do not edit.\n/*!\n${license}\n*/`,
	plugins: [{ name: "host-sdk-exports", setup(build) {
		// Externalize only the public root; abortableSource's unexposed subpath must be bundled.
		build.onResolve({ filter: /^@oh-my-pi\/pi-utils$/ }, () => ({
			path: "@oh-my-pi/pi-utils", external: true,
		}));
		build.onResolve({ filter: /^\.\/providers\/transform-messages$/ }, () => ({
			path: "@oh-my-pi/pi-ai/providers/transform-messages", external: true,
		}));
	} }],
});
if (!result.success) throw new AggregateError(result.logs, "Replay helper bundle failed");
