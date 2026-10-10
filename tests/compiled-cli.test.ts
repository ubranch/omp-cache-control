import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("compiled OMP loads Cache Control and advertises /cache without extension load failures", async () => {
	const omp = process.env.OMP_COMPILED_CLI || Bun.which("omp");
	assert(omp, "Put the compiled OMP CLI on PATH or set OMP_COMPILED_CLI before running this E2E check");
	const magic = new Uint8Array(await Bun.file(omp).slice(0, 4).arrayBuffer());
	assert(magic[0] === 0x4d && magic[1] === 0x5a
		|| magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46
		|| ["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"].includes(Buffer.from(magic).toString("hex")),
	"OMP_COMPILED_CLI must identify a native compiled OMP executable, not a source launcher");
	const root = await mkdtemp(join(tmpdir(), "omp-cache-control-cli-"));
	try {
		const profile = join(root, "profile");
		await mkdir(profile);
		const child = Bun.spawn([omp, "--no-extensions", "-e", fileURLToPath(new URL("../cache-control.ts", import.meta.url)),
			"--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-session", "--mode", "rpc"], {
			cwd: root,
			env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: profile, PI_PROFILE: "", OMP_PROFILE: "" },
			stdin: "ignore", stdout: "pipe", stderr: "pipe",
		});
		let timedOut = false;
		// A hung external process needs a real deadline; fake timers cannot advance its clock.
		const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
			]);
			const diagnostic = `OMP exited ${code}\n${stdout}\n${stderr}`;
			assert(!timedOut, `Compiled CLI E2E exceeded 30s\n${diagnostic}`);
			assert.equal(code, 0, diagnostic);
			assert.doesNotMatch(`${stdout}\n${stderr}`, /failed to load extension|error loading extension|extension load fail|cannot find (?:module|package)/i, diagnostic);
			const events = stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
			assert(events.some(event => event.type === "available_commands_update"
				&& event.commands.some((command: { name: string }) => command.name === "cache")), diagnostic);
		} finally {
			clearTimeout(deadline);
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		}
	} finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}, 40_000);
