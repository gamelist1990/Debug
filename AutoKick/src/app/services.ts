import { createAutomationRunner } from "../client/automationRunner";
import {
  createBedrockClient,
  createBedrockTransport,
} from "../client/bedrock/bedrockClient";
import { createSessionDirectory } from "../client/xbox/sessionDirectory";
import { createTokenStore } from "../client/config/tokenStore";

export const tokenStore = createTokenStore();
export const sessionDirectory = createSessionDirectory();
export const automationRunner = createAutomationRunner(async (account) =>
  createBedrockClient(account, createBedrockTransport()),
);
