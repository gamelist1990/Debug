import { spawn } from "node:child_process";
import { resolve } from "node:path";

const sessionIndex = process.env.AUTOKICK_SESSION_INDEX ?? "1";
const timeoutMs = Number.parseInt(process.env.AUTOKICK_TEST_TIMEOUT_MS ?? "90000", 10);
const root = resolve(import.meta.dirname, "..");
const events: string[] = [];
let output = "";
let finished = false;

function emit(result: Record<string, unknown>): void {
	console.log(`\nAUTOKICK_INTEGRATION_RESULT=${JSON.stringify(result)}`);
}

const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
	cwd: root,
	env: {
		...process.env,
		AUTOKICK_ACTION: "join",
		AUTOKICK_SESSION_INDEX: sessionIndex,
		AUTOKICK_DEBUG: process.env.AUTOKICK_DEBUG ?? "1",
	},
	stdio: ["ignore", "pipe", "pipe"],
});

function inspect(chunk: Buffer): void {
	const text = chunk.toString();
	process.stdout.write(text);
	output = `${output}${text}`.slice(-120_000);

	for (const [marker, event] of [
		["NetherNet に接続しました。", "connect"],
		["ワールドへ参加しました。", "join"],
		["プレイヤーがスポーンしました。", "spawn"],
		["チャット「hello World」を送信しました。", "greeting"],
		["コマンド結果（/help）:", "command_output"],
	] as const) {
		if (text.includes(marker) && !events.includes(event)) events.push(event);
	}
}

child.stdout.on("data", inspect);
child.stderr.on("data", inspect);

const timer = setTimeout(() => {
	if (finished) return;
	finished = true;
	child.kill("SIGINT");
	emit({
		success: false,
		reason: "timeout",
		sessionIndex,
		events,
		remoteError: output.match(/connecterror:(\d+)/i)?.[1],
	});
	process.exitCode = 1;
}, timeoutMs);

timer.unref?.();

child.on("exit", (code, signal) => {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	const success = events.includes("spawn") && events.includes("greeting") && events.includes("command_output");
	emit({
		success,
		sessionIndex,
		events,
		code,
		signal,
		remoteError: output.match(/connecterror:(\d+)/i)?.[1],
	});
	process.exitCode = success ? 0 : 1;
});
