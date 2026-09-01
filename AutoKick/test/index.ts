import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { Client, Server } from "bedrock-protocol";

const require = createRequire(import.meta.url);
const bedrock = require("bedrock-protocol") as typeof import("bedrock-protocol");
const bedrockx = require("../src/library/BedrockX") as {
	createClient(options: Record<string, unknown>): any;
};
const { Authflow, Titles } = require("prismarine-auth") as {
	Authflow: new (
		username?: string,
		cache?: typeof tokenCacheFactory,
		options?: Record<string, unknown>,
		codeCallback?: typeof showDeviceCode,
	) => XboxAuthflow;
	Titles: {
		MinecraftNintendoSwitch: string;
	};
};
const { Rest } = require("bedrock-protocol/src/xsapi/rest.js") as {
	Rest: new (authflow: XboxAuthflow) => XboxRest;
};

type JsonObject = Record<string, unknown>;

interface XboxAuthflow {
	getXboxToken(relyingParty?: string): Promise<{
		userXUID: string;
		userHash: string;
		XSTSToken: string;
		expiresOn: number;
	}>;
}

interface XboxToken {
	userXUID: string;
	userHash: string;
	XSTSToken: string;
	expiresOn: number;
}

interface FriendRequestPerson {
	xuid?: string;
	gamertag?: string;
	displayName?: string;
}

interface FriendRequestResponse {
	people?: FriendRequestPerson[];
}

interface FriendRequestAcceptResponse {
	xuid?: string;
	addedDateTimeUtc?: string;
	isFriend?: boolean;
}

interface XboxRest {
	get(
		url: string,
		config?: {
			contractVersion?: string;
		},
	): any;
	getProfile(input: string): any;
	getSessions(xuid: string): any;
	getSession(sessionName: string): any;
	updateSession(sessionName: string, payload: unknown): any;
}

interface UserSearchCandidate {
	text: string;
	result: {
		id: string;
		gamertag: string;
		displayPicUri?: string;
		score?: number;
	} | null;
}

interface UserSearchResponse {
	results?: UserSearchCandidate[];
}

interface XboxPresenceTitle {
	id?: string;
	name?: string;
	state?: string;
	placement?: string;
	activity?: {
		richPresence?: string;
	};
}

interface XboxPresenceDevice {
	type?: string;
	titles?: XboxPresenceTitle[];
}

interface XboxPresenceResponse {
	xuid?: string;
	state?: string;
	devices?: XboxPresenceDevice[];
	lastSeen?: {
		deviceType?: string;
		titleId?: string;
		titleName?: string;
		timestamp?: string;
	};
}

interface SessionProperties {
	hostName?: string;
	worldName?: string;
	version?: string;
	MemberCount?: number;
	MaxMemberCount?: number;
	protocol?: number;
	SupportedConnections?: Array<{
		ConnectionType?: number;
		NetherNetId?: bigint | string | { toString(): string };
		PmsgId?: string;
	}>;
	nonces?: Record<string, unknown> | string[];
}

interface SessionResult {
	sessionRef: {
		name: string;
	};
	ownerXuid?: string;
	createTime?: string;
	titleId?: string;
	customProperties?: SessionProperties;
	relatedInfo?: {
		customProperties?: SessionProperties;
	};
	properties?: {
		custom?: SessionProperties;
	};
}

type NethernetClientOptions = {
	transport: "nethernet";
	useSignalling: true;
	authflow: XboxAuthflow;
	profilesFolder: typeof tokenCacheFactory;
	onMsaCode: typeof showDeviceCode;
	world: {
		targetXuid: string;
		sessions: SessionResult[];
		pickSession: (sessions: SessionResult[]) => Promise<SessionResult>;
	};
};

type NethernetServerOptions = {
	transport: "nethernet";
	useSignalling: true;
	authflow: XboxAuthflow;
	profilesFolder: typeof tokenCacheFactory;
	onMsaCode: typeof showDeviceCode;
	motd: {
		motd: string;
		levelName: string;
	};
};

type NethernetServer = Server & {
	options?: {
		networkId?: bigint | string;
	};
	nethernet?: {
		session?: {
			session?: {
				name?: string;
			};
		};
	};
};

interface CacheContext {
	username: string;
	cacheName: string;
}

interface TokenStore {
	[account: string]: {
		[cacheName: string]: JsonObject;
	};
}

const rl = createInterface({ input, output });
const tokenPath = resolve(process.cwd(), "tokens.json");
const debugEnabled = process.env.AUTOKICK_DEBUG !== "0";
const friendRequestPollIntervalMs = 15_000;

let tokenQueue: Promise<void> = Promise.resolve();
let friendRequestPoll: ReturnType<typeof setInterval> | undefined;
let acceptingFriendRequests = false;

function debugLog(label: string, value?: unknown): void {
	if (!debugEnabled) return;

	console.log(`\n[DEBUG] ${label}`);
	if (value !== undefined) {
		console.dir(value, {
			depth: 12,
			colors: true,
			maxArrayLength: 100,
			maxStringLength: 2000,
		});
	}
}

async function loadTokenStore(): Promise<TokenStore> {
	if (!existsSync(tokenPath)) {
		await writeFile(tokenPath, "{}\n", { encoding: "utf8", mode: 0o600 });
		return {};
	}

	const source = await readFile(tokenPath, "utf8");
	if (!source.trim()) return {};

	const parsed: unknown = JSON.parse(source);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("tokens.json の内容がオブジェクトではありません。");
	}
	return parsed as TokenStore;
}

async function updateTokenStore(
	account: string,
	cacheName: string,
	updater: (current: JsonObject) => JsonObject,
): Promise<void> {
	tokenQueue = tokenQueue.then(async () => {
		const store = await loadTokenStore();
		const current = store[account]?.[cacheName] ?? {};
		store[account] ??= {};
		store[account][cacheName] = updater(current);
		await writeFile(tokenPath, `${JSON.stringify(store, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	});
	return tokenQueue;
}

function tokenCacheFactory({ username, cacheName }: CacheContext) {
	const account = username || "default";

	return {
		async reset(): Promise<JsonObject> {
			await updateTokenStore(account, cacheName, () => ({}));
			return {};
		},
		async getCached(): Promise<JsonObject> {
			await tokenQueue;
			const store = await loadTokenStore();
			return store[account]?.[cacheName] ?? {};
		},
		async setCached(value: JsonObject): Promise<void> {
			await updateTokenStore(account, cacheName, () => value);
		},
		async setCachedPartial(value: JsonObject): Promise<void> {
			await updateTokenStore(account, cacheName, (current) => ({
				...current,
				...value,
			}));
		},
	};
}

function showDeviceCode(data: {
	verification_uri?: string;
	verificationUri?: string;
	user_code?: string;
	userCode?: string;
	message?: string;
}): void {
	console.log("\nMicrosoft アカウントで認証してください。");
	if (data.message) console.log(data.message);
	const uri = data.verification_uri ?? data.verificationUri;
	const code = data.user_code ?? data.userCode;
	if (uri) console.log(`URL: ${uri}`);
	if (code) console.log(`コード: ${code}`);
	console.log();
}

function createXboxAuthflow(): XboxAuthflow {
	return new Authflow(
		undefined,
		tokenCacheFactory,
		{
			authTitle: Titles.MinecraftNintendoSwitch,
			deviceType: "Nintendo",
			flow: "live",
		},
		showDeviceCode,
	);
}

function getXboxAuthorization(token: XboxToken): string {
	return `XBL3.0 x=${token.userHash};${token.XSTSToken}`;
}

async function xboxPeopleRequest<T>(
	url: string,
	token: XboxToken,
	options: RequestInit = {},
	contractVersion?: string,
): Promise<T> {
	const response = await fetch(url, {
		...options,
		headers: {
			Authorization: getXboxAuthorization(token),
			"Accept-Language": "ja-JP",
			...(contractVersion
				? { "x-xbl-contract-version": contractVersion }
				: {}),
			...options.headers,
		},
	});

	const body = await response.text();
	if (!response.ok) {
		throw new Error(
			`XboxフレンドAPIが ${response.status} を返しました${body ? `: ${body}` : ""}`,
		);
	}

	return (body ? JSON.parse(body) : {}) as T;
}

async function acceptPendingFriendRequests(token: XboxToken): Promise<number> {
	if (acceptingFriendRequests) return 0;
	acceptingFriendRequests = true;

	try {
		const pending = await xboxPeopleRequest<FriendRequestResponse>(
			"https://peoplehub.xboxlive.com/users/me/people/friendrequests(received)",
			token,
			{ method: "GET" },
			"7",
		);
		const people = Array.isArray(pending.people) ? pending.people : [];
		let acceptedCount = 0;

		for (const person of people) {
			if (!person.xuid) continue;

			try {
				const accepted = await xboxPeopleRequest<FriendRequestAcceptResponse>(
					`https://social.xboxlive.com/users/me/people/friends/v2/xuid(${encodeURIComponent(person.xuid)})`,
					token,
					{ method: "PUT" },
				);

				if (accepted.isFriend) {
					acceptedCount += 1;
					console.log(
						`フレンドリクエストを承諾しました: ${person.gamertag ?? person.displayName ?? "名称不明"} (XUID: ${person.xuid})`,
					);
				}
			} catch (error: unknown) {
				console.warn(
					`XUID ${person.xuid} のフレンドリクエストを承諾できませんでした: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return acceptedCount;
	} finally {
		acceptingFriendRequests = false;
	}
}

async function sendFriendRequest(
	token: XboxToken,
	xuid: string,
	gamertag: string,
): Promise<void> {
	const result = await xboxPeopleRequest<FriendRequestAcceptResponse>(
		`https://social.xboxlive.com/users/me/people/friends/v2/xuid(${encodeURIComponent(xuid)})`,
		token,
		{ method: "PUT" },
	);

	console.log(
		result.isFriend
			? `${gamertag} は既にフレンド、またはフレンドとして追加されました。`
			: `${gamertag} にフレンドリクエストを送信しました。`,
	);
}

function startFriendRequestAutoAccept(token: XboxToken): void {
	const check = async (): Promise<void> => {
		try {
			await acceptPendingFriendRequests(token);
		} catch (error: unknown) {
			console.warn(
				`フレンドリクエストの確認に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	void check();
	friendRequestPoll = setInterval(() => void check(), friendRequestPollIntervalMs);
	friendRequestPoll.unref?.();
	console.log("フレンドリクエストの自動承諾を有効にしました。");
}

function getSessionProperties(session: SessionResult): SessionProperties {
	return (
		session.properties?.custom ??
		session.relatedInfo?.customProperties ??
		session.customProperties ??
		{}
	);
}

function findSessionNonce(value: unknown, path = "session"): string | undefined {
	if (!value || typeof value !== "object") return undefined;

	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const nonce = findSessionNonce(item, `${path}[${index}]`);
			if (nonce) return nonce;
		}
		return undefined;
	}

	for (const [key, child] of Object.entries(value)) {
		if (key.toLowerCase().includes("nonce")) {
			if (typeof child === "string" && /^[0-9a-f]+$/i.test(child)) {
				debugLog("Session Directory API nonce候補を検出", {
					path: `${path}.${key}`,
					length: child.length,
				});
				return child;
			}
			if (Array.isArray(child)) {
				const candidate = child.find(
					(item): item is string =>
						typeof item === "string" && /^[0-9a-f]+$/i.test(item),
				);
				if (candidate) return candidate;
			}
		}

		const nonce = findSessionNonce(child, `${path}.${key}`);
		if (nonce) return nonce;
	}

	return undefined;
}

function getSessionNonceForXuid(
	session: SessionResult,
	xuid: string,
): string | undefined {
	const nonceMaps = [
		session.customProperties?.nonces,
		session.relatedInfo?.customProperties?.nonces,
		session.properties?.custom?.nonces,
	];

	for (const nonceMap of nonceMaps) {
		if (!nonceMap || Array.isArray(nonceMap) || typeof nonceMap !== "object") {
			continue;
		}
		const value = nonceMap[xuid];
		if (typeof value === "string" && /^[0-9a-f]+$/i.test(value)) {
			return value;
		}

	}

	return undefined;
}

function inspectSessionNonceMaps(session: SessionResult): void {
	const locations = [
		["customProperties.nonces", session.customProperties?.nonces],
		["relatedInfo.customProperties.nonces", session.relatedInfo?.customProperties?.nonces],
		["properties.custom.nonces", session.properties?.custom?.nonces],
	] as const;

	for (const [path, value] of locations) {
		if (!value || typeof value !== "object") continue;
		const keys = Object.keys(value);
		debugLog(`Session Directory API ${path} の内容`, {
			keys,
			valueCount: Array.isArray(value) ? value.length : keys.length,
		});
	}
}

function hasNonceForXuid(session: SessionResult, xuid: string): boolean {
	return getSessionNonceForXuid(session, xuid) !== undefined;
}

async function registerSessionMemberForNonce(
	rest: XboxRest,
	session: SessionResult,
	xuid: string,
): Promise<SessionResult | undefined> {
	const sessionName = session.sessionRef?.name;
	if (!sessionName) return undefined;

	const connectionId = randomUUID();
	const subscriptionId = randomUUID();
	debugLog("Session Directory APIへ参加者を登録してnonce発行を要求", {
		sessionName,
		xuid,
		connectionId,
	});

	await rest.updateSession(sessionName, {
		members: {
			me: {
				constants: { system: { xuid, initialize: true } },
				properties: {
					system: {
						active: true,
						connection: connectionId,
						subscription: {
							id: subscriptionId,
							changeTypes: ["everything"],
						},
					},
				},
			},
		},
	});

	const refreshed = (await rest.getSession(sessionName)) as SessionResult;
	debugLog("参加者登録後のセッションnonce", {
		nonce: getSessionNonceForXuid(refreshed, xuid),
	});
	return {
		...session,
		...refreshed,
		sessionRef: refreshed.sessionRef ?? session.sessionRef,
	};
}

function summarizeSessionCandidates(
	sessions: SessionResult[],
	targetXuid: string,
): unknown {
	const ownerCounts = new Map<string, number>();
	const titleCounts = new Map<string, number>();

	for (const session of sessions) {
		const owner = session.ownerXuid ?? "ownerXuidなし";
		const title = session.titleId ?? "titleIdなし";
		ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
		titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
	}

	return {
		targetXuid,
		total: sessions.length,
		targetOwnerMatches: sessions.filter(
			(session) => session.ownerXuid === targetXuid,
		).length,
		owners: Object.fromEntries(ownerCounts),
		titles: Object.fromEntries(titleCounts),
		candidates: sessions.map((session, index) => {
			const properties = getSessionProperties(session);
			return {
				index: index + 1,
				ownerXuid: session.ownerXuid,
				titleId: session.titleId,
				createTime: session.createTime,
				sessionRef: session.sessionRef,
				hasCustomProperties: Boolean(
					session.customProperties &&
					Object.keys(session.customProperties).length,
				),
				hasRelatedCustomProperties: Boolean(
					session.relatedInfo?.customProperties &&
					Object.keys(session.relatedInfo.customProperties).length,
				),
				hostName: properties.hostName,
				worldName: properties.worldName,
				version: properties.version,
			};
		}),
	};
}

async function debugXboxPresence(
	rest: XboxRest,
	targetXuid: string,
): Promise<void> {
	if (!debugEnabled) return;

	try {
		const presence = (await rest.get(
			`https://userpresence.xboxlive.com/users/xuid(${encodeURIComponent(targetXuid)})?level=all`,
			{ contractVersion: "3" },
		)) as XboxPresenceResponse;

		debugLog("検索対象XUIDのXbox Presence", {
			xuid: presence.xuid,
			state: presence.state,
			lastSeen: presence.lastSeen,
			devices: Array.isArray(presence.devices)
				? presence.devices.map((device) => ({
						type: device.type,
						titles: Array.isArray(device.titles)
							? device.titles.map((title) => ({
									id: title.id,
									name: title.name,
									state: title.state,
									placement: title.placement,
									richPresence: title.activity?.richPresence,
								}))
							: [],
					}))
				: [],
		});
	} catch (error: unknown) {
		debugLog("検索対象XUIDのXbox Presence取得失敗", {
			targetXuid,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function getProfileGamertag(profile: any): string {
	const settings = Array.isArray(profile?.settings) ? profile.settings : [];
	const settingNames = [
		"Gamertag",
		"ModernGamertag",
		"GameDisplayName",
		"PublicGamerpic",
	];

	for (const settingName of settingNames) {
		const setting = settings.find(
			(candidate: any) =>
				candidate &&
				typeof candidate === "object" &&
				candidate.id === settingName &&
				typeof candidate.value === "string" &&
				candidate.value.trim().length !== 0,
		);

		if (setting && settingName !== "PublicGamerpic") {
			return setting.value.trim();
		}
	}

	const directNames = [
		profile?.name,
		profile?.gamertag,
		profile?.modernGamertag,
		profile?.displayName,
	];

	const directName = directNames.find(
		(value) => typeof value === "string" && value.trim().length !== 0,
	);

	return typeof directName === "string" ? directName.trim() : "取得できませんでした";
}

async function getDetailedXboxProfile(
	rest: XboxRest,
	xuid: string,
): Promise<any> {
	const requestedSettings = [
		"Gamertag",
		"ModernGamertag",
		"ModernGamertagSuffix",
		"UniqueModernGamertag",
		"GameDisplayName",
	].join(",");
	const url =
		`https://profile.xboxlive.com/users/xuid(${encodeURIComponent(xuid)})/profile/settings` +
		`?settings=${encodeURIComponent(requestedSettings)}`;
	const response = await rest.get(url, { contractVersion: "2" });

	if (!Array.isArray(response?.profileUsers) || !response.profileUsers[0]) {
		throw new Error("Xboxプロフィールの応答にユーザー情報がありません。");
	}

	return response.profileUsers[0];
}

async function loadSessionDetails(
	rest: XboxRest,
	sessions: SessionResult[],
	inspectedXuid?: string,
): Promise<SessionResult[]> {
	const uniqueSessions = new Map<string, SessionResult>();

	for (const session of sessions) {
		const sessionName = session.sessionRef?.name;
		if (!sessionName || uniqueSessions.has(sessionName)) continue;
		uniqueSessions.set(sessionName, session);
	}

	debugLog("重複除去後のフレンドセッション候補", {
		inspectedXuid,
		apiResultCount: sessions.length,
		inspectedOwnerMatches: inspectedXuid
			? sessions.filter((session) => session.ownerXuid === inspectedXuid).length
			: undefined,
		uniqueCount: uniqueSessions.size,
	});

	const detailedSessions = await Promise.all(
		[...uniqueSessions.values()].map(async (session, index) => {
			const sessionName = session.sessionRef.name;

			try {
				debugLog(
					`候補 ${index + 1}: セッション詳細を取得`,
					session.sessionRef,
				);
				const detail = (await rest.getSession(sessionName)) as SessionResult;
				const merged = {
					...session,
					...detail,
					sessionRef: detail.sessionRef ?? session.sessionRef,
				};
				debugLog(`候補 ${index + 1}: セッション詳細`, merged);
				return merged;
			} catch (error: unknown) {
				debugLog(`候補 ${index + 1}: 詳細取得失敗`, {
					sessionRef: session.sessionRef,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}
		}),
	);

	return detailedSessions.filter((session): session is SessionResult => {
		if (!session) return false;
		const properties = getSessionProperties(session);
		return Boolean(
			properties.hostName ||
			properties.worldName ||
			properties.version,
		);
	});
}

function mergeSessionCandidates(
	...candidateGroups: SessionResult[][]
): SessionResult[] {
	const merged = new Map<string, SessionResult>();

	for (const sessions of candidateGroups) {
		for (const session of sessions) {
			const sessionName = session.sessionRef?.name;
			if (!sessionName) continue;

			const existing = merged.get(sessionName);
			merged.set(sessionName, existing ? { ...existing, ...session } : session);
		}
	}

	return [...merged.values()];
}

async function getVisibleSessionCandidates(
	rest: XboxRest,
	loggedInXuid: string,
	selectedFriendXuid: string,
): Promise<SessionResult[]> {
	const ownNetworkPromise = rest
		.getSessions(loggedInXuid)
		.then((sessions: unknown) =>
			Array.isArray(sessions) ? sessions as SessionResult[] : [],
		);

	const friendNetworkPromise = selectedFriendXuid === loggedInXuid
		? Promise.resolve([] as SessionResult[])
		: rest
			.getSessions(selectedFriendXuid)
			.then((sessions: unknown) =>
				Array.isArray(sessions) ? sessions as SessionResult[] : [],
			)
			.catch((error: unknown) => {
				debugLog("選択したフレンドを基点にしたセッション検索失敗", {
					selectedFriendXuid,
					error: error instanceof Error ? error.message : String(error),
				});
				return [] as SessionResult[];
			});

	const [ownNetworkSessions, friendNetworkSessions] = await Promise.all([
		ownNetworkPromise,
		friendNetworkPromise,
	]);

	debugLog("フレンド関係別のセッション件数", {
		loggedInXuid,
		selectedFriendXuid,
		ownNetworkCount: ownNetworkSessions.length,
		friendNetworkCount: friendNetworkSessions.length,
	});

	return mergeSessionCandidates(ownNetworkSessions, friendNetworkSessions);
}

async function askNonEmpty(message: string) {
	while (true) {
		const value = (await rl.question(message)).trim();
		if (value) return value;
		console.log("検索するXboxゲーマータグを入力してください。");
	}
}

async function searchXboxUsers(rest: XboxRest, query: string) {
	const url = `https://usersearch.xboxlive.com/suggest?q=${encodeURIComponent(query)}`;
	const response = (await rest.get(url, {
		contractVersion: "1",
	})) as UserSearchResponse;

	const candidates = Array.isArray(response.results)
		? response.results.filter((candidate) => {
		if (!candidate || !candidate.result) return false;
		if (typeof candidate.result.id !== "string") return false;
		if (typeof candidate.result.gamertag !== "string") return false;
		return candidate.result.gamertag.trim().length !== 0;
		}) as any[]
		: [];

	if (candidates.length !== 0) return candidates;

	try {
		const profile = await rest.getProfile(query);
		if (!profile || typeof profile.id !== "string") return [];

		const settings = Array.isArray(profile.settings) ? profile.settings : [];
		const gamertagSetting = settings.find(
			(setting: any) =>
				setting &&
				typeof setting === "object" &&
				setting.id === "Gamertag" &&
				typeof setting.value === "string",
		);
		const gamertag =
			gamertagSetting?.value ??
			(typeof profile.gamertag === "string" ? profile.gamertag : query);

		return [
			{
				text: gamertag,
				result: {
					id: profile.id,
					gamertag,
				},
			},
		];
	} catch {
		return [];
	}
}

async function pickXboxUser(
	candidates: any[],
	query: string,
) {
	if (candidates.length === 0) {
		throw new Error(
			`「${query}」に一致するXboxユーザー候補が見つかりませんでした。`,
		);
	}

	const normalizedQuery = query.toLocaleLowerCase();
	const sorted = [...candidates].sort((left, right) => {
		const leftName = left.result.gamertag.toLocaleLowerCase();
		const rightName = right.result.gamertag.toLocaleLowerCase();
		const leftExact = leftName === normalizedQuery ? 0 : 1;
		const rightExact = rightName === normalizedQuery ? 0 : 1;

		if (leftExact !== rightExact) return leftExact - rightExact;

		const leftStarts = leftName.startsWith(normalizedQuery) ? 0 : 1;
		const rightStarts = rightName.startsWith(normalizedQuery) ? 0 : 1;
		if (leftStarts !== rightStarts) return leftStarts - rightStarts;

		return leftName.localeCompare(rightName);
	});

	console.log(`\n「${query}」のXboxユーザー候補:`);
	sorted.forEach((candidate, index) => {
		const exact =
			candidate.result.gamertag.toLocaleLowerCase() === normalizedQuery
				? " [完全一致]"
				: "";
		console.log(
			`${index + 1}. ${candidate.result.gamertag}${exact} (XUID: ${candidate.result.id})`,
		);
	});

	while (true) {
		const answer = Number.parseInt(
			(await rl.question("対象ユーザーの番号: ")).trim(),
			10,
		);
		const selected = sorted[answer - 1];
		if (selected) return selected;
		console.log("候補一覧にある番号を入力してください。");
	}
}

async function pickSession(
	sessions: SessionResult[],
	gamertag?: string,
): Promise<SessionResult> {
	if (sessions.length === 0) {
		throw new Error(
			gamertag
				? `${gamertag} には現在参加可能なXboxセッションがありません。`
				: "参加可能なXboxセッションが見つかりませんでした。",
		);
	}

	console.log(
		gamertag
			? `\n${gamertag} の参加可能なXboxセッション:`
			: "\n参加可能なXboxセッション:",
	);
	sessions.forEach((session, index) => {
		const properties = getSessionProperties(session);
		const members =
			properties.MemberCount !== undefined
				? ` ${properties.MemberCount}/${properties.MaxMemberCount ?? "?"}`
				: "";
		console.log(
			`${index + 1}. ${properties.hostName ?? "名称不明"} / ${
				properties.worldName ?? "ワールド名不明"
			} (${properties.version ?? "バージョン不明"})${members}`,
		);
	});

	const configuredIndex = process.env.AUTOKICK_SESSION_INDEX;
	if (configuredIndex !== undefined) {
		const index = Number.parseInt(configuredIndex, 10);
		const selected = sessions[index - 1];
		if (!selected) {
			throw new Error(
				`AUTOKICK_SESSION_INDEX=${configuredIndex} はセッション一覧の範囲外です。候補数: ${sessions.length}`,
			);
		}
		console.log(`非対話モードで接続する番号を選択しました: ${index}`);
		return selected;
	}

	while (true) {
		const answer = Number.parseInt(
			(await rl.question("接続する番号: ")).trim(),
			10,
		);
		const selected = sessions[answer - 1];
			if (selected) {
				return selected;
			}
		console.log("一覧にある番号を入力してください。");
	}
}



function attachBedrockXClientLogs(client: any, sendGreetingAndExit = false): void {
	let greetingSent = false;
	let runtimeEntityId: bigint | number | undefined;
	let spawnReceived = false;
	let playerUuid = "";
	const commandRequestId = randomUUID();
	let commandOutputReceived = false;
	let availableCommandsReceived = false;
	let commandSent = false;
	const initializePlayer = (): void => {
		if (runtimeEntityId === undefined) return;
		client.write("set_local_player_as_initialized", {
			runtime_entity_id: runtimeEntityId,
		});
		console.log("プレイヤー初期化パケットを送信しました。");
	};

	client.on("connect_allowed", () => console.log("NetherNet 接続を開始しました。"));
		client.on("connected", () => console.log("WebRTC NetherNet接続が確立しました。"));
	client.on("network_settings", () => console.log("Bedrock network_settingsを受信しました。"));
	client.on("resource_packs_info", () => console.log("Bedrock resource_packs_infoを受信しました。"));
	client.on("play_status", (data: { status?: string }) => {
		console.log("Bedrock play_status:", data.status);
		if (data.status === "login_success") {
			console.log("ワールドへ参加しました。");
		}
		if (data.status !== "player_spawn") return;
		spawnReceived = true;
		initializePlayer();
		if (!sendGreetingAndExit || greetingSent) return;

		greetingSent = true;
		console.log("プレイヤーがスポーンしました。");
		client.write("text", {
			category: "authored",
			type: "chat",
			needs_translation: false,
			source_name: client.username ?? "",
			xuid: client.xuid ?? "",
			platform_chat_id: "",
			filtered_message: "",
			message: "hello World from Bedrock Protocol Client Bot!!",
		});
		console.log('チャット「hello World from Bedrock Protocol Client Bot!!」を送信しました。');
		const sendHelp = (): void => {
			if (commandSent || !availableCommandsReceived) return;
			commandSent = true;
			client.write("command_request", {
				command: "/help",
				origin: {
					type: "player",
					uuid: commandRequestId,
					request_id: "",
					player_entity_id: runtimeEntityId ?? 0n,
				},
				internal: false,
				version: "latest",
			});
			console.log("コマンド「/help」を送信しました。");
		};
		setTimeout(sendHelp, 500);

		setTimeout(() => {
			if (!commandOutputReceived) console.log("コマンド結果が届かないまま待機時間を終了します。");
			client.close("Greeting sent");
		}, 15000);
	});
	client.on("start_game", (data: { runtime_entity_id?: bigint | number }) => {
		runtimeEntityId = data.runtime_entity_id;
		console.log("Bedrockワールドの開始情報を受信しました。");
		if (spawnReceived) initializePlayer();
	});
	client.on("resource_pack_stack", () => console.log("Bedrock resource_pack_stackを受信しました。"));
	client.on("player_list", (data: { records?: Array<{ type?: string; uuid?: string }> }) => {
		for (const record of data.records ?? []) {
			if (record.type === "add" && record.uuid) playerUuid = record.uuid;
		}
		console.log("プレイヤーリスト:", data);
	});
	client.on("available_commands", () => {
		availableCommandsReceived = true;
		console.log("利用可能コマンド一覧を受信しました。");
	});
	client.on("command_output", (data: unknown) => {
		const packet = data as { origin?: { uuid?: string }; output_type?: string; output?: unknown };
		if (packet.origin?.uuid !== commandRequestId) return;
		commandOutputReceived = true;
		console.log("コマンド結果（/help）:", {
			output_type: packet.output_type,
			output: packet.output,
		});
	});
	client.on("text", (data: unknown) => console.log("テキスト受信:", data));
	client.on("packet", (packet: { data?: { name?: string; params?: unknown } }) => {
		const name = packet.data?.name;
		if (name === "command_output") {
			console.log("command_outputパケットを受信しました:", packet.data?.params);
		}
	});
	client.on("disconnect", (data: unknown) => console.log("Bedrock disconnect:", data));
	client.on("kick", (reason: unknown) => console.log("キック:", reason));
	client.on("error", (error: unknown) => console.error("クライアントエラー:", error));
	client.once("close", (reason: unknown) => console.log("クライアントを終了しました:", reason));
}

async function listFriendWorldsAndConnect(
	authflow: XboxAuthflow,
	rest: XboxRest,
	xboxToken: XboxToken,
): Promise<void> {
	console.log(
		"フレンド、またはフレンドのフレンド経由で参加可能なXboxセッションを検索しています...",
	);
	const rawSessions = await rest.getSessions(xboxToken.userXUID);
	const sessionCandidates = Array.isArray(rawSessions)
		? rawSessions as SessionResult[]
		: [];
	debugLog(
		`Session Directory API 候補診断 (${sessionCandidates.length}件)`,
		summarizeSessionCandidates(sessionCandidates, xboxToken.userXUID),
	);
	debugLog(
		`Session Directory API 生レスポンス (${sessionCandidates.length}件)`,
		sessionCandidates,
	);
	const sessions = await loadSessionDetails(
		rest,
		sessionCandidates,
		xboxToken.userXUID,
	);
	debugLog(`詳細取得後のセッション (${sessions.length}件)`, sessions);
	const nonceReadySessions = sessions.filter((session) =>
		hasNonceForXuid(session, xboxToken.userXUID),
	);
	if (nonceReadySessions.length > 0 && process.env.AUTOKICK_SESSION_INDEX === undefined) {
		console.log(
			`参加者XUID ${xboxToken.userXUID} 用のnonceがあるセッションを優先します。`,
		);
	}
	let selectedSession = await pickSession(
		nonceReadySessions.length > 0 &&
		process.env.AUTOKICK_SESSION_INDEX === undefined
			? nonceReadySessions
			: sessions,
	);
	if (!hasNonceForXuid(selectedSession, xboxToken.userXUID)) {
		try {
			const registered = await registerSessionMemberForNonce(
				rest,
				selectedSession,
				xboxToken.userXUID,
			);
			if (registered) selectedSession = registered;
		} catch (error: unknown) {
			console.warn(
				`Session Directoryへの参加者登録に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const sessionOwnerXuid = selectedSession.ownerXuid;
	if (!sessionOwnerXuid) {
		throw new Error("選択したセッションから所有者XUIDを取得できませんでした。");
	}
	const selectedProperties = getSessionProperties(selectedSession);
	inspectSessionNonceMaps(selectedSession);
	const sessionNonce = getSessionNonceForXuid(
		selectedSession,
		xboxToken.userXUID,
	);
	if (sessionNonce) {
		console.log("[BedrockX:session] Session Directory APIからnonceを取得しました", {
			length: sessionNonce.length,
			value: sessionNonce,
		});
	} else {
		console.warn(
			"[BedrockX:session] Session Directory APIレスポンスにnonceがありません。",
		);
	}
	const type7Connection = selectedProperties.SupportedConnections?.find(
		(connection) =>
			Number(connection.ConnectionType) === 7 &&
			connection.NetherNetId !== undefined &&
			Boolean(connection.PmsgId),
	);
	if (!type7Connection?.NetherNetId || !type7Connection.PmsgId) {
		throw new Error("選択したセッションにType 7のNetherNetIdまたはPmsgIdがありません。");
	}
	console.log("[BedrockX:session] Type 7接続情報を選択", {
		NetherNetId: type7Connection.NetherNetId.toString(),
		PmsgId: type7Connection.PmsgId,
		version: selectedProperties.version ?? "1.26.40",
		protocolVersion: selectedProperties.protocol ?? 2168,
	});

	const client = bedrockx.createClient({
		transport: "NETHERNET_JSONRPC",
		networkId: BigInt(type7Connection.NetherNetId.toString()),
		serverNetworkId: type7Connection.PmsgId,
		version: selectedProperties.version ?? "1.26.40",
		protocolVersion: selectedProperties.protocol ?? 2168,
		authflow,
		profilesFolder: tokenCacheFactory,
		onMsaCode: showDeviceCode,
		skinData: sessionNonce ? { Nonce: sessionNonce } : {},
	});

	attachBedrockXClientLogs(client, true);

	process.once("SIGINT", () => {
		console.log("\n終了しています...");
		client.close("CLI closed");
	});
}

async function searchAndSendFriendRequest(
	rest: XboxRest,
	xboxToken: XboxToken,
): Promise<void> {
	const query = await askNonEmpty("\n検索するXboxゲーマータグまたはID: ");
	console.log(`「${query}」のXboxユーザー候補を検索しています...`);

	const candidates = await searchXboxUsers(rest, query);
	const selectedUser = await pickXboxUser(candidates, query);
	await sendFriendRequest(
		xboxToken,
		selectedUser.result.id,
		selectedUser.result.gamertag,
	);
}



async function main(): Promise<void> {
	console.log("=== Bedrock NetherNet Xbox Session CLI ===");
	console.log(`認証キャッシュ: ${tokenPath}`);
	console.log(
		`デバッグログ: ${debugEnabled ? "有効" : "無効"} (AUTOKICK_DEBUG=0 で無効化)`,
	);
	await loadTokenStore();

	const authflow = createXboxAuthflow();
	const rest = new Rest(authflow);
	const xboxToken = await authflow.getXboxToken();
	let loggedInGamertag = "取得できませんでした";

	try {
		const profile = await getDetailedXboxProfile(rest, xboxToken.userXUID);
		loggedInGamertag = getProfileGamertag(profile);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`Xboxプロフィール名の取得に失敗しました: ${message}`);
	}

	console.log("\n=== ログイン情報 ===");
	console.log(`ログイン中のXboxユーザー: ${loggedInGamertag}`);
	console.log(`XUID: ${xboxToken.userXUID}`);
	console.log("====================");
	startFriendRequestAutoAccept(xboxToken);

	console.log("\n1. フレンド、またはフレンドのフレンドの参加可能ワールド一覧から参加");
	console.log("2. ID検索してフレンド申請");

	const configuredAction = process.env.AUTOKICK_ACTION;
	if (configuredAction === "join") {
		console.log("非対話モードでワールド参加を実行します。");
		await listFriendWorldsAndConnect(authflow, rest, xboxToken);
		return;
	}
	if (configuredAction !== undefined) {
		throw new Error(`未対応の AUTOKICK_ACTION です: ${configuredAction}`);
	}

	while (true) {
		const action = (await rl.question("操作番号: ")).trim();
		if (action === "1") {
			await listFriendWorldsAndConnect(authflow, rest, xboxToken);
			return;
		}
		if (action === "2") {
			await searchAndSendFriendRequest(rest, xboxToken);
			rl.close();
			return;
		}
		console.log("1 または 2 を入力してください。");
	}
}

main().catch((error: unknown) => {
	console.error(
		"実行に失敗しました:",
		error instanceof Error ? error.message : error,
	);
	rl.close();
	process.exitCode = 1;
});